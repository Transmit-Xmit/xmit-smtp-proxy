/**
 * Server configuration
 *
 * Centralized configuration with environment variable support
 */

import type { ServerConfig, Logger, LogLevel } from "./types.js";

/**
 * Load configuration from environment variables
 */
export function loadConfig(): ServerConfig {
    return {
        smtpPort: parseInt(process.env.SMTP_PORT || process.env.PORT || "587", 10),
        imapPort: parseInt(process.env.IMAP_PORT || "993", 10),
        apiBase: process.env.API_BASE || "https://api.xmit.sh",
        tlsKey: process.env.TLS_KEY_PATH || "/etc/letsencrypt/live/mail.xmit.sh/privkey.pem",
        tlsCert: process.env.TLS_CERT_PATH || "/etc/letsencrypt/live/mail.xmit.sh/fullchain.pem",
        devMode: process.env.NODE_ENV === "development",
        apiKeyCacheTtl: parseInt(process.env.API_KEY_CACHE_TTL || "300000", 10), // 5 min
        apiTimeout: parseInt(process.env.API_TIMEOUT || "30000", 10), // 30 sec
        maxMessageSize: parseInt(process.env.MAX_MESSAGE_SIZE || "10485760", 10), // 10MB
        imapIdleTimeout: parseInt(process.env.IMAP_IDLE_TIMEOUT || "1800000", 10), // 30 min
    };
}

/**
 * API key format validation
 */
export const API_KEY_PREFIXES = ["pm_live_", "pm_test_"] as const;

export function isValidApiKeyFormat(apiKey: string): boolean {
    return API_KEY_PREFIXES.some((prefix) => apiKey.startsWith(prefix));
}

/**
 * Console logger with module prefixes
 */
export function createLogger(minLevel: LogLevel = "info"): Logger {
    const levels: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
    };

    const shouldLog = (level: LogLevel): boolean => {
        return levels[level] >= levels[minLevel];
    };

    const formatMessage = (module: string, message: string): string => {
        return `[${module}] ${message}`;
    };

    return {
        debug(module, message, ...args) {
            if (shouldLog("debug")) {
                console.debug(formatMessage(module, message), ...args);
            }
        },
        info(module, message, ...args) {
            if (shouldLog("info")) {
                console.log(formatMessage(module, message), ...args);
            }
        },
        warn(module, message, ...args) {
            if (shouldLog("warn")) {
                console.warn(formatMessage(module, message), ...args);
            }
        },
        error(module, message, ...args) {
            if (shouldLog("error")) {
                console.error(formatMessage(module, message), ...args);
            }
        },
    };
}

/**
 * Escape HTML entities
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
