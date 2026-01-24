/**
 * SMTP Server
 * Accepts SMTP connections and forwards emails through Transmit's REST API
 */
import {
    SMTPServer,
    SMTPServerAuthentication,
    SMTPServerAuthenticationResponse,
} from "smtp-server";
import { simpleParser, ParsedMail } from "mailparser";
import { Readable } from "stream";
import fs from "fs";

import type { XmitSession, EmailPayload, Logger, ServerConfig } from "../shared/types.js";
import { isValidApiKeyFormat, escapeHtml } from "../shared/config.js";
import { TransmitClient } from "../shared/api-client.js";
import { SmtpProxyError, ErrorCodes, toSmtpCode } from "../shared/errors.js";

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
export function createSmtpServer(
    config: ServerConfig,
    apiClient: TransmitClient,
    logger: Logger
): SMTPServer {
    // Load TLS certificates (optional in dev mode)
    let tlsOptions: { key?: Buffer; cert?: Buffer } = {};

    if (!config.devMode) {
        try {
            tlsOptions = {
                key: fs.readFileSync(config.tlsKey),
                cert: fs.readFileSync(config.tlsCert),
            };
            logger.info("smtp", "Loaded TLS certificates");
        } catch (error) {
            logger.warn("smtp", "Could not load TLS certificates, STARTTLS disabled");
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
                logger.info("smtp", `Invalid key format from ${session.remoteAddress}`);
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
                        logger.info("smtp", `Auth success from ${session.remoteAddress}`);
                        callback(null, { user: auth.username || "api" });
                    } else {
                        logger.info("smtp", `Invalid key from ${session.remoteAddress}`);
                        callback(new Error("Invalid API key"));
                    }
                })
                .catch((error) => {
                    logger.error("smtp", `Auth error: ${error}`);
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
                    logger.info(
                        "smtp",
                        `From: ${getAddressText(parsed.from)}, To: ${getAddressText(parsed.to)}, Subject: ${parsed.subject}`
                    );

                    // Build payload
                    const payload = buildPayload(parsed);

                    // Forward to API
                    return apiClient.sendEmail(apiKey, payload);
                })
                .then((result) => {
                    if (result.success) {
                        logger.info("smtp", `Sent: ${result.messageId}`);
                        callback();
                    } else {
                        logger.warn("smtp", `Failed: ${result.error}`);
                        callback(new Error(result.error || "Send failed"));
                    }
                })
                .catch((error) => {
                    if (error instanceof SmtpProxyError) {
                        const smtpCode = toSmtpCode(error);
                        logger.warn("smtp", `Error (${smtpCode}): ${error.message}`);
                        callback(new Error(`${smtpCode} ${error.message}`));
                    } else {
                        logger.error("smtp", `Parse error: ${error}`);
                        callback(new Error("Failed to parse message"));
                    }
                });
        },

        // Connection logging
        onConnect(session: XmitSession, callback: (err?: Error | null) => void) {
            logger.debug("smtp", `Connection from ${session.remoteAddress}`);
            callback();
        },

        onClose(session: XmitSession) {
            logger.debug("smtp", `Closed ${session.remoteAddress}`);
        },
    });

    return server;
}
