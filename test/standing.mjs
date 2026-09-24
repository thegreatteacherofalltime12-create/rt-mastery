/**
 * The Standing Order. Most of this file is about the thing that must NOT
 * happen: falling short has to leave no trace at all.
 *
 *   node test/standing.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const MARK = `projects/test-project/databases/(default)/documents/classes/${CLASS}/meta/standing`;

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
const attempt = (name, correct, seconds, asked = 10) =>
  call('POST', '/api/standing', { classCode: CLASS, name, correct, seconds, asked });

// ---------------------------------------------------------------------------
// Nobody holds it yet.
// ---------------------------------------------------------------------------
const empty = await call('GET', `/api/standing?classCode=${CLASS}`);
check('an untouched class has no holder', empty.j.standing.holder === null, JSON.stringify(empty.j));
check('and no bar to beat', empty.j.standing.bar === 0);

// ---------------------------------------------------------------------------
// The clamp. This is what makes a solo run and one snatched between classes
// comparable: without it a lucky sprint posts a rate nobody can reach.
// ---------------------------------------------------------------------------
const sprint = await attempt('Avery Diaz', 3, 20);      // 3 right in 20s
check('a sub-minute sprint is clamped to a minute', sprint.j.rate === 180,
      'got ' + sprint.j.rate);   // 3 per minute -> 180/hr, not 540/hr
check('the first claim takes the mark', sprint.j.took === true);

const slower = await attempt('Sam Okafor', 10, 300);    // 10 right in 5 min
check('a longer honest run is rated fairly', slower.j.rate === 120, 'got ' + slower.j.rate);
check('and falls short of the sprint', slower.j.took === false);

// ---------------------------------------------------------------------------
// FALLING SHORT LEAVES NO TRACE. This is the feature, not a detail.
// ---------------------------------------------------------------------------
fs.resetCounters();
const missed = await attempt('Jo Bell', 4, 600);
check('falling short writes nothing at all', fs.writes.length === 0, fs.writes.length + ' write(s)');
check('falling short names nobody', JSON.stringify(missed.j).indexOf('Jo Bell') === -1,
      JSON.stringify(missed.j));
check('the holder is unchanged after a failed attempt',
      missed.j.standing.holder === 'Avery Diaz', missed.j.standing.holder);
check('a failed attempt still tells the student their own number',
      missed.j.rate === 24 && missed.j.took === false, 'rate ' + missed.j.rate);

const stored = fs.get(MARK);
check('the document holds exactly one holder', stored.holder === 'avery-diaz', JSON.stringify(stored));
check('there is no list of anybody else',
      JSON.stringify(stored).indexOf('Jo Bell') === -1 &&
      JSON.stringify(stored).indexOf('Sam Okafor') === -1,
      JSON.stringify(stored));

// ---------------------------------------------------------------------------
// Beating it takes it, and only then is anything written.
// ---------------------------------------------------------------------------
// correct is clamped to what was actually asked, so a bigger run needs a
// bigger `asked` - the client cannot claim 20 right out of 10.
const overclaim = await attempt('Sam Okafor', 20, 300, 10);
check('correct cannot exceed asked', overclaim.j.rate === 120, 'got ' + overclaim.j.rate);

fs.resetCounters();
const taken = await attempt('Sam Okafor', 20, 300, 20);   // 240/hr on a 20 question run
check('beating the mark takes it', taken.j.took === true && taken.j.standing.holder === 'Sam Okafor',
      JSON.stringify(taken.j.standing));
check('taking it costs exactly one write', fs.writes.length === 1, fs.writes.length + ' write(s)');
check('the previous holder is not mentioned anywhere',
      JSON.stringify(fs.get(MARK)).indexOf('Avery') === -1, JSON.stringify(fs.get(MARK)));

// ---------------------------------------------------------------------------
// The mark eases. This is how the weakest student ends up holding it inside a
// fortnight WITHOUT ever beating anybody - the bar comes down to meet them.
// ---------------------------------------------------------------------------
// The mark is cached for a minute and keyed on the class, so each ageing
// scenario gets its own class rather than trying to defeat the cache.
function seedAged(cls, rate, days) {
  fs.seed(`projects/test-project/databases/(default)/documents/classes/${cls}/meta/standing`, {
    holder: 'sam-okafor', holderName: 'Sam Okafor', rate: rate,
    correct: 20, asked: 20, seconds: 300,
    setAt: new Date(Date.now() - days * 86400000).toISOString()
  });
}

seedAged('fresh1', 240, 1);
let view = (await call('GET', '/api/standing?classCode=fresh1')).j.standing;
check('inside the grace period the mark is at full height', view.bar === 240 && !view.easing,
      'bar ' + view.bar);

seedAged('eased6', 240, 6);   // 3 days past grace -> 30% off
view = (await call('GET', '/api/standing?classCode=eased6')).j.standing;
check('after the grace period the mark eases', view.bar === 168 && view.easing === true,
      'bar ' + view.bar);
check('but the rate that was actually set is still reported', view.rate === 240, 'rate ' + view.rate);

seedAged('floored', 240, 60);
view = (await call('GET', '/api/standing?classCode=floored')).j.standing;
check('the mark never eases below its floor', view.bar === 96, 'bar ' + view.bar);   // 40% of 240

// A modest run now takes it, having beaten no person: the bar came down to
// meet them, and the former holder is never told they lost it.
const modest = await call('POST', '/api/standing',
  { classCode: 'floored', name: 'Jo Bell', correct: 10, seconds: 300, asked: 10 });
check('a modest run takes an eased mark', modest.j.took === true,
      'rate ' + modest.j.rate + ' vs bar ' + modest.j.bar);
check('the weakest student can hold it without beating anyone',
      modest.j.standing.holder === 'Jo Bell', modest.j.standing.holder);

// ---------------------------------------------------------------------------
// The client cannot name its own rate.
// ---------------------------------------------------------------------------
const cheat = await call('POST', '/api/standing',
  { classCode: CLASS, name: 'Avery Diaz', correct: 9999, seconds: 1, asked: 9999 });
check('correct answers cannot exceed what was asked', cheat.j.rate <= 3600,
      'got ' + cheat.j.rate);
const noName = await call('POST', '/api/standing', { classCode: CLASS, correct: 5, seconds: 300 });
check('an attempt without a name is refused', noName.status === 400, 'got ' + noName.status);

restore();

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + n + ' Standing Order checks FAILED:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' Standing Order checks hold');
