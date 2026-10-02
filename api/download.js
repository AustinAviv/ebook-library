// api/download.js  ->  GET /api/download?id=123
//
// 1. validates the id against api/_catalog.json (id -> blob pathname)
// 2. increments the download counter in Upstash Redis
// 3. signs a 5-minute GET URL for that ONE pathname in the private Blob store
// 4. answers 302 -> the browser streams the PDF straight from Blob storage
//    (the PDF never passes through this function, so the 4.5 MB limit is irrelevant)

import { issueSignedToken, presignUrl } from '@vercel/blob';
import { Redis } from '@upstash/redis';
import catalog from './_catalog.json' with { type: 'json' };

// The Vercel Marketplace Upstash integration injects KV_REST_API_* variables;
// a manually created Upstash database uses UPSTASH_REDIS_REST_*. We accept both.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const URL_LIFETIME_MS = 5 * 60 * 1000; // each download link lives 5 minutes
const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // the signing token lives 1 hour
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

// issueSignedToken() makes a network call, so we cache the token in memory and
// reuse it between requests (the docs recommend this). It is a store-wide
// "get" token, but every URL we sign with it is bound to ONE pathname.
let cachedToken = null;
async function getSigningToken() {
  const now = Date.now();
  if (!cachedToken || cachedToken.validUntil - now < TOKEN_REFRESH_MARGIN_MS) {
    // Auth: on Vercel the SDK uses OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID),
    // otherwise it falls back to BLOB_READ_WRITE_TOKEN.
    cachedToken = await issueSignedToken({
      operations: ['get'],
      validUntil: now + TOKEN_LIFETIME_MS,
    });
  }
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // --- 1. validate the id ---
  const id = String(req.query?.id ?? '');
  if (!/^\d{1,9}$/.test(id) || !Object.hasOwn(catalog, id)) {
    res.statusCode = 404;
    return res.end('Book not found');
  }
  const pathname = catalog[id];

  // --- 2. count the download (never block the download if Redis is down) ---
  try {
    await redis.hincrby('downloads', id, 1);
  } catch (err) {
    console.error('Redis increment failed:', err);
  }

  // --- 3. sign a short-lived GET URL for this single pathname ---
  try {
    const token = await getSigningToken();
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil: Date.now() + URL_LIFETIME_MS,
    });

    // --- 4. redirect: the browser downloads directly from Blob ---
    res.statusCode = 302;
    res.setHeader('Location', presignedUrl);
    return res.end();
  } catch (err) {
    console.error('Signing failed:', err);
    cachedToken = null; // force a fresh token next time
    res.statusCode = 500;
    return res.end('Could not create the download link');
  }
}
