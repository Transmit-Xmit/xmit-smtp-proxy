/**
 * Type definitions for SMTP proxy
 *
 * Single source of truth for all data structures
 */

import type { SMTPServerSession } from "smtp-server";

/**
 * Extended SMTP session with API key
 */
export interface XmitSession extends SMTPServerSession {
    apiKey?: string;
}

/**
 * Email attachment
 */
export interface EmailAttachment {
    filename: string;
    content: string; // base64 encoded
    contentType: string;
}

/**
 * Email payload for Transmit API
 */
export interface EmailPayload {
    from: string;
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
    attachments?: EmailAttachment[];
}

/**
 * Transmit API response for email send
 */
export interface SendEmailResponse {
    success: boolean;
    messageId?: string;
    error?: string;
}

/**
 * API key validation cache entry
 */
export interface CacheEntry<T> {
    value: T;
    expires: number;
}

/**
 * Server configuration
 */
export interface ServerConfig {
    /** SMTP port (default: 587) */
    port: number;
    /** Transmit API base URL */
    apiBase: string;
    /** TLS private key path */
    tlsKey: string;
    /** TLS certificate path */
    tlsCert: string;
    /** Development mode (disables TLS requirement) */
    devMode: boolean;
    /** API key cache TTL in milliseconds (default: 5 min) */
    apiKeyCacheTtl: number;
    /** API request timeout in milliseconds (default: 30 sec) */
    apiTimeout: number;
    /** Maximum message size in bytes (default: 10MB) */
    maxMessageSize: number;
}

/**
 * Log levels
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Logger interface for dependency injection
 */
export interface Logger {
    debug(module: string, message: string, ...args: unknown[]): void;
    info(module: string, message: string, ...args: unknown[]): void;
    warn(module: string, message: string, ...args: unknown[]): void;
    error(module: string, message: string, ...args: unknown[]): void;
}
