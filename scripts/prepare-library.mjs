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

const titleFromFile = (file) =>
  path.basename(file, path.extname(file)).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const slugify = (text) =>
  text.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-') || 'book';

const files = (await readdir(folder, { recursive: true }))
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort((a, b) => a.localeCompare(b));
console.log(`Found ${files.length} PDF(s) in ${folder}`);

let existing = [];
if (existsSync(BOOKS_JSON)) existing = JSON.parse(await readFile(BOOKS_JSON, 'utf8'));
const byPath = new Map(existing.map((b) => [b.blobPathname, b]));
let nextId = existing.reduce((max, b) => Math.max(max, b.id), 0) + 1;

const used = new Set();
const jobs = files.map((file) => {
  let slug = slugify(titleFromFile(file));
  let candidate = slug, n = 2;
  while (used.has(candidate)) candidate = `${slug}-${n++}`;
  used.add(candidate);
  return { file, pathname: `books/${candidate}.pdf` };
});

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
        multipart: true,
      });
    }
    book = {
      id: book?.id ?? nextId++,
      title: book?.title ?? titleFromFile(file),
      author: book?.author ?? 'Unknown author',
      description: book?.description ?? 'No description yet.',
      category: book?.category ?? 'Uncategorized',
      year: book?.year ?? 0,
      language: book?.language ?? 'English',
      pages: book?.pages ?? 0,
      fileSize: size,
      blobPathname: pathname,
    };
    books.push(book);
    console.log(`[${++done}/${jobs.length}] ${pathname}`);
  }
}
const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

books.sort((a, b) => a.id - b.id);
await mkdir(path.dirname(BOOKS_JSON), { recursive: true });
await writeFile(BOOKS_JSON, JSON.stringify(books, null, 2));
await writeFile(CATALOG_JSON, JSON.stringify(Object.fromEntries(books.map((b) => [b.id, b.blobPathname])), null, 2));
console.log(`\nWrote ${books.length} books to ${BOOKS_JSON} and ${CATALOG_JSON}`);
console.log('Next: edit author/category/description in books.json, then rebuild + redeploy.');
