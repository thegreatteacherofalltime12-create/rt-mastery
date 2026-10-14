/**
 * A whole class has to be able to play.
 *
 * Every number on the projector was chosen for a class of ten. When the class
 * turned out to be twenty-five, Buy Time's forty clears were gone inside the
 * first two minutes: the room hit its target while most of the class was still
 * on its second question, and every answer after that came back "round is not
 * running". Measured here before the fix, sixty of a hundred answers were
 * refused at twenty-five students. Nothing in the suite noticed, because every
 * test room had two or three players in it.
 *
 * So this drives the REAL worker with a real class, at both sizes, and asserts
 * the thing the instructor actually cares about: everybody got to play.
 *
 *   node test/classsize.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';
const EACH = 4;                 // answers per student the instructor asked for
const SIZES = [2, 10, 25, 40];  // a tiny room, the old class, the new one, and bigger

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
  let j = {};
  try { j = await res.json(); } catch {}
  return { status: res.status, j };
}

const GAMES = ['buytime', 'fieldday', 'forecast', 'walkthrough'];

async function playBuyTime(size, createBody) {
  const names = [];
  for (let i = 0; i < size; i++) names.push('Student ' + String(i + 1).padStart(2, '0'));

  const mk = await call('POST', '/api/room', Object.assign(
    { action: 'create', classCode: CLASS, pin: PIN, game: 'buytime', minutes: 5 }, createBody));
  const code = mk.j.room.code;
  for (const name of names) {
    await call('POST', '/api/room/event', { classCode: CLASS, code, name, type: 'join', games: GAMES });
  }
  const started = await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });
  const target = (started.j.room.gs || started.j.room).target;

  // Round robin: everyone answers their first before anyone answers a second,
  // which is the friendliest possible order. If the round still shuts people
  // out here, a real room is worse.
  let taken = 0;
  const played = new Set();
  for (let k = 0; k < EACH; k++) {
    for (const name of names) {
      const r = await call('POST', '/api/room/event', {
        classCode: CLASS, code, name, type: 'clear', qid: 'q' + k,
        topic: 'Psychoanalytic', chapter: 'ch2', level: 1, bucket: 1
      });
      if (r.status === 200) { taken++; played.add(name); }
    }
  }
  return { target, taken, played: played.size, want: size * EACH, size };
}

for (const size of SIZES) {
  const r = await playBuyTime(size, { each: EACH });

  check('a class of ' + size + ' gets a target sized for it',
    r.target === EACH * size, 'target ' + r.target + ' for ' + size + ' students at ' + EACH + ' each');

  // The real regression: answers refused because the round shut early.
  check('a class of ' + size + ' all get to answer ' + EACH + ' times',
    r.taken === r.want, r.taken + ' of ' + r.want + ' answers were taken');

  check('every student in a class of ' + size + ' got to play',
    r.played === size, r.played + ' of ' + size + ' students answered at all');
}

// ---------------------------------------------------------------------------
// The per-student cap has to bind at BOTH ends. A flat share of the target
// caps nothing once the class is large; a multiple of a fair share caps
// nothing once the class is tiny, because three fair shares in a room of two
// is more than the whole round.
// ---------------------------------------------------------------------------
async function capFor(size, each) {
  const names = [];
  for (let i = 0; i < size; i++) names.push('Capper ' + i);
  const mk = await call('POST', '/api/room', {
    action: 'create', classCode: CLASS, pin: PIN, game: 'buytime', each, minutes: 5
  });
  const code = mk.j.room.code;
  for (const name of names) {
    await call('POST', '/api/room/event', { classCode: CLASS, code, name, type: 'join', games: GAMES });
  }
  const s = await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });
  const g = s.j.room.gs || s.j.room;
  return { cap: g.perStudentCap, target: g.target };
}

for (const size of [2, 10, 25]) {
  const { cap, target } = await capFor(size, EACH);
  check('in a class of ' + size + ' no student can take the whole round',
    cap < target, 'cap ' + cap + ' against a target of ' + target);
  check('in a class of ' + size + ' the cap still lets a student do real work',
    cap >= EACH, 'cap ' + cap + ' against ' + EACH + ' each');
}

// A big class must not let one student end the round alone.
const big = await capFor(25, EACH);
check('one student cannot clear half a big round on their own',
  big.cap <= Math.ceil(big.target / 2), 'cap ' + big.cap + ' of ' + big.target);

// ---------------------------------------------------------------------------
// A projector that predates this change sends an absolute target and no
// `each`. Her number must be honoured exactly, not quietly resized.
// ---------------------------------------------------------------------------
// 55 deliberately: a round number like 40 is exactly what the scaled path
// would produce for ten students at four each, so this check passed whether or
// not the legacy branch existed at all.
const legacy = await playBuyTime(10, { target: 55 });
check('an older projector\'s absolute target is left alone',
  legacy.target === 55, 'target ' + legacy.target);

// ---------------------------------------------------------------------------
// The Walk-Through has the same disease from a different direction. It ends the
// moment the last barrier is found, so its length is set by how much building
// there is to sweep - the clock never gets a say. A fixed thirty-area board was
// three surveys each for ten students and under one each for twenty-five.
// ---------------------------------------------------------------------------
async function walkThrough(size, createBody) {
  const names = [];
  for (let i = 0; i < size; i++) names.push('Walker ' + i);
  const mk = await call('POST', '/api/room', Object.assign(
    { action: 'create', classCode: CLASS, pin: PIN, game: 'walkthrough', minutes: 15 }, createBody));
  const code = mk.j.room.code;
  for (const name of names) {
    await call('POST', '/api/room/event', { classCode: CLASS, code, name, type: 'join', games: GAMES });
  }
  const started = await call('POST', '/api/room', { action: 'start', classCode: CLASS, pin: PIN, code });
  const g0 = started.j.room.gs || started.j.room;

  // Sweep the board until the round shuts, which is when the last barrier is
  // found. That count IS the length of the round.
  let surveyed = 0;
  for (let cell = 0; cell < 200; cell++) {
    const r = await call('POST', '/api/room/event', {
      classCode: CLASS, code, name: names[cell % size], type: 'clear',
      qid: 'q' + cell, topic: 'Access', chapter: 'ch7', cell: cell % g0.areas
    });
    if (r.status !== 200) break;
    if (r.j.surveyed) surveyed++;
  }
  return { areas: g0.areas, barriers: g0.total, surveyed, per: surveyed / size, size };
}

for (const size of [2, 10, 25, 40]) {
  const w = await walkThrough(size, { each: 3, maxAreas: 90 });

  check('a class of ' + size + ' gets a building sized for it',
    w.areas === Math.min(90, Math.max(6, 3 * size)),
    'areas ' + w.areas + ' for ' + size + ' students at 3 each');

  check('a class of ' + size + ' gets barriers in proportion to the building',
    w.barriers === Math.min(24, Math.max(1, Math.round(w.areas / 5))),
    'barriers ' + w.barriers + ' in ' + w.areas + ' areas');

  // The regression: a round that is over before most of the class has answered.
  check('a class of ' + size + ' gets more than one survey each',
    w.per > 1.5, w.per.toFixed(1) + ' surveys each (' + w.surveyed + ' over ' + size + ' students)');
}

// The Worker must never build a board bigger than the projector can NAME, or
// the wall fills with blank cells. An older projector reports nothing and has
// thirty names.
const narrow = await walkThrough(25, { each: 3 });
check('the board never outruns what the client can name',
  narrow.areas === 30, 'areas ' + narrow.areas + ' with no maxAreas reported');

const fixedBoard = await walkThrough(10, { areas: 24, barriers: 5 });
check('an older projector\'s absolute board is left alone',
  fixedBoard.areas === 24 && fixedBoard.barriers === 5,
  'areas ' + fixedBoard.areas + ' barriers ' + fixedBoard.barriers);

restore();
if (failures.length) {
  console.error('\nCLASS SIZE FAILURES:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' class size checks hold');
