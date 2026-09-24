/**
 * The seam's own guarantees. These are the failures the seam exists to prevent,
 * so each one is written as "the thing that used to happen must not happen".
 *
 *   node test/seam.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';
const P = (code) => `projects/test-project/databases/(default)/documents/classes/${CLASS}/rooms/${code}`;

const fs = makeFirestore();
const env = testEnv();
const restore = fs.install();
const worker = (await import('../worker/index.js')).default;

const failures = [];
let n = 0;
function check(label, cond, detail) {
  n++;
  if (!cond) failures.push(label + (detail ? ' — ' + detail : ''));
}

async function call(method, path, body) {
  const res = await worker.fetch(new Request(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// 1. An unknown game must never be rendered as Buy Time.
//
// Before the seam, publicRoom was a whitelist with `|| 40` and `|| 5`
// fallbacks, so ANY document came back as a plausible Buy Time board:
// cleared 0, pool [], perStudentCap 24. Both clients rendered it happily. The
// second game would not have failed loudly - it would have put a confident
// wrong scoreboard on a projector in front of a class.
// ---------------------------------------------------------------------------
fs.seed(P('AAAA'), {
  code: 'AAAA', classCode: CLASS, game: 'fieldday', state: 'running', stage: 'lap2',
  cfg: { lanes: 5 }, gs: { lanes: [3, 1, 4, 0, 2] },
  players: { 'avery-diaz': { name: 'Avery Diaz' } },
  createdAt: new Date().toISOString()
});

const unknown = await call('GET', `/api/room?classCode=${CLASS}&code=AAAA`);
check('an unknown game still returns the room', unknown.status === 200, 'got ' + unknown.status);
check('an unknown game names itself on the wire', unknown.j.room && unknown.j.room.game === 'fieldday');
check('an unknown game carries its stage', unknown.j.room.stage === 'lap2');
check('an unknown game has NO fabricated Buy Time board',
      unknown.j.room.target === undefined &&
      unknown.j.room.cleared === undefined &&
      unknown.j.room.pool === undefined &&
      unknown.j.room.perStudentCap === undefined,
      JSON.stringify(unknown.j.room));
check('an unknown game projects no game state', unknown.j.room.gs === null);

// ---------------------------------------------------------------------------
// 2. A stale phone is refused BEFORE it costs a write.
//
// It must not be added to players, and it must not half-play.
// ---------------------------------------------------------------------------
fs.resetCounters();
const stale = await call('POST', '/api/room/event',
  { classCode: CLASS, code: 'AAAA', name: 'Sam Okafor', type: 'join', games: ['buytime'] });
check('a stale client is refused', stale.status === 426, 'got ' + stale.status);
check('the refusal names the game it cannot play', stale.j.game === 'fieldday');
check('a refused client costs no write', fs.writes.length === 0, fs.writes.length + ' write(s)');
check('a refused client is not added to the room',
      !fs.get(P('AAAA')).players['sam-okafor']);

// a client that DOES know the game is admitted
fs.resetCounters();
const current = await call('POST', '/api/room/event',
  { classCode: CLASS, code: 'AAAA', name: 'Sam Okafor', type: 'join', games: ['buytime', 'fieldday'] });
check('a current client is admitted', current.status === 200, 'got ' + current.status);

// ---------------------------------------------------------------------------
// 3. Buy Time scoring must not run in a room that is not Buy Time.
//
// Before the seam the only gate was state === 'running', so a student's stale
// tab could increment cleared and endsAtMs on a document that has neither.
// ---------------------------------------------------------------------------
fs.resetCounters();
const wrongGame = await call('POST', '/api/room/event',
  { classCode: CLASS, code: 'AAAA', name: 'Avery Diaz', type: 'clear',
    qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2', level: 3, bucket: 0 });
check('a Buy Time clear is refused by another game', wrongGame.status === 400, 'got ' + wrongGame.status);
check('a refused event writes nothing', fs.writes.length === 0, fs.writes.length + ' write(s)');
const afterDoc = fs.get(P('AAAA'));
check('a refused event does not invent Buy Time fields',
      afterDoc.gs.cleared === undefined && afterDoc.gs.endsAtMs === undefined,
      JSON.stringify(afterDoc.gs));

// ---------------------------------------------------------------------------
// 4. An unknown game id at create is rejected outright.
// ---------------------------------------------------------------------------
const badCreate = await call('POST', '/api/room',
  { action: 'create', classCode: CLASS, pin: PIN, game: 'not-a-game' });
check('create refuses an unknown game', badCreate.status === 400, 'got ' + badCreate.status);

// ---------------------------------------------------------------------------
// 5. A room written before the seam still works, and migrates on first write.
// ---------------------------------------------------------------------------
fs.seed(P('BBBB'), {
  code: 'BBBB', classCode: CLASS, state: 'running',
  target: 10, startMinutes: 5, cleared: 3,
  endsAtMs: Date.now() + 120000, pool: [{ qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2' }],
  allHands: null, players: { 'avery-diaz': { name: 'Avery Diaz', cleared: 3 } },
  createdAt: new Date().toISOString()
});

const legacyRead = await call('GET', `/api/room?classCode=${CLASS}&code=BBBB`);
check('a pre-seam room reads as buytime', legacyRead.j.room.game === 'buytime');
check('a pre-seam room keeps its progress', legacyRead.j.room.cleared === 3, 'got ' + legacyRead.j.room.cleared);
check('a pre-seam room keeps its target', legacyRead.j.room.target === 10);
check('a pre-seam room keeps its pool', (legacyRead.j.room.pool || []).length === 1);

const legacyClear = await call('POST', '/api/room/event',
  { classCode: CLASS, code: 'BBBB', name: 'Avery Diaz', type: 'clear',
    qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0, fromPool: true });
check('a pre-seam room still scores', legacyClear.status === 200 && legacyClear.j.seconds === 10,
      'status ' + legacyClear.status + ' seconds ' + legacyClear.j.seconds);
const migrated = fs.get(P('BBBB'));
check('the document migrated to the new shape',
      migrated.game === 'buytime' && migrated.gs && migrated.cfg,
      JSON.stringify(Object.keys(migrated)));
check('migration did not lose the score', migrated.gs.cleared === 4, 'got ' + migrated.gs.cleared);
check('migration removed the flat fields', migrated.cleared === undefined && migrated.target === undefined);

// ---------------------------------------------------------------------------
// 6. Victory writes the ONE terminal word every delivered bundle tests for.
//
// A fourth state string would be invisible to cached clients, and a client that
// never recognises the end polls Firestore every four seconds forever.
// ---------------------------------------------------------------------------
const win = await call('POST', '/api/room',
  { action: 'create', classCode: CLASS, pin: PIN, target: 5, minutes: 5 });
const wc = win.j.room.code;
await call('POST', '/api/room/event', { classCode: CLASS, code: wc, name: 'Avery Diaz', type: 'join' });
await call('POST', '/api/room/event', { classCode: CLASS, code: wc, name: 'Sam Okafor', type: 'join' });
await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code: wc });
// target 5 x 0.6 => a cap of 3, so no one student can finish a round alone.
// That is the straggler rule, and it means a win needs at least two people.
let last = null;
for (let i = 0; i < 3; i++) {
  last = await call('POST', '/api/room/event',
    { classCode: CLASS, code: wc, name: 'Avery Diaz', type: 'clear',
      qid: 'ch2-0' + i, topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0 });
}
check('one student alone cannot finish a round', last.j.room.cleared === 3, 'got ' + last.j.room.cleared);
for (let i = 0; i < 2; i++) {
  last = await call('POST', '/api/room/event',
    { classCode: CLASS, code: wc, name: 'Sam Okafor', type: 'clear',
      qid: 'ch3-0' + i, topic: 'Relaxation', chapter: 'ch3', level: 1, bucket: 0 });
}
check("winning writes state 'ended', never a fourth word", last.j.room.state === 'ended',
      'got ' + last.j.room.state);
check('winning is recorded as a game fact', last.j.room.gs.won === true);
check('an old bundle can still derive the win from cleared >= target',
      last.j.room.cleared >= last.j.room.target,
      last.j.room.cleared + '/' + last.j.room.target);

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' seam guarantees FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' seam guarantees hold');
