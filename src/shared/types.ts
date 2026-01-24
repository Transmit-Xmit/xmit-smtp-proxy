/**
 * Type definitions for SMTP/IMAP proxy
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
    smtpPort: number;
    /** IMAP port (default: 993) */
    imapPort: number;
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
    /** IMAP IDLE timeout in milliseconds (default: 30 min) */
    imapIdleTimeout: number;
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

// ============================================================================
// IMAP Types
// ============================================================================

export type ImapSessionState = "not_authenticated" | "authenticated" | "selected" | "logout";

export interface ImapSession {
    id: string;
    remoteAddress: string;

    // Auth state
    state: ImapSessionState;
    apiKey?: string;
    workspaceId?: string;

    // Selected sender (authenticated user picks which mailbox)
    selectedSender?: {
        id: string;
        email: string;
    };

    // Selected folder state
    selectedFolder?: {
        id: string;
        name: string;
        uidValidity: number;
        uidNext: number;
        readOnly: boolean;

        // Message UID cache (for sequence <-> UID mapping)
        messageUids: number[];
        highestModSeq: number;
    };

    // IDLE state
    idling: boolean;
    idleTag?: string;
    idleTimeout?: ReturnType<typeof setTimeout>;

    // Enabled extensions
    enabledExtensions: Set<string>;
}

export interface ImapCommand {
    tag: string;
    name: string;
    args: string[];
    useUid?: boolean; // true if called via UID prefix
    raw: string;
}

export interface ImapResponse {
    type?: "untagged" | "continuation";
    tag?: string;
    status?: "OK" | "NO" | "BAD";
    code?: string; // e.g., "[UIDVALIDITY 123]"
    message?: string;
    data?: string;
}

// Mailbox types (from API)
export interface MailboxFolder {
    id: string;
    name: string;
    specialUse?: string;
    flags: string[];
    uidValidity: number;
    uidNext: number;
    totalMessages: number;
    unseenCount: number;
    recentCount: number;
}

export interface MailboxMessage {
    uid: number;
    flags: string[];
    internalDate: string;
    size: number;
    envelope?: ImapEnvelope;
    bodyStructure?: BodyStructure;
    body?: {
        text?: string;
        html?: string;
        headers?: Record<string, string>;
    };
}

export interface ImapEnvelope {
    date: string | null;
    subject: string | null;
    from: ImapAddress[] | null;
    sender: ImapAddress[] | null;
    replyTo: ImapAddress[] | null;
    to: ImapAddress[] | null;
    cc: ImapAddress[] | null;
    bcc: ImapAddress[] | null;
    inReplyTo: string | null;
    messageId: string | null;
}

export interface ImapAddress {
    name: string | null;
    adl: string | null;
    mailbox: string;
    host: string;
}

export interface BodyStructure {
    type: string;
    subtype: string;
    params?: Record<string, string>;
    id?: string;
    description?: string;
    encoding?: string;
    size?: number;
    lines?: number;
    md5?: string;
    disposition?: {
        type: string;
        params?: Record<string, string>;
    };
    language?: string[];
    location?: string;
    parts?: BodyStructure[];
}

export interface Sender {
    id: string;
    email: string;
    name?: string;
    verified: boolean;
}

export interface FolderStatus {
    exists: number;
    recent: number;
    unseen: number;
    uidValidity: number;
    uidNext: number;
    highestModSeq: number;
    flags: string[];
    permanentFlags: string[];
}
