/**
 * IMAP API Client
 * Extended TransmitClient with mailbox-specific methods
 */
import type {
    Logger,
    MailboxFolder,
    MailboxMessage,
    FolderStatus,
    Sender,
} from "../shared/types.js";
import { withRetry, withTimeout } from "../shared/retry.js";

export class ImapApiClient {
    private readonly apiBase: string;
    private readonly timeout: number;
    private readonly logger: Logger;
    private readonly apiKeyCache: Map<string, { value: AuthResult; expires: number }>;
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
        try {
            const res = await this.fetch(apiKey, `/api/mailbox/accounts`);
            if (!res.ok) return null;

            const data = await res.json() as { accounts: Sender[] };
            return data.accounts?.find((s) => s.email.toLowerCase() === email.toLowerCase()) || null;
        } catch {
            return null;
        }
    }

    /**
     * List all senders (mailbox accounts)
     */
    async listSenders(apiKey: string): Promise<Sender[]> {
        try {
            const res = await this.fetch(apiKey, `/api/mailbox/accounts`);
            if (!res.ok) return [];

            const data = await res.json() as { accounts: Sender[] };
            return data.accounts || [];
        } catch {
            return [];
        }
    }

    /**
     * List folders for a sender
     */
    async listFolders(apiKey: string, senderId: string): Promise<MailboxFolder[]> {
        try {
            const res = await this.fetch(apiKey, `/api/mailbox/${senderId}/folders`);
            if (!res.ok) return [];

            const data = await res.json() as { folders: MailboxFolder[] };
            return data.folders || [];
        } catch {
            return [];
        }
    }

    /**
     * Get folder status (for SELECT/STATUS)
     */
    async getFolderStatus(apiKey: string, senderId: string, folderName: string): Promise<FolderStatus | null> {
        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/folders/${encodeURIComponent(folderName)}/status`
            );
            if (!res.ok) return null;

            return await res.json() as FolderStatus;
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
            return data.messages || [];
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
        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/messages/${uid}?folder=${encodeURIComponent(folderName)}`
            );
            if (!res.ok) return null;

            const data = await res.json() as { message: MailboxMessage };
            return data.message || null;
        } catch {
            return null;
        }
    }

    /**
     * Get message body
     */
    async getMessageBody(
        apiKey: string,
        senderId: string,
        uid: number,
        folderName: string,
        peek: boolean = false
    ): Promise<{ text?: string; html?: string; headers?: Record<string, string> } | null> {
        try {
            const res = await this.fetch(
                apiKey,
                `/api/mailbox/${senderId}/messages/${uid}/body?folder=${encodeURIComponent(folderName)}&peek=${peek}`
            );
            if (!res.ok) return null;

            const data = await res.json() as { body: any };
            return data.body || null;
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
}

interface AuthResult {
    valid: boolean;
    workspaceId: string;
}
