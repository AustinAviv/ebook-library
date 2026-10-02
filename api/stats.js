import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  try {
    const raw = (await redis.hgetall('downloads')) ?? {};
    const counts = {};
    for (const [id, value] of Object.entries(raw)) counts[id] = Number(value) || 0;

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify(counts));
  } catch (err) {
    console.error('Stats failed:', err);
    res.statusCode = 500;
    res.end('{}');
  }
}
