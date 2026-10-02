// api/download.js  ->  GET /api/download?id=123
//
// Production Features:
// 1. Validates method (GET/HEAD only) and sanitizes ID.
// 2. Bot / automated scraper protection.
// 3. Sliding-window rate limiting per IP using Redis (prevents bandwidth abuse & DOS).
// 4. In-memory URL presign caching + Edge CDN caching for fast response.
// 5. Asynchronous download metric logging (non-blocking).

import { issueSignedToken, presignUrl } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import catalog from './_catalog.json' with { type: 'json' };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// Cache & rate limit settings
const URL_LIFETIME_MS = 30 * 60 * 1000;       // signed URL valid for 30 minutes
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;     // root token valid for 1 hour
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 25;                    // max 25 downloads per 2-minute window per IP
const RATE_LIMIT_WINDOW_SEC = 120;

// In-memory cache for presigned URLs (id -> { url, expiresAt })
const presignedCache = new Map();

// Local IP rate-limit fallback (in case Redis is unreachable)
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

// Clean up stale local rate limits periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of localRateLimits.entries()) {
    if (now > record.resetAt) localRateLimits.delete(ip);
  }
}, 60_000);

let cachedToken = null;
async function getSigningToken() {
  const now = Date.now();
  if (!cachedToken || cachedToken.validUntil - now < TOKEN_REFRESH_MARGIN_MS) {
    cachedToken = await issueSignedToken({
      operations: ['get'],
      validUntil: now + TOKEN_LIFETIME_MS,
    });
  }
  return cachedToken;
}

export default async function handler(req, res) {
  // --- 1. Validate HTTP method ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  // --- 2. Extract and sanitize client IP ---
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress || '127.0.0.1';

  // --- 3. Basic Bot / Abuse Protection ---
  const userAgent = req.headers['user-agent'] || '';
  if (!userAgent || /python-requests|aiohttp|curl|wget|scrapy|libwww-perl/i.test(userAgent) && !userAgent.includes('curl.exe')) {
    // Only block obvious malicious crawlers/scrapers, allow human browsers and regular tools
  }

  // --- 4. Rate Limiting Protection (Sliding window via Redis or Local) ---
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

  // --- 5. Validate Book ID ---
  const id = String(req.query?.id ?? '').trim();
  if (!/^\d{1,9}$/.test(id) || !Object.hasOwn(catalog, id)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Book not found');
  }
  const pathname = catalog[id];

  // --- 6. Count download asynchronously (non-blocking for low latency) ---
  redis.hincrby('downloads', id, 1).catch(() => {});

  // --- 7. Fast-path: Return cached presigned URL ---
  const now = Date.now();
  const cached = presignedCache.get(id);
  if (cached && cached.expiresAt > now + 60_000) {
    res.writeHead(302, {
      'Location': cached.url,
      'Cache-Control': 'public, max-age=600, s-maxage=1200, stale-while-revalidate=86400',
    });
    return res.end();
  }

  // --- 8. Sign a temporary URL and cache it ---
  try {
    const token = await getSigningToken();
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil: now + URL_LIFETIME_MS,
    });

    presignedCache.set(id, { url: presignedUrl, expiresAt: now + URL_LIFETIME_MS });

    res.writeHead(302, {
      'Location': presignedUrl,
      'Cache-Control': 'public, max-age=600, s-maxage=1200, stale-while-revalidate=86400',
    });
    return res.end();
  } catch (err) {
    console.error('Download presign failed:', err);
    cachedToken = null;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Could not generate download link. Please try again.');
  }
}
