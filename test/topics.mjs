/**
 * The per-topic breakdown, phone to professor.
 *
 * The instructor could see how MUCH each student had answered and a six-item
 * weak list each phone computed for itself. She could not see what any one of
 * them was getting right and wrong, which is the only thing that tells her what
 * to re-teach. This is the path that carries it: POST /api/progress stores a
 * right/seen pair per topic, GET /api/class hands back each student's own list
 * plus a class-wide roll-up.
 *
 * It is a wire test, so it asserts what the dashboard actually receives - not
 * what the worker happens to keep in memory.
 *
 *   node test/topics.mjs
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

const sync = (name, topics, extra) => call('POST', '/api/progress', Object.assign({
  name, classCode: CLASS, xp: 100, sessions: 4, mastered: 20, totalQuestions: 538,
  avgLevel: 2, weakTopics: [], topics
}, extra || {}));

const klass = () => call('GET', `/api/class?code=${CLASS}&pin=${PIN}`);

// ---------------------------------------------------------------------------
// The round trip.
// ---------------------------------------------------------------------------
await sync('Avery Diaz', [
  { t: 'Transference', r: 1, s: 6 },
  { t: 'Active Listening', r: 9, s: 10 }
]);
await sync('Sam Okafor', [
  { t: 'Transference', r: 2, s: 5 },
  { t: 'SMART Goals', r: 1, s: 8 }
]);

let c = await klass();
check('the class loads', c.status === 200, 'status ' + c.status);

const avery = (c.j.students || []).find((s) => s.name === 'Avery Diaz');
check('a student carries their own topic list', !!avery && Array.isArray(avery.topics));
check('right and seen both survive the round trip',
  !!avery && JSON.stringify(avery.topics.find((t) => t.t === 'Transference')) === '{"t":"Transference","r":1,"s":6}',
  JSON.stringify(avery && avery.topics));

// The roll-up is the whole class's answers, not a count of who flagged a topic.
const roll = {};
(c.j.classTopics || []).forEach((t) => { roll[t.topic] = t; });
check('the class roll-up sums right across students',
  roll['Transference'] && roll['Transference'].right === 3, JSON.stringify(roll['Transference']));
check('the class roll-up sums seen across students',
  roll['Transference'] && roll['Transference'].seen === 11);
check('the class roll-up counts how many students have met a topic',
  roll['Transference'] && roll['Transference'].students === 2);
check('a topic only one student has met says so',
  roll['SMART Goals'] && roll['SMART Goals'].students === 1);
check('percent is right over seen',
  roll['Active Listening'] && roll['Active Listening'].pct === 90, JSON.stringify(roll['Active Listening']));
check('the roll-up is weakest first',
  (c.j.classTopics || [])[0] && c.j.classTopics[0].topic === 'SMART Goals',
  (c.j.classTopics || []).map((t) => t.topic + ':' + t.pct).join(' '));

// ---------------------------------------------------------------------------
// A student who has not resynced since this shipped. Her document was written
// by the previous worker and has NO topics field at all - which is not a state
// POST /api/progress can produce any more, so it has to be seeded directly or
// the check below silently passes on a document that always had the field.
// The dashboard iterates this, so it must arrive as an array, not undefined,
// or one stale row throws the whole professor's page.
// ---------------------------------------------------------------------------
const JO = `projects/test-project/databases/(default)/documents/classes/${CLASS}/students/jo-fields`;
fs.seed(JO, {
  name: 'Jo Fields', classCode: CLASS, xp: 10, sessions: 1, mastered: 2,
  totalQuestions: 538, avgLevel: 1, weakTopics: [], tokens: 0, bestExam: 0,
  examRuns: [], updatedAt: new Date().toISOString()
});
check('the legacy document was seeded where the worker will read it', fs.has(JO));
check('and it genuinely has no topics field', !('topics' in (fs.get(JO) || {})));
// The class payload is cached for 20s and seeding Firestore directly does not
// invalidate it, so without this the read below would be served the payload
// from before Jo existed - and the check would pass on the wrong document.
await sync('Avery Diaz', [
  { t: 'Transference', r: 1, s: 6 },
  { t: 'Active Listening', r: 9, s: 10 }
]);
c = await klass();
const jo = (c.j.students || []).find((s) => s.name === 'Jo Fields');
check('a legacy document really has no topics field',
  !!jo, 'the seeded student never came back');
check('a student who has not resynced still arrives with an array',
  !!jo && Array.isArray(jo.topics) && jo.topics.length === 0,
  'got ' + JSON.stringify(jo && jo.topics));

// ---------------------------------------------------------------------------
// It is client-supplied and it lands in a document every class read pays for,
// so it is clamped. A phone sending nonsense must not be able to bloat the
// document or put junk on the professor's screen.
// ---------------------------------------------------------------------------
const junk = [];
for (let i = 0; i < 400; i++) junk.push({ t: 'Topic ' + i, r: 1, s: 2 });
junk.push({ t: 'x'.repeat(500), r: 5, s: 5 });
junk.push({ t: 'Negative', r: -9, s: -9 });
junk.push({ t: '', r: 1, s: 1 });
junk.push({ t: 'Never seen', r: 0, s: 0 });
await sync('Mal Formed', junk);
c = await klass();
const mal = (c.j.students || []).find((s) => s.name === 'Mal Formed');
check('an over-long topic list is clamped', !!mal && mal.topics.length <= 120,
  'got ' + (mal && mal.topics.length));
check('a topic name is clamped',
  !!mal && mal.topics.every((t) => t.t.length <= 80));
check('negative counts cannot come through',
  !!mal && mal.topics.every((t) => t.r >= 0 && t.s >= 0));
check('a nameless topic is dropped', !!mal && mal.topics.every((t) => t.t !== ''));
check('a topic with no attempts is dropped',
  !!mal && !mal.topics.some((t) => t.t === 'Never seen'));

// A string where a number belongs must not reach the professor as NaN.
await sync('Odd Types', [{ t: 'Flow', r: 'three', s: '5' }]);
c = await klass();
const odd = (c.j.students || []).find((s) => s.name === 'Odd Types');
check('a non-numeric count becomes a number, not NaN',
  !!odd && odd.topics[0] && odd.topics[0].r === 0 && odd.topics[0].s === 5,
  JSON.stringify(odd && odd.topics));

// ---------------------------------------------------------------------------
// A renamed topic must not split one topic into two chips, for the breakdown
// exactly as it already does not for the weak list.
// ---------------------------------------------------------------------------
await sync('Old Build', [{ t: 'CBT', r: 1, s: 4 }]);
await sync('New Build', [{ t: 'Cognitive Behavioral Therapy', r: 1, s: 4 }]);
c = await klass();
const names = (c.j.classTopics || []).map((t) => t.topic);
check('a retired topic name folds into the current one in the roll-up',
  names.indexOf('CBT') === -1 && names.indexOf('Cognitive Behavioral Therapy') > -1,
  names.join(' | '));
const folded = (c.j.classTopics || []).find((t) => t.topic === 'Cognitive Behavioral Therapy');
check('the folded topic counts both students', folded && folded.students === 2,
  JSON.stringify(folded));
const oldBuild = (c.j.students || []).find((s) => s.name === 'Old Build');
check('a retired name folds in the student\'s own list too',
  oldBuild && oldBuild.topics[0] && oldBuild.topics[0].t === 'Cognitive Behavioral Therapy',
  JSON.stringify(oldBuild && oldBuild.topics));

// ---------------------------------------------------------------------------
// The student document must not have lost anything on the way.
// ---------------------------------------------------------------------------
check('the fields the dashboard already read are untouched',
  !!avery && avery.mastered === 20 && avery.totalQuestions === 538 && avery.avgLevel === 2);

restore();
if (failures.length) {
  console.error('\nTOPIC BREAKDOWN FAILURES:');
  failures.forEach((f) => console.error('  x ' + f));
  process.exit(1);
}
console.log('all ' + n + ' topic breakdown checks hold');
