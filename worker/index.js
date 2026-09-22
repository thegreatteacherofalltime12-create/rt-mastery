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
    avgLevel: Number(body.avgLevel) || 1,
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

// ---------------------------------------------------------------- Buy Time
//
// A live class round. One shared countdown on the projector; every phone serves
// that student their own questions at their own level. Correct answers buy the
// room time. Nothing a student gets wrong ever costs the room anything.

const ROOM_TTL_MS = 3 * 60 * 60 * 1000;   // a room is stale after three hours

// Seconds bought are computed HERE, never taken from the client. Ten students
// who all know each other will try the obvious thing.
const SECONDS = {
  1: [5, 4, 3],     // level 1: under 10s, under 20s, slower
  2: [8, 6, 5],
  3: [12, 9, 7]
};
const POOL_MULTIPLIER = 2;                // clearing someone else's miss is worth double
const ALL_HANDS_BONUS = 60;
const MAX_SHARE = 0.6;                    // no one student may clear more than this share

let roomCache = { key: null, at: 0, value: null };

function roomPath(env, classCode, roomCode) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${classCode}/rooms/${roomCode}`;
}

async function readRoom(env, classCode, roomCode, maxAgeMs) {
  const key = classCode + '/' + roomCode;
  const age = maxAgeMs === undefined ? 900 : maxAgeMs;
  if (roomCache.key === key && Date.now() - roomCache.at < age) return roomCache.value;

  const token = await getAccessToken(env);
  const res = await fetch(`${FS}/${roomPath(env, classCode, roomCode)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('room read failed: ' + res.status);
  const doc = docToObject(await res.json());
  roomCache = { key: key, at: Date.now(), value: doc };
  return doc;
}

async function writeRoom(env, classCode, roomCode, room) {
  const token = await getAccessToken(env);
  const fields = {};
  for (const k of Object.keys(room)) fields[k] = toFsValue(room[k]);
  const res = await fetch(`${FS}/${roomPath(env, classCode, roomCode)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('room write failed: ' + res.status);
  roomCache = { key: classCode + '/' + roomCode, at: Date.now(), value: room };
  return room;
}

// Four letters, no vowels, so the code cannot spell anything and cannot be
// misheard as a word across a classroom.
function makeRoomCode() {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXYZ';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function publicRoom(room) {
  if (!room) return null;
  const players = room.players || {};
  return {
    code: room.code,
    state: room.state,
    target: room.target,
    cleared: room.cleared || 0,
    endsAt: room.endsAt || null,
    pool: (room.pool || []).map((p) => ({ qid: p.qid, topic: p.topic, chapter: p.chapter })),
    allHands: room.allHands || null,
    players: Object.keys(players).map((id) => ({
      id: id, name: players[id].name, cleared: players[id].cleared || 0
    })).sort((a, b) => b.cleared - a.cleared),
    perStudentCap: Math.max(1, Math.ceil((room.target || 40) * MAX_SHARE))
  };
}

async function handleRoomControl(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const classCode = slug(body.classCode);
  const pin = body.pin || '';
  if (!classCode) return json({ error: 'classCode required' }, 400);
  if (!env.INSTRUCTOR_PIN || pin !== env.INSTRUCTOR_PIN) return json({ error: 'invalid pin' }, 401);

  const action = String(body.action || '');

  if (action === 'create') {
    const target = Math.min(200, Math.max(5, Number(body.target) || 40));
    const minutes = Math.min(60, Math.max(1, Number(body.minutes) || 5));
    const code = makeRoomCode();
    const room = {
      code: code, classCode: classCode, state: 'lobby',
      target: target, startMinutes: minutes, cleared: 0,
      endsAt: null, pool: [], players: {}, allHands: null,
      createdAt: new Date().toISOString()
    };
    await writeRoom(env, classCode, code, room);
    return json({ ok: true, room: publicRoom(room) });
  }

  const roomCode = String(body.code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(roomCode)) return json({ error: 'bad room code' }, 400);
  const room = await readRoom(env, classCode, roomCode, 0);
  if (!room) return json({ error: 'room not found' }, 404);

  if (action === 'start') {
    room.state = 'running';
    room.endsAt = new Date(Date.now() + room.startMinutes * 60000).toISOString();
    room.startedAt = new Date().toISOString();
  } else if (action === 'allhands') {
    const pool = room.pool || [];
    if (!pool.length) return json({ error: 'the pool is empty' }, 400);
    const pick = pool[0];
    room.allHands = {
      qid: pick.qid, topic: pick.topic, chapter: pick.chapter,
      endsAt: new Date(Date.now() + 35000).toISOString(), solved: false
    };
  } else if (action === 'extend') {
    const add = Math.min(300, Math.max(10, Number(body.seconds) || 60));
    const base = room.endsAt ? new Date(room.endsAt).getTime() : Date.now();
    room.endsAt = new Date(Math.max(base, Date.now()) + add * 1000).toISOString();
  } else if (action === 'end') {
    room.state = 'ended';
  } else {
    return json({ error: 'unknown action' }, 400);
  }

  await writeRoom(env, classCode, roomCode, room);
  return json({ ok: true, room: publicRoom(room) });
}

async function handleRoomState(url, env) {
  const classCode = slug(url.searchParams.get('classCode'));
  const roomCode = String(url.searchParams.get('code') || '').toUpperCase();
  if (!classCode || !/^[A-Z]{4}$/.test(roomCode)) return json({ error: 'classCode and code required' }, 400);
  const room = await readRoom(env, classCode, roomCode);
  if (!room) return json({ error: 'room not found' }, 404);
  if (Date.now() - new Date(room.createdAt || 0).getTime() > ROOM_TTL_MS) {
    return json({ error: 'room expired' }, 410);
  }
  return json({ ok: true, room: publicRoom(room), now: new Date().toISOString() });
}

async function handleRoomEvent(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const classCode = slug(body.classCode);
  const roomCode = String(body.code || '').toUpperCase();
  const name = String(body.name || '').trim().slice(0, 80);
  const studentId = slug(name);
  if (!classCode || !/^[A-Z]{4}$/.test(roomCode) || !studentId) {
    return json({ error: 'classCode, code and name are required' }, 400);
  }

  const room = await readRoom(env, classCode, roomCode, 0);
  if (!room) return json({ error: 'room not found' }, 404);

  room.players = room.players || {};
  room.pool = room.pool || [];
  if (!room.players[studentId]) room.players[studentId] = { name: name, cleared: 0 };
  room.players[studentId].lastSeen = new Date().toISOString();

  const type = String(body.type || '');

  if (type === 'join') {
    await writeRoom(env, classCode, roomCode, room);
    return json({ ok: true, room: publicRoom(room) });
  }

  if (room.state !== 'running') return json({ error: 'round is not running' }, 409);

  const qid = String(body.qid || '').slice(0, 40);
  const topic = String(body.topic || '').slice(0, 60);
  const chapter = String(body.chapter || '').slice(0, 12);

  if (type === 'miss') {
    // A miss costs the room nothing. It drops into the pool anonymously - the
    // projector shows topic tags only, never who put it there.
    if (qid && !room.pool.some((p) => p.qid === qid)) {
      room.pool.push({ qid: qid, topic: topic, chapter: chapter });
      if (room.pool.length > 40) room.pool.shift();
    }
    await writeRoom(env, classCode, roomCode, room);
    return json({ ok: true, seconds: 0, room: publicRoom(room) });
  }

  if (type === 'clear') {
    const cap = Math.max(1, Math.ceil((room.target || 40) * MAX_SHARE));
    const mine = room.players[studentId].cleared || 0;
    const counted = mine < cap;

    // Seconds are derived server-side from the level and speed bucket the client
    // reports, both clamped. The client never names its own reward.
    const level = Math.min(3, Math.max(1, Number(body.level) || 1));
    const bucket = Math.min(2, Math.max(0, Number(body.bucket) || 0));
    let seconds = SECONDS[level][bucket];

    const fromPool = !!body.fromPool && room.pool.some((p) => p.qid === qid);
    if (fromPool) {
      seconds *= POOL_MULTIPLIER;
      room.pool = room.pool.filter((p) => p.qid !== qid);
    }

    const answeringAllHands = room.allHands && !room.allHands.solved && room.allHands.qid === qid
      && Date.now() < new Date(room.allHands.endsAt).getTime();
    if (answeringAllHands) {
      seconds = ALL_HANDS_BONUS;
      room.allHands.solved = true;
      room.pool = room.pool.filter((p) => p.qid !== qid);
    }

    if (!counted && !fromPool && !answeringAllHands) seconds = 0;

    if (seconds > 0) {
      const base = room.endsAt ? new Date(room.endsAt).getTime() : Date.now();
      room.endsAt = new Date(Math.max(base, Date.now()) + seconds * 1000).toISOString();
    }
    if (counted || fromPool || answeringAllHands) {
      room.cleared = (room.cleared || 0) + 1;
      room.players[studentId].cleared = mine + 1;
    }
    if ((room.cleared || 0) >= (room.target || 40)) room.state = 'won';

    await writeRoom(env, classCode, roomCode, room);
    return json({
      ok: true, seconds: seconds, counted: counted,
      atCap: !counted, fromPool: fromPool, allHands: answeringAllHands,
      room: publicRoom(room)
    });
  }

  return json({ error: 'unknown event type' }, 400);
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
        if (url.pathname === '/api/room' && request.method === 'GET') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleRoomState(url, env);
        }
        if (url.pathname === '/api/room' && request.method === 'POST') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleRoomControl(request, env);
        }
        if (url.pathname === '/api/room/event' && request.method === 'POST') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleRoomEvent(request, env);
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
