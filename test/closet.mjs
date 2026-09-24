/**
 * The Supply Closet's two server-side pieces: Co-Treat and teacher grants.
 * Everything else about the shop is local to the phone.
 *
 *   node test/closet.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';
const SP = (id) => `projects/test-project/databases/(default)/documents/classes/${CLASS}/students/${id}`;

const fs = makeFirestore();
const env = testEnv();
const restore = fs.install();
const worker = (await import('../worker/index.js')).default;

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' — ' + detail : '')); };

async function call(method, path, body) {
  const res = await worker.fetch(new Request(BASE + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Co-Treat: the only token the room can see, and it always helps whoever is
// furthest behind. The recipient is chosen on the server so it cannot be aimed.
// ---------------------------------------------------------------------------
const room = await call('POST', '/api/room', { action: 'create', classCode: CLASS, pin: PIN, target: 20, minutes: 5 });
const code = room.j.room.code;
for (const name of ['Avery Diaz', 'Sam Okafor', 'Jo Bell']) {
  await call('POST', '/api/room/event', { classCode: CLASS, code, name, type: 'join' });
}
await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });

// Avery gets two, so Sam and Jo are both behind on zero
for (let i = 0; i < 2; i++) {
  await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz', type: 'clear',
    qid: 'ch2-0' + i, topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0 });
}
// Sam pulls ahead of Jo
await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Sam Okafor', type: 'clear',
  qid: 'ch3-01', topic: 'Relaxation', chapter: 'ch3', level: 1, bucket: 0 });

const before = (await call('GET', `/api/room?classCode=${CLASS}&code=${code}`)).j.room.gs.scores;
check('the room is uneven before the co-treat',
      before['avery-diaz'] === 2 && before['sam-okafor'] === 1 && before['jo-bell'] === 0,
      JSON.stringify(before));

const co = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz', type: 'clear',
  qid: 'ch4-01', topic: 'APIE', chapter: 'ch4', level: 1, bucket: 0, coTreat: true });

check('a co-treat still buys the room its time', co.j.seconds === 5, 'got ' + co.j.seconds);
check('a co-treat names who it went to', co.j.creditedTo === 'Jo Bell', 'got ' + co.j.creditedTo);

const after = co.j.room.gs.scores;
check('the credit went to whoever was furthest behind', after['jo-bell'] === 1, JSON.stringify(after));
check('the spender did not also score', after['avery-diaz'] === 2, JSON.stringify(after));
check('the room total still went up', co.j.room.gs.cleared === 4, 'got ' + co.j.room.gs.cleared);

// an ordinary clear credits the person who made it
const plain = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz', type: 'clear',
  qid: 'ch4-02', topic: 'APIE', chapter: 'ch4', level: 1, bucket: 0 });
check('an ordinary clear names nobody', plain.j.creditedTo === null);
check('an ordinary clear credits the answerer', plain.j.room.gs.scores['avery-diaz'] === 3);

// ---------------------------------------------------------------------------
// Teacher grants: one write, no read, and never applied twice.
// ---------------------------------------------------------------------------
const sync = await call('POST', '/api/progress',
  { name: 'Avery Diaz', classCode: CLASS, xp: 120, mastered: 10, totalQuestions: 708, tokens: 7 });
check('a first sync reports no grants yet', sync.j.grantTotal === 0, 'got ' + sync.j.grantTotal);

fs.resetCounters();
const grant = await call('POST', '/api/grant', { code: CLASS, pin: PIN, id: 'avery-diaz', tokens: 5 });
check('a grant succeeds', grant.status === 200 && grant.j.granted === 5, JSON.stringify(grant.j));
check('a grant costs no read', fs.reads() === 0, fs.reads() + ' read(s)');

const sync2 = await call('POST', '/api/progress',
  { name: 'Avery Diaz', classCode: CLASS, xp: 130, mastered: 11, totalQuestions: 708, tokens: 7 });
check('the next sync carries the running total', sync2.j.grantTotal === 5, 'got ' + sync2.j.grantTotal);

await call('POST', '/api/grant', { code: CLASS, pin: PIN, id: 'avery-diaz', tokens: 3 });
const sync3 = await call('POST', '/api/progress',
  { name: 'Avery Diaz', classCode: CLASS, xp: 140, mastered: 12, totalQuestions: 708, tokens: 15 });
check('grants accumulate rather than replace', sync3.j.grantTotal === 8, 'got ' + sync3.j.grantTotal);

// THE regression this guards: a student syncing must not erase what the
// instructor wrote on them. Before the update mask, the PATCH replaced the
// whole document and every grant vanished on the next finished round.
check('a student sync does not wipe the grant',
      (fs.get(SP('avery-diaz')) || {}).grantTotal === 8,
      JSON.stringify(fs.get(SP('avery-diaz'))));
check('the roster carries the balance she can see',
      (fs.get(SP('avery-diaz')) || {}).tokens === 15);

const noPin = await call('POST', '/api/grant', { code: CLASS, id: 'avery-diaz', tokens: 5 });
check('a grant without the PIN is refused', noPin.status === 401, 'got ' + noPin.status);

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' supply closet checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' supply closet checks hold');
