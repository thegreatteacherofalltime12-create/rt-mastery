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
    tokens: Number(body.tokens) || 0,
    bestExam: Number(body.bestExam) || 0,
    examRuns: Array.isArray(body.examRuns) ? body.examRuns.slice(-3) : [],
    updatedAt: new Date().toISOString()
  };

  const fields = {};
  for (const k of Object.keys(doc)) fields[k] = toFsValue(doc[k]);

  const token = await getAccessToken(env);
  const path = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${classCode}/students/${studentId}`;

  // The mask matters. Without it this PATCH replaces the WHOLE document, so a
  // student finishing a round would erase anything the instructor had written
  // on them - grants included. The student owns these fields; nothing else.
  const mask = Object.keys(doc).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const text = await res.text();
    return json({ error: 'firestore write failed', detail: text.slice(0, 300) }, 502);
  }
  if (classCache.key === classCode) classCache = { key: null, at: 0, value: null };

  // A PATCH returns the merged document, so the running total of tokens the
  // instructor has granted comes back for free. No extra read, ever.
  let granted = 0;
  try {
    const back = docToObject(await res.json());
    granted = Number(back.grantTotal) || 0;
  } catch { /* the write landed; the echo is a bonus */ }

  return json({ ok: true, studentId, grantTotal: granted });
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

/**
 * Teacher-issued tokens.
 *
 * One atomic increment on the student document the dashboard already writes:
 * no read, one write. The client claims the difference between grantTotal and
 * what it has already taken, so a grant is never applied twice and never lost
 * if the phone is offline when it is issued.
 */
async function handleGrant(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const code = slug(body.code);
  const pin = body.pin || '';
  if (!code) return json({ error: 'code is required' }, 400);
  if (!env.INSTRUCTOR_PIN || pin !== env.INSTRUCTOR_PIN) return json({ error: 'invalid pin' }, 401);

  const tokens = Math.min(50, Math.max(1, Math.round(Number(body.tokens) || 0)));
  const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(slug).filter(Boolean);
  if (!ids.length) return json({ error: 'at least one student is required' }, 400);

  const token = await getAccessToken(env);
  const writes = ids.map((id) => ({
    update: {
      name: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/classes/${code}/students/${id}`,
      fields: {}
    },
    updateMask: { fieldPaths: [] },
    updateTransforms: [{ fieldPath: 'grantTotal', increment: { integerValue: String(tokens) } }],
    // a grant to somebody who has never played would otherwise create a
    // half-student the dashboard cannot explain
    currentDocument: { exists: true }
  }));

  const res = await fetch(`${FS}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes })
  });
  if (!res.ok) {
    const t = await res.text();
    return json({ error: 'grant failed', detail: t.slice(0, 300) }, 502);
  }

  if (classCache.key === code) classCache = { key: null, at: 0, value: null };
  return json({ ok: true, granted: tokens, students: ids.length });
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

// ------------------------------------------------------------------ the seam
//
// A room code carries which game to play. The instructor picks on the
// projector, the choice is written once into the room document at create, and
// every poller already reading that document gets it for free. There is no
// manifest, no second collection and no new request: adding a game must never
// touch the hot path.
//
// The room owns identity and lifecycle - code, class, game, state, stage, who
// is present. Everything a format needs beyond that lives in two fields it
// owns outright: `cfg` (what the instructor chose, never mutated) and `gs`
// (game state). That split is what lets a whole game be swapped in one write.

const DEFAULT_GAME = 'buytime';

// The legacy flat mirror. Before the seam, Buy Time's fields sat at the top
// level of the wire object, and every phone and projector in the building is
// still running a bundle that reads them there. Emitting both shapes makes
// this deploy invisible to a client that has not reloaded. Delete it - and the
// mirror block in buytime.project - once a class has been through where every
// device reloaded at least once.
const LEGACY_FLAT = true;

function gameOf(room) { return (room && room.game) || DEFAULT_GAME; }
function defOf(room) { return GAMES[gameOf(room)] || null; }

// The terminal predicate. There are three room states and there will never be
// a fourth: a format that invents its own terminal word is invisible to every
// already-delivered bundle, and a client that never recognises the end polls
// Firestore every four seconds forever. 'won' is accepted for one release so
// rooms straddling the deploy still read as finished.
function isOver(room) {
  return !!room && (room.state === 'ended' || room.state === 'won');
}

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
  if (maxAgeMs === undefined && isOver(cached)) {
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

// Every format is one entry here. A format owns its own create defaults, its
// own projection onto the wire, and its own verbs - and nothing outside its
// entry may name it.
const GAMES = {
  buytime: {
    label: 'Buy Time',
    blurb: 'One clock the whole class keeps alive',

    // What the instructor chose. Clamped here, never mutated afterwards.
    config(body) {
      return {
        target: Math.min(200, Math.max(5, Number(body.target) || 40)),
        minutes: Math.min(60, Math.max(1, Number(body.minutes) || 5))
      };
    },

    newState() {
      return { cleared: 0, endsAtMs: 0, pool: [], allHands: null };
    },

    project(room) {
      // `|| room` reads a room created before the seam shipped, where these
      // fields sat at the top level. Deletable at the end of the semester.
      const cfg = room.cfg || room;
      const gs = room.gs || room;
      const players = room.players || {};
      const cap = Math.max(1, Math.ceil((cfg.target || 40) * MAX_SHARE));
      const scores = {};
      for (const id of Object.keys(players)) scores[id] = players[id].cleared || 0;
      return {
        target: cfg.target,
        startMinutes: cfg.minutes || cfg.startMinutes || 5,
        cleared: gs.cleared || 0,
        endsAtMs: gs.endsAtMs || null,
        pool: (gs.pool || []).map((p) => ({ qid: p.qid, topic: p.topic, chapter: p.chapter })),
        allHands: gs.allHands || null,
        won: !!gs.won,
        scores: scores,
        perStudentCap: cap
      };
    },

    // Buy Time's clock starts when she does. A format with no clock simply
    // omits this hook.
    onStart(room, set) {
      const cfg = room.cfg || {};
      room.gs.endsAtMs = set['gs.endsAtMs'] =
        Date.now() + (cfg.minutes || 5) * 60000;
    },

    // Verbs this format adds to the generic start/end. The namespace is
    // per-game, so two formats may both have a 'draw' without colliding.
    actions: {
      allhands(room, set) {
        const pool = room.gs.pool || [];
        if (!pool.length) return 'the pool is empty';
        const pick = pool[0];
        room.gs.allHands = set['gs.allHands'] = {
          qid: pick.qid, topic: pick.topic, chapter: pick.chapter,
          endsAt: new Date(Date.now() + 35000).toISOString(), solved: false
        };
      },

      extend(room, set, inc, body) {
        const add = Math.min(300, Math.max(10, Number(body.seconds) || 60));
        // While the clock is live this has to be an increment, or it wipes the
        // seconds the class bought during the round trip. Once it has run out
        // there is nothing to add to, so set a fresh deadline instead.
        if ((room.gs.endsAtMs || 0) > Date.now()) {
          inc['gs.endsAtMs'] = add * 1000;
          room.gs.endsAtMs = room.gs.endsAtMs + add * 1000;
        } else {
          room.gs.endsAtMs = set['gs.endsAtMs'] = Date.now() + add * 1000;
        }
      }
    },

    events: {
      // A miss costs the room nothing. It drops into the pool anonymously -
      // the projector shows topic tags only, never who put it there.
      async miss(room, ctx) {
        const qid = String(ctx.body.qid || '').slice(0, 40);
        // Already in the pool? Then there is nothing to write at all.
        if (!qid || room.gs.pool.some((p) => p.qid === qid)) return { seconds: 0 };
        room.gs.pool.push({
          qid: qid,
          topic: String(ctx.body.topic || '').slice(0, 60),
          chapter: String(ctx.body.chapter || '').slice(0, 12)
        });
        if (room.gs.pool.length > 40) room.gs.pool.shift();
        await ctx.commit({ set: { 'gs.pool': room.gs.pool } });
        return { seconds: 0 };
      },

      async clear(room, ctx) {
        const qid = String(ctx.body.qid || '').slice(0, 40);
        const cap = Math.max(1, Math.ceil((room.cfg.target || 40) * MAX_SHARE));
        const mine = (room.players[ctx.studentId] || {}).cleared || 0;
        const counted = mine < cap;

        // Seconds are derived server-side from the level and speed bucket the
        // client reports, both clamped. The client never names its own reward.
        const level = Math.min(3, Math.max(1, Number(ctx.body.level) || 1));
        const bucket = Math.min(2, Math.max(0, Number(ctx.body.bucket) || 0));
        let seconds = SECONDS[level][bucket];

        const fromPool = !!ctx.body.fromPool && room.gs.pool.some((p) => p.qid === qid);
        if (fromPool) {
          seconds *= POOL_MULTIPLIER;
          room.gs.pool = room.gs.pool.filter((p) => p.qid !== qid);
        }

        const ah = room.gs.allHands;
        const answeringAllHands = ah && !ah.solved && ah.qid === qid &&
          Date.now() < new Date(ah.endsAt).getTime();
        if (answeringAllHands) {
          seconds = ALL_HANDS_BONUS;
          room.gs.allHands.solved = true;
          room.gs.pool = room.gs.pool.filter((p) => p.qid !== qid);
        }

        if (!counted && !fromPool && !answeringAllHands) seconds = 0;
        const scores = counted || fromPool || answeringAllHands;

        // Co-Treat. The recipient is chosen HERE, not by the client, and it is
        // always whoever has cleared least - so the only token the room can see
        // is one that helps whoever is furthest behind, and nobody has to pick a
        // classmate in front of the class.
        let creditTo = ctx.studentId;
        if (ctx.body.coTreat && scores) {
          const others = Object.keys(room.players).filter((id) => id !== ctx.studentId);
          if (others.length) {
            creditTo = others.sort((a, b) =>
              (room.players[a].cleared || 0) - (room.players[b].cleared || 0))[0];
          }
        }

        // ONE write, all of it atomic. Counters and the deadline are
        // increments, so simultaneous clears add up instead of overwriting.
        const set = {};
        const inc = {};
        if (seconds > 0) inc['gs.endsAtMs'] = seconds * 1000;
        if (scores) {
          inc['gs.cleared'] = 1;
          inc[fieldPath(['players', creditTo, 'cleared'])] = 1;
        }
        if (fromPool || answeringAllHands) set['gs.pool'] = room.gs.pool;
        if (answeringAllHands) set['gs.allHands'] = room.gs.allHands;

        // Optimistically mirror the change so the next poll is served from cache.
        room.gs.cleared = (room.gs.cleared || 0) + (scores ? 1 : 0);
        if (scores) {
          room.players[creditTo].cleared = (room.players[creditTo].cleared || 0) + 1;
        }
        if (seconds > 0) room.gs.endsAtMs = (room.gs.endsAtMs || Date.now()) + seconds * 1000;

        // Victory is a game fact, not a room state. The room still ends with
        // the one terminal word every delivered bundle already tests for, and
        // those bundles derive their own headline from cleared >= target.
        if (room.gs.cleared >= (room.cfg.target || 40)) {
          room.gs.won = true; set['gs.won'] = true;
          room.state = 'ended'; set.state = 'ended';
        }

        if (Object.keys(set).length || Object.keys(inc).length) await ctx.commit({ set, inc });

        return {
          seconds: seconds, counted: counted, atCap: !counted,
          fromPool: fromPool, allHands: answeringAllHands,
          creditedTo: creditTo === ctx.studentId ? null : (room.players[creditTo] || {}).name || null
        };
      }
    }
  },

  // ------------------------------------------------------------- Field Day
  //
  // Five lanes, one per chapter. Every correct answer in the room moves the
  // lane its question came from.
  //
  // THE RACERS ARE CHAPTERS, NOT STUDENTS. That is the entire straggler
  // design: there is no order of students to come last in, because the object
  // does not exist. Nothing per-student is projected at any point, and a step
  // is worth one whether it came from a Recognise question or a Recall one -
  // the level difference is paid privately in XP, never on the wall.
  fieldday: {
    label: 'Field Day',
    blurb: 'Five lanes, one per chapter. Every right answer moves the lane its question came from. Nobody races anybody.',

    config(body) {
      return {
        laps: Math.min(80, Math.max(5, Number(body.laps) || 20)),
        minutes: Math.min(60, Math.max(1, Number(body.minutes) || 10))
      };
    },

    newState() {
      return { lanes: {}, misses: {}, endsAtMs: 0, focus: null, winner: null };
    },

    project(room) {
      const cfg = room.cfg || {};
      const gs = room.gs || {};
      return {
        laps: cfg.laps || 20,
        startMinutes: cfg.minutes || 10,
        lanes: gs.lanes || {},
        misses: gs.misses || {},
        focus: gs.focus || null,
        endsAtMs: gs.endsAtMs || null,
        winner: gs.winner || null
      };
    },

    onStart(room, set) {
      room.gs.endsAtMs = set['gs.endsAtMs'] =
        Date.now() + (room.cfg.minutes || 10) * 60000;
    },

    actions: {
      // The reteach cue, as spectacle rather than as a grade. It names the
      // chapter the room is getting wrong most and makes it worth DOUBLE.
      //
      // The original design called this a setback card and moved that lane
      // backwards. It does not, deliberately: a lane losing ground because the
      // room missed questions would mean a student's wrong answer cost everyone
      // else, and nothing in this project is allowed to do that. Pointing the
      // room at its weakest material is the useful half; the penalty was not.
      focus(room, set) {
        const misses = room.gs.misses || {};
        const worst = Object.keys(misses).sort((a, b) => misses[b] - misses[a])[0];
        if (!worst) return 'nobody has missed anything yet';
        room.gs.focus = set['gs.focus'] = { chapter: worst, left: 5 };
      },

      extend(room, set, inc, body) {
        const add = Math.min(600, Math.max(10, Number(body.seconds) || 60));
        if ((room.gs.endsAtMs || 0) > Date.now()) {
          inc['gs.endsAtMs'] = add * 1000;
          room.gs.endsAtMs = room.gs.endsAtMs + add * 1000;
        } else {
          room.gs.endsAtMs = set['gs.endsAtMs'] = Date.now() + add * 1000;
        }
      }
    },

    events: {
      // A miss moves nothing. It is only ever a tally feeding the reteach cue,
      // and it is never attributed to anybody.
      async miss(room, ctx) {
        const chapter = String(ctx.body.chapter || '').slice(0, 12);
        if (!/^[a-z0-9]{1,12}$/.test(chapter)) return { steps: 0 };
        room.gs.misses = room.gs.misses || {};
        room.gs.misses[chapter] = (room.gs.misses[chapter] || 0) + 1;
        await ctx.commit({ inc: { [fieldPath(['gs', 'misses', chapter])]: 1 } });
        return { steps: 0 };
      },

      async clear(room, ctx) {
        const chapter = String(ctx.body.chapter || '').slice(0, 12);
        // Lane ids become field paths, so they are validated rather than trusted.
        if (!/^[a-z0-9]{1,12}$/.test(chapter)) return { steps: 0 };

        room.gs.lanes = room.gs.lanes || {};
        const focus = room.gs.focus;
        const focused = !!(focus && focus.chapter === chapter && focus.left > 0);
        const steps = focused ? 2 : 1;

        const set = {};
        const inc = {};
        inc[fieldPath(['gs', 'lanes', chapter])] = steps;

        const now = (room.gs.lanes[chapter] || 0) + steps;
        room.gs.lanes[chapter] = now;

        if (focused) {
          focus.left -= 1;
          room.gs.focus = focus.left > 0 ? focus : null;
          set['gs.focus'] = room.gs.focus;
        }

        // A lane reaching the line ends the round, and the winner is a CHAPTER.
        const laps = (room.cfg && room.cfg.laps) || 20;
        if (now >= laps && !room.gs.winner) {
          room.gs.winner = set['gs.winner'] = chapter;
          room.state = set.state = 'ended';
        }

        await ctx.commit({ set, inc });
        return { steps: steps, lane: chapter, focused: focused, won: room.gs.winner || null };
      }
    }
  }
};

// Verbs are checked before a read is paid for, and the room's game is not
// known until after it. So the cheap check is against the union of every
// game's verbs; the per-game check happens once the document is in hand.
const SPINE_ACTIONS = ['create', 'start', 'end'];
const ALL_ACTIONS = new Set(SPINE_ACTIONS.concat(
  ...Object.keys(GAMES).map((g) => Object.keys(GAMES[g].actions || {}))));

/**
 * Rebuild a document written before the seam into the new shape, in memory.
 *
 * A room lives three hours, so this only ever sees a round that was already
 * running when the seam deployed. The caller writes the whole document back
 * once - a masked write cannot be used here, because a mask plus an increment
 * on overlapping paths in one commit is not worth reasoning about for a case
 * this rare. Deletable once no pre-seam room can still be alive.
 */
function migrateRoom(room) {
  room.game = DEFAULT_GAME;
  room.stage = room.stage || '';
  room.cfg = { target: room.target, minutes: room.startMinutes };
  room.gs = {
    cleared: room.cleared || 0,
    endsAtMs: room.endsAtMs || 0,
    pool: room.pool || [],
    allHands: room.allHands || null
  };
  delete room.target; delete room.startMinutes; delete room.cleared;
  delete room.endsAtMs; delete room.pool; delete room.allHands;
  return room;
}

/**
 * The projection wall.
 *
 * Everything a poller receives is produced here, and the per-game half is
 * produced ENTIRELY by that game's own project(). Before the seam this
 * function synthesised a plausible Buy Time scoreboard for any document it was
 * handed - `perStudentCap: 24` out of a `|| 40` fallback, `cleared: 0`,
 * `pool: []` - so a second game would not have failed loudly, it would have
 * shown a confident wrong board on a projector in front of a class.
 */
function publicRoom(room) {
  if (!room) return null;
  const players = room.players || {};
  const def = defOf(room);

  const out = {
    code: room.code,
    game: gameOf(room),
    state: room.state,
    stage: room.stage || '',
    // Sorted by id: stable, meaningless, and deliberately NOT a ranking. The
    // old descending-by-score sort shipped a permanent public last place to
    // any format that reused this projection without asking for one.
    players: Object.keys(players).sort().map((id) => ({ id: id, name: players[id].name })),
    gs: def ? def.project(room) : null
  };

  // Legacy flat mirror - see LEGACY_FLAT. Buy Time only, and byte-identical to
  // what this function returned before the seam, so an un-reloaded phone
  // cannot tell the difference.
  if (LEGACY_FLAT && gameOf(room) === 'buytime' && out.gs) {
    const g = out.gs;
    out.target = g.target;
    out.startMinutes = g.startMinutes;
    out.cleared = g.cleared;
    out.endsAtMs = g.endsAtMs;
    out.pool = g.pool;
    out.allHands = g.allHands;
    out.perStudentCap = g.perStudentCap;
    out.players = Object.keys(players).map((id) => ({
      id: id, name: players[id].name, cleared: players[id].cleared || 0
    })).sort((a, b) => b.cleared - a.cleared);
  }

  return out;
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
    // THE SEAM. The instructor's choice is written once, here, and every
    // poller reads it for free off a document they already fetch. The room
    // code itself stays opaque - four consonants that cannot spell anything
    // and cannot be misheard across a classroom.
    const game = String(body.game || DEFAULT_GAME);
    const def = GAMES[game];
    if (!def) return json({ error: 'unknown game' }, 400);
    const code = makeRoomCode();
    const room = {
      code: code, classCode: classCode, game: game,
      state: 'lobby', stage: '',
      cfg: def.config(body),
      gs: def.newState(),
      players: {},
      createdAt: new Date().toISOString()   // load-bearing: the TTL check reads it
    };
    await writeRoom(env, classCode, code, room);
    return json({ ok: true, room: publicRoom(room) });
  }

  const roomCode = String(body.code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(roomCode)) return json({ error: 'bad room code' }, 400);
  // Reject a bad action before it costs a read. The room's game is not known
  // yet, so this checks the union; the per-game check is below.
  if (!ALL_ACTIONS.has(action) || action === 'create') {
    return json({ error: 'unknown action' }, 400);
  }

  // A cached read is safe now that every branch below writes through
  // commitRoom: a masked write touches only the fields it names, so a student's
  // clear landing between this read and that write is no longer erased by it.
  const room = await readRoom(env, classCode, roomCode);
  if (!room) return json({ error: 'room not found' }, 404);

  if (!room.game) { migrateRoom(room); await writeRoom(env, classCode, roomCode, room); }
  const def = defOf(room);
  if (!def) return json({ error: 'unknown game', game: gameOf(room) }, 400);

  const set = {};
  const inc = {};

  if (action === 'start') {
    room.state = set.state = 'running';
    if (def.onStart) def.onStart(room, set, inc);
  } else if (action === 'end') {
    // 'ended' is the only terminal word this Worker ever writes. Every bundle
    // already delivered tests for it, so a phone that has never heard of this
    // room's game still knows to stop polling.
    room.state = set.state = 'ended';
  } else {
    const fn = def.actions && def.actions[action];
    if (!fn) return json({ error: 'action not available in this game' }, 400);
    const err = fn(room, set, inc, body);
    if (err) return json({ error: err }, 400);
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

  if (!room.game) { migrateRoom(room); await writeRoom(env, classCode, roomCode, room); }

  room.players = room.players || {};
  room.gs = room.gs || {};
  room.cfg = room.cfg || {};
  const known = !!room.players[studentId];

  const type = String(body.type || '');

  if (type === 'join') {
    // A phone tells the room which games its bundle can actually play. An old
    // bundle omits the list, and is assumed to know only Buy Time. Refusing
    // here - before the player write - means a client that cannot play never
    // costs a write and never appears in the room it cannot render.
    const can = Array.isArray(body.games) && body.games.length ? body.games : [DEFAULT_GAME];
    if (!can.includes(gameOf(room))) {
      return json({ error: 'client out of date', game: gameOf(room) }, 426);
    }
    // Only pay for a write when this student is actually new to the room.
    if (!known) {
      room.players[studentId] = { name: name, cleared: 0 };
      await commitRoom(env, classCode, roomCode, {
        set: { ['players.' + studentId]: { name: name, cleared: 0 } },
        local: room
      });
    }
    return json({ ok: true, room: publicRoom(room) });
  }

  // Past join, this Worker must actually implement the game. A room naming a
  // game we have no handler for means a client newer than this deployment.
  const def = defOf(room);
  if (!def) return json({ error: 'unknown game', game: gameOf(room) }, 400);

  if (!known) room.players[studentId] = { name: name, cleared: 0 };

  if (room.state !== 'running') return json({ error: 'round is not running' }, 409);

  // The guard. Without it the only gate is state === 'running', so a student's
  // stale tab posting a Buy Time 'clear' at a Field Day room runs Buy Time
  // scoring against a document that has none of its fields.
  const fn = def.events && def.events[type];
  if (!fn) return json({ error: 'event not available in this game' }, 400);

  const out = await fn(room, {
    studentId: studentId,
    name: name,
    body: body,
    // commit() supplies `local` for the caller. Forgetting it blows the room
    // cache with no symptom at all beyond every poller paying for a read, so
    // it is not left to whoever writes the next game.
    commit: (w) => commitRoom(env, classCode, roomCode, Object.assign({ local: room }, w))
  });

  if (out && out.error) return json({ error: out.error }, out.status || 400);
  return json(Object.assign({ ok: true }, out || {}, { room: publicRoom(room) }));
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
        if (url.pathname === '/api/grant' && request.method === 'POST') {
          if (!backendReady(env)) return json(NOT_CONFIGURED, 503);
          return await handleGrant(request, env);
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
