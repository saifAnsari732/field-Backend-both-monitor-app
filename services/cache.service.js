const Redis = require('ioredis');

// Initialize Redis connection
const redisClient = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL) 
  : null;

if (redisClient) {
  redisClient.on('connect', () => console.log('🟢 Redis Connected to Upstash'));
  redisClient.on('error', (err) => console.error('🔴 Redis Error:', err));
} else {
  console.warn('⚠️ REDIS_URL not provided. Caching will be disabled.');
}

/**
 * Get value from Redis cache
 * @param {string} key Cache key
 * @returns {Promise<any>} Parsed JSON value or null
 */
const getCache = async (key) => {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error(`Redis Get Error [${key}]:`, err);
    return null;
  }
};

/**
 * Set value in Redis cache
 * @param {string} key Cache key
 * @param {any} value Value to store (will be JSON stringified)
 * @param {number} ttl Time to live in seconds
 * @returns {Promise<void>}
 */
const setCache = async (key, value, ttl = 60) => {
  if (!redisClient) return;
  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
  } catch (err) {
    console.error(`Redis Set Error [${key}]:`, err);
  }
};

// Exporting legacy names as wrappers to minimize controller changes where possible, 
// though they MUST be awaited now.
const liveCache = {
  get: getCache,
  set: (key, val, ttl = 60) => setCache(key, val, ttl)
};

const geocodeCache = {
  get: getCache,
  set: (key, val, ttl = 86400) => setCache(key, val, ttl)
};

module.exports = {
  redisClient,
  liveCache,
  geocodeCache,
  getCache,
  setCache
};
