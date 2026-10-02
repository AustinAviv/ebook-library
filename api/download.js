import { Redis } from '@upstash/redis';
import catalog from './_catalog.json' with { type: 'json' };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_SEC = 120;
const PUBLIC_BLOB_BASE = 'https://awewxdgwtlwxy5wf.public.blob.vercel-storage.com';

const localRateLimits = new Map();

function isRateLimitedLocally(ip) {
  const now = Date.now();
  const record = localRateLimits.get(ip);
  if (!record || now > record.resetAt) {
    localRateLimits.set(ip, { count: 1, resetAt: now + (RATE_LIMIT_WINDOW_SEC * 1000) });
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of localRateLimits.entries()) {
    if (now > record.resetAt) localRateLimits.delete(ip);
  }
}, 60_000);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress || '127.0.0.1';

  const rateLimitKey = `ratelimit:dl:${clientIp}`;
  let rateLimited = false;

  try {
    const current = await redis.incr(rateLimitKey);
    if (current === 1) {
      await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SEC);
    }
    if (current > RATE_LIMIT_MAX) {
      rateLimited = true;
    }
  } catch {
    rateLimited = isRateLimitedLocally(clientIp);
  }

  if (rateLimited) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW_SEC));
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 429;
    return res.end(JSON.stringify({
      error: 'Too many download requests. Please wait a moment before downloading another book.',
      retryAfterSeconds: RATE_LIMIT_WINDOW_SEC,
    }));
  }

  const id = String(req.query?.id ?? '').trim();
  if (!/^\d{1,9}$/.test(id) || !Object.hasOwn(catalog, id)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Book not found');
  }

  redis.hincrby('downloads', id, 1).catch(() => {});

  const entry = catalog[id];
  const isInline = req.query?.view === '1' || req.query?.inline === '1';
  let targetUrl = '';

  if (typeof entry === 'string') {
    if (entry.startsWith('http://') || entry.startsWith('https://')) {
      targetUrl = entry;
      if (isInline) {
        targetUrl = targetUrl.replace(/[?&]download=1/, '');
      } else if (!targetUrl.includes('download=1')) {
        targetUrl += targetUrl.includes('?') ? '&download=1' : '?download=1';
      }
    } else {
      targetUrl = `${PUBLIC_BLOB_BASE}/${entry}${isInline ? '' : '?download=1'}`;
    }
  } else if (entry && typeof entry === 'object') {
    targetUrl = isInline
      ? (entry.url || entry.downloadUrl)
      : (entry.downloadUrl || entry.url);
  }

  if (!targetUrl) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Download URL unavailable.');
  }

  res.writeHead(302, {
    'Location': targetUrl,
    'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
  });
  return res.end();
}
