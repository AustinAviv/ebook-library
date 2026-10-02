// scripts/prepare-library.mjs
//
// Usage:  npm run prepare-library            (scans ./pdfs)
//         node --env-file=.env.local scripts/prepare-library.mjs "D:/my/pdfs" [--force]
//
// For every PDF in the folder it:
//   1. uploads it to your PRIVATE Vercel Blob store (path: books/<slug>.pdf)
//   2. adds an entry to src/WikiLibrary/wwwroot/data/books.json
//      (title from the filename, size from the file, placeholder author/category)
//   3. writes api/_catalog.json (id -> blob pathname) used by api/download.js
//
// Re-running is safe: books already in books.json keep their id and any metadata
// you edited by hand, and their PDFs are not uploaded again (use --force to re-upload).
// Needs BLOB_READ_WRITE_TOKEN (run `vercel env pull .env.local` first).

import { put } from '@vercel/blob';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const folder = process.argv[2] ?? './pdfs';
const force = process.argv.includes('--force');
const BOOKS_JSON = 'src/WikiLibrary/wwwroot/data/books.json';
const CATALOG_JSON = 'api/_catalog.json';
const CONCURRENCY = 4;

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN is missing. Run: vercel env pull .env.local');
  process.exit(1);
}

// "the_great-gatsby.PDF" -> "the great gatsby" (title) / "the-great-gatsby" (slug)
const titleFromFile = (file) =>
  path.basename(file, path.extname(file)).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const slugify = (text) =>
  text.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-') || 'book';

// 1. find the PDFs (including sub-folders)
const files = (await readdir(folder, { recursive: true }))
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort((a, b) => a.localeCompare(b));
console.log(`Found ${files.length} PDF(s) in ${folder}`);

// 2. load the existing books.json so ids and hand-edited metadata survive
let existing = [];
if (existsSync(BOOKS_JSON)) existing = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
const byPath = new Map(existing.map((b) => [b.blobPathname, b]));
let nextId = existing.reduce((max, b) => Math.max(max, b.id), 0) + 1;

// 3. give every file a unique blob pathname (adds -2, -3 ... on name clashes)
const used = new Set();
const jobs = files.map((file) => {
  let slug = slugify(titleFromFile(file));
  let candidate = slug, n = 2;
  while (used.has(candidate)) candidate = `${slug}-${n++}`;
  used.add(candidate);
  return { file, pathname: `books/${candidate}.pdf` };
});

// 4. upload (a few at a time) and build the book list
const books = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const { file, pathname } = queue.shift();
    const fullPath = path.join(folder, file);
    const { size } = await stat(fullPath);
    let book = byPath.get(pathname);

    if (!book || force) {
      await put(pathname, createReadStream(fullPath), {
        access: 'private',
        contentType: 'application/pdf',
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: true, // handles big files
      });
    }
    book = {
      id: book?.id ?? nextId++,
      title: book?.title ?? titleFromFile(file),
      author: book?.author ?? 'Unknown author',      // <- edit by hand
      description: book?.description ?? 'No description yet.',
      category: book?.category ?? 'Uncategorized',     // <- edit by hand
      year: book?.year ?? 0,
      language: book?.language ?? 'English',
      pages: book?.pages ?? 0,
      fileSize: size,
      blobPathname: pathname,                          // pathname only, never a URL
    };
    books.push(book);
    console.log(`[${++done}/${jobs.length}] ${pathname}`);
  }
}
const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// 5. write books.json and the server-side catalog
books.sort((a, b) => a.id - b.id);
await mkdir(path.dirname(BOOKS_JSON), { recursive: true });
await writeFile(BOOKS_JSON, JSON.stringify(books, null, 2));
await writeFile(CATALOG_JSON, JSON.stringify(Object.fromEntries(books.map((b) => [b.id, b.blobPathname])), null, 2));
console.log(`\nWrote ${books.length} books to ${BOOKS_JSON} and ${CATALOG_JSON}`);
console.log('Next: edit author/category/description in books.json, then rebuild + redeploy.');
