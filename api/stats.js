// api/stats.js  ->  GET /api/stats
// Returns every book's download count in one call: { "1": 42, "7": 3, ... }
// Books that were never downloaded are simply absent (the app treats them as 0).

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

    // Cache at the CDN for a minute so a busy site hits Redis rarely.
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
