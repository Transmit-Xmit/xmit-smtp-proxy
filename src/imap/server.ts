/**
 * IMAP Server
 * Accepts IMAP connections and translates to Transmit REST API calls
 */
import net from "net";
import tls from "tls";
import fs from "fs";
import crypto from "crypto";

// Security limits
const MAX_LINE_SIZE = 64 * 1024; // 64KB max command line
const MAX_LITERAL_SIZE = 50 * 1024 * 1024; // 50MB max literal (attachment)
const LITERAL_TIMEOUT_MS = 60 * 1000; // 60s timeout for literal collection

import type { ServerConfig, Logger, ImapSession, ImapCommand, ImapResponse } from "../shared/types.js";
import { ImapApiClient } from "./api-client.js";
import { parseCommand } from "./parser.js";
import { formatResponse } from "./formatter.js";
import { handleCommand } from "./commands/index.js";

/**
 * Create IMAP session
 */
function createSession(remoteAddress: string): ImapSession {
    return {
        id: crypto.randomUUID(),
        remoteAddress,
        state: "not_authenticated",
        idling: false,
        enabledExtensions: new Set(),
    };
}

/**
 * Create and configure IMAP server
 */
export function createImapServer(
    config: ServerConfig,
    apiClient: ImapApiClient,
    logger: Logger
): net.Server {
    const sessions = new Map<net.Socket, ImapSession>();

    // Load TLS certificates
    let tlsOptions: tls.TlsOptions = {};
    if (!config.devMode) {
        try {
            tlsOptions = {
                key: fs.readFileSync(config.tlsKey),
                cert: fs.readFileSync(config.tlsCert),
            };
            logger.info("imap", "Loaded TLS certificates");
        } catch (error) {
            logger.warn("imap", "Could not load TLS certificates");
        }
    }

    // Create server (TLS in production, plain in dev)
    const server = config.devMode
        ? net.createServer()
        : tls.createServer(tlsOptions);

    // For TLS server, use "secureConnection"; for plain server, use "connection"
    const connectionEvent = config.devMode ? "connection" : "secureConnection";
    server.on(connectionEvent, (socket: net.Socket) => {
        const session = createSession(socket.remoteAddress || "unknown");
        sessions.set(socket, session);

        logger.info("imap", `Connection from ${session.remoteAddress}`);

        // Send greeting
        socket.write("* OK [CAPABILITY IMAP4rev1 IDLE NAMESPACE UIDPLUS MOVE SPECIAL-USE] Transmit IMAP Ready\r\n");

        let buffer = Buffer.alloc(0);
        let pendingLiteral: {
            command: string;
            size: number;
            collected: Buffer;
            timeout?: NodeJS.Timeout;
        } | null = null;

        socket.on("data", async (data) => {
            buffer = Buffer.concat([buffer, data]);

            // Security: Check buffer size to prevent memory exhaustion
            if (buffer.length > MAX_LINE_SIZE && !pendingLiteral) {
                logger.warn("imap", `Command too long from ${session.remoteAddress}, closing`);
                socket.write("* BAD Command line too long\r\n");
                socket.end();
                return;
            }

            // Handle literal data collection
            if (pendingLiteral) {
                // Clear and reset timeout on activity
                if (pendingLiteral.timeout) {
                    clearTimeout(pendingLiteral.timeout);
                    pendingLiteral.timeout = setTimeout(() => {
                        logger.warn("imap", `Literal timeout from ${session.remoteAddress}`);
                        socket.write("* BAD Literal data timeout\r\n");
                        socket.end();
                    }, LITERAL_TIMEOUT_MS);
                }
                const remaining = pendingLiteral.size - pendingLiteral.collected.length;

                // Take up to 'remaining' bytes
                const chunk = buffer.subarray(0, remaining);
                pendingLiteral.collected = Buffer.concat([pendingLiteral.collected, chunk]);
                buffer = buffer.subarray(chunk.length);

                // Check if we have all literal data
                if (pendingLiteral.collected.length >= pendingLiteral.size) {
                    // Clear timeout
                    if (pendingLiteral.timeout) {
                        clearTimeout(pendingLiteral.timeout);
                    }

                    // Remove trailing CRLF after literal if present (checks the NEXT bytes in buffer)
                    // Note: literal data is followed by CRLF if it was part of a line? 
                    // No, usually literal is {N}\r\n<data>. The command continues?
                    // Actually, if it's a non-synchronizing literal, or just an argument.
                    // The command line parser expects the literal data to be attached.
                    // But usually the client sends:
                    // C: A01 APPEND "INBOX" {4}\r\n
                    // S: + go ahead\r\n
                    // C: test
                    // C: \r\n
                    // Wait. RFC 3501 says:
                    // "The characters matching the N characters of the literal are treated as a single argument."
                    // If the command is not synchronous, or if the literal is an argument.
                    // The buffer logic here assumes the client sends exactly size bytes.
                    // Does it send \r\n after?
                    // Usually no, unless it's the end of line?
                    // Example: C: LOGIN user {4}\r\npass
                    // If 'pass' is 4 chars, the command ends there?
                    // Actually, usually arguments are space separated.
                    // LOGIN user {4}\r\npass
                    // The 'buffer' handling logic below (original code) did:
                    /*
                    if (buffer.startsWith("\r\n")) {
                         buffer = buffer.slice(2);
                    }
                    */
                    // This implies it expects CRLF after literal?
                    // Let's preserve that logic but use Buffer methods.
                    // But wait, why would there be CRLF after literal unless it's end of command?
                    // If I am appending a message: APPEND "box" {N}\r\n<data>\r\n  <- Wait, no.
                    // APPEND "box" {N}\r\n<data>
                    // Only IF <data> is the last arg, the request might end there?
                    // But usually commands end with CRLF.
                    // If literal is the last arg, does client send CRLF after data?
                    // RFC 3501: "Every client command ... is terminated by a CRLF."
                    // If the command ends with a literal:
                    // C: A01 APPEND "box" {4}\r\nDATA
                    // Does it send CRLF after DATA?
                    // NO. The CRLF after {4} is the trigger for literal.
                    // The command line effectively continues "through" the literal.
                    // If DATA is the end of the line, then yes, possibly?
                    // But usually: A01 LOGIN {3}\r\nfoo {3}\r\nbar\r\n
                    // The literal "foo" is one arg. Literal "bar" is second?
                    // The previous logic `if (buffer.startsWith("\r\n"))` handles the case where there is a newline?
                    // Or maybe it was handling the newline that *preceded* the literal? No.
                    // Let's assume the previous logic was trying to consume a newline that might appear?
                    // Actually, checking `server.ts` line 117 (original):
                    // `if (buffer.startsWith("\r\n")) buffer = buffer.slice(2);`
                    // This was executed AFTER literal collection.
                    // If the literal is followed by CRLF (end of command), this eats it.
                    // If not (e.g. LOGIN {3}\r\nfoo {3}...), then there is a space?
                    // Eating CRLF might merge lines?
                    // Let's stick safe: Check for \r\n.
                    // Buffer check:
                    if (buffer.length >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
                        buffer = buffer.subarray(2);
                    }

                    // Process the complete command with literal
                    const line = pendingLiteral.command;
                    // Convert collected buffer to string.
                    // IMPORTANT: This resolves the framing issue, but keeps string internal API
                    const literalData = pendingLiteral.collected.toString("utf8");
                    pendingLiteral = null;

                    try {
                        const command = parseCommand(line);
                        (command as any).literalData = literalData;
                        logger.debug("imap", `< ${command.tag} ${command.name} [+${literalData.length} chars, ${Buffer.byteLength(literalData)} bytes]`);

                        const responses = await handleCommand(session, command, apiClient, socket, config);

                        for (const response of responses) {
                            const formatted = formatResponse(response);
                            socket.write(formatted + "\r\n");
                            logger.debug("imap", `> ${formatted.slice(0, 100)}${formatted.length > 100 ? "..." : ""}`);
                        }

                        if (session.state === "logout") {
                            socket.end();
                        }
                    } catch (error) {
                        logger.error("imap", `Command error: ${error}`);
                        socket.write(`* BAD ${error instanceof Error ? error.message : "Unknown error"}\r\n`);
                    }
                }
                return;
            }

            // Process complete lines (CRLF terminated)
            let lineEnd;
            while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
                const line = buffer.subarray(0, lineEnd).toString("utf8");
                buffer = buffer.subarray(lineEnd + 2);

                // Handle IDLE termination
                if (line.toUpperCase() === "DONE") {
                    if (session.idling) {
                        if (session.idleTimeout) {
                            clearTimeout(session.idleTimeout);
                        }
                        session.idling = false;
                        socket.write(`${session.idleTag} OK IDLE terminated\r\n`);
                    } else {
                        // DONE received when not in IDLE - ignore silently
                        logger.debug("imap", "DONE received but not in IDLE state");
                    }
                    continue;
                }

                if (!line.trim()) continue;

                // Check for literal syntax {size}
                const literalMatch = line.match(/\{(\d+)\}\s*$/);
                if (literalMatch) {
                    const size = parseInt(literalMatch[1]);

                    // Security: Check literal size limit
                    if (size > MAX_LITERAL_SIZE) {
                        logger.warn("imap", `Literal too large (${size} bytes) from ${session.remoteAddress}`);
                        socket.write("* BAD Literal too large\r\n");
                        continue;
                    }

                    logger.debug("imap", `< Literal expected: ${size} bytes`);

                    // Send continuation response
                    socket.write("+ Ready for literal data\r\n");

                    // Set up literal collection with timeout
                    pendingLiteral = {
                        command: line.replace(/\{(\d+)\}\s*$/, ""),
                        size,
                        collected: Buffer.alloc(0),
                        timeout: setTimeout(() => {
                            logger.warn("imap", `Literal timeout from ${session.remoteAddress}`);
                            pendingLiteral = null;
                            socket.write("* BAD Literal data timeout\r\n");
                            socket.end();
                        }, LITERAL_TIMEOUT_MS),
                    };

                    // Process any data already in buffer
                    if (buffer.length > 0) {
                        const remaining = size;
                        const chunk = buffer.subarray(0, remaining);
                        pendingLiteral.collected = Buffer.concat([pendingLiteral.collected, chunk]);
                        buffer = buffer.subarray(chunk.length);

                        if (pendingLiteral.collected.length >= size) {
                            // Remove trailing CRLF after literal if present
                            if (buffer.length >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
                                buffer = buffer.subarray(2);
                            }

                            // Process immediately
                            const literalData = pendingLiteral.collected.toString("utf8");
                            pendingLiteral = null;

                            try {
                                const command = parseCommand(line.replace(/\{(\d+)\}\s*$/, ""));
                                (command as any).literalData = literalData;
                                logger.debug("imap", `< ${command.tag} ${command.name} [+${literalData.length} chars]`);

                                const responses = await handleCommand(session, command, apiClient, socket, config);

                                for (const response of responses) {
                                    const formatted = formatResponse(response);
                                    socket.write(formatted + "\r\n");
                                    logger.debug("imap", `> ${formatted.slice(0, 100)}${formatted.length > 100 ? "..." : ""}`);
                                }

                                if (session.state === "logout") {
                                    socket.end();
                                }
                            } catch (error) {
                                logger.error("imap", `Command error: ${error}`);
                                socket.write(`* BAD ${error instanceof Error ? error.message : "Unknown error"}\r\n`);
                            }
                        }
                    }
                    continue;
                }

                try {
                    const command = parseCommand(line);
                    // Log full command for debugging SELECT and FETCH issues
                    if (command.name === "SELECT" || command.name === "EXAMINE" || command.name === "FETCH") {
                        logger.info("imap", `< ${command.tag} ${command.name} [${command.args.join("|")}] raw="${line}"`);
                    } else {
                        logger.info("imap", `< ${command.tag} ${command.name}`);
                    }

                    const responses = await handleCommand(session, command, apiClient, socket, config);

                    for (const response of responses) {
                        const formatted = formatResponse(response);
                        socket.write(formatted + "\r\n");
                        logger.info("imap", `> ${formatted.slice(0, 200)}${formatted.length > 200 ? "..." : ""}`);
                    }

                    // Check for logout
                    if (session.state === "logout") {
                        socket.end();
                    }
                } catch (error) {
                    logger.error("imap", `Command error: ${error} | raw="${line}" | idling=${session.idling}`);
                    if (error instanceof Error) {
                        logger.error("imap", `Stack: ${error.stack}`);
                    }
                    socket.write(`* BAD ${error instanceof Error ? error.message : "Unknown error"}\r\n`);
                }
            }
        });

        socket.on("close", () => {
            if (session.idleTimeout) {
                clearTimeout(session.idleTimeout);
            }
            sessions.delete(socket);
            logger.info("imap", `Closed ${session.remoteAddress}`);
        });

        socket.on("error", (err) => {
            logger.error("imap", `Socket error: ${err.message}`);
            sessions.delete(socket);
        });

        // Set socket timeout
        socket.setTimeout(config.imapIdleTimeout);
        socket.on("timeout", () => {
            logger.info("imap", `Timeout ${session.remoteAddress}`);
            socket.write("* BYE Connection timed out\r\n");
            socket.end();
        });
    });

    return server;
}
