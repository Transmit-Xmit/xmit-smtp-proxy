/**
 * SQLite-based Persistent Cache
 * For large, immutable data like message bodies
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface SqliteCacheOptions {
    /** Path to the cache database file */
    dbPath?: string;
    /** Default TTL in milliseconds (default: 24 hours) */
    defaultTtl?: number;
    /** Maximum cache size in bytes (default: 500MB) */
    maxSize?: number;
}

export class SqliteCache {
    private db: Database.Database;
    private readonly defaultTtl: number;
    private readonly maxSize: number;

    constructor(options: SqliteCacheOptions = {}) {
        const dbPath = options.dbPath ?? path.join(process.cwd(), ".cache", "imap-cache.db");
        this.defaultTtl = options.defaultTtl ?? 24 * 60 * 60 * 1000; // 24 hours
        this.maxSize = options.maxSize ?? 500 * 1024 * 1024; // 500MB

        // Ensure cache directory exists
        const cacheDir = path.dirname(dbPath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        // Open database with WAL mode for better concurrency
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");

        // Create tables
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cache (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                size INTEGER NOT NULL,
                expires INTEGER NOT NULL,
                created INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_expires ON cache(expires);
            CREATE INDEX IF NOT EXISTS idx_created ON cache(created);
        `);

        // Prepare statements
        this.stmtGet = this.db.prepare("SELECT value, expires FROM cache WHERE key = ?");
        this.stmtSet = this.db.prepare(`
            INSERT OR REPLACE INTO cache (key, value, size, expires, created)
            VALUES (?, ?, ?, ?, ?)
        `);
        this.stmtDelete = this.db.prepare("DELETE FROM cache WHERE key = ?");
        this.stmtDeleteExpired = this.db.prepare("DELETE FROM cache WHERE expires < ?");
        this.stmtDeletePattern = this.db.prepare("DELETE FROM cache WHERE key LIKE ?");
        this.stmtGetSize = this.db.prepare("SELECT SUM(size) as total FROM cache");
        this.stmtGetOldest = this.db.prepare("SELECT key FROM cache ORDER BY created ASC LIMIT ?");
        this.stmtGetStats = this.db.prepare("SELECT COUNT(*) as count, SUM(size) as size FROM cache");
    }

    private stmtGet: Database.Statement;
    private stmtSet: Database.Statement;
    private stmtDelete: Database.Statement;
    private stmtDeleteExpired: Database.Statement;
    private stmtDeletePattern: Database.Statement;
    private stmtGetSize: Database.Statement;
    private stmtGetOldest: Database.Statement;
    private stmtGetStats: Database.Statement;

    /**
     * Get a value from cache
     */
    get(key: string): Buffer | null {
        const row = this.stmtGet.get(key) as { value: Buffer; expires: number } | undefined;
        if (!row) return null;

        // Check expiration
        if (row.expires < Date.now()) {
            this.stmtDelete.run(key);
            return null;
        }

        return row.value;
    }

    /**
     * Get a value as string
     */
    getString(key: string): string | null {
        const buffer = this.get(key);
        return buffer ? buffer.toString("utf-8") : null;
    }

    /**
     * Get a value as JSON
     */
    getJson<T>(key: string): T | null {
        const str = this.getString(key);
        if (!str) return null;
        try {
            return JSON.parse(str) as T;
        } catch {
            return null;
        }
    }

    /**
     * Set a value in cache
     */
    set(key: string, value: Buffer | string, ttl?: number): void {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
        const size = buffer.length;
        const expires = Date.now() + (ttl ?? this.defaultTtl);
        const created = Date.now();

        // Check if we need to evict
        this.ensureSpace(size);

        this.stmtSet.run(key, buffer, size, expires, created);
    }

    /**
     * Set a JSON value
     */
    setJson(key: string, value: unknown, ttl?: number): void {
        this.set(key, JSON.stringify(value), ttl);
    }

    /**
     * Check if key exists
     */
    has(key: string): boolean {
        return this.get(key) !== null;
    }

    /**
     * Delete a key
     */
    delete(key: string): boolean {
        const result = this.stmtDelete.run(key);
        return result.changes > 0;
    }

    /**
     * Delete keys matching a pattern (SQL LIKE pattern)
     */
    deletePattern(pattern: string): number {
        const result = this.stmtDeletePattern.run(pattern);
        return result.changes;
    }

    /**
     * Prune expired entries
     */
    prune(): number {
        const result = this.stmtDeleteExpired.run(Date.now());
        return result.changes;
    }

    /**
     * Get cache stats
     */
    stats(): { entries: number; size: number; maxSize: number } {
        const row = this.stmtGetStats.get() as { count: number; size: number | null };
        return {
            entries: row.count,
            size: row.size ?? 0,
            maxSize: this.maxSize,
        };
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.db.exec("DELETE FROM cache");
    }

    /**
     * Close the database
     */
    close(): void {
        this.db.close();
    }

    /**
     * Ensure there's space for new data, evicting old entries if needed
     */
    private ensureSpace(neededSize: number): void {
        const sizeRow = this.stmtGetSize.get() as { total: number | null };
        let currentSize = sizeRow.total ?? 0;

        // First, prune expired entries
        if (currentSize + neededSize > this.maxSize) {
            this.prune();
            const afterPrune = this.stmtGetSize.get() as { total: number | null };
            currentSize = afterPrune.total ?? 0;
        }

        // If still over limit, evict oldest entries
        while (currentSize + neededSize > this.maxSize) {
            const oldest = this.stmtGetOldest.all(100) as Array<{ key: string }>;
            if (oldest.length === 0) break;

            for (const row of oldest) {
                this.stmtDelete.run(row.key);
            }

            const afterEvict = this.stmtGetSize.get() as { total: number | null };
            currentSize = afterEvict.total ?? 0;
        }
    }
}
