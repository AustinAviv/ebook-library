// api/download.js  ->  GET /api/download?id=123
//
// 1. validates the id against api/_catalog.json (id -> blob pathname)
// 2. increments the download counter in Upstash Redis (non-blocking)
// 3. signs a GET URL for that pathname in the private Blob store (cached)
// 4. answers 302 -> the browser streams the PDF straight from Blob storage

import { issueSignedToken, presignUrl } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import catalog from './_catalog.json' with { type: 'json' };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const URL_LIFETIME_MS = 15 * 60 * 1000;       // each download link lives 15 minutes
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;     // the signing token lives 1 hour
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

// In-memory cache for presigned URLs (id -> { url, expiresAt })
const presignedCache = new Map();

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
  // --- 1. validate the id ---
  const id = String(req.query?.id ?? '');
  if (!/^\d{1,9}$/.test(id) || !Object.hasOwn(catalog, id)) {
    res.statusCode = 404;
    return res.end('Book not found');
  }
  const pathname = catalog[id];

  // --- 2. count the download asynchronously (non-blocking for the user) ---
  redis.hincrby('downloads', id, 1).catch(err => {
    console.error('Redis increment failed:', err);
  });

  // --- 3. check memory cache for an active signed URL ---
  const now = Date.now();
  const cached = presignedCache.get(id);
  if (cached && cached.expiresAt > now + 60_000) {
    res.writeHead(302, {
      'Location': cached.url,
      'Cache-Control': 'private, max-age=300',
    });
    return res.end();
  }

  // --- 4. sign a short-lived GET URL for this single pathname ---
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
      'Cache-Control': 'private, max-age=300',
    });
    return res.end();
  } catch (err) {
    console.error('Signing failed:', err);
    cachedToken = null; // force a fresh token next time
    res.statusCode = 500;
    return res.end('Could not create the download link');
  }
}
