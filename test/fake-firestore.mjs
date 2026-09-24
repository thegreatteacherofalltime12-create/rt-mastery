/**
 * A Firestore stand-in that speaks the REST dialect the Worker actually uses.
 *
 * It is written independently of worker/index.js on purpose: if both sides
 * shared a toFsValue/fieldPath implementation, a bug in that shared code would
 * cancel itself out and the test would pass on broken writes. The point of
 * this file is to be a second opinion about what a masked write means.
 */

import { generateKeyPairSync } from 'node:crypto';

// ---------------------------------------------------------------- value codec

export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = toFs(v[k]);
  return { mapValue: { fields } };
}

export function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) out[k] = fromFs(f[k]);
    return out;
  }
  return null;
}

/**
 * Split a Firestore field path into segments. A segment is backticked unless it
 * is a plain identifier, so `players.\`avery-diaz\`.cleared` is three segments,
 * not four. Getting this wrong is exactly the class of bug this file exists to
 * catch, so it is parsed rather than assumed.
 */
export function splitPath(path) {
  const out = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '`') {
      const end = path.indexOf('`', i + 1);
      if (end === -1) throw new Error('unterminated backtick in field path: ' + path);
      out.push(path.slice(i + 1, end));
      i = end + 1;
      if (path[i] === '.') i++;
    } else {
      const dot = path.indexOf('.', i);
      if (dot === -1) { out.push(path.slice(i)); break; }
      out.push(path.slice(i, dot));
      i = dot + 1;
    }
  }
  return out;
}

function getAt(obj, parts) {
  let node = obj;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return node;
}

function setAt(obj, parts, value) {
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (node[p] == null || typeof node[p] !== 'object' || Array.isArray(node[p])) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------- the fake

export function makeFirestore() {
  /** docPath -> plain JS object */
  const docs = new Map();
  /** every write the Worker issued, in order, for assertion */
  const writes = [];
  let reads = 0;

  function seed(path, obj) { docs.set(path, JSON.parse(JSON.stringify(obj))); }

  function applyCommit(name, fields, mask, transforms) {
    const cur = docs.get(name) || {};
    const incoming = fromFs({ mapValue: { fields: fields || {} } });

    if (mask) {
      // A masked write touches ONLY the named paths. This is the property the
      // whole seam depends on: a game handler writing gs.cleared must not
      // disturb a player's score written a hundred milliseconds earlier.
      for (const p of mask) {
        const parts = splitPath(p);
        const val = getAt(incoming, parts);
        setAt(cur, parts, val === undefined ? null : val);
      }
    } else {
      // no mask == whole-document replace
      docs.set(name, incoming);
      writes.push({ kind: 'replace', path: name, doc: incoming });
      return;
    }

    for (const t of transforms || []) {
      const parts = splitPath(t.fieldPath);
      if (t.increment) {
        const by = Number(t.increment.integerValue);
        if (!Number.isInteger(by)) throw new Error('non-integer increment on ' + t.fieldPath);
        const prev = getAt(cur, parts);
        setAt(cur, parts, (typeof prev === 'number' ? prev : 0) + by);
      } else {
        throw new Error('unsupported transform: ' + JSON.stringify(t));
      }
    }

    docs.set(name, cur);
    writes.push({ kind: 'commit', path: name, mask: mask.slice(), transforms: (transforms || []).map((t) => t.fieldPath) });
  }

  async function handle(url, opt) {
    const method = (opt && opt.method) || 'GET';

    // --- OAuth token exchange
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // --- documents:commit
    if (url.endsWith('/documents:commit')) {
      const body = JSON.parse(opt.body);
      for (const w of body.writes || []) {
        if (!w.update) throw new Error('unsupported write shape: ' + Object.keys(w).join(','));
        // a precondition the real service enforces, so the fake must too
        if (w.currentDocument && w.currentDocument.exists === true && !docs.has(w.update.name)) {
          return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), { status: 400 });
        }
        applyCommit(w.update.name,
                    w.update.fields,
                    w.updateMask && w.updateMask.fieldPaths,
                    w.updateTransforms);
      }
      return new Response(JSON.stringify({ writeResults: [{}] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const path = url.replace(/^https:\/\/firestore\.googleapis\.com\/v1\//, '').split('?')[0];
    const query = url.indexOf('?') > -1 ? url.slice(url.indexOf('?') + 1) : '';

    if (method === 'PATCH') {
      const body = JSON.parse(opt.body);
      // updateMask travels in the QUERY STRING on a PATCH, not in the body.
      // Ignoring it would silently turn every masked write back into a whole-
      // document replace - the exact bug these tests exist to catch.
      const masked = query.split('&')
        .filter((kv) => kv.indexOf('updateMask.fieldPaths=') === 0)
        .map((kv) => decodeURIComponent(kv.slice('updateMask.fieldPaths='.length)));
      applyCommit(path, body.fields, masked.length ? masked : null, null);
      // a real PATCH answers with the MERGED document, which is how the Worker
      // learns a granted total without paying for a read
      return new Response(JSON.stringify({
        name: path,
        fields: toFs(docs.get(path) || {}).mapValue.fields
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE') {
      docs.delete(path);
      writes.push({ kind: 'delete', path });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // --- LIST (a collection)
    if (method === 'GET' && !docs.has(path)) {
      const kids = [...docs.keys()].filter((k) => k.startsWith(path + '/'));
      if (kids.length) {
        reads += kids.length;
        return new Response(JSON.stringify({
          documents: kids.map((k) => ({ name: k, fields: toFs(docs.get(k)).mapValue.fields }))
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
    }

    // --- GET one document
    reads++;
    return new Response(JSON.stringify({ name: path, fields: toFs(docs.get(path)).mapValue.fields }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return {
    seed,
    get: (p) => docs.get(p),
    has: (p) => docs.has(p),
    writes,
    reads: () => reads,
    resetCounters() { writes.length = 0; reads = 0; },
    install() {
      const real = globalThis.fetch;
      globalThis.fetch = (u, o) => handle(String(u), o);
      return () => { globalThis.fetch = real; };
    }
  };
}

/**
 * The Worker signs a real RS256 JWT before it will talk to Firestore, so the
 * test needs a real key. Generating a throwaway one keeps the production path
 * under test instead of stubbing it out.
 */
export function testEnv(extra) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Object.assign({
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@test-project.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    INSTRUCTOR_PIN: '1234',
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) }
  }, extra || {});
}
