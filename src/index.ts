/**
 * xmit-smtp - SMTP & IMAP Server for Transmit
 *
 * SMTP: Accepts SMTP connections and forwards emails through Transmit's REST API.
 * IMAP: Accepts IMAP connections and translates to Transmit mailbox API calls.
 *
 * Authenticate using your Transmit API key as the password.
 */

// Load .env file before anything else
import "dotenv/config";

import { loadConfig, createLogger } from "./shared/config.js";
import { TransmitClient } from "./shared/api-client.js";
import { createSmtpServer } from "./smtp/server.js";
import { createImapServer } from "./imap/server.js";
import { ImapApiClient } from "./imap/api-client.js";

// Load configuration
const config = loadConfig();
const logger = createLogger(config.devMode ? "debug" : "info");

// Create API clients
const smtpApiClient = new TransmitClient({
    apiBase: config.apiBase,
    timeout: config.apiTimeout,
    cacheTtl: config.apiKeyCacheTtl,
    logger,
});

const imapApiClient = new ImapApiClient({
    apiBase: config.apiBase,
    timeout: config.apiTimeout,
    cacheTtl: config.apiKeyCacheTtl,
    logger,
});

// Create and start SMTP server
const smtpServer = createSmtpServer(config, smtpApiClient, logger);
smtpServer.listen(config.smtpPort, () => {
    logger.info("smtp", `Listening on port ${config.smtpPort}`);
});

// Create and start IMAP server
const imapServer = createImapServer(config, imapApiClient, logger);
imapServer.listen(config.imapPort, () => {
    logger.info("imap", `Listening on port ${config.imapPort}`);
});

// Startup banner
console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   xmit-mail - SMTP & IMAP Server for Transmit             ║
║                                                           ║
║   SMTP: port ${config.smtpPort.toString().padEnd(43)}║
║   IMAP: port ${config.imapPort.toString().padEnd(43)}║
║   API:  ${config.apiBase.padEnd(48)}║
║   Mode: ${(config.devMode ? "development" : "production").padEnd(48)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

Email client settings:

  Incoming Mail (IMAP):
    Host: imap.xmit.sh (or mail.xmit.sh)
    Port: ${config.imapPort}
    Security: SSL/TLS
    Username: <your sender email or "api">
    Password: <your Transmit API key>

  Outgoing Mail (SMTP):
    Host: smtp.xmit.sh (or mail.xmit.sh)
    Port: ${config.smtpPort}
    Security: STARTTLS
    Username: api (or any value)
    Password: <your Transmit API key>
`);

// Periodic cache cleanup (every 10 minutes)
setInterval(() => {
    smtpApiClient.pruneCache();
    imapApiClient.pruneCache();
}, 10 * 60 * 1000);

// Graceful shutdown
function shutdown(signal: string) {
    logger.info("shutdown", `Received ${signal}, closing servers...`);

    Promise.all([
        new Promise<void>((resolve) => smtpServer.close(() => resolve())),
        new Promise<void>((resolve) => imapServer.close(() => resolve())),
    ]).then(() => {
        logger.info("shutdown", "Servers closed");
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
