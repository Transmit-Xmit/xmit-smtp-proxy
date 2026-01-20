/**
 * Retry logic with exponential backoff and jitter
 *
 * Generic wrapper for async operations that may fail transiently
 */

import { isRetryableError } from "./errors.js";

export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial delay in milliseconds (default: 500) */
    initialDelayMs?: number;
    /** Maximum delay in milliseconds (default: 10000) */
    maxDelayMs?: number;
    /** Custom function to determine if error is retryable */
    isRetryable?: (error: unknown) => boolean;
    /** Called on each retry attempt */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Execute an async operation with retry logic
 *
 * Uses exponential backoff with jitter to prevent thundering herd
 */
export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = 3,
        initialDelayMs = 500,
        maxDelayMs = 10000,
        isRetryable = isRetryableError,
        onRetry,
    } = options;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            // Don't retry on last attempt or non-retryable errors
            if (attempt === maxRetries || !isRetryable(error)) {
                throw error;
            }

            // Calculate delay with exponential backoff + jitter
            const baseDelay = initialDelayMs * Math.pow(2, attempt);
            const jitter = Math.random() * 100;
            const delay = Math.min(baseDelay + jitter, maxDelayMs);

            // Notify caller of retry
            if (onRetry) {
                onRetry(error, attempt + 1, delay);
            }

            await sleep(delay);
        }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout wrapper for an async operation
 */
export async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    errorMessage = "Operation timed out"
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(errorMessage));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId!);
    }
}
