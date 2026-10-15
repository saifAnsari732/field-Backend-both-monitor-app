require('dotenv').config();
const Redis = require('ioredis');

async function testRedis() {
  const url = process.env.REDIS_URL.trim().replace(/^["']|["']$/g, '');
  const redis = new Redis(url);

  await new Promise((resolve, reject) => {
    redis.on('ready', resolve);
    redis.on('error', reject);
  });

  const allKeys = await redis.keys('*');
  console.log('Total keys in Redis:', allKeys.length);
  console.log('Sample keys:', allKeys.slice(0, 30));

  redis.disconnect();
}

testRedis().catch(console.error);
