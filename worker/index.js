/**
 * RT Mastery — Cloudflare Worker
 *
 * Serves the static game and provides two endpoints:
 *   POST /api/progress          student progress upsert (one batched write per round)
 *   GET  /api/class?code=&pin=  instructor roster view, gated by INSTRUCTOR_PIN
 *
 * Firestore is reached with a Google service account signed in-Worker (RS256
 * via Web Crypto), so no key material ever reaches the browser.
 *
 * Secrets (wrangler secret put <NAME>):
 *   FIREBASE_PROJECT_ID     e.g. dojomojo
 *   FIREBASE_CLIENT_EMAIL   ...@....iam.gserviceaccount.com
 *   FIREBASE_PRIVATE_KEY    full PEM including BEGIN/END lines
 *   INSTRUCTOR_PIN          anything you like; required to read the roster
 */

const FS = 'https://firestore.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

// cached access token (Workers may reuse an isolate across requests)
let tokenCache = { value: null, exp: 0 };

// ---------------------------------------------------------------- utilities

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp > now + 60) return tokenCache.value;

  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(new TextEncoder().encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  })));
  const unsigned = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = await res.json();
  tokenCache = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.value;
}

// ---- Firestore value encoding -------------------------------------------

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) out[k] = fromFsValue(f[k]);
    return out;
  }
  return null;
}

function docToObject(doc) {
  const out = {};
  const f = doc.fields || {};
  for (const k of Object.keys(f)) out[k] = fromFsValue(f[k]);
  return out;
}

// ---- identity ------------------------------------------------------------

function slug(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------- handlers

// The game is fully playable before Firestore is wired up, so say so plainly
// instead of throwing when the service-account secrets are missing.
function backendReady(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

const NOT_CONFIGURED = {
  error: 'backend not configured',
  detail: 'Firestore credentials are not set on this Worker. The game still works; progress is saved on each device only. See DEPLOY.md.'
};

async function handleProgress(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const name = String(body.name || '').trim().slice(0, 80);
  const classCode = slug(body.classCode);
  if (!name || !classCode) return json({ error: 'name and classCode are required' }, 400);

  const studentId = slug(name);
  if (!studentId) return json({ error: 'name must contain letters or numbers' }, 400);

  const doc = {
    name,
    classCode,
    xp: Number(body.xp) || 0,
    sessions: Number(body.sessions) || 0,
    bestStreak: Number(body.bestStreak) || 0,
    mastered: Number(body.mastered) || 0,
    totalQuestions: Number(body.totalQuestions) || 0,
    chapters: body.chapters && typeof body.chapters === 'object' ? body.chapters : {},
    weakTopics: Array.isArray(body.weakTopics) ? body.weakTopics.slice(0, 10).map(String) : [],
    examRuns: Array.isArray(body.examRuns) ? body.examRuns.slice(-10) : [],
    lastEvent: body.event && typeof body.event === 'object' ? body.event : null,
    updatedAt: new Date().toISOString()
  };

  const fields = {};
  for (const k of Object.keys(doc)) fields[k] = toFsValue(doc[k]);

  const token = await getAccessToken(env);
  const path = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${classCode}/students/${studentId}`;
  const res = await fetch(`${FS}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'firestore write failed', detail: text.slice(0, 300) }, 502);
  }
  return json({ ok: true, studentId });
}

async function handleClass(url, env) {
  const code = slug(url.searchParams.get('code'));
  const pin = url.searchParams.get('pin') || '';
  if (!code) return json({ error: 'code is required' }, 400);
  if (!env.INSTRUCTOR_PIN || pin !== env.INSTRUCTOR_PIN) {
    return json({ error: 'invalid pin' }, 401);
  }

  const token = await getAccessToken(env);
  const path = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${code}/students`;
  const res = await fetch(`${FS}/${path}?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'firestore read failed', detail: text.slice(0, 300) }, 502);
  }
  const data = await res.json();
  const students = (data.documents || []).map(docToObject)
    .sort((a, b) => (b.mastered || 0) - (a.mastered || 0));

  // roll up the topics the class as a whole is weakest on
  const tally = {};
  for (const s of students) {
    for (const t of s.weakTopics || []) {
      const topic = String(t).replace(/\s*\(\d+%\)$/, '');
      tally[topic] = (tally[topic] || 0) + 1;
    }
  }
  const classWeak = Object.keys(tally)
    .map((t) => ({ topic: t, students: tally[t] }))
    .sort((a, b) => b.students - a.students)
    .slice(0, 12);

  return json({ code, count: students.length, students, classWeak });
}

// Students type their own names, so duplicates and typos are inevitable.
// Removing a row is instructor-only and permanent.
async function handleDelete(url, env) {
  const code = slug(url.searchParams.get('code'));
  const id = slug(url.searchParams.get('id'));
  const pin = url.searchParams.get('pin') || '';
  if (!code) return json({ error: 'code is required' }, 400);
  if (!env.INSTRUCTOR_PIN || pin !== env.INSTRUCTOR_PIN) {
    return json({ error: 'invalid pin' }, 401);
  }

  const token = await getAccessToken(env);
  const base = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${code}/students`;

  // a single student
  if (id) {
    const res = await fetch(`${FS}/${base}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const text = await res.text();
      return json({ error: 'delete failed', detail: text.slice(0, 300) }, 502);
    }
    return json({ ok: true, deleted: [id] });
  }

  // the whole class
  const list = await fetch(`${FS}/${base}?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!list.ok) {
    const text = await list.text();
    return json({ error: 'list failed', detail: text.slice(0, 300) }, 502);
  }
  const docs = (await list.json()).documents || [];
  const deleted = [];
  for (const d of docs) {
    const res = await fetch(`${FS}/${d.name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) deleted.push(d.name.split('/').pop());
  }
  return json({ ok: true, deleted, count: deleted.length });
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/progress' && request.method === 'POST') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleProgress(request, env);
        }
        if (url.pathname === '/api/class' && request.method === 'GET') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleClass(url, env);
        }
        if (url.pathname === '/api/class' && request.method === 'DELETE') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleDelete(url, env);
        }
        if (url.pathname === '/api/health') {
          return json({
            ok: true,
            project: env.FIREBASE_PROJECT_ID || null,
            firestore: backendReady(env) ? 'configured' : 'not configured',
            dashboard: env.INSTRUCTOR_PIN ? 'pin set' : 'pin not set'
          });
        }
        return json({ error: 'not found' }, 404);
      } catch (err) {
        return json({ error: 'server error', detail: String(err && err.message || err) }, 500);
      }
    }

    // everything else is a static asset from dist/
    return env.ASSETS.fetch(request);
  }
};
