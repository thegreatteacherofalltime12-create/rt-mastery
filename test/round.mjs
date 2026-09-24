/**
 * Drives a full Buy Time round through the Worker's real entry point against a
 * fake Firestore, and records two things:
 *
 *   wire  - every response body a phone or projector would receive
 *   doc   - what actually landed in the stored document after each step
 *
 * Both matter. The Worker keeps a 2.5s in-isolate room cache and mirrors its
 * own writes into it, so a response can look perfectly correct while the write
 * that produced it went to the wrong field path. Only the stored document
 * catches that, and a wrong field path is the exact failure mode of moving Buy
 * Time's state under `gs`.
 *
 *   node test/round.mjs            print the snapshot
 *   node test/round.mjs --save     write test/snapshot.json
 *   node test/round.mjs --check    diff against test/snapshot.json, exit 1 on drift
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP = join(HERE, 'snapshot.json');
const LEGACY_SNAP = join(HERE, 'legacy-wire.json');

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';

const fs = makeFirestore();
const env = testEnv();
const restore = fs.install();
const worker = (await import('../worker/index.js')).default;

let roomCode = null;
let t0 = null;
const steps = [];
const failures = [];

function assert(label, cond, detail) {
  if (!cond) failures.push(label + (detail ? ' — ' + detail : ''));
}

/** Strip everything that legitimately differs between two runs. */
function normalise(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (roomCode && v === roomCode) return '<CODE>';
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return '<TS>';
    return v;
  }
  if (typeof v === 'number') {
    // absolute ms deadlines become seconds-from-start, which IS stable
    if (v > 1e12) return '<+' + Math.round((v - t0) / 1000) + 's>';
    return v;
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalise(v[k]);
    return out;
  }
  return v;
}

function roomDocPath() {
  return `projects/test-project/databases/(default)/documents/classes/${CLASS}/rooms/${roomCode}`;
}

async function call(label, method, path, body) {
  const res = await worker.fetch(new Request(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), env);
  const status = res.status;
  const j = await res.json().catch(() => ({ unparseable: true }));

  if (!roomCode && j.room && j.room.code) { roomCode = j.room.code; t0 = Date.now(); }

  steps.push({
    step: label,
    status,
    wire: normalise(j),
    doc: roomCode && fs.has(roomDocPath()) ? normalise(fs.get(roomDocPath())) : null
  });
  return { status, j };
}

// ---------------------------------------------------------------- the round

// 1. she creates a room on the projector
const created = await call('create', 'POST', '/api/room',
  { action: 'create', classCode: CLASS, pin: PIN, target: 6, minutes: 5 });
assert('create returns a 4-letter code', /^[A-Z]{4}$/.test(created.j.room && created.j.room.code));
assert('create starts in lobby', created.j.room.state === 'lobby');

// 2. two students join; a third join from the same student must not write again
await call('join:avery', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Avery Diaz', type: 'join' });
await call('join:sam', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Sam Okafor', type: 'join' });

fs.resetCounters();
await call('join:avery-again', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Avery Diaz', type: 'join' });
assert('a repeat join costs no write', fs.writes.length === 0,
       'saw ' + fs.writes.length + ' write(s)');

// 3. she starts the clock
const started = await call('start', 'POST', '/api/room',
  { action: 'start', classCode: CLASS, pin: PIN, code: roomCode });
assert('start sets running', started.j.room.state === 'running');

// 4. an answer nobody can get drops into the pool, anonymously
await call('miss:avery', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Avery Diaz', type: 'miss',
    qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2' });

fs.resetCounters();
await call('miss:duplicate', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Sam Okafor', type: 'miss',
    qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2' });
assert('a question already in the pool costs no write', fs.writes.length === 0,
       'saw ' + fs.writes.length + ' write(s)');

// 5. the hot path: a poll must cost nothing beyond the cached read
fs.resetCounters();
await call('poll', 'GET', `/api/room?classCode=${CLASS}&code=${roomCode}`);
assert('a poll writes nothing', fs.writes.length === 0);

// 6. someone steals it out of the pool — worth double
const steal = await call('clear:sam-from-pool', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Sam Okafor', type: 'clear',
    qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2', level: 2, bucket: 0, fromPool: true });
assert('a pool steal pays double', steal.j.seconds === 16, 'got ' + steal.j.seconds);
assert('a cleared question leaves the pool',
       (steal.j.room.pool || steal.j.room.gs && steal.j.room.gs.pool || []).length === 0);

// 7. ALL HANDS needs something in the pool
await call('miss:sam', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Sam Okafor', type: 'miss',
    qid: 'ch4-09', topic: 'APIE Evaluation', chapter: 'ch4' });
const ah = await call('allhands', 'POST', '/api/room',
  { action: 'allhands', classCode: CLASS, pin: PIN, code: roomCode });
assert('all hands opens a window', !!(ah.j.room.allHands || (ah.j.room.gs && ah.j.room.gs.allHands)));

const ahClear = await call('clear:avery-allhands', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Avery Diaz', type: 'clear',
    qid: 'ch4-09', topic: 'APIE Evaluation', chapter: 'ch4', level: 1, bucket: 2, fromPool: true });
assert('all hands pays the flat bonus', ahClear.j.seconds === 60, 'got ' + ahClear.j.seconds);

// 8. +60 while the clock is live must ADD, never overwrite
const before = ahClear.j.room.endsAtMs || (ahClear.j.room.gs && ahClear.j.room.gs.endsAtMs);
const ext = await call('extend', 'POST', '/api/room',
  { action: 'extend', classCode: CLASS, pin: PIN, code: roomCode, seconds: 60 });
const after = ext.j.room.endsAtMs || (ext.j.room.gs && ext.j.room.gs.endsAtMs);
assert('+60 adds to the live deadline', after - before === 60000, 'delta ' + (after - before));

// 9. the per-student cap: target 6 x 0.6 => cap 4. Sam has 1, so 3 more count, the 4th does not.
let capped = null;
for (let i = 0; i < 4; i++) {
  capped = await call('clear:sam-' + (i + 2), 'POST', '/api/room/event',
    { classCode: CLASS, code: roomCode, name: 'Sam Okafor', type: 'clear',
      qid: 'ch3-1' + i, topic: 'Relaxation', chapter: 'ch3', level: 1, bucket: 0 });
}
assert('a student at their cap earns nothing', capped.j.atCap === true && capped.j.seconds === 0,
       'atCap=' + capped.j.atCap + ' seconds=' + capped.j.seconds);

// 10. she ends it
const ended = await call('end', 'POST', '/api/room',
  { action: 'end', classCode: CLASS, pin: PIN, code: roomCode });
assert("the terminal state on the wire is 'ended'", ended.j.room.state === 'ended',
       'got ' + ended.j.room.state);

// 11. events after the end are rejected
const late = await call('clear:after-end', 'POST', '/api/room/event',
  { classCode: CLASS, code: roomCode, name: 'Avery Diaz', type: 'clear',
    qid: 'ch7-02', topic: 'Groups', chapter: 'ch7', level: 3, bucket: 0 });
assert('a clear after the end is refused', late.status === 409, 'got ' + late.status);

restore();

// ---------------------------------------------------------------- report

// ---------------------------------------------------------------- legacy wire
//
// Every key below is read by a bundle that is already sitting on a student's
// phone. The seam is only safe to deploy because these stay byte-identical, so
// this check runs on every test run, not just on --check.
const LEGACY_KEYS = ['code', 'state', 'target', 'startMinutes', 'cleared',
                     'endsAtMs', 'pool', 'allHands', 'players', 'perStudentCap'];
if (existsSync(LEGACY_SNAP)) {
  const frozen = JSON.parse(readFileSync(LEGACY_SNAP, 'utf8')).steps;
  let compared = 0;
  frozen.forEach((want, i) => {
    const got = steps[i];
    if (!got || got.step !== want.step) { failures.push('legacy wire: step ' + i + ' moved'); return; }
    if (!want.room) return;
    const room = got.wire && got.wire.room;
    if (!room) { failures.push('legacy wire: ' + want.step + ' lost its room'); return; }
    for (const k of LEGACY_KEYS) {
      if (!(k in want.room)) continue;
      compared++;
      const a = JSON.stringify(want.room[k]), b = JSON.stringify(room[k]);
      if (a !== b) failures.push('legacy wire drift at ' + want.step + '.' + k + ': was ' + a + ' now ' + b);
    }
  });
  console.log('legacy wire keys compared: ' + compared);
}

const snapshot = { steps };
const mode = process.argv[2];

if (failures.length) {
  console.error('\nINVARIANTS FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
} else {
  console.log('\nall ' + 12 + ' invariants hold');
}

if (mode === '--save') {
  writeFileSync(SNAP, JSON.stringify(snapshot, null, 2));
  console.log('snapshot written: ' + SNAP);
} else if (mode === '--check') {
  if (!existsSync(SNAP)) { console.error('no snapshot to check against; run --save first'); process.exit(1); }
  const want = readFileSync(SNAP, 'utf8');
  const got = JSON.stringify(snapshot, null, 2);
  if (want === got) {
    console.log('wire + stored document identical to snapshot');
  } else {
    const a = want.split('\n'), b = got.split('\n');
    console.error('\nSNAPSHOT DRIFT:');
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 60; i++) {
      if (a[i] !== b[i]) { console.error('  ' + (i + 1) + ' -' + (a[i] ?? '')); console.error('  ' + (i + 1) + ' +' + (b[i] ?? '')); shown++; }
    }
    process.exit(1);
  }
} else {
  console.log(JSON.stringify(snapshot, null, 2));
}

if (failures.length) process.exit(1);
