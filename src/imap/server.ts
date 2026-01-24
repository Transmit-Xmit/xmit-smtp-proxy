/**
 * IMAP Server
 * Accepts IMAP connections and translates to Transmit REST API calls
 */
import net from "net";
import tls from "tls";
import fs from "fs";
import crypto from "crypto";

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

        let buffer = "";

        socket.on("data", async (data) => {
            buffer += data.toString();

            // Process complete lines (CRLF terminated)
            let lineEnd;
            while ((lineEnd = buffer.indexOf("\r\n")) !== -1) {
                const line = buffer.slice(0, lineEnd);
                buffer = buffer.slice(lineEnd + 2);

                // Handle IDLE termination
                if (session.idling && line.toUpperCase() === "DONE") {
                    if (session.idleTimeout) {
                        clearTimeout(session.idleTimeout);
                    }
                    session.idling = false;
                    socket.write(`${session.idleTag} OK IDLE terminated\r\n`);
                    continue;
                }

                if (!line.trim()) continue;

                try {
                    const command = parseCommand(line);
                    logger.debug("imap", `< ${command.tag} ${command.name}`);

                    const responses = await handleCommand(session, command, apiClient, socket, config);

                    for (const response of responses) {
                        const formatted = formatResponse(response);
                        socket.write(formatted + "\r\n");
                        logger.debug("imap", `> ${formatted.slice(0, 100)}${formatted.length > 100 ? "..." : ""}`);
                    }

                    // Check for logout
                    if (session.state === "logout") {
                        socket.end();
                    }
                } catch (error) {
                    logger.error("imap", `Command error: ${error}`);
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
