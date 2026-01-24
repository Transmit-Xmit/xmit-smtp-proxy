/**
 * LRU Cache with TTL support
 * Fast in-memory cache with automatic eviction
 */

interface CacheEntry<T> {
    value: T;
    expires: number;
    size: number;
}

export interface LruCacheOptions {
    /** Maximum number of entries */
    maxEntries?: number;
    /** Maximum memory in bytes (approximate) */
    maxMemory?: number;
    /** Default TTL in milliseconds */
    defaultTtl?: number;
}

export class LruCache<T = unknown> {
    private cache: Map<string, CacheEntry<T>>;
    private readonly maxEntries: number;
    private readonly maxMemory: number;
    private readonly defaultTtl: number;
    private currentMemory: number = 0;

    constructor(options: LruCacheOptions = {}) {
        this.cache = new Map();
        this.maxEntries = options.maxEntries ?? 10000;
        this.maxMemory = options.maxMemory ?? 100 * 1024 * 1024; // 100MB default
        this.defaultTtl = options.defaultTtl ?? 60000; // 1 minute default
    }

    /**
     * Get a value from cache
     */
    get(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        // Check if expired
        if (entry.expires < Date.now()) {
            this.delete(key);
            return undefined;
        }

        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);

        return entry.value;
    }

    /**
     * Set a value in cache
     */
    set(key: string, value: T, ttl?: number): void {
        // Remove existing entry if present
        if (this.cache.has(key)) {
            this.delete(key);
        }

        const size = this.estimateSize(value);
        const entry: CacheEntry<T> = {
            value,
            expires: Date.now() + (ttl ?? this.defaultTtl),
            size,
        };

        // Evict if needed
        while (
            (this.cache.size >= this.maxEntries || this.currentMemory + size > this.maxMemory) &&
            this.cache.size > 0
        ) {
            this.evictOldest();
        }

        this.cache.set(key, entry);
        this.currentMemory += size;
    }

    /**
     * Check if key exists and is not expired
     */
    has(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;
        if (entry.expires < Date.now()) {
            this.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Delete a key
     */
    delete(key: string): boolean {
        const entry = this.cache.get(key);
        if (entry) {
            this.currentMemory -= entry.size;
            return this.cache.delete(key);
        }
        return false;
    }

    /**
     * Delete all keys matching a pattern
     */
    deletePattern(pattern: string | RegExp): number {
        const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
        let deleted = 0;

        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.delete(key);
                deleted++;
            }
        }

        return deleted;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.cache.clear();
        this.currentMemory = 0;
    }

    /**
     * Get cache stats
     */
    stats(): { entries: number; memory: number; maxEntries: number; maxMemory: number } {
        return {
            entries: this.cache.size,
            memory: this.currentMemory,
            maxEntries: this.maxEntries,
            maxMemory: this.maxMemory,
        };
    }

    /**
     * Prune expired entries
     */
    prune(): number {
        const now = Date.now();
        let pruned = 0;

        for (const [key, entry] of this.cache) {
            if (entry.expires < now) {
                this.delete(key);
                pruned++;
            }
        }

        return pruned;
    }

    /**
     * Evict the oldest (least recently used) entry
     */
    private evictOldest(): void {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
            this.delete(firstKey);
        }
    }

    /**
     * Estimate memory size of a value
     */
    private estimateSize(value: T): number {
        if (value === null || value === undefined) return 8;
        if (typeof value === "string") return value.length * 2;
        if (typeof value === "number") return 8;
        if (typeof value === "boolean") return 4;
        if (Buffer.isBuffer(value)) return value.length;

        // For objects, stringify and measure (rough estimate)
        try {
            return JSON.stringify(value).length * 2;
        } catch {
            return 1024; // Default estimate for non-serializable objects
        }
    }
}

/**
 * Create a namespaced cache key
 */
export function cacheKey(...parts: (string | number)[]): string {
    return parts.join(":");
}
