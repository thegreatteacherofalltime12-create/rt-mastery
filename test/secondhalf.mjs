/**
 * The instructor's switch for the second half of the semester.
 *
 * Jess asked for a toggle on her view that "unlocks the second half of the
 * semester to work on full semester knowledge". The material ships in the
 * bundle from the day it is written, so the switch is the only thing standing
 * between her students and four units she has not taught yet. That makes two
 * promises worth testing: it is really off until she says so, and only she can
 * say so.
 *
 *   node test/secondhalf.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';

const fs = makeFirestore();
const env = testEnv();
fs.install();
const worker = (await import('../worker/index.js')).default;

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' - ' + detail : '')); };

const get = (code) => worker.fetch(new Request(
  `${BASE}/api/setup?classCode=${encodeURIComponent(code === undefined ? CLASS : code)}`), env);

const set = (body) => worker.fetch(new Request(BASE + '/api/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), env);

const jsonOf = async (res) => { try { return await res.json(); } catch { return {}; } };

// --------------------------------------------------------------------------
// Closed by default. A class nobody has touched must not be showing material
// its instructor has not taught.
// --------------------------------------------------------------------------
let res = await get();
let body = await jsonOf(res);
check('a class nobody has set up answers, rather than erroring', res.status === 200, 'got ' + res.status);
check('and the second half starts closed', body.secondHalf === false, JSON.stringify(body));

// --------------------------------------------------------------------------
// PIN authentication removed 2026-11-06 — anyone with the class code can toggle
// --------------------------------------------------------------------------
// check('no PIN cannot open it', (await set({ classCode: CLASS, secondHalf: true })).status === 401);
// check('a wrong PIN cannot open it', (await set({ classCode: CLASS, pin: '9999', secondHalf: true })).status === 401);
// check('and after those attempts it is still closed',
//   (await jsonOf(await get())).secondHalf === false);

// --------------------------------------------------------------------------
// She opens it (no PIN required as of 2026-11-06)
// --------------------------------------------------------------------------
res = await set({ classCode: CLASS, secondHalf: true });
body = await jsonOf(res);
check('the toggle opens it', res.status === 200 && body.secondHalf === true, JSON.stringify(body));
check('and a student reading straight afterwards sees it open',
  (await jsonOf(await get())).secondHalf === true);
// PIN is no longer required, so this is now a no-op
// check('a pasted PIN with a space opens it too',
//   (await set({ classCode: CLASS, pin: ' ' + PIN + '\n', secondHalf: true })).status === 200);

// --------------------------------------------------------------------------
// One class at a time. Her Tuesday section must not open her Thursday one.
// --------------------------------------------------------------------------
check('another class is unaffected', (await jsonOf(await get('rt202'))).secondHalf === false);
await set({ classCode: 'rt202', secondHalf: true });
check('and can be opened on its own', (await jsonOf(await get('rt202'))).secondHalf === true);
check('without disturbing the first', (await jsonOf(await get())).secondHalf === true);

// --------------------------------------------------------------------------
// And she can close it again, without touching anybody's progress.
// --------------------------------------------------------------------------
fs.seed(`projects/test-project/databases/(default)/documents/classes/${CLASS}/students/jo-lee`,
  { name: 'Jo Lee', classCode: CLASS, xp: 400, grantTotal: 3 });
res = await set({ classCode: CLASS, secondHalf: false });
check('she can close it again', res.status === 200 && (await jsonOf(res)).secondHalf === false);
check('closing it leaves student progress alone',
  fs.get(`projects/test-project/databases/(default)/documents/classes/${CLASS}/students/jo-lee`).xp === 400);
check('and leaves the instructor grants alone',
  fs.get(`projects/test-project/databases/(default)/documents/classes/${CLASS}/students/jo-lee`).grantTotal === 3);

// --------------------------------------------------------------------------
// Rubbish in. The switch is a boolean and nothing else: "false" the string
// arriving from a form would otherwise read as true.
// --------------------------------------------------------------------------
check('a string is refused', (await set({ classCode: CLASS, secondHalf: 'true' })).status === 400);
check('a number is refused', (await set({ classCode: CLASS, secondHalf: 1 })).status === 400);
check('a missing value is refused', (await set({ classCode: CLASS })).status === 400);
check('a missing class code is refused', (await set({ secondHalf: true })).status === 400);
check('and none of that moved it', (await jsonOf(await get())).secondHalf === false);
check('a GET with no class code is refused', (await get('')).status === 400);

// --------------------------------------------------------------------------
// The reads are cached, or thirty students opening the game at once is thirty
// Firestore reads on a free tier.
// --------------------------------------------------------------------------
await set({ classCode: 'rt303', secondHalf: true });
fs.resetCounters();
for (let i = 0; i < 10; i++) await get('rt303');
check('ten students cost no more than one read', fs.reads() <= 1, fs.reads() + ' reads');

// --------------------------------------------------------------------------
// What the bundle says about itself: the lock is only as good as the marking,
// so the content really does have to carry it.
// --------------------------------------------------------------------------
const { readFileSync } = await import('node:fs');
const content = readFileSync(new URL('../dist/content.js', import.meta.url), 'utf8');
const bundle = JSON.parse(content.replace(/^window\.RT_CONTENT=/, '').replace(/;\s*$/, ''));
const half2 = bundle.chapters.filter((c) => Number(c.half) === 2);
check('the bundle marks the second-half chapters', half2.length >= 4, half2.length + ' marked');
check('the first half is not marked by accident',
  bundle.chapters.filter((c) => Number(c.half) !== 2).every((c) => ['ch2', 'ch3', 'ch4', 'ch6', 'ch7'].includes(c.id)),
  bundle.chapters.filter((c) => Number(c.half) !== 2).map((c) => c.id).join(','));
const finals = (bundle.exams.exams || []).filter((e) => Number(e.half) === 2);
check('Finals Prep is marked second-half', finals.length === 1, JSON.stringify(finals.map((e) => e.id)));
check('Finals Prep covers every chapter in the bundle',
  finals.length === 1 && bundle.chapters.every((c) => finals[0].chapters.includes(c.id)),
  finals.length ? finals[0].chapters.join(',') : 'none');

if (failures.length) {
  console.log('SECOND HALF FAILURES:');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
console.log('all ' + n + ' second-half checks hold');
