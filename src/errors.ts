/**
 * Custom error classes for SMTP proxy
 *
 * Provides structured errors with codes, status, and retryable classification
 */

export class SmtpProxyError extends Error {
    readonly code: string;
    readonly statusCode?: number;
    readonly smtpCode?: number;
    readonly retryable: boolean;
    readonly originalError?: unknown;

    constructor(
        message: string,
        code: string,
        options?: {
            statusCode?: number;
            smtpCode?: number;
            retryable?: boolean;
            originalError?: unknown;
        }
    ) {
        super(message);
        this.name = "SmtpProxyError";
        this.code = code;
        this.statusCode = options?.statusCode;
        this.smtpCode = options?.smtpCode;
        this.retryable = options?.retryable ?? false;
        this.originalError = options?.originalError;
    }
}

// Error codes
export const ErrorCodes = {
    // Authentication
    AUTH_INVALID_FORMAT: "AUTH_INVALID_FORMAT",
    AUTH_INVALID_KEY: "AUTH_INVALID_KEY",
    AUTH_FAILED: "AUTH_FAILED",

    // Validation
    MISSING_FROM: "MISSING_FROM",
    MISSING_TO: "MISSING_TO",
    INVALID_EMAIL: "INVALID_EMAIL",
    MESSAGE_TOO_LARGE: "MESSAGE_TOO_LARGE",

    // API errors
    API_ERROR: "API_ERROR",
    API_TIMEOUT: "API_TIMEOUT",
    API_RATE_LIMITED: "API_RATE_LIMITED",
    API_UNAVAILABLE: "API_UNAVAILABLE",

    // Network errors
    NETWORK_ERROR: "NETWORK_ERROR",
    CONNECTION_RESET: "CONNECTION_RESET",

    // Parse errors
    PARSE_ERROR: "PARSE_ERROR",

    // Internal
    INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof SmtpProxyError) {
        return error.retryable;
    }

    // Check for network errors
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return (
            msg.includes("timeout") ||
            msg.includes("econnreset") ||
            msg.includes("econnrefused") ||
            msg.includes("socket hang up") ||
            msg.includes("network") ||
            msg.includes("503") ||
            msg.includes("502") ||
            msg.includes("429")
        );
    }

    return false;
}

/**
 * Parse API error response into structured error
 */
export function parseApiError(statusCode: number, body: string): SmtpProxyError {
    let message = `API request failed with status ${statusCode}`;
    let code: ErrorCode = ErrorCodes.API_ERROR;
    let retryable = false;

    // Try to parse JSON error
    try {
        const json = JSON.parse(body);
        if (json.error) message = json.error;
        if (json.message) message = json.message;
    } catch {
        if (body && body.length < 500) {
            message = body;
        }
    }

    // Determine if retryable based on status code
    if (statusCode === 429) {
        code = ErrorCodes.API_RATE_LIMITED;
        retryable = true;
    } else if (statusCode >= 500) {
        code = ErrorCodes.API_UNAVAILABLE;
        retryable = true;
    }

    return new SmtpProxyError(message, code, { statusCode, retryable });
}

/**
 * Map error to SMTP response code
 */
export function toSmtpCode(error: SmtpProxyError): number {
    const code = error.code;

    // Permanent failures (5xx)
    if (
        code === ErrorCodes.AUTH_INVALID_FORMAT ||
        code === ErrorCodes.AUTH_INVALID_KEY ||
        code === ErrorCodes.AUTH_FAILED
    ) {
        return 535; // Authentication failed
    }

    if (
        code === ErrorCodes.MISSING_FROM ||
        code === ErrorCodes.MISSING_TO ||
        code === ErrorCodes.INVALID_EMAIL
    ) {
        return 550; // Mailbox unavailable
    }

    if (code === ErrorCodes.MESSAGE_TOO_LARGE) {
        return 552; // Message too large
    }

    // Temporary failures (4xx)
    if (code === ErrorCodes.API_RATE_LIMITED) {
        return 451; // Requested action aborted
    }

    if (
        code === ErrorCodes.API_TIMEOUT ||
        code === ErrorCodes.API_UNAVAILABLE ||
        code === ErrorCodes.NETWORK_ERROR ||
        code === ErrorCodes.CONNECTION_RESET
    ) {
        return 421; // Service not available
    }

    // Internal errors (PARSE_ERROR, INTERNAL_ERROR, etc.)
    return 451; // Local error in processing
}
