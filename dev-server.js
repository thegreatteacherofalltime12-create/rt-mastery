#!/usr/bin/env node
/**
 * Minimal static server for local development.
 * Serves dist/ and stubs the /api/progress endpoint so the sync path can be
 * exercised without deploying the Worker.
 *   node dev-server.js  ->  http://localhost:5173
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const DIST = path.join(__dirname, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // stubbed API so local testing mirrors production shape
  if (url.pathname === '/api/progress' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        console.log(`  [api] ${d.name} (${d.classCode}) — ${d.mastered}/${d.totalQuestions} mastered`);
      } catch { /* ignore malformed body in dev */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dev: true }));
    });
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(DIST, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));

  if (!full.startsWith(DIST) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n  RT Mastery dev server → http://localhost:${PORT}\n`);
});
