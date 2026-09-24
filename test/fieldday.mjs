/**
 * Field Day. The first format built on the seam, so this doubles as proof that
 * adding a game costs nothing but its own registry entry.
 *
 *   node test/fieldday.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';

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

const room = await call('POST', '/api/room',
  { action: 'create', classCode: CLASS, pin: PIN, game: 'fieldday', laps: 6, minutes: 10 });
const code = room.j.room.code;
check('a Field Day room is created', room.status === 200 && room.j.room.game === 'fieldday',
      JSON.stringify(room.j).slice(0, 160));
check('it starts with no lanes moved', JSON.stringify(room.j.room.gs.lanes) === '{}');
check('it carries its own settings', room.j.room.gs.laps === 6);

// THE straggler property: no Buy Time board leaks in, and nothing per-student
// is ever projected.
check('no Buy Time fields leak into a Field Day room',
      room.j.room.target === undefined && room.j.room.pool === undefined &&
      room.j.room.perStudentCap === undefined && room.j.room.cleared === undefined,
      JSON.stringify(room.j.room));
check('the projection carries no per-student scores',
      room.j.room.gs.scores === undefined, JSON.stringify(room.j.room.gs));

for (const name of ['Avery Diaz', 'Sam Okafor']) {
  await call('POST', '/api/room/event',
    { classCode: CLASS, code, name, type: 'join', games: ['buytime', 'fieldday'] });
}
await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });

// a correct answer moves the lane its question came from
const one = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz',
  type: 'clear', qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0 });
check('a clear moves its own lane', one.j.room.gs.lanes.ch2 === 1, JSON.stringify(one.j.room.gs.lanes));
check('a clear moves no other lane', Object.keys(one.j.room.gs.lanes).length === 1);
check('a step is worth one', one.j.steps === 1, 'got ' + one.j.steps);

// a step is flat: a Recall answer moves a lane exactly as far as a Recognise one
const hard = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Sam Okafor',
  type: 'clear', qid: 'ch2-02', topic: 'Gestalt', chapter: 'ch2', level: 3, bucket: 0 });
check('a level 3 answer moves a lane the same distance as level 1', hard.j.steps === 1,
      'got ' + hard.j.steps);
check('the lane accumulated', hard.j.room.gs.lanes.ch2 === 2);

// a miss moves NOTHING. It only ever feeds the reteach cue.
const miss = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz',
  type: 'miss', qid: 'ch4-01', topic: 'APIE', chapter: 'ch4' });
check('a miss moves no lane', miss.j.room.gs.lanes.ch4 === undefined,
      JSON.stringify(miss.j.room.gs.lanes));
check('a miss is tallied for the reteach cue', miss.j.room.gs.misses.ch4 === 1);
check('a miss never moves a lane backwards', miss.j.room.gs.lanes.ch2 === 2);

await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Sam Okafor',
  type: 'miss', qid: 'ch4-02', topic: 'APIE', chapter: 'ch4' });

// the Focus card names the chapter the room is worst at and pays double for it
const focus = await call('POST', '/api/room',
  { action: 'focus', classCode: CLASS, pin: PIN, code });
check('focus names the worst chapter', focus.j.room.gs.focus &&
      focus.j.room.gs.focus.chapter === 'ch4', JSON.stringify(focus.j.room.gs.focus));

const focused = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz',
  type: 'clear', qid: 'ch4-01', topic: 'APIE', chapter: 'ch4', level: 1, bucket: 0 });
check('a focused lane pays double', focused.j.steps === 2, 'got ' + focused.j.steps);
check('the focused lane moved two', focused.j.room.gs.lanes.ch4 === 2);

const unfocused = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Avery Diaz',
  type: 'clear', qid: 'ch2-03', topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0 });
check('a lane outside the focus still pays one', unfocused.j.steps === 1, 'got ' + unfocused.j.steps);

// reaching the line ends the round, and the winner is a CHAPTER
let last = null;
for (let i = 0; i < 6; i++) {
  const r = await call('POST', '/api/room/event', { classCode: CLASS, code, name: 'Sam Okafor',
    type: 'clear', qid: 'ch2-1' + i, topic: 'Gestalt', chapter: 'ch2', level: 1, bucket: 0 });
  // once a lane crosses the line the round is over and further events are
  // refused, so keep the response that actually won it
  if (r.status !== 200) break;
  last = r;
  if (r.j.won) break;
}
check('the round stopped accepting events once it was won', !!last && !!last.j.won);
check('the winner is a chapter, not a student', last.j.room.gs.winner === 'ch2',
      'got ' + last.j.room.gs.winner);
check("a win still writes the one terminal word", last.j.room.state === 'ended',
      'got ' + last.j.room.state);

// and there is STILL nothing per-student anywhere on the wire
check('no player score reached the wire at any point',
      JSON.stringify(last.j.room).indexOf('cleared') === -1,
      JSON.stringify(last.j.room).slice(0, 200));

// a Buy Time verb must not work here
const wrong = await call('POST', '/api/room', { action: 'allhands', classCode: CLASS, pin: PIN, code });
check("Buy Time's all-hands is not a Field Day verb", wrong.status === 400, 'got ' + wrong.status);

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' Field Day checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' Field Day checks hold');
