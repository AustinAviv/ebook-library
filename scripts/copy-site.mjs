// Copies the published Blazor site (.publish/wwwroot) into ./public,
// which is the folder Vercel serves as static files.
import { cp, rm, mkdir } from 'node:fs/promises';

await rm('public', { recursive: true, force: true });
await mkdir('public', { recursive: true });
await cp('.publish/wwwroot', 'public', { recursive: true });
console.log('Copied .publish/wwwroot -> public/');
