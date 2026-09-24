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

  // Only what the dashboard renders. bestStreak, per-chapter counts and the
  // last event were written on every sync and read by nobody. bestExam is sent
  // precomputed so the run history can stay short.
  const doc = {
    name,
    classCode,
    xp: Number(body.xp) || 0,
    sessions: Number(body.sessions) || 0,
    mastered: Number(body.mastered) || 0,
    totalQuestions: Number(body.totalQuestions) || 0,
    avgLevel: Number(body.avgLevel) || 1,
    weakTopics: Array.isArray(body.weakTopics) ? body.weakTopics.slice(0, 10).map(String) : [],
    bestExam: Number(body.bestExam) || 0,
    examRuns: Array.isArray(body.examRuns) ? body.examRuns.slice(-3) : [],
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
  if (classCache.key === classCode) classCache = { key: null, at: 0, value: null };
  return json({ ok: true, studentId });
}

// A roster LIST is billed one read PER STUDENT, and Refresh is a button a human
// leans on. The probe sits below the PIN check, never above it.
const CLASS_CACHE_MS = 20000;
let classCache = { key: null, at: 0, value: null };

async function handleClass(url, env) {
  const code = slug(url.searchParams.get('code'));
  const pin = url.searchParams.get('pin') || '';
  if (!code) return json({ error: 'code is required' }, 400);
  if (!env.INSTRUCTOR_PIN || pin !== env.INSTRUCTOR_PIN) {
    return json({ error: 'invalid pin' }, 401);
  }

  if (classCache.key === code && Date.now() - classCache.at < CLASS_CACHE_MS) {
    return json(classCache.value);
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

  const payload = { code, count: students.length, students, classWeak };
  classCache = { key: code, at: Date.now(), value: payload };
  return json(payload);
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
    if (classCache.key === code) classCache = { key: null, at: 0, value: null };
    return json({ ok: true, deleted: [id] });
  }

  // The whole class, behind an explicit flag. Without one, a DELETE that simply
  // forgot its id would erase the roster and answer 200.
  if (url.searchParams.get('all') !== '1') {
    return json({ error: 'id is required (add all=1 to reset the whole class)' }, 400);
  }
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
  if (classCache.key === code) classCache = { key: null, at: 0, value: null };
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

// Firestore is billed per document read and per document write, so the whole
// game here is collapsing many callers into few operations.
//
// Ten phones and a projector polling a live room is the only high-volume path
// in this app. They all want the SAME document, so one cached read serves every
// poll inside the window. The clock is derived client-side from an absolute
// deadline, so a couple of seconds of staleness changes nothing on screen.
const ROOM_CACHE_MS = 2500;

const TERMINAL_CACHE_MS = 60000;         // a finished round cannot change again

let roomCache = { key: null, at: 0, value: null };

function roomPath(env, classCode, roomCode) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${classCode}/rooms/${roomCode}`;
}

function cacheKey(classCode, roomCode) { return classCode + '/' + roomCode; }

async function readRoom(env, classCode, roomCode, maxAgeMs) {
  const key = cacheKey(classCode, roomCode);
  let age = maxAgeMs === undefined ? ROOM_CACHE_MS : maxAgeMs;

  // Only the DEFAULT is relaxed for a finished round. A caller that explicitly
  // asked for a fresh read is about to mutate the room and still gets one.
  const cached = roomCache.key === key ? roomCache.value : null;
  if (maxAgeMs === undefined && cached && (cached.state === 'ended' || cached.state === 'won')) {
    age = TERMINAL_CACHE_MS;
  }
  if (roomCache.key === key && Date.now() - roomCache.at < age) return roomCache.value;

  const token = await getAccessToken(env);
  const res = await fetch(`${FS}/${roomPath(env, classCode, roomCode)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) { roomCache = { key: key, at: Date.now(), value: null }; return null; }
  if (!res.ok) throw new Error('room read failed: ' + res.status);
  const doc = docToObject(await res.json());
  roomCache = { key: key, at: Date.now(), value: doc };
  return doc;
}

// A Firestore field path segment must be backticked unless it is a plain
// identifier. Student ids are slugs and usually contain dashes.
function fieldPath(parts) {
  return parts.map((p) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(p) ? p : '`' + String(p).replace(/`/g, '') + '`')).join('.');
}

/**
 * One Firestore write that both sets fields and applies atomic increments.
 *
 * Increments are what make a clear cost a single operation instead of a
 * read-modify-write, and they are also the only correct way to do this: two
 * students clearing in the same second would otherwise overwrite each other's
 * time. That is why the deadline is stored as `endsAtMs`, an integer we can
 * add to, rather than a timestamp string we would have to read first.
 */
async function commitRoom(env, classCode, roomCode, { set, inc, local }) {
  const token = await getAccessToken(env);
  const doc = roomPath(env, classCode, roomCode);

  // A dotted key like "players.avery-diaz" targets a nested field. The REST
  // `fields` map is a tree, so it has to be nested to match, while updateMask
  // takes the dotted path - that pairing is what makes this a MERGE of one
  // nested field rather than a clobber of the whole map.
  const fields = {};
  const mask = [];
  for (const k of Object.keys(set || {})) {
    const v = set[k];
    if (v === undefined) continue;
    const parts = k.split('.');
    let node = fields;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node[seg]) node[seg] = { mapValue: { fields: {} } };
      node = node[seg].mapValue.fields;
    }
    node[parts[parts.length - 1]] = toFsValue(v);
    mask.push(fieldPath(parts));
  }

  const transforms = Object.keys(inc || {})
    .filter((p) => inc[p])
    .map((p) => ({ fieldPath: p, increment: { integerValue: String(inc[p]) } }));

  const write = { update: { name: doc, fields }, updateMask: { fieldPaths: mask } };
  if (transforms.length) write.updateTransforms = transforms;

  const res = await fetch(`${FS}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [write] })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('room commit failed: ' + res.status + ' ' + t.slice(0, 200));
  }

  // Keep the cache in step so the next poll does not pay for a read just to
  // observe a change we already know about.
  if (local && roomCache.key === cacheKey(classCode, roomCode) && roomCache.value) {
    roomCache = { key: roomCache.key, at: Date.now(), value: local };
  } else {
    roomCache = { key: null, at: 0, value: null };
  }
}

// Creating a room is the one place a whole-document PATCH is right: there is
// nothing there yet to clobber. Every later change goes through commitRoom.
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
  roomCache = { key: cacheKey(classCode, roomCode), at: Date.now(), value: room };
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
    startMinutes: room.startMinutes || 5,
    cleared: room.cleared || 0,
    endsAtMs: room.endsAtMs || null,
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
      endsAtMs: 0, pool: [], players: {}, allHands: null,
      createdAt: new Date().toISOString()
    };
    await writeRoom(env, classCode, code, room);
    return json({ ok: true, room: publicRoom(room) });
  }

  const roomCode = String(body.code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(roomCode)) return json({ error: 'bad room code' }, 400);
  // Reject a bad action before it costs a read.
  if (!['start', 'allhands', 'extend', 'end'].includes(action)) {
    return json({ error: 'unknown action' }, 400);
  }

  // A cached read is safe now that every branch below writes through
  // commitRoom: a masked write touches only the fields it names, so a student's
  // clear landing between this read and that write is no longer erased by it.
  const room = await readRoom(env, classCode, roomCode);
  if (!room) return json({ error: 'room not found' }, 404);

  const set = {};
  const inc = {};

  if (action === 'start') {
    room.state = set.state = 'running';
    room.endsAtMs = set.endsAtMs = Date.now() + room.startMinutes * 60000;
  } else if (action === 'allhands') {
    const pool = room.pool || [];
    if (!pool.length) return json({ error: 'the pool is empty' }, 400);
    const pick = pool[0];
    room.allHands = set.allHands = {
      qid: pick.qid, topic: pick.topic, chapter: pick.chapter,
      endsAt: new Date(Date.now() + 35000).toISOString(), solved: false
    };
  } else if (action === 'extend') {
    const add = Math.min(300, Math.max(10, Number(body.seconds) || 60));
    // While the clock is still live, +60 has to be an increment, or it would
    // wipe the seconds the class bought during the round trip. Once it has run
    // out there is nothing left to add to, so set a fresh deadline instead -
    // that clamp is the whole reason the button is usable when it is reached for.
    if ((room.endsAtMs || 0) > Date.now()) {
      inc.endsAtMs = add * 1000;
      room.endsAtMs = room.endsAtMs + add * 1000;
    } else {
      room.endsAtMs = set.endsAtMs = Date.now() + add * 1000;
    }
  } else {
    room.state = set.state = 'ended';
  }

  await commitRoom(env, classCode, roomCode, { set, inc, local: room });
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
  return json({ ok: true, room: publicRoom(room) });
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

  // The cached room is good enough to validate against: it is at most a couple
  // of seconds stale, and every mutation below is an atomic increment, so a
  // stale read cannot corrupt a counter.
  const room = await readRoom(env, classCode, roomCode);
  if (!room) return json({ error: 'room not found' }, 404);

  room.players = room.players || {};
  room.pool = room.pool || [];
  const known = !!room.players[studentId];
  if (!known) room.players[studentId] = { name: name, cleared: 0 };

  const type = String(body.type || '');

  if (type === 'join') {
    // Only pay for a write when this student is actually new to the room.
    if (!known) {
      await commitRoom(env, classCode, roomCode, {
        set: { ['players.' + studentId]: { name: name, cleared: 0 } },
        local: room
      });
    }
    return json({ ok: true, room: publicRoom(room) });
  }

  if (room.state !== 'running') return json({ error: 'round is not running' }, 409);

  const qid = String(body.qid || '').slice(0, 40);
  const topic = String(body.topic || '').slice(0, 60);
  const chapter = String(body.chapter || '').slice(0, 12);

  if (type === 'miss') {
    // A miss costs the room nothing. It drops into the pool anonymously - the
    // projector shows topic tags only, never who put it there.
    // Already in the pool? Then there is nothing to write at all.
    if (!qid || room.pool.some((p) => p.qid === qid)) {
      return json({ ok: true, seconds: 0, room: publicRoom(room) });
    }
    room.pool.push({ qid: qid, topic: topic, chapter: chapter });
    if (room.pool.length > 40) room.pool.shift();
    await commitRoom(env, classCode, roomCode, { set: { pool: room.pool }, local: room });
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
    const scores = counted || fromPool || answeringAllHands;

    // ONE write, all of it atomic. Counters and the deadline are increments, so
    // simultaneous clears add up instead of overwriting each other.
    const set = {};
    const inc = {};
    if (seconds > 0) inc.endsAtMs = seconds * 1000;
    if (scores) {
      inc.cleared = 1;
      inc[fieldPath(['players', studentId, 'cleared'])] = 1;
    }
    if (fromPool || answeringAllHands) set.pool = room.pool;
    if (answeringAllHands) set.allHands = room.allHands;

    // Optimistically mirror the change so the next poll is served from cache.
    room.cleared = (room.cleared || 0) + (scores ? 1 : 0);
    if (scores) room.players[studentId].cleared = mine + 1;
    if (seconds > 0) room.endsAtMs = (room.endsAtMs || Date.now()) + seconds * 1000;
    if (room.cleared >= (room.target || 40)) { room.state = 'won'; set.state = 'won'; }

    if (Object.keys(set).length || Object.keys(inc).length) {
      await commitRoom(env, classCode, roomCode, { set, inc, local: room });
    }
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
