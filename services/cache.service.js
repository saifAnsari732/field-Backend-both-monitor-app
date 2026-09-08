const Redis = require('ioredis');
const NodeCache = require('node-cache');

// ─── In-memory fallback cache (when Redis is not available) ──────────────────
const memCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// ─── Redis Connection ──────────────────────────────────────────────────────────
let redisClient = null;
let redisAvailable = false;

if (process.env.REDIS_URL) {
  try {
    const isRediss = process.env.REDIS_URL.startsWith('rediss://');
    redisClient = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      family: 4, // Force IPv4 (Solves timeout/drop issues on some hostings)
      ...(isRediss && { tls: { rejectUnauthorized: false } }), // Prevent strict SSL rejection on MilesWeb
      retryStrategy: (times) => {
        if (times > 5) {
          console.warn('⚠️  Redis: Max retries reached. Falling back to in-memory cache.');
          redisAvailable = false;
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff
      },
      maxRetriesPerRequest: 2,
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
      console.log('🟢 Redis Connected to Upstash');
    });

    redisClient.on('error', (err) => {
      redisAvailable = false;
      // Swallow: fallback to in-memory
    });

    redisClient.connect().catch(() => {
      console.warn('⚠️  Redis: Initial connection failed. Using in-memory fallback cache.');
    });
  } catch (e) {
    console.warn('⚠️  Redis: Initialization error. Using in-memory fallback cache.');
  }
} else {
  console.warn('⚠️  REDIS_URL not set. Using in-memory fallback cache (not persistent across restarts).');
}

// ─── Generic Cache Helpers ────────────────────────────────────────────────────
const getCache = async (key) => {
  if (redisAvailable && redisClient) {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch { /* fall through */ }
  }
  const val = memCache.get(key);
  return val !== undefined ? val : null;
};

const setCache = async (key, value, ttl = 60) => {
  if (redisAvailable && redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
      return;
    } catch { /* fall through */ }
  }
  memCache.set(key, value, ttl);
};

const deleteCache = async (key) => {
  if (redisAvailable && redisClient) {
    try { await redisClient.del(key); } catch { /* ignore */ }
  }
  memCache.del(key);
};

// ─── Distance Tracking Helpers (Redis-native atomic increment) ────────────────
/**
 * Get current distance for a session from Redis / mem-cache.
 * Returns { totalDistance, lastLat, lastLng, lastTs }
 */
const getSessionState = async (sessionId) => {
  const key = `session:${sessionId}`;
  const raw = await getCache(key);
  return raw || null;
};

/**
 * Save session state (last coord + total distance) so distance can be calculated
 * incrementally without touching MongoDB on every GPS tick.
 *
 * TTL = 24 hours (covers a full shift day even if the server restarts)
 */
const saveSessionState = async (sessionId, state) => {
  const key = `session:${sessionId}`;
  await setCache(key, state, 60 * 60 * 24);
};

/**
 * Atomically increment the session's total distance by delta.
 * Returns the new total.
 */
const incrementSessionDistance = async (sessionId, deltaKm) => {
  const state = (await getSessionState(sessionId)) || { totalDistance: 0 };
  state.totalDistance = parseFloat((state.totalDistance + deltaKm).toFixed(3));
  await saveSessionState(sessionId, state);
  return state.totalDistance;
};

const clearSessionState = async (sessionId) => {
  await deleteCache(`session:${sessionId}`);
};

// ─── Exports ───────────────────────────────────────────────────────────────────
const liveCache = {
  get: getCache,
  set: (key, val, ttl = 60) => setCache(key, val, ttl),
};

const geocodeCache = {
  get: getCache,
  set: (key, val, ttl = 86400) => setCache(key, val, ttl),
};

module.exports = {
  redisClient,
  liveCache,
  geocodeCache,
  getCache,
  setCache,
  deleteCache,
  getSessionState,
  saveSessionState,
  incrementSessionDistance,
  clearSessionState,
};
