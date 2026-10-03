import { Redis } from '@upstash/redis';
import catalog from './_catalog.json' with { type: 'json' };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const RATE_LIMIT_MAX = 25;
const RATE_LIMIT_WINDOW_SEC = 120;
const PUBLIC_BLOB_BASE = 'https://awewxdgwtlwxy5wf.public.blob.vercel-storage.com';
const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://tiwpirzwtpxdpdfqrzoe.supabase.co';
const SUPABASE_ANON_KEY = process.env.PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_fNzWE8j076OWPvyKR2Euow_TrqHBbxv';

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

function isValidSupabaseStorageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isSupabaseHost = host.endsWith('.supabase.co') || host === new URL(SUPABASE_URL).hostname.toLowerCase();
    return isSupabaseHost && parsed.pathname.includes('/storage/v1/object/public/book-submissions/');
  } catch {
    return false;
  }
}

function sanitizePdfFilename(raw) {
  const base = String(raw || 'book')
    .replace(/[^\w.\-\s]/g, '')
    .trim();
  const name = base.length > 0 ? base : 'book';
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

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
  if (!/^\d{1,9}$/.test(id)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Book not found');
  }

  const isInline = req.query?.view === '1' || req.query?.inline === '1';
  let targetUrl = '';

  // 1. Static Catalog Archive Books (IDs 1 to 60)
  if (Object.hasOwn(catalog, id)) {
    redis.hincrby('downloads', id, 1).catch(() => {});

    const entry = catalog[id];
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
  }
  // 2. Community Published Books: Fast-path if client provided validated Supabase storage URL
  else if (req.query?.url && isValidSupabaseStorageUrl(req.query.url)) {
    redis.hincrby('downloads', id, 1).catch(() => {});

    const safeFilename = sanitizePdfFilename(req.query?.title);
    const rawUrl = String(req.query.url);

    if (isInline) {
      targetUrl = rawUrl.replace(/[?&]download(=[^&]*)?/g, '');
    } else {
      const cleanUrl = rawUrl.replace(/[?&]download(=[^&]*)?/g, '');
      const separator = cleanUrl.includes('?') ? '&' : '?';
      targetUrl = `${cleanUrl}${separator}download=${encodeURIComponent(safeFilename)}`;
    }
  }
  // 3. Community Published Books: Dynamic lookup via Supabase REST API (when only ?id= is given)
  else {
    const numId = parseInt(id, 10);
    const submissionId = numId >= 100000 ? numId - 100000 : numId;

    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/book_submissions?id=eq.${submissionId}&select=id,title,public_url,file_path,status`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        }
      );

      if (resp.ok) {
        const rows = await resp.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].public_url) {
          const bookRecord = rows[0];
          redis.hincrby('downloads', id, 1).catch(() => {});

          const safeFilename = sanitizePdfFilename(bookRecord.title);
          const rawUrl = String(bookRecord.public_url);

          if (isInline) {
            targetUrl = rawUrl.replace(/[?&]download(=[^&]*)?/g, '');
          } else {
            const cleanUrl = rawUrl.replace(/[?&]download(=[^&]*)?/g, '');
            const separator = cleanUrl.includes('?') ? '&' : '?';
            targetUrl = `${cleanUrl}${separator}download=${encodeURIComponent(safeFilename)}`;
          }
        }
      }
    } catch (err) {
      console.error('[Download API] Error resolving submission:', err);
    }
  }

  if (!targetUrl) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Book not found');
  }

  res.writeHead(302, {
    'Location': targetUrl,
    'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
  });
  return res.end();
}
