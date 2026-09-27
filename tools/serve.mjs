#!/usr/bin/env node
/**
 * Zero-dependency static file server for the built page.
 *
 *   npm run serve                 # serves dist/ on http://127.0.0.1:8921/
 *   SERVE_DIR=. PORT=8921 node tools/serve.mjs
 *
 * ES-module imports need an http(s) origin (module fetches from `file://` are blocked by the
 * same-origin policy in every browser), so the page must be served, never opened from disk.
 * `.mjs` is served as `text/javascript` so the browser will evaluate it as a module.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(process.env.SERVE_DIR ?? path.join(ROOT, 'dist'));
const PORT = Number(process.env.PORT ?? 8921);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = path.join(DIR, safe);
  if (rel.endsWith('/')) file = path.join(DIR, safe, 'index.html');
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${DIR} at http://127.0.0.1:${PORT}/`);
});
