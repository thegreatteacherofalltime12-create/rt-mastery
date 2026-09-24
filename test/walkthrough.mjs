/**
 * The Walk-Through. The load-bearing property is that the hidden plan never
 * leaves the server: if the layout rode along on the wire, anyone with a phone
 * could read the answers out of a network tab.
 *
 *   node test/walkthrough.mjs
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
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' — ' + detail : '')); };

async function call(method, path, body) {
  const res = await worker.fetch(new Request(BASE + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

const room = await call('POST', '/api/room',
  { action: 'create', classCode: CLASS, pin: PIN, game: 'walkthrough', areas: 12, barriers: 3, minutes: 15 });
const code = room.j.room.code;
check('a walk-through room is created', room.status === 200 && room.j.room.game === 'walkthrough');
check('it knows how many barriers are out there', room.j.room.gs.total === 3);
check('nothing is surveyed yet', room.j.room.gs.surveyed === 0 && room.j.room.gs.found === 0);

// ---------------------------------------------------------------------------
// THE PLAN IS SECRET. This is the whole reason the game is playable.
// ---------------------------------------------------------------------------
const stored = fs.get(P(code));
check('the plan IS stored, server-side', Array.isArray(stored.gs.plan) && stored.gs.plan.length === 3,
      JSON.stringify(stored.gs.plan));
check('the plan never appears on the create response',
      JSON.stringify(room.j).indexOf('plan') === -1, JSON.stringify(room.j).slice(0, 200));

const polled = await call('GET', `/api/room?classCode=${CLASS}&code=${code}`);
check('the plan never appears on a poll either',
      JSON.stringify(polled.j).indexOf('plan') === -1, JSON.stringify(polled.j).slice(0, 200));
check('a poll carries only what has been surveyed',
      Object.keys(polled.j.room.gs).sort().join(',') === 'areas,done,endsAtMs,found,seen,startMinutes,surveyed,total',
      Object.keys(polled.j.room.gs).join(','));

await call('POST', '/api/room/event',
  { classCode: CLASS, code, name: 'Avery Diaz', type: 'join', games: ['buytime', 'walkthrough'] });
await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });

const plan = stored.gs.plan.slice();
const clearCell = [...Array(12).keys()].find((i) => plan.indexOf(i) === -1);

const survey = (cell, type = 'clear') => call('POST', '/api/room/event',
  { classCode: CLASS, code, name: 'Avery Diaz', type, qid: 'ch2-01', topic: 'x', chapter: 'ch2', cell });

// ---------------------------------------------------------------------------
// A correct answer buys the look. A wrong one costs the room nothing.
// ---------------------------------------------------------------------------
fs.resetCounters();
const missed = await survey(plan[0], 'miss');
check('getting it wrong surveys nothing', missed.j.surveyed === false);
check('getting it wrong writes nothing', fs.writes.length === 0, fs.writes.length + ' write(s)');
check('and does not reveal the area',
      (await call('GET', `/api/room?classCode=${CLASS}&code=${code}`)).j.room.gs.seen[plan[0]] === undefined);

const cleanRoom = await survey(clearCell);
check('a clear area reports no barrier', cleanRoom.j.barrier === null, JSON.stringify(cleanRoom.j));
check('a clear area still counts as surveyed', cleanRoom.j.surveyed === true);
check('finding nothing does not move the count', cleanRoom.j.found === 0);

const hit = await survey(plan[0]);
check('a barrier is found', !!hit.j.barrier, JSON.stringify(hit.j));
check('the barrier has a kind a student can name',
      ['stairs', 'curb', 'door', 'heavy', 'signage', 'transfer', 'noise', 'lighting'].indexOf(hit.j.barrier) > -1,
      hit.j.barrier);
check('the count moves', hit.j.found === 1);

// Assert against the STORED DOCUMENT, not just the response. The response is
// built from the local mirror, so it looks perfect even when the write went
// somewhere useless - which is exactly what happened the first time.
const afterHit = fs.get(P(code));
check('the survey actually landed in the document',
      afterHit.gs.seen[String(plan[0])] === hit.j.barrier,
      JSON.stringify(afterHit.gs.seen));
check('a clear area landed too', afterHit.gs.seen[String(clearCell)] === 'clear',
      JSON.stringify(afterHit.gs.seen));
check('no surveyed area is stored as null',
      Object.keys(afterHit.gs.seen).every(function (k) { return !!afterHit.gs.seen[k]; }),
      JSON.stringify(afterHit.gs.seen));
check('the found count landed in the document', afterHit.gs.found === 1,
      'got ' + afterHit.gs.found);

// surveying the same area twice is free and not an error
fs.resetCounters();
const again = await survey(plan[0]);
check('surveying somewhere already done is not an error', again.status === 200 && again.j.already === true);
check('and costs nothing', fs.writes.length === 0, fs.writes.length + ' write(s)');

// a cell outside the plan is refused
const daft = await survey(999);
check('an area that does not exist is refused', daft.status === 400, 'got ' + daft.status);

// ---------------------------------------------------------------------------
// Finding them all ends the round, with the ONE terminal word.
// ---------------------------------------------------------------------------
await survey(plan[1]);
const last = await survey(plan[2]);
check('finding them all finishes the audit', last.j.done === true, JSON.stringify(last.j));
check('and writes the one terminal word', last.j.room.state === 'ended', last.j.room.state);
check('the wall can say how many were found', last.j.room.gs.found === 3);

// even at the end, the plan is not on the wire
check('the plan is still not on the wire at the end',
      JSON.stringify(last.j).indexOf('"plan"') === -1);
// and nothing per-student was ever recorded
check('no per-student record exists anywhere',
      Object.keys(fs.get(P(code)).players['avery-diaz']).join(',') === 'name',
      JSON.stringify(fs.get(P(code)).players['avery-diaz']));

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' Walk-Through checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' Walk-Through checks hold');
