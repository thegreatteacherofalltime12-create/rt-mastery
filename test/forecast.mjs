/**
 * Beat the Forecast. The point of this file is the privacy property: the room
 * document must hold two integers for the WHOLE class and nothing per student,
 * so there is nothing for the projector to leak even by accident.
 *
 *   node test/forecast.mjs
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
  { action: 'create', classCode: CLASS, pin: PIN, game: 'forecast', holes: 10, minutes: 12 });
const code = room.j.room.code;
check('a forecast room is created', room.status === 200 && room.j.room.game === 'forecast');
check('it starts level with its forecast', room.j.room.gs.margin === 0, JSON.stringify(room.j.room.gs));

for (const name of ['Avery Diaz', 'Sam Okafor', 'Jo Bell']) {
  await call('POST', '/api/room/event',
    { classCode: CLASS, code, name, type: 'join', games: ['buytime', 'forecast'] });
}
await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });

const hole = (name, type, expected, defend) => call('POST', '/api/room/event',
  { classCode: CLASS, code, name, type, qid: 'ch2-01', topic: 'Gestalt', chapter: 'ch2', expected, defend });

// Getting one you were unlikely to get is worth a lot.
const upset = await hole('Jo Bell', 'clear', 40);
check('beating a low expectation pays the difference', upset.j.delta === 60, 'got ' + upset.j.delta);
check('the room margin moves by that much', upset.j.room.gs.margin === 0.6,
      'got ' + upset.j.room.gs.margin);

// Getting one you were expected to get is worth almost nothing.
const expectedWin = await hole('Avery Diaz', 'clear', 90);
check('clearing a high expectation pays little', expectedWin.j.delta === 10, 'got ' + expectedWin.j.delta);

// THE POINT: missing one you were expected to get costs, and missing one you
// were not expected to get barely registers.
const badMiss = await hole('Avery Diaz', 'miss', 90);
check('missing a high expectation costs a lot', badMiss.j.delta === -90, 'got ' + badMiss.j.delta);
const softMiss = await hole('Jo Bell', 'miss', 20);
check('missing a low expectation costs little', softMiss.j.delta === -20, 'got ' + softMiss.j.delta);

// the forecast is charged whether or not the answer lands - that is what makes
// it a prediction rather than a score
check('every hole counts towards the room total', softMiss.j.room.gs.answered === 4,
      'got ' + softMiss.j.room.gs.answered);

// 'Defend it' doubles both sides.
const defendWin = await hole('Sam Okafor', 'clear', 90, true);
check('defending and winning pays double the margin', defendWin.j.delta === 20, 'got ' + defendWin.j.delta);
const defendLoss = await hole('Sam Okafor', 'miss', 90, true);
check('defending and losing costs double', defendLoss.j.delta === -180, 'got ' + defendLoss.j.delta);

// The client cannot claim it was expected to fail and then bank a huge margin.
const cheat = await hole('Jo Bell', 'clear', -500);
check('a claimed expectation is clamped at the bottom', cheat.j.expected === 5, 'got ' + cheat.j.expected);
const cheat2 = await hole('Jo Bell', 'miss', 500);
check('a claimed expectation is clamped at the top', cheat2.j.expected === 95, 'got ' + cheat2.j.expected);

// ---------------------------------------------------------------------------
// THE PRIVACY PROPERTY. This is the whole reason the format is shaped this way.
// ---------------------------------------------------------------------------
const doc = fs.get(P(code));
const wire = JSON.stringify((await call('GET', `/api/room?classCode=${CLASS}&code=${code}`)).j.room);

check('the stored game state is two integers and a count for the whole class',
      Object.keys(doc.gs).sort().join(',') === 'actual,endsAtMs,expected,holes',
      Object.keys(doc.gs).join(','));
check('no student margin is stored anywhere',
      JSON.stringify(doc.gs).indexOf('avery') === -1 &&
      JSON.stringify(doc.gs).indexOf('Avery') === -1,
      JSON.stringify(doc.gs));
check('players carry identity only, never a score',
      Object.keys(doc.players['avery-diaz']).join(',') === 'name',
      JSON.stringify(doc.players['avery-diaz']));
check('the wire carries no per-student number at all',
      wire.indexOf('margin') > -1 && wire.indexOf('delta') === -1 &&
      wire.indexOf('expected') === -1,
      wire.slice(0, 220));

// a margin can go negative and that is fine - it is the ROOM's, not a person's
check('the room margin can be negative', typeof doc.gs.actual === 'number' &&
      typeof doc.gs.expected === 'number');

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' forecast checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' Beat the Forecast checks hold');
