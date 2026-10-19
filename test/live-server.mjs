/**
 * Serves dist/ AND routes /api/* through the REAL Worker against the fake
 * Firestore (and a fake Admin Hub for the dashboard's message tab). So a browser pointed here drives production Worker code - the same
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
// A made-up key for the made-up hub below; the real one is a Worker secret.
const env = testEnv({ HUB_KEY: 'live-server-fake-hub-key-not-a-secret' });
fs.install();                                   // left installed: the Worker needs it

// Matt's Admin Hub, faked, so the Message Project Manager tab works offline.
// Every message gets one canned reply, so both sides of the thread show.
const HUB = 'https://matt-hub.prior-mixed-theme.workers.dev';
const hubThread = [];
// Pictures kept in memory like the hub's KV. The thread hands back the real
// hub's /img/ links (so the Worker's link filter is exercised for real), and
// this server rewrites them to /fake-hub/img/ on the way to the browser, so the
// page never fetches anything from the live hub.
const hubPics = new Map();
let hubPicSeq = 0;
const viaFirestore = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (!url.startsWith(HUB + '/')) return viaFirestore(u, o);
  const answer = (j, status = 200) =>
    new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith(HUB + '/api/app/message')) {
    const b = JSON.parse((o && o.body) || '{}');
    const now = Date.now();
    const images = (b.images || []).map((p) => {
      const id = ('fake' + (++hubPicSeq)).padEnd(32, '0');
      hubPics.set(id, { type: p.type, buf: Buffer.from(p.data, 'base64') });
      return HUB + '/img/' + id;
    });
    hubThread.push({ id: 'in' + now, direction: 'in', body: b.body, created: now, images });
    // The canned reply sends her first picture back, so Matt's side shows one too.
    hubThread.push({ id: 'out' + now, direction: 'out', created: now + 1, images: images.slice(0, 1),
                     body: 'Fake hub reply: this is the local test server, nothing left this computer.' });
    console.log(`  [hub] ${b.senderName} (${b.senderId}): ${String(b.body).slice(0, 60)}` +
                (images.length ? ` + ${images.length} picture(s), ` +
                  images.map((x) => hubPics.get(x.slice(-32)).buf.length).join('/') + ' bytes' : ''));
    return answer({ ok: true, id: 'in' + now });
  }
  if (url.startsWith(HUB + '/api/app/thread')) return answer({ messages: hubThread.slice().reverse() });
  return answer({ error: 'not found' }, 404);
};
const worker = (await import('../worker/index.js')).default;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;

    // Forward the browser's own headers. Replacing them hands the Worker a
    // request no real client ever sends, so anything it reads off a header - a
    // cookie, an Authorization bearer, a custom one - would look absent here and
    // pass a mock round it fails in production.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith(':') || k === 'connection' || k === 'host') continue;
      for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
    }
    if (body && !headers.has('content-type')) headers.set('Content-Type', 'application/json');

    const wres = await worker.fetch(new Request('https://rt.test' + req.url, {
      method: req.method,
      headers,
      body
    }), env);

    let text = await wres.text();
    if (url.pathname === '/api/hub/thread') text = text.split(HUB + '/img/').join('/fake-hub/img/');
    res.writeHead(wres.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
    console.log(`  ${req.method} ${url.pathname} -> ${wres.status}`);
    return;
  }

  if (url.pathname.startsWith('/fake-hub/img/')) {
    const pic = hubPics.get(url.pathname.slice('/fake-hub/img/'.length));
    if (!pic) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': pic.type, 'X-Content-Type-Options': 'nosniff' });
    res.end(pic.buf);
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
  console.log(`  dashboard  http://localhost:${PORT}/dashboard  (PIN 1234; the hub is faked)`);
});
