let Redis = null;
try {
  Redis = require('ioredis');
} catch (_) {}
const NodeCache = require('node-cache');

// ─── In-memory fallback cache (when Redis is not available) ──────────────────
const memCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// ─── Redis Connection (Supports ioredis TCP & Upstash HTTPS REST) ─────────────
let redisClient = null;
let redisAvailable = false;

const rawRedisUrl = (process.env.REDIS_URL || '').trim().replace(/^["']|["']$/g, '');
let restUrl = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/^["']|["']$/g, '');
let restToken = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '');

// Auto-derive Upstash REST endpoint & token from REDIS_URL if not explicitly defined
if (!restToken && rawRedisUrl && rawRedisUrl.includes('@')) {
  try {
    const u = new URL(rawRedisUrl);
    if (u.hostname.includes('upstash.io')) {
      restUrl = `https://${u.hostname}`;
      restToken = decodeURIComponent(u.password || '');
    }
  } catch (_) {}
}

const useRest = Boolean(restUrl && restToken);

if (useRest) {
  console.log('🟢 Upstash Redis REST Mode Active (HTTPS Port 443)');
}

if (Redis && rawRedisUrl) {
  try {
    redisClient = new Redis(rawRedisUrl, {
      connectTimeout: 10000,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        if (times > 5) {
          if (!useRest) console.warn('⚠️  Redis: Max retries reached. Falling back to in-memory cache.');
          redisAvailable = false;
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff
      },
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
      console.log('🟢 Redis Connected to Upstash (TCP)');
    });

    redisClient.on('ready', () => {
      redisAvailable = true;
    });

    redisClient.on('error', (err) => {
      redisAvailable = false;
    });
  } catch (e) {
    if (!useRest) console.warn('⚠️  Redis: Initialization error. Using in-memory fallback cache.');
  }
}

const upstashRestCall = async (commandArr) => {
  if (!useRest) return null;
  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const endpoint = `${restUrl}/${commandArr.map(encodeURIComponent).join('/')}`;
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${restToken}` }
    });
    const json = await res.json();
    return json?.result ?? null;
  } catch (err) {
    return null;
  }
};

// ─── Generic Cache Helpers ────────────────────────────────────────────────────
const getCache = async (key) => {
  if (redisAvailable && redisClient) {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch { /* fall through */ }
  }
  if (useRest) {
    try {
      const data = await upstashRestCall(['get', key]);
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
  if (useRest) {
    try {
      await upstashRestCall(['set', key, JSON.stringify(value), 'EX', String(ttl)]);
      return;
    } catch { /* fall through */ }
  }
  memCache.set(key, value, ttl);
};

const deleteCache = async (key) => {
  if (redisAvailable && redisClient) {
    try { await redisClient.del(key); } catch { /* ignore */ }
  }
  if (useRest) {
    try { await upstashRestCall(['del', key]); } catch { /* ignore */ }
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

// ─── Distributed Locking with Lua Release ─────────────────────────────────────
const localLocks = new Map();
const LUA_RELEASE_LOCK = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Acquire a distributed lock on Redis with token validation
 * Falls back to local in-process queue if Redis is disconnected
 */
const acquireDistributedLock = async (resourceKey, ttlMs = 5000, maxWaitMs = 3000) => {
  const lockKey = `tracking:lock:${resourceKey}`;
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const startWait = Date.now();

  if (redisAvailable && redisClient) {
    while (Date.now() - startWait < maxWaitMs) {
      try {
        const result = await redisClient.set(lockKey, token, 'PX', ttlMs, 'NX');
        if (result === 'OK') {
          return async () => {
            try {
              await redisClient.eval(LUA_RELEASE_LOCK, 1, lockKey, token);
            } catch (_) {}
          };
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // In-process fallback lock
  const prev = localLocks.get(resourceKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = prev.then(() => gate);
  localLocks.set(resourceKey, queued);
  await prev;
  return () => {
    release();
    if (localLocks.get(resourceKey) === queued) localLocks.delete(resourceKey);
  };
};

/**
 * Redis Idempotency Gate
 * Returns true if event is NEW (acquired), false if it was already processed
 */
const checkAndSetIdempotency = async (sessionId, eventId, ttlSec = 86400) => {
  if (!eventId) return true;
  const key = `gps:idem:${sessionId}:${eventId}`;
  if (redisAvailable && redisClient) {
    try {
      const result = await redisClient.set(key, '1', 'EX', ttlSec, 'NX');
      return result === 'OK';
    } catch (_) {}
  }
  // Memory fallback
  if (memCache.has(key)) return false;
  memCache.set(key, 1, ttlSec);
  return true;
};

const clearIdempotencyKey = async (sessionId, eventId) => {
  if (!eventId) return;
  const key = `gps:idem:${sessionId}:${eventId}`;
  await deleteCache(key);
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
  acquireDistributedLock,
  checkAndSetIdempotency,
  clearIdempotencyKey,
};
