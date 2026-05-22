import { createServer } from 'node:http';
import { readFile }     from 'node:fs/promises';
import { extname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serve from the emmix root (one level up from web/)
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ts':   'application/javascript; charset=utf-8',
};

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  // Prevent path traversal
  const file = resolve(ROOT, '.' + pathname.replace(/^\/+/, '/'));
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // / → web/index.html
  const target = pathname === '/' ? join(ROOT, 'web', 'index.html') : file;

  let data;
  try {
    data = await readFile(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${pathname}`);
    return;
  }

  const ct = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': ct,
    'Cache-Control': 'no-store',
  });
  res.end(data);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\x1b[92m✓\x1b[0m Emmix dev server → \x1b[94mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  Serving from: ${ROOT}`);
  console.log(`  Ctrl+C to stop`);
});
