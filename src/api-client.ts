/**
 * Transmit API client
 *
 * Handles API key validation and email forwarding with proper error handling
 */

import type { EmailPayload, SendEmailResponse, CacheEntry, Logger } from "./types.js";
import { SmtpProxyError, ErrorCodes, parseApiError } from "./errors.js";
import { withRetry, withTimeout } from "./retry.js";

/**
 * API client for Transmit
 */
export class TransmitClient {
    private readonly apiBase: string;
    private readonly timeout: number;
    private readonly logger: Logger;
    private readonly apiKeyCache: Map<string, CacheEntry<boolean>>;
    private readonly cacheTtl: number;

    constructor(options: {
        apiBase: string;
        timeout: number;
        cacheTtl: number;
        logger: Logger;
    }) {
        this.apiBase = options.apiBase;
        this.timeout = options.timeout;
        this.cacheTtl = options.cacheTtl;
        this.logger = options.logger;
        this.apiKeyCache = new Map();
    }

    /**
     * Validate API key against Transmit API
     * Results are cached for cacheTtl milliseconds
     */
    async validateApiKey(apiKey: string): Promise<boolean> {
        // Check cache first
        const cached = this.apiKeyCache.get(apiKey);
        if (cached && cached.expires > Date.now()) {
            this.logger.debug("api", `Cache hit for key ${this.maskKey(apiKey)}`);
            return cached.value;
        }

        this.logger.debug("api", `Validating key ${this.maskKey(apiKey)}`);

        try {
            const valid = await withRetry(
                async () => {
                    const res = await withTimeout(
                        fetch(`${this.apiBase}/api/workspaces`, {
                            method: "GET",
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                "User-Agent": "xmit-smtp/1.0",
                            },
                        }),
                        this.timeout,
                        "API key validation timed out"
                    );

                    // Drain response body
                    await res.text();

                    return res.ok;
                },
                {
                    maxRetries: 2,
                    initialDelayMs: 200,
                    onRetry: (error, attempt, delay) => {
                        this.logger.warn(
                            "api",
                            `Validation retry ${attempt}, waiting ${delay}ms: ${error}`
                        );
                    },
                }
            );

            // Cache result
            this.apiKeyCache.set(apiKey, {
                value: valid,
                expires: Date.now() + this.cacheTtl,
            });

            return valid;
        } catch (error) {
            this.logger.error("api", `Validation error: ${error}`);

            // Don't cache errors, but return false
            return false;
        }
    }

    /**
     * Send email through Transmit API
     */
    async sendEmail(apiKey: string, payload: EmailPayload): Promise<SendEmailResponse> {
        this.logger.info(
            "api",
            `Sending email from ${payload.from} to ${Array.isArray(payload.to) ? payload.to.join(", ") : payload.to}`
        );

        try {
            return await withRetry(
                async () => {
                    const res = await withTimeout(
                        fetch(`${this.apiBase}/email/send`, {
                            method: "POST",
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                "Content-Type": "application/json",
                                "User-Agent": "xmit-smtp/1.0",
                            },
                            body: JSON.stringify(payload),
                        }),
                        this.timeout,
                        "Email send request timed out"
                    );

                    const body = await res.text();

                    if (!res.ok) {
                        throw parseApiError(res.status, body);
                    }

                    const data = JSON.parse(body) as { success?: boolean; messageId?: string };
                    return {
                        success: true,
                        messageId: data.messageId,
                    };
                },
                {
                    maxRetries: 3,
                    initialDelayMs: 500,
                    onRetry: (error, attempt, delay) => {
                        this.logger.warn(
                            "api",
                            `Send retry ${attempt}, waiting ${delay}ms: ${error}`
                        );
                    },
                }
            );
        } catch (error) {
            if (error instanceof SmtpProxyError) {
                return { success: false, error: error.message };
            }

            this.logger.error("api", `Send failed: ${error}`);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to send email",
            };
        }
    }

    /**
     * Clear expired cache entries
     */
    pruneCache(): number {
        const now = Date.now();
        let pruned = 0;

        for (const [key, entry] of this.apiKeyCache) {
            if (entry.expires <= now) {
                this.apiKeyCache.delete(key);
                pruned++;
            }
        }

        if (pruned > 0) {
            this.logger.debug("api", `Pruned ${pruned} expired cache entries`);
        }

        return pruned;
    }

    /**
     * Mask API key for logging (show first 8 and last 4 chars)
     */
    private maskKey(apiKey: string): string {
        if (apiKey.length <= 16) {
            return "***";
        }
        return `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`;
    }
}
