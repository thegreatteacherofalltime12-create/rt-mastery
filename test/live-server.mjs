/**
 * Serves dist/ AND routes /api/* through the REAL Worker against the fake
 * Firestore. So a browser pointed here drives production Worker code - the same
 * dispatch, the same masked writes, the same cache - without touching the live
 * project or spending a Firestore operation.
 *
 * This is how a full mock round gets played before a deploy.
 *
 *   node test/live-server.mjs      ->  http://localhost:5174
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFirestore, testEnv } from './fake-firestore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = process.env.PORT || 5174;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const fs = makeFirestore();
const env = testEnv();
fs.install();                                   // left installed: the Worker needs it
const worker = (await import('../worker/index.js')).default;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;

    const wres = await worker.fetch(new Request('https://rt.test' + req.url, {
      method: req.method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body
    }), env);

    const text = await wres.text();
    res.writeHead(wres.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
    console.log(`  ${req.method} ${url.pathname} -> ${wres.status}`);
    return;
  }

  // /room and /dashboard without .html, the way Cloudflare serves them
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!extname(p)) p += '.html';
  const file = join(DIST, p);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, () => {
  console.log(`real Worker + fake Firestore on http://localhost:${PORT}`);
  console.log(`  projector  http://localhost:${PORT}/room    (any class code, PIN 1234)`);
  console.log(`  student    http://localhost:${PORT}/`);
});
