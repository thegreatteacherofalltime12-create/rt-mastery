/**
 * Message Project Manager: the dashboard's line to Matt's Admin Hub.
 *
 * The hub here is a fake that answers the two calls the real one does. Any
 * other fetch fails the suite, because this feature promises it never reads or
 * writes Firestore and never leaves the Worker for anywhere but the hub.
 *
 *   node test/hub.mjs
 */

import { testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const HUB = 'https://matt-hub.prior-mixed-theme.workers.dev';
const PIN = '1234';
const KEY = 'test-hub-key-0123456789abcdef0123456789';   // a fixture, not a real key

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' — ' + detail : '')); };

// ---------------------------------------------------------------- the fake hub

const hub = { calls: [], strays: [], next: null, thread: [] };

const real = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const opt = o || {};
  if (!url.startsWith(HUB + '/')) {
    hub.strays.push(url);
    throw new Error('unexpected fetch outside the hub: ' + url);
  }
  const headers = new Headers(opt.headers || {});
  const call = { url, method: opt.method || 'GET', auth: headers.get('Authorization'),
                 body: opt.body ? JSON.parse(opt.body) : null };
  hub.calls.push(call);

  // one canned failure, used once, for the error-passing checks
  if (hub.next) { const r = hub.next; hub.next = null; return r(); }

  if (call.auth !== 'Bearer ' + KEY) return reply({ error: 'Unknown project key.' }, 401);
  const path = url.slice(HUB.length).split('?')[0];
  if (path === '/api/app/message' && call.method === 'POST') {
    const id = 'm' + (hub.thread.length + 1);
    hub.thread.push({ id, direction: 'in', body: call.body.body, created: 1000 + hub.thread.length });
    return reply({ ok: true, id });
  }
  if (path === '/api/app/thread' && call.method === 'GET') {
    // newest first on purpose: the Worker is the one promising oldest-first
    return reply({ messages: hub.thread.slice().reverse() });
  }
  return reply({ error: 'not found' }, 404);
};

function reply(j, status = 200) {
  return new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
}

const worker = (await import('../worker/index.js')).default;
const env = testEnv({ HUB_KEY: KEY });

async function call(path, body, useEnv) {
  const res = await worker.fetch(new Request(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), useEnv || env);
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Only the instructor gets through, and a refusal never reaches the hub.
// ---------------------------------------------------------------------------
hub.calls.length = 0;
const wrongSend = await call('/api/hub/send', { pin: '9999', body: 'hello' });
check('a send with the wrong PIN is refused', wrongSend.status === 401, 'got ' + wrongSend.status);
const noPinSend = await call('/api/hub/send', { body: 'hello' });
check('a send with no PIN is refused', noPinSend.status === 401, 'got ' + noPinSend.status);
const wrongThread = await call('/api/hub/thread', { pin: '9999' });
check('a thread read with the wrong PIN is refused', wrongThread.status === 401, 'got ' + wrongThread.status);
const unset = await call('/api/hub/send', { pin: '', body: 'hello' }, testEnv({ HUB_KEY: KEY, INSTRUCTOR_PIN: '' }));
check('an unset INSTRUCTOR_PIN lets nobody in, not everybody', unset.status === 401, 'got ' + unset.status);
check('a refused request never reaches the hub', hub.calls.length === 0, hub.calls.length + ' call(s)');

// ---------------------------------------------------------------------------
// A send forwards exactly the contract the hub reads.
// ---------------------------------------------------------------------------
hub.calls.length = 0;
const sent = await call('/api/hub/send', { pin: PIN, body: '  The exam 2 timer looks short.  ' });
check('an instructor send succeeds', sent.status === 200 && sent.j.ok === true, JSON.stringify(sent.j));
check('the send returns the hub\'s id', sent.j.id === 'm1', 'got ' + sent.j.id);
const c = hub.calls[0] || {};
check('one call to the hub', hub.calls.length === 1, hub.calls.length + ' call(s)');
check('it is a POST to /api/app/message', c.method === 'POST' && c.url === HUB + '/api/app/message', c.method + ' ' + c.url);
check('it carries the Bearer key', c.auth === 'Bearer ' + KEY, 'got ' + c.auth);
check('the body is exactly senderId, senderName, body, link',
      JSON.stringify(Object.keys(c.body || {}).sort()) === '["body","link","senderId","senderName"]',
      JSON.stringify(c.body));
check('senderId is the stable instructor id', c.body && c.body.senderId === 'instructor', c.body && c.body.senderId);
check('senderId stays inside the hub\'s alphabet',
      c.body && /^[A-Za-z0-9._@+-]{1,120}$/.test(c.body.senderId));
check('senderName is her name', c.body && c.body.senderName === 'Jess', c.body && c.body.senderName);
check('the message is trimmed', c.body && c.body.body === 'The exam 2 timer looks short.', JSON.stringify(c.body && c.body.body));
check('the link is the live dashboard',
      c.body && c.body.link === 'https://rt-mastery.prior-mixed-theme.workers.dev/dashboard.html', c.body && c.body.link);
check('the PIN is not forwarded to the hub', !JSON.stringify(c.body).includes(PIN));

// ---------------------------------------------------------------------------
// Empty and too-long messages stop at the Worker.
// ---------------------------------------------------------------------------
hub.calls.length = 0;
const empty = await call('/api/hub/send', { pin: PIN, body: '   \n  ' });
check('a blank message is refused', empty.status === 400, 'got ' + empty.status);
const missing = await call('/api/hub/send', { pin: PIN });
check('a send with no body is refused', missing.status === 400, 'got ' + missing.status);
const long = await call('/api/hub/send', { pin: PIN, body: 'x'.repeat(4001) });
check('a message over 4000 characters is refused', long.status === 400, 'got ' + long.status);
check('the refusal says why in plain English', /4000/.test(long.j.error || ''), long.j.error);
check('rejected messages never reach the hub', hub.calls.length === 0, hub.calls.length + ' call(s)');
const edge = await call('/api/hub/send', { pin: PIN, body: 'y'.repeat(4000) });
check('exactly 4000 characters is allowed', edge.status === 200, 'got ' + edge.status);

// ---------------------------------------------------------------------------
// The thread comes back oldest first, Matt's replies included.
// ---------------------------------------------------------------------------
hub.thread.push({ id: 'r1', direction: 'out', body: 'On it - fixed tonight.', created: 5000 });
hub.calls.length = 0;
const th = await call('/api/hub/thread', { pin: PIN });
check('a thread read succeeds', th.status === 200 && Array.isArray(th.j.messages), JSON.stringify(th.j));
const tc = hub.calls[0] || {};
check('it is a GET to /api/app/thread for the instructor',
      tc.method === 'GET' && tc.url === HUB + '/api/app/thread?senderId=instructor', tc.method + ' ' + tc.url);
check('the thread read carries the Bearer key', tc.auth === 'Bearer ' + KEY, 'got ' + tc.auth);
const ids = (th.j.messages || []).map((m) => m.id).join(',');
check('the thread is oldest first', ids === 'm1,m2,r1', ids);
const last = (th.j.messages || [])[2] || {};
check('Matt\'s reply is marked out', last.direction === 'out' && last.body === 'On it - fixed tonight.', JSON.stringify(last));
check('each message has only id, direction, body, created',
      (th.j.messages || []).every((m) => JSON.stringify(Object.keys(m).sort()) === '["body","created","direction","id"]'));

// ---------------------------------------------------------------------------
// No HUB_KEY: a clear 503, never a crash and never a call.
// ---------------------------------------------------------------------------
hub.calls.length = 0;
const bare = testEnv();
const ns = await call('/api/hub/send', { pin: PIN, body: 'hello' }, bare);
check('a send with no HUB_KEY is a 503', ns.status === 503, 'got ' + ns.status);
check('the 503 says it is not connected yet', ns.j.error === 'not connected yet', ns.j.error);
const nt = await call('/api/hub/thread', { pin: PIN }, bare);
check('a thread read with no HUB_KEY is a 503', nt.status === 503, 'got ' + nt.status);
check('no HUB_KEY means no call to the hub', hub.calls.length === 0, hub.calls.length + ' call(s)');
const nw = await call('/api/hub/send', { pin: '9999', body: 'hello' }, bare);
check('the PIN is still checked before the key', nw.status === 401, 'got ' + nw.status);

// ---------------------------------------------------------------------------
// The hub's own refusals reach her in words, not status codes.
// ---------------------------------------------------------------------------
hub.next = () => reply({ error: 'Too many messages this hour. Try again later.' }, 429);
const busy = await call('/api/hub/send', { pin: PIN, body: 'again' });
check('a hub 429 passes through', busy.status === 429 && /Too many messages/.test(busy.j.error || ''), JSON.stringify(busy.j));

const badKey = await call('/api/hub/send', { pin: PIN, body: 'hello' }, testEnv({ HUB_KEY: 'not-the-right-key-000000000000000000' }));
check('a key the hub rejects is explained, not echoed as a 401',
      badKey.status === 502 && /HUB_KEY/.test(badKey.j.error || ''), JSON.stringify(badKey));

hub.next = () => new Response('<html>oops</html>', { status: 500 });
const broke = await call('/api/hub/thread', { pin: PIN });
check('a hub 500 becomes a plain 502', broke.status === 502 && /problem/.test(broke.j.error || ''), JSON.stringify(broke.j));

hub.next = () => { throw new TypeError('network down'); };
const down = await call('/api/hub/send', { pin: PIN, body: 'hello' });
check('an unreachable hub is a plain 502', down.status === 502 && /reach/.test(down.j.error || ''), JSON.stringify(down.j));

check('nothing but the hub was ever fetched (no Firestore)', hub.strays.length === 0, hub.strays.join(', '));

globalThis.fetch = real;

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' message hub checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' message hub checks hold');
