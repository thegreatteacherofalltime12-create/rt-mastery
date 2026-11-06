/**
 * Attaching documents to a message.
 *
 * The finals material arrived as four Word documents that had to reach Matt by
 * a route outside this app, because the message tab took pictures and nothing
 * else. Now it takes files: each one goes up on its own as raw bytes, the hub
 * answers with an id, and the message carries the ids.
 *
 * Two things here are worth more than the happy path. A document link is a
 * bearer token - whoever holds it can read the file - so a link that is not the
 * hub's own must never reach the page. And the bytes must never be turned into
 * a string to be measured, because a 20 MB file would not survive it.
 *
 *   node test/files.mjs
 */

const BASE = 'https://rt.test';
const HUB = 'https://matt-hub.prior-mixed-theme.workers.dev';
const KEY = 'test-hub-key';

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' - ' + detail : '')); };

const hub = { calls: [], strays: [], next: null, thread: [], seq: 0 };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const real = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const opt = o || {};
  if (!url.startsWith(HUB + '/')) { hub.strays.push(url); throw new Error('unexpected fetch: ' + url); }
  const headers = new Headers(opt.headers || {});
  // A file body is bytes, not JSON. Record the length rather than parsing it.
  const isBytes = opt.body instanceof ArrayBuffer || ArrayBuffer.isView(opt.body);
  const call = {
    url, method: opt.method || 'GET', auth: headers.get('Authorization'),
    type: headers.get('Content-Type'),
    bytes: isBytes ? (opt.body.byteLength === undefined ? opt.body.length : opt.body.byteLength) : null,
    body: !isBytes && opt.body ? JSON.parse(opt.body) : null
  };
  hub.calls.push(call);
  if (hub.next) { const r = hub.next; hub.next = null; return r(); }
  if (call.auth !== 'Bearer ' + KEY) return reply({ error: 'Unknown project key.' }, 401);

  const path = url.slice(HUB.length).split('?')[0];
  const query = new URL(url).searchParams;

  if (path === '/api/app/file' && call.method === 'POST') {
    const name = query.get('name') || '';
    if (!/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|md|json|zip|jpe?g|png|webp|gif|heic)$/i.test(name)) {
      // the hub writes its refusals for the reader, and they are passed through
      return reply({ error: 'That kind of file cannot be sent. Try a PDF or a Word document.' }, 400);
    }
    const id = ('f' + (++hub.seq)).padEnd(12, '0');
    return reply({ id, name, size: call.bytes });
  }
  if (path === '/api/app/message' && call.method === 'POST') {
    const id = 'm' + (hub.thread.length + 1);
    const files = (call.body.files || []).map((fid, i) => ({
      name: 'notes-' + i + '.docx', size: 1234, sizeText: '1.2 KB', url: HUB + '/file/' + fid
    }));
    hub.thread.push({ id, direction: 'in', body: call.body.body, created: 1000 + hub.thread.length, files });
    return reply({ ok: true, id });
  }
  if (path === '/api/app/thread' && call.method === 'GET') {
    return reply({ messages: hub.thread.slice().reverse() });
  }
  return reply({ error: 'not found' }, 404);
};

const { testEnv } = await import('./fake-firestore.mjs');
const env = Object.assign(testEnv(), { HUB_KEY: KEY });
const worker = (await import('../worker/index.js')).default;

const putFile = (name, bytes, e) => worker.fetch(new Request(
  BASE + '/api/hub/file?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes
  }), e || env);

const post = (path, body, e) => worker.fetch(new Request(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), e || env);

const jsonOf = async (r) => { try { return await r.json(); } catch { return {}; } };

// ---------------------------------------------------------------- uploading
const doc = new Uint8Array(2048).fill(7);

let res = await putFile('Ch 6&7 lecture notes.docx', doc);
let body = await jsonOf(res);
check('a document uploads and comes back with an id', res.status === 200 && /^[A-Za-z0-9]{8,64}$/.test(body.id || ''), JSON.stringify(body));
check('the name survives the round trip, spaces and ampersand included',
  body.name === 'Ch 6&7 lecture notes.docx', body.name);
check('its size is reported', body.size === 2048, String(body.size));

const up = hub.calls[hub.calls.length - 1];
check('the hub was sent raw bytes, not JSON', up.bytes === 2048 && up.body === null, JSON.stringify({ bytes: up.bytes }));
check('the name travelled in the query string, encoded',
  up.url.includes('name=Ch%206%267%20lecture%20notes.docx'), up.url);
check('the browser never sees the hub key, the Worker adds it', up.auth === 'Bearer ' + KEY);

check('a file with no name is refused before any upload', (await putFile('', doc)).status === 400);
check('an empty file is refused', (await putFile('empty.docx', new Uint8Array(0))).status === 400);

// The ceiling is checked on Content-Length first, because the whole point is
// not to pull 20 MB into memory to find out it is too big.
const big = await worker.fetch(new Request(BASE + '/api/hub/file?name=huge.zip', {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(21 * 1024 * 1024) },
  body: new Uint8Array(16)
}), env);
check('a file declared over 20 MB is refused on its header alone', big.status === 413, 'got ' + big.status);

const oversize = await putFile('huge.zip', new Uint8Array(20 * 1024 * 1024 + 1));
check('and one that lies about its size is refused once measured', oversize.status === 413, 'got ' + oversize.status);

const refused = await putFile('macro.exe', doc);
check("the hub's own refusal text is passed through, not replaced",
  refused.status === 400 && /PDF or a Word document/.test((await jsonOf(refused)).error || ''),
  JSON.stringify(await jsonOf(refused)));

const noKey = await putFile('notes.docx', doc, Object.assign(testEnv(), { HUB_KEY: '' }));
check('with no hub key it says so rather than failing oddly', noKey.status === 503, 'got ' + noKey.status);

// ---------------------------------------------------------------- sending
const idA = (await jsonOf(await putFile('a.docx', doc))).id;
const idB = (await jsonOf(await putFile('b.pdf', doc))).id;

res = await post('/api/hub/send', { body: 'Here are the notes', files: [idA, idB] });
check('a message carries the file ids', res.status === 200, 'got ' + res.status);
const sent = hub.calls[hub.calls.length - 1];
check('and the hub receives them as a files list', JSON.stringify(sent.body.files) === JSON.stringify([idA, idB]),
  JSON.stringify(sent.body.files));

res = await post('/api/hub/send', { files: [idA] });
check('a file on its own is a whole message, no words needed', res.status === 200, 'got ' + res.status);
check('an empty message with no files and no pictures is still refused',
  (await post('/api/hub/send', { body: '   ' })).status === 400);

check('eleven files are refused',
  (await post('/api/hub/send', { body: 'x', files: Array.from({ length: 11 }, () => idA) })).status === 400);
check('ten are allowed',
  (await post('/api/hub/send', { body: 'x', files: Array.from({ length: 10 }, () => idA) })).status === 200);

// Ids are the only thing the send route takes: anything shaped like a path or
// a URL is a client that has gone wrong, and is refused rather than forwarded.
for (const bad of ['../../etc/passwd', 'https://example.com/file/x', 'id with spaces', '', 'short!!']) {
  check('a bad file id is refused: ' + JSON.stringify(bad),
    (await post('/api/hub/send', { body: 'x', files: [bad] })).status === 400);
}
check('a files value that is not a list is refused',
  (await post('/api/hub/send', { body: 'x', files: 'nope' })).status === 400);

// ---------------------------------------------------------------- the thread
res = await post('/api/hub/thread', {});
body = await jsonOf(res);
const withFiles = (body.messages || []).filter((m) => (m.files || []).length);
check('the thread shows the files she sent', withFiles.length > 0, JSON.stringify(body.messages || []).slice(0, 200));
const f = withFiles[0].files[0];
check('each file comes back with a name', typeof f.name === 'string' && f.name.length > 0);
check('and a readable size', typeof f.sizeText === 'string');
check('and a hub link', /^https:\/\/matt-hub\.prior-mixed-theme\.workers\.dev\/file\//.test(f.url), f.url);

// The part that matters: a link that is not the hub's own never reaches her.
hub.thread.push({
  id: 'evil', direction: 'out', body: 'click me', created: 9000,
  files: [
    { name: 'invoice.pdf', size: 10, sizeText: '10 B', url: 'https://example.com/file/abc' },
    { name: 'ok.pdf', size: 10, sizeText: '10 B', url: HUB + '/file/realone' },
    { name: 'js.pdf', size: 10, sizeText: '10 B', url: 'javascript:alert(1)' },
    { name: 'lookalike.pdf', size: 10, sizeText: '10 B', url: 'https://matt-hub.prior-mixed-theme.workers.dev.evil.com/file/x' }
  ]
});
body = await jsonOf(await post('/api/hub/thread', {}));
const evil = (body.messages || []).filter((m) => m.id === 'evil')[0];
check('only the hub\'s own file links survive', evil && evil.files.length === 1, JSON.stringify(evil && evil.files));
check('and the one that survives is the real one', evil && evil.files[0].url === HUB + '/file/realone');

check('nothing but the hub was ever fetched', hub.strays.length === 0, hub.strays.join(', '));

globalThis.fetch = real;

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' file checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' file attachment checks hold');
