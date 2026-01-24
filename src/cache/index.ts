/**
 * Cache Module
 * Hybrid caching with in-memory LRU and SQLite persistence
 */

export { LruCache, cacheKey, type LruCacheOptions } from "./lru-cache.js";
export { SqliteCache, type SqliteCacheOptions } from "./sqlite-cache.js";

import { LruCache, cacheKey } from "./lru-cache.js";
import { SqliteCache } from "./sqlite-cache.js";
import type { Logger } from "../shared/types.js";

/**
 * Cache TTL constants (in milliseconds)
 *
 * Since we invalidate caches on all mutations (APPEND, EXPUNGE, STORE, etc.),
 * these TTLs only matter for external changes (mail arriving via inbound worker).
 * We can be aggressive here - the only staleness is from external sources.
 */
export const CacheTtl = {
    /** API key validation - 10 minutes */
    API_KEY: 10 * 60 * 1000,
    /** Folder list - 5 minutes (invalidated on CREATE/DELETE) */
    FOLDERS: 5 * 60 * 1000,
    /** Folder status - 2 minutes (invalidated on message changes) */
    FOLDER_STATUS: 2 * 60 * 1000,
    /** Message list/metadata - 2 minutes (invalidated on APPEND/EXPUNGE/STORE) */
    MESSAGES: 2 * 60 * 1000,
    /** Message body - 7 days (immutable, never changes) */
    MESSAGE_BODY: 7 * 24 * 60 * 60 * 1000,
    /** Sender info - 10 minutes (rarely changes) */
    SENDER: 10 * 60 * 1000,
} as const;

/**
 * Cache Manager
 * Coordinates in-memory and persistent caches
 */
export class CacheManager {
    /** Fast in-memory cache for hot data */
    readonly memory: LruCache;
    /** Persistent SQLite cache for message bodies */
    readonly persistent: SqliteCache;
    private readonly logger: Logger;
    private pruneInterval: NodeJS.Timeout | null = null;

    constructor(options: {
        logger: Logger;
        cacheDir?: string;
        maxMemoryMb?: number;
        maxPersistentMb?: number;
    }) {
        this.logger = options.logger;

        // In-memory LRU cache (default 50MB)
        this.memory = new LruCache({
            maxMemory: (options.maxMemoryMb ?? 50) * 1024 * 1024,
            maxEntries: 50000,
            defaultTtl: CacheTtl.MESSAGES,
        });

        // Persistent SQLite cache (default 500MB)
        this.persistent = new SqliteCache({
            dbPath: options.cacheDir
                ? `${options.cacheDir}/imap-cache.db`
                : undefined,
            maxSize: (options.maxPersistentMb ?? 500) * 1024 * 1024,
            defaultTtl: CacheTtl.MESSAGE_BODY,
        });

        // Start periodic pruning (every 5 minutes)
        this.pruneInterval = setInterval(() => this.prune(), 5 * 60 * 1000);

        this.logger.info("cache", "Cache manager initialized");
    }

    /**
     * Invalidate all caches for a sender
     */
    invalidateSender(senderId: string): void {
        // Memory cache patterns (use $ or : after senderId to prevent prefix collisions)
        // e.g., "abc" should not match "abcd"
        this.memory.deletePattern(`^folders:${senderId}$`);
        this.memory.deletePattern(`^status:${senderId}:`);
        this.memory.deletePattern(`^messages:${senderId}:`);
        this.memory.deletePattern(`^message:${senderId}:`);
        this.memory.deletePattern(`^sender:`);  // Clear all sender caches

        // Persistent cache patterns (SQL LIKE)
        this.persistent.deletePattern(`body:${senderId}:%`);

        this.logger.debug("cache", `Invalidated caches for sender ${senderId}`);
    }

    /**
     * Invalidate folder-specific caches
     */
    invalidateFolder(senderId: string, folderName: string): void {
        const folderKey = `${senderId}:${folderName}`;
        // Use $ to match exact key or : to match keys with more segments
        this.memory.deletePattern(`^status:${folderKey}$`);
        this.memory.deletePattern(`^messages:${folderKey}$`);
        this.memory.deletePattern(`^message:${folderKey}:`);
        this.persistent.deletePattern(`body:${folderKey}:%`);

        // Also invalidate the folder list
        this.memory.delete(cacheKey("folders", senderId));

        this.logger.debug("cache", `Invalidated folder cache: ${folderKey}`);
    }

    /**
     * Invalidate a specific message
     */
    invalidateMessage(senderId: string, folderName: string, uid: number): void {
        const msgKey = cacheKey(senderId, folderName, uid);
        // Delete the specific message and its body
        this.memory.delete(cacheKey("message", senderId, folderName, uid));
        this.persistent.delete(cacheKey("body", senderId, folderName, uid));

        // Invalidate message list and status for folder (counts may have changed)
        this.memory.delete(cacheKey("messages", senderId, folderName));
        this.memory.delete(cacheKey("status", senderId, folderName));
    }

    /**
     * Prune expired entries from both caches
     */
    prune(): { memory: number; persistent: number } {
        const memoryPruned = this.memory.prune();
        const persistentPruned = this.persistent.prune();

        if (memoryPruned > 0 || persistentPruned > 0) {
            this.logger.debug("cache", `Pruned ${memoryPruned} memory, ${persistentPruned} persistent entries`);
        }

        return { memory: memoryPruned, persistent: persistentPruned };
    }

    /**
     * Get cache statistics
     */
    stats(): {
        memory: { entries: number; memory: number; maxMemory: number };
        persistent: { entries: number; size: number; maxSize: number };
    } {
        return {
            memory: this.memory.stats(),
            persistent: this.persistent.stats(),
        };
    }

    /**
     * Shutdown - close database and clear intervals
     */
    close(): void {
        if (this.pruneInterval) {
            clearInterval(this.pruneInterval);
            this.pruneInterval = null;
        }
        this.persistent.close();
        this.logger.info("cache", "Cache manager closed");
    }
}
