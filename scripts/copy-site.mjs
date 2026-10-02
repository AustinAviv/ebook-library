// Copies the published Blazor site (.publish/wwwroot) into ./public,
// which is the folder Vercel serves as static files.
// Also patches the importmap in index.html with the real fingerprinted filenames.
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';

await rm('public', { recursive: true, force: true });
await mkdir('public', { recursive: true });
await cp('.publish/wwwroot', 'public', { recursive: true });
console.log('Copied .publish/wwwroot -> public/');

// Patch importmap: find fingerprinted dotnet.runtime.*.js and dotnet.native.*.js
const frameworkFiles = await readdir('public/_framework');
const runtime = frameworkFiles.find(f => /^dotnet\.runtime\..+\.js$/.test(f));
const native  = frameworkFiles.find(f => /^dotnet\.native\..+\.js$/.test(f));

if (runtime && native) {
  const importmap = JSON.stringify({
    imports: {
      './dotnet.js': './_framework/dotnet.js',
      './dotnet.runtime.js': `./_framework/${runtime}`,
      './dotnet.native.js': `./_framework/${native}`,
    }
  });
  let html = await readFile('public/index.html', 'utf8');
  // Replace empty importmap and fix fingerprint placeholder in script src
  html = html
    .replace(/<script type="importmap"><\/script>/, `<script type="importmap">${importmap}</script>`)
    .replace(/_framework\/blazor\.webassembly#\[\.{fingerprint}\]\.js/, '_framework/blazor.webassembly.js');
  await writeFile('public/index.html', html, 'utf8');
  console.log(`Patched importmap: runtime=${runtime}, native=${native}`);
} else {
  console.warn('Warning: Could not find fingerprinted dotnet runtime/native JS files in _framework/');
}
