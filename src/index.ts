/**
 * xmit-smtp - SMTP Relay Proxy for Transmit
 *
 * Accepts SMTP connections and forwards emails through Transmit's REST API.
 * Authenticate using your Transmit API key as the SMTP password.
 */

// Load .env file before anything else
import "dotenv/config";

import {
    SMTPServer,
    SMTPServerAuthentication,
    SMTPServerAuthenticationResponse,
} from "smtp-server";
import { simpleParser, ParsedMail } from "mailparser";
import { Readable } from "stream";
import fs from "fs";

import type { XmitSession, EmailPayload, Logger } from "./types.js";
import { loadConfig, isValidApiKeyFormat, createLogger, escapeHtml } from "./config.js";
import { TransmitClient } from "./api-client.js";
import { SmtpProxyError, ErrorCodes, toSmtpCode } from "./errors.js";

// Load configuration
const config = loadConfig();
const logger = createLogger(config.devMode ? "debug" : "info");

// Create API client
const apiClient = new TransmitClient({
    apiBase: config.apiBase,
    timeout: config.apiTimeout,
    cacheTtl: config.apiKeyCacheTtl,
    logger,
});

/**
 * Extract email addresses from mailparser AddressObject
 */
function extractAddresses(addr: ParsedMail["to"]): string[] {
    if (!addr) return [];
    const arr = Array.isArray(addr) ? addr : [addr];
    return arr.flatMap(
        (a) => a.value?.map((v) => v.address).filter((x): x is string => !!x) || []
    );
}

/**
 * Get display text from address object (for logging)
 */
function getAddressText(addr: ParsedMail["from"] | ParsedMail["to"]): string | undefined {
    if (!addr) return undefined;
    const obj = Array.isArray(addr) ? addr[0] : addr;
    return obj?.text;
}

/**
 * Build email payload from parsed mail
 */
function buildPayload(mail: ParsedMail): EmailPayload {
    // Extract from address
    const fromObj = Array.isArray(mail.from) ? mail.from[0] : mail.from;
    const fromAddr = fromObj?.value?.[0];
    const from = fromAddr?.name
        ? `${fromAddr.name} <${fromAddr.address}>`
        : fromAddr?.address;

    if (!from) {
        throw new SmtpProxyError("Missing 'from' address", ErrorCodes.MISSING_FROM);
    }

    // Extract recipients
    const toAddresses = extractAddresses(mail.to);
    if (toAddresses.length === 0) {
        throw new SmtpProxyError("Missing 'to' address", ErrorCodes.MISSING_TO);
    }

    const ccAddresses = extractAddresses(mail.cc);
    const bccAddresses = extractAddresses(mail.bcc);

    // Build base payload
    const payload: EmailPayload = {
        from,
        to: toAddresses.length === 1 ? toAddresses[0] : toAddresses,
        subject: mail.subject || "(no subject)",
    };

    // HTML and text content
    if (mail.html) {
        payload.html = typeof mail.html === "string" ? mail.html : String(mail.html);
    }
    if (mail.text) {
        payload.text = mail.text;
    }

    // If only text, wrap in <pre> for HTML
    if (!mail.html && mail.text) {
        payload.html = `<pre>${escapeHtml(mail.text)}</pre>`;
    }

    // CC/BCC
    if (ccAddresses.length > 0) {
        payload.cc = ccAddresses.length === 1 ? ccAddresses[0] : ccAddresses;
    }
    if (bccAddresses.length > 0) {
        payload.bcc = bccAddresses.length === 1 ? bccAddresses[0] : bccAddresses;
    }

    // Reply-To
    const replyToObj = Array.isArray(mail.replyTo) ? mail.replyTo[0] : mail.replyTo;
    const replyTo = replyToObj?.value?.[0]?.address;
    if (replyTo) {
        payload.replyTo = replyTo;
    }

    // Attachments
    if (mail.attachments && mail.attachments.length > 0) {
        payload.attachments = mail.attachments.map((att) => ({
            filename: att.filename || "attachment",
            content: att.content.toString("base64"),
            contentType: att.contentType || "application/octet-stream",
        }));
    }

    return payload;
}

/**
 * Create and configure SMTP server
 */
function createServer(log: Logger): SMTPServer {
    // Load TLS certificates (optional in dev mode)
    let tlsOptions: { key?: Buffer; cert?: Buffer } = {};

    if (!config.devMode) {
        try {
            tlsOptions = {
                key: fs.readFileSync(config.tlsKey),
                cert: fs.readFileSync(config.tlsCert),
            };
            log.info("tls", "Loaded TLS certificates");
        } catch (error) {
            log.warn("tls", "Could not load TLS certificates, STARTTLS disabled");
            log.warn("tls", "Set TLS_KEY_PATH and TLS_CERT_PATH environment variables");
        }
    }

    const server = new SMTPServer({
        // Connection settings
        secure: false, // Use STARTTLS, not implicit TLS
        authMethods: ["PLAIN", "LOGIN"],
        authOptional: false,
        disabledCommands: config.devMode ? ["STARTTLS"] : [],

        // TLS
        ...tlsOptions,

        // Banner
        banner: "xmit-smtp ESMTP Ready",

        // Size limit
        size: config.maxMessageSize,

        // Authentication handler
        onAuth(
            auth: SMTPServerAuthentication,
            session: XmitSession,
            callback: (
                err: Error | null | undefined,
                response?: SMTPServerAuthenticationResponse
            ) => void
        ) {
            const apiKey = auth.password || "";

            // Validate API key format
            if (!isValidApiKeyFormat(apiKey)) {
                log.info("auth", `Invalid key format from ${session.remoteAddress}`);
                return callback(
                    new Error("Invalid API key format. Use your Transmit API key as password.")
                );
            }

            // Validate against API
            apiClient
                .validateApiKey(apiKey)
                .then((valid) => {
                    if (valid) {
                        session.apiKey = apiKey;
                        log.info("auth", `Success from ${session.remoteAddress}`);
                        callback(null, { user: auth.username || "api" });
                    } else {
                        log.info("auth", `Invalid key from ${session.remoteAddress}`);
                        callback(new Error("Invalid API key"));
                    }
                })
                .catch((error) => {
                    log.error("auth", `Error: ${error}`);
                    callback(new Error("Authentication failed"));
                });
        },

        // Message handler
        onData(
            stream: Readable,
            session: XmitSession,
            callback: (err?: Error | null) => void
        ) {
            const apiKey = session.apiKey;

            if (!apiKey) {
                return callback(new Error("Not authenticated"));
            }

            // Parse and forward the email
            simpleParser(stream)
                .then((parsed) => {
                    log.info(
                        "recv",
                        `From: ${getAddressText(parsed.from)}, To: ${getAddressText(parsed.to)}, Subject: ${parsed.subject}`
                    );

                    // Build payload
                    const payload = buildPayload(parsed);

                    // Forward to API
                    return apiClient.sendEmail(apiKey, payload);
                })
                .then((result) => {
                    if (result.success) {
                        log.info("send", `Success: ${result.messageId}`);
                        callback();
                    } else {
                        log.warn("send", `Failed: ${result.error}`);
                        callback(new Error(result.error || "Send failed"));
                    }
                })
                .catch((error) => {
                    if (error instanceof SmtpProxyError) {
                        const smtpCode = toSmtpCode(error);
                        log.warn("send", `Error (${smtpCode}): ${error.message}`);
                        callback(new Error(`${smtpCode} ${error.message}`));
                    } else {
                        log.error("recv", `Parse error: ${error}`);
                        callback(new Error("Failed to parse message"));
                    }
                });
        },

        // Connection logging
        onConnect(session: XmitSession, callback: (err?: Error | null) => void) {
            log.info("conn", `New connection from ${session.remoteAddress}`);
            callback();
        },

        onClose(session: XmitSession) {
            log.info("conn", `Closed connection from ${session.remoteAddress}`);
        },
    });

    return server;
}

// Create and start server
const server = createServer(logger);

server.listen(config.port, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   xmit-smtp - SMTP Relay for Transmit             ║
║                                                   ║
║   Listening on port ${config.port.toString().padEnd(27)}║
║   API endpoint: ${config.apiBase.padEnd(31)}║
║   Mode: ${(config.devMode ? "development" : "production").padEnd(40)}║
║                                                   ║
╚═══════════════════════════════════════════════════╝

Configure your email client:
  Host: smtp.xmit.sh
  Port: ${config.port}
  User: api (or any value)
  Pass: <your Transmit API key>
  TLS:  STARTTLS
`);
});

// Periodic cache cleanup (every 10 minutes)
setInterval(
    () => {
        apiClient.pruneCache();
    },
    10 * 60 * 1000
);

// Graceful shutdown
function shutdown(signal: string) {
    logger.info("shutdown", `Received ${signal}, closing server...`);
    server.close(() => {
        logger.info("shutdown", "Server closed");
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        logger.warn("shutdown", "Forcing exit after timeout");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
