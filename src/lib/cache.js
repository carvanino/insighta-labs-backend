import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
const TTL_S = 5 * 60; // 5 minutes in seconds (Redis TTL is seconds)

// Lazy singleton — created once on first import
let client = null;

export function getRedisClient() {
  if (client) return client;

  if (!REDIS_URL) {
    throw new Error("REDIS_URL environment variable is not set");
  }

  client = new Redis(REDIS_URL, {
    // Reconnect with exponential backoff — don't crash on transient failures
    retryStrategy: (times) => Math.min(times * 100, 3000),
    // Don't throw on connection errors — surface them via error event
    lazyConnect: false,
    enableOfflineQueue: true,
  });

  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  client.on("connect", () => {
    console.log("[redis] connected");
  });

  return client;
}

class RedisCache {
  get #client() {
    return getRedisClient();
  }

  /**
   * Store a value with a TTL (seconds). Value is JSON-serialized.
   */
  async set(key, value, ttlSeconds = TTL_S) {
    try {
      await this.#client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      console.error("[cache] set error:", err.message);
    }
  }

  /**
   * Retrieve a value. Returns null on miss or error.
   */
  async get(key) {
    try {
      const raw = await this.#client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error("[cache] get error:", err.message);
      return null;
    }
  }

  /**
   * Delete a single key.
   */
  async del(key) {
    try {
      await this.#client.del(key);
    } catch (err) {
      console.error("[cache] del error:", err.message);
    }
  }

  /**
   * Invalidate all keys that start with the given prefix using SCAN.
   * Uses SCAN instead of KEYS to avoid blocking the Redis server on large keyspaces.
   */
  async invalidatePrefix(prefix) {
    try {
      const stream = this.#client.scanStream({ match: `${prefix}*`, count: 100 });
      const pipeline = this.#client.pipeline();
      let queued = 0;

      stream.on("data", (keys) => {
        for (const key of keys) {
          pipeline.del(key);
          queued++;
        }
      });

      await new Promise((resolve, reject) => {
        stream.on("end", async () => {
          if (queued > 0) {
            try { await pipeline.exec(); } catch (e) { /* best-effort */ }
          }
          resolve();
        });
        stream.on("error", reject);
      });
    } catch (err) {
      console.error("[cache] invalidatePrefix error:", err.message);
    }
  }
}

export const cache = new RedisCache();
