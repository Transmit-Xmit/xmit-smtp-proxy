/**
 * IMAP API Client
 * Extended TransmitClient with mailbox-specific methods and caching
 */
import type {
    Logger,
    MailboxFolder,
    MailboxMessage,
    FolderStatus,
    Sender,
} from "../shared/types.js";
import { withRetry, withTimeout } from "../shared/retry.js";
import { CacheManager, CacheTtl, cacheKey } from "../cache/index.js";

export class ImapApiClient {
    private readonly apiBase: string;
    private readonly timeout: number;
    private readonly logger: Logger;
    private readonly apiKeyCache: Map<string, { value: AuthResult; expires: number }>;
    private readonly cacheTtl: number;
    private cache: CacheManager | null = null;

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
     * Set the cache manager (called after initialization)
     */
    setCache(cache: CacheManager): void {
        this.cache = cache;
    }

    /**
     * Validate API key and get workspace info
     */
    async validateApiKey(apiKey: string): Promise<AuthResult | null> {
        // Check cache
        const cached = this.apiKeyCache.get(apiKey);
        if (cached && cached.expires > Date.now()) {
            return cached.value;
        }

        try {
            const result = await withRetry(
                async () => {
                    const res = await withTimeout(
                        fetch(`${this.apiBase}/api/workspaces`, {
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                "User-Agent": "xmit-imap/1.0",
                            },
                        }),
                        this.timeout,
                        "API validation timed out"
                    );

                    if (!res.ok) {
                        return null;
                    }

                    const data = await res.json() as { workspaces: Array<{ id: string }> };
                    if (!data.workspaces?.[0]) {
                        return null;
                    }

                    return {
                        valid: true,
                        workspaceId: data.workspaces[0].id,
                    };
                },
                { maxRetries: 2, initialDelayMs: 200 }
            );

            if (result) {
                this.apiKeyCache.set(apiKey, {
                    value: result,
                    expires: Date.now() + this.cacheTtl,
                });
            }

            return result;
        } catch (error) {
            this.logger.error("imap-api", `Validation error: ${error}`);
            return null;
        }
    }

    /**
     * Get sender by email address
     */
    async getSenderByEmail(apiKey: string, email: string): Promise<Sender | null> {
        // Check cache
        const key = cacheKey("sender", email.toLowerCase());
        if (this.cache) {
            const cached = this.cache.memory.get(key) as Sender | undefined;
            if (cached) return cached;
        }

        try {
            const res = await this.fetch(apiKey, `/api/mailbox/accounts`);
            if (!res.ok) return null;

            const data = await res.json() as { accounts: Sender[] };
            const sender = data.accounts?.find((s) => s.email.toLowerCase() === email.toLowerCase()) || null;

            // Cache all senders
            if (this.cache && data.accounts) {
                for (const s of data.accounts) {
                    this.cache.memory.set(cacheKey("sender", s.email.toLowerCase()), s, CacheTtl.SENDER);
                }
            }

            return sender;
        } catch {
            return null;
        }
    }

    /**
     * List all senders (mailbox accounts)
     */
    async listSenders(apiKey: string): Promise<Sender[]> {
        // Check cache
        const key = cacheKey("senders", "all");
        if (this.cache) {
            const cached = this.cache.memory.get(key) as Sender[] | undefined;
            if (cached) return cached;
        }

        try {
            const res = await this.fetch(apiKey, `/api/mailbox/accounts`);
            if (!res.ok) return [];

            const data = await res.json() as { accounts: Sender[] };
            const senders = data.accounts || [];

            // Cache
            if (this.cache && senders.length > 0) {
                this.cache.memory.set(key, senders, CacheTtl.SENDER);
                for (const s of senders) {
                    this.cache.memory.set(cacheKey("sender", s.email.toLowerCase()), s, CacheTtl.SENDER);
                }
            }

            return senders;
        } catch {
            return [];
        }
    }

    /**
     * List folders for a sender
     */
    async listFolders(apiKey: string, senderId: string): Promise<MailboxFolder[]> {
        // Check cache
        const key = cacheKey("folders", senderId);
        if (this.cache) {
            const cached = this.cache.memory.get(key) as MailboxFolder[] | undefined;
            if (cached) return cached;
        }

        try {
            const res = await this.fetch(apiKey, `/api/mailbox/${senderId}/folders`);
            if (!res.ok) return [];

            const data = await res.json() as { folders: MailboxFolder[] };
            const folders = data.folders || [];

            // Cache
            if (this.cache && folders.length > 0) {
                this.cache.memory.set(key, folders, CacheTtl.FOLDERS);
            }

            return folders;
        } catch {
            return [];
        }
    }

    /**
     * Get folder status (for SELECT/STATUS)
     */
    async getFolderStatus(apiKey: string, senderId: string, folderName: string): Promise<FolderStatus | null> {
        // Check cache
        const key = cacheKey("status", senderId, folderName);
        if (this.cache) {
            const cached = this.cache.memory.get(key) as FolderStatus | undefined;
            if (cached) return cached;
        }

        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/folders/${encodeURIComponent(folderName)}/status`
            );
            if (!res.ok) return null;

            const status = await res.json() as FolderStatus;

            // Cache
            if (this.cache && status) {
                this.cache.memory.set(key, status, CacheTtl.FOLDER_STATUS);
            }

            return status;
        } catch {
            return null;
        }
    }

    /**
     * List messages in a folder
     */
    async listMessages(
        apiKey: string,
        senderId: string,
        folderName: string,
        options: { uids?: number[]; fields?: string[]; limit?: number; offset?: number } = {}
    ): Promise<MailboxMessage[]> {
        // Build cache key including query params for accurate caching
        const queryParts: string[] = [];
        if (options.uids?.length) queryParts.push(`u:${options.uids.sort().join(",")}`);
        if (options.fields?.length) queryParts.push(`f:${options.fields.sort().join(",")}`);
        if (options.limit) queryParts.push(`l:${options.limit}`);
        if (options.offset) queryParts.push(`o:${options.offset}`);

        const key = queryParts.length > 0
            ? cacheKey("messages", senderId, folderName, queryParts.join("|"))
            : cacheKey("messages", senderId, folderName);

        // Check cache
        if (this.cache) {
            const cached = this.cache.memory.get(key) as MailboxMessage[] | undefined;
            if (cached) return cached;
        }

        try {
            const params = new URLSearchParams();
            if (options.uids?.length) params.set("uids", options.uids.join(","));
            if (options.fields?.length) params.set("fields", options.fields.join(","));
            if (options.limit) params.set("limit", options.limit.toString());
            if (options.offset) params.set("offset", options.offset.toString());

            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/folders/${encodeURIComponent(folderName)}/messages?${params}`
            );
            if (!res.ok) return [];

            const data = await res.json() as { messages: MailboxMessage[] };
            const messages = data.messages || [];

            // Cache results
            if (this.cache && messages.length > 0) {
                this.cache.memory.set(key, messages, CacheTtl.MESSAGES);
            }

            return messages;
        } catch {
            return [];
        }
    }

    /**
     * Get single message
     */
    async getMessage(
        apiKey: string,
        senderId: string,
        uid: number,
        folderName: string
    ): Promise<MailboxMessage | null> {
        // Check cache
        const key = cacheKey("message", senderId, folderName, uid);
        if (this.cache) {
            const cached = this.cache.memory.get(key) as MailboxMessage | undefined;
            if (cached) return cached;
        }

        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/messages/${uid}?folder=${encodeURIComponent(folderName)}`
            );
            if (!res.ok) return null;

            const data = await res.json() as { message: MailboxMessage };
            const message = data.message || null;

            // Cache
            if (this.cache && message) {
                this.cache.memory.set(key, message, CacheTtl.MESSAGES);
            }

            return message;
        } catch {
            return null;
        }
    }

    /**
     * Get message body (uses persistent cache for large bodies)
     */
    async getMessageBody(
        apiKey: string,
        senderId: string,
        uid: number,
        folderName: string,
        peek: boolean = false
    ): Promise<{ text?: string; html?: string; headers?: Record<string, string> } | null> {
        // Check persistent cache first (message bodies are immutable)
        const key = cacheKey("body", senderId, folderName, uid);
        if (this.cache) {
            const cached = this.cache.persistent.getJson<{
                text?: string;
                html?: string;
                headers?: Record<string, string>;
            }>(key);
            if (cached) {
                this.logger.debug("imap-api", `Cache hit for body ${key}`);
                return cached;
            }
        }

        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/messages/${uid}/body?folder=${encodeURIComponent(folderName)}&peek=${peek}`
            );
            if (!res.ok) return null;

            const data = await res.json() as { body: any };
            const body = data.body || null;

            // Cache in persistent storage (bodies are immutable and can be large)
            if (this.cache && body) {
                this.cache.persistent.setJson(key, body, CacheTtl.MESSAGE_BODY);
                this.logger.debug("imap-api", `Cached body ${key}`);
            }

            return body;
        } catch {
            return null;
        }
    }

    /**
     * Update message flags
     */
    async updateFlags(
        apiKey: string,
        senderId: string,
        uid: number,
        folderName: string,
        changes: { add?: string[]; remove?: string[]; set?: string[] }
    ): Promise<string[] | null> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/messages/${uid}/flags?folder=${encodeURIComponent(folderName)}`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify(changes),
                }
            );

            if (!res.ok) return null;

            const data = await res.json() as { flags: string[] };

            // Invalidate message cache
            if (this.cache) {
                this.cache.memory.delete(cacheKey("message", senderId, folderName, uid));
                this.cache.memory.delete(cacheKey("messages", senderId, folderName));
            }

            return data.flags || [];
        } catch {
            return null;
        }
    }

    /**
     * Copy message to another folder
     */
    async copyMessage(
        apiKey: string,
        senderId: string,
        uid: number,
        sourceFolder: string,
        targetFolder: string
    ): Promise<number | null> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/messages/${uid}/copy?folder=${encodeURIComponent(sourceFolder)}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify({ targetFolder }),
                }
            );

            if (!res.ok) return null;

            const data = await res.json() as { newUid: number };

            // Invalidate target folder cache
            if (this.cache) {
                this.cache.invalidateFolder(senderId, targetFolder);
            }

            return data.newUid;
        } catch {
            return null;
        }
    }

    /**
     * Move message to another folder
     */
    async moveMessage(
        apiKey: string,
        senderId: string,
        uid: number,
        sourceFolder: string,
        targetFolder: string
    ): Promise<number | null> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/messages/${uid}/move?folder=${encodeURIComponent(sourceFolder)}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify({ targetFolder }),
                }
            );

            if (!res.ok) return null;

            const data = await res.json() as { newUid: number };

            // Invalidate both folder caches
            if (this.cache) {
                this.cache.invalidateFolder(senderId, sourceFolder);
                this.cache.invalidateFolder(senderId, targetFolder);
            }

            return data.newUid;
        } catch {
            return null;
        }
    }

    /**
     * Search messages
     */
    async searchMessages(
        apiKey: string,
        senderId: string,
        folderName: string,
        criteria: Array<{ type: string; value?: string | number }>
    ): Promise<number[]> {
        // Searches are not cached (too dynamic)
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/folders/${encodeURIComponent(folderName)}/search`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify({ criteria }),
                }
            );

            if (!res.ok) return [];

            const data = await res.json() as { uids: number[] };
            return data.uids || [];
        } catch {
            return [];
        }
    }

    /**
     * Trigger mailbox sync
     */
    async syncMailbox(apiKey: string, senderId: string): Promise<boolean> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/sync`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "User-Agent": "xmit-imap/1.0",
                    },
                }
            );

            // Invalidate all caches for this sender after sync
            if (res.ok && this.cache) {
                this.cache.invalidateSender(senderId);
            }

            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Helper: fetch with auth
     */
    private async fetch(apiKey: string, path: string): Promise<Response> {
        return withTimeout(
            fetch(`${this.apiBase}${path}`, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "User-Agent": "xmit-imap/1.0",
                },
            }),
            this.timeout,
            "API request timed out"
        );
    }

    /**
     * Append a message to a folder
     */
    async appendMessage(
        apiKey: string,
        senderId: string,
        folderName: string,
        message: string,
        flags?: string[],
        internalDate?: Date
    ): Promise<{ uid: number } | null> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/folders/${encodeURIComponent(folderName)}/append`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify({
                        message,
                        flags,
                        internalDate: internalDate?.toISOString(),
                    }),
                }
            );

            if (!res.ok) {
                this.logger.error("imap-api", `Append failed: ${res.status}`);
                return null;
            }

            const data = await res.json() as { uid: number };

            // Invalidate folder cache
            if (this.cache) {
                this.cache.invalidateFolder(senderId, folderName);
            }

            return data;
        } catch (error) {
            this.logger.error("imap-api", `Append error: ${error}`);
            return null;
        }
    }

    /**
     * Create a folder
     */
    async createFolder(
        apiKey: string,
        senderId: string,
        folderName: string
    ): Promise<boolean> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/folders`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "User-Agent": "xmit-imap/1.0",
                    },
                    body: JSON.stringify({ name: folderName }),
                }
            );

            // Invalidate folder list cache
            if (res.ok && this.cache) {
                this.cache.memory.delete(cacheKey("folders", senderId));
            }

            return res.ok;
        } catch (error) {
            this.logger.error("imap-api", `Create folder error: ${error}`);
            return false;
        }
    }

    /**
     * Delete a folder
     */
    async deleteFolder(
        apiKey: string,
        senderId: string,
        folderName: string
    ): Promise<boolean> {
        try {
            // First get folder ID by name (use cache if available)
            const folders = await this.listFolders(apiKey, senderId);
            const folder = folders.find(f => f.name === folderName);

            if (!folder) {
                return false;
            }

            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/folders/${folder.id}`,
                {
                    method: "DELETE",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "User-Agent": "xmit-imap/1.0",
                    },
                }
            );

            // Invalidate caches
            if (res.ok && this.cache) {
                this.cache.memory.delete(cacheKey("folders", senderId));
                this.cache.invalidateFolder(senderId, folderName);
            }

            return res.ok;
        } catch (error) {
            this.logger.error("imap-api", `Delete folder error: ${error}`);
            return false;
        }
    }

    /**
     * Delete/expunge a message
     */
    async deleteMessage(
        apiKey: string,
        senderId: string,
        uid: number,
        folderName: string,
        expunge: boolean = true
    ): Promise<boolean> {
        try {
            const res = await fetch(
                `${this.apiBase}/api/mailbox/${senderId}/messages/${uid}?folder=${encodeURIComponent(folderName)}&expunge=${expunge}`,
                {
                    method: "DELETE",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "User-Agent": "xmit-imap/1.0",
                    },
                }
            );

            // Invalidate caches
            if (res.ok && this.cache) {
                this.cache.invalidateMessage(senderId, folderName, uid);
                this.cache.memory.delete(cacheKey("messages", senderId, folderName));
                this.cache.memory.delete(cacheKey("status", senderId, folderName));
            }

            return res.ok;
        } catch (error) {
            this.logger.error("imap-api", `Delete error: ${error}`);
            return false;
        }
    }

    /**
     * Prune expired cache entries
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

        return pruned;
    }

    /**
     * Get cache stats
     */
    getCacheStats(): {
        apiKeys: number;
        memory?: { entries: number; memory: number };
        persistent?: { entries: number; size: number };
    } {
        const stats: any = { apiKeys: this.apiKeyCache.size };
        if (this.cache) {
            const s = this.cache.stats();
            stats.memory = { entries: s.memory.entries, memory: s.memory.memory };
            stats.persistent = { entries: s.persistent.entries, size: s.persistent.size };
        }
        return stats;
    }
}

interface AuthResult {
    valid: boolean;
    workspaceId: string;
}
