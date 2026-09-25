/**
 * The level ladder. Everything else in test/ drives the Worker; nothing drove
 * src/app.js at all, which is how two defects shipped together:
 *
 *   1. sessions mixed levels, because a second predicate guessed at the level a
 *      question would be served at and had drifted from serve() itself;
 *   2. the ladder could not be climbed, because chapterMastery counted every
 *      question in a chapter against a level most of them can never be served
 *      at, so 80% was out of reach and no chapter ever promoted.
 *
 * Both are shape defects, not wording defects, so these checks are written
 * against the structure of whatever bank is present - they pass on the single
 * example chapter of a fresh clone and on the instructor's full bank.
 *
 *   node test/levels.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_JS = join(ROOT, 'dist', 'content.js');
const APP_JS = join(ROOT, 'src', 'app.js');

// `npm run deploy` runs the tests before the build, so dist/ may not exist yet.
if (!existsSync(CONTENT_JS)) execFileSync(process.execPath, [join(ROOT, 'build.js')], { stdio: 'ignore' });

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' — ' + detail : '')); };

// ---------------------------------------------------------------------------
// Load the real app.js. It is an IIFE that expects a browser, so it gets the
// smallest stub that lets it boot; its module.exports seam hands back the level
// math. Stubbing rather than re-implementing is the point - a copy of serve()
// in here would drift from serve() exactly the way servedLevel() did.
// ---------------------------------------------------------------------------
const stubEl = () => ({
  innerHTML: '', textContent: '', style: {}, classList: { toggle() {}, add() {}, remove() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  setAttribute() {}, getAttribute: () => null, focus() {},
  // A five-in-a-row streak pops a badge into the page, and a practice run long
  // enough to pay XP is long enough to hit five.
  appendChild() {}, removeChild() {}, remove() {}, contains: () => false
});
const store = {};
const sent = [];
const sandbox = {
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat,
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  // Every request the app makes is kept, so the level it TELLS THE ROOM can be
  // read back and compared with the level it showed and the level it paid. The
  // response is a miss on purpose: the room is not under test here, and a live
  // answer has to record and pay locally whether or not the Worker is reachable.
  fetch: (url, opt) => {
    sent.push({ url: String(url), body: opt && opt.body ? JSON.parse(opt.body) : null });
    return Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) });
  },
  scrollTo() {}, confirm: () => false, alert() {}, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { href: '', search: '', hash: '' },
  navigator: { userAgent: 'node' },
  document: {
    getElementById: stubEl, createElement: stubEl, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, body: stubEl(), documentElement: stubEl()
  },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  module: { exports: {} }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(CONTENT_JS, 'utf8'), sandbox, { filename: 'content.js' });
vm.runInContext(readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });

const A = sandbox.module.exports;
if (!A || !A.serve) { console.error('src/app.js did not export its level math — the test seam is gone'); process.exit(1); }

const { S, CHAPTERS, MAX_LEVEL, UNLOCK_AT, SESSION_SIZE, LEVEL_FLOOR } = A;
const LEVELS = [];
for (let lv = 1; lv <= MAX_LEVEL; lv++) LEVELS.push(lv);

const reset = () => { S.progress = {}; S.levels = {}; S.run = null; S.screen = 'map'; };
const masterAll = (ch, lv) => {
  A.servableAt(ch, lv).forEach((q) => {
    S.progress[A.recKey(q.id, lv)] = { box: 3, seen: 3, right: 3, wrong: 0, last: 1 };
  });
};

check('there is content to measure', CHAPTERS.length > 0);

// ---------------------------------------------------------------------------
// Purity: a session serves exactly one level.
// ---------------------------------------------------------------------------
reset();
for (const ch of CHAPTERS) {
  for (const lv of LEVELS) {
    const servable = A.servableAt(ch, lv);
    // Level 1 has no transform to fail, so every question is servable there -
    // with one exception, and only one. A question authored as free recall has
    // no four-option form to fall back to, so serve() stamps it 3 at every
    // level and it drops out of Recognise. Anything ELSE missing from level 1
    // means a transform started refusing questions, and the fallback story the
    // rest of this file rests on has stopped holding.
    const nativeFill = ch.questions.filter((q) => q.type === 'fill').length;
    if (lv === 1) check('level 1 serves the whole chapter bar free recall (' + ch.id + ')',
      servable.length === ch.questions.length - nativeFill,
      servable.length + ' of ' + ch.questions.length + ' less ' + nativeFill + ' free recall');
    if (!servable.length) continue;

    // Hand it the WHOLE chapter, the way a stale saved run or a future caller
    // would: filtering is buildSession's job, not the caller's.
    const pool = ch.questions.map((q) => Object.assign({ chapter: ch.id }, q));
    const want = Math.min(SESSION_SIZE, servable.length);
    let offLevel = 0, padded = 0, dupes = 0, wrongSize = 0;
    for (let i = 0; i < 25; i++) {
      const picked = A.buildSession(pool, want, lv);
      picked.forEach((q) => { if (A.serve(q, lv)._level !== lv) offLevel++; });
      if (picked.length > want) padded++;
      if (picked.length !== want) wrongSize++;
      if (new Set(picked.map((q) => q.id)).size !== picked.length) dupes++;
    }
    check('session is level-pure (' + ch.id + ' L' + lv + ')', offLevel === 0, offLevel + ' off-level views');
    check('session never pads past the pure pool (' + ch.id + ' L' + lv + ')', padded === 0);
    // The shape ramp reorders the round; it must never be a filter. A group
    // quietly left out builds a short round, or an empty one - and viewPlay
    // reads views[idx].q the moment the screen opens.
    check('session is exactly the size asked for (' + ch.id + ' L' + lv + ')', wrongSize === 0,
      wrongSize + ' of 25 rounds came back the wrong size, wanted ' + want);
    check('session never repeats a question (' + ch.id + ' L' + lv + ')', dupes === 0);
  }
}

// A question that cannot take the level must be filtered out, not served at 1.
reset();
for (const ch of CHAPTERS) {
  for (const lv of [2, 3]) {
    const whole = ch.questions.map((q) => Object.assign({ chapter: ch.id }, q));
    const servable = A.servableAt(ch, lv).length;
    if (servable === whole.length) continue;      // nothing to drop in this chapter
    const picked = A.buildSession(whole, whole.length, lv);
    check('an unservable question is dropped, not downgraded (' + ch.id + ' L' + lv + ')',
      picked.length === servable, picked.length + ' picked of ' + servable + ' servable');
  }
}

// ---------------------------------------------------------------------------
// Reachability: 80% must be attainable at every level a chapter can sit at.
// ---------------------------------------------------------------------------
for (const ch of CHAPTERS) {
  for (const lv of LEVELS) {
    reset();
    const pool = A.servableAt(ch, lv);
    check('mastery denominator is the servable subset (' + ch.id + ' L' + lv + ')',
      A.chapterMastery(ch, lv).total === pool.length,
      A.chapterMastery(ch, lv).total + ' vs ' + pool.length);
    if (!pool.length) continue;
    masterAll(ch, lv);
    const m = A.chapterMastery(ch, lv);
    check('80% is reachable (' + ch.id + ' L' + lv + ')', m.pct >= UNLOCK_AT,
      Math.round(m.pct * 100) + '%');
    check('mastery never exceeds 100% (' + ch.id + ' L' + lv + ')', m.pct <= 1,
      m.done + '/' + m.total);
  }
}

// A record written under a level the question cannot be served at is a leftover
// from the live round that used to stamp the wrong level. It must not count.
reset();
for (const ch of CHAPTERS) {
  const lv = MAX_LEVEL;
  ch.questions.forEach((q) => {
    S.progress[A.recKey(q.id, lv)] = { box: 3, seen: 3, right: 3, wrong: 0, last: 1 };
  });
  const m = A.chapterMastery(ch, lv);
  check('stale off-level records cannot push mastery past 100% (' + ch.id + ')', m.pct <= 1,
    m.done + '/' + m.total);
}

// ---------------------------------------------------------------------------
// The ladder: a chapter must be able to climb, and must never be promoted into
// a level it cannot fill.
// ---------------------------------------------------------------------------
for (const ch of CHAPTERS) {
  reset();
  for (let lv = 1; lv < MAX_LEVEL; lv++) {
    masterAll(ch, lv);
    const to = A.checkPromotion(ch.id);
    const next = A.servableAt(ch, lv + 1).length;
    if (next >= LEVEL_FLOOR) {
      check('chapter promotes ' + lv + ' -> ' + (lv + 1) + ' (' + ch.id + ')', to === lv + 1,
        'got ' + to + ' with ' + next + ' servable above');
    } else {
      check('promotion refuses a level it cannot fill (' + ch.id + ' -> L' + (lv + 1) + ')', to === null,
        next + ' servable, floor ' + LEVEL_FLOOR);
      break;
    }
  }
}

// Whatever level a chapter ends up at, practice must find something to serve.
for (const ch of CHAPTERS) {
  for (const lv of LEVELS) {
    reset();
    S.levels[ch.id] = lv;
    A.startPractice(ch.id);
    check('practice builds a non-empty run (' + ch.id + ' L' + lv + ')',
      !!(S.run && S.run.views.length));
    if (!S.run) continue;
    const served = new Set(S.run.views.map((v) => v.q._level || 1));
    check('practice run is one level (' + ch.id + ' L' + lv + ')', served.size === 1,
      'levels ' + [...served].join('/'));
    check('practice title matches what is served (' + ch.id + ' L' + lv + ')',
      S.run.level === (S.run.views[0].q._level || 1));
  }
}

// A device promoted before the floor guard existed can hold a level with
// nothing servable. Practice must climb back down rather than throw.
//
// No chapter in the present bank can reach that state - the smallest servable
// subset is 13 - so the state has to be BUILT, or this reads as a passing check
// while testing nothing at all. A chapter of plain four-option questions with
// no sixth option and no write-in key is servable at level 1 and nowhere else;
// saving it at level 3 is exactly the stranded device. It is added after every
// other check has run and taken out again straight away, so nothing above or
// below sees it.
reset();
for (const ch of CHAPTERS) {
  if (A.servableAt(ch, MAX_LEVEL).length) continue;
  S.levels[ch.id] = MAX_LEVEL;
  A.startPractice(ch.id);
  check('a stranded saved level still starts a round (' + ch.id + ')',
    !!(S.run && S.run.views.length));
}

const STRANDED = {
  id: 'zz-stranded', number: 99, title: 'Fixture',
  questions: Array.from({ length: 10 }, (_, i) => ({
    id: 'zz-' + i, type: 'mc', topic: 'Fixture',
    prompt: 'Fixture question ' + i, choices: ['a', 'b', 'c', 'd'], answer: 0, explain: 'Fixture.'
  }))
};
CHAPTERS.push(STRANDED);
try {
  reset();
  check('the fixture really is stranded above level 1',
    A.servableAt(STRANDED, 2).length === 0 && A.servableAt(STRANDED, MAX_LEVEL).length === 0,
    A.servableAt(STRANDED, 2).length + '/' + A.servableAt(STRANDED, MAX_LEVEL).length + ' servable');
  S.levels[STRANDED.id] = MAX_LEVEL;
  let threw = null;
  try { A.startPractice(STRANDED.id); } catch (e) { threw = e; }
  check('a stranded saved level does not throw', !threw, threw && threw.message);
  check('a stranded saved level still starts a round', !!(S.run && S.run.views.length),
    S.run ? S.run.views.length + ' views' : 'no run');
  check('a stranded saved level is HEALED, not just worked around',
    A.levelOf(STRANDED.id) === 1, 'left at ' + A.levelOf(STRANDED.id));
  check('and the round it builds is the level it walked down to',
    !!(S.run && S.run.level === 1 && S.run.views.every((v) => (v.q._level || 1) === 1)));
  check('promotion refuses to strand it again',
    A.checkPromotion(STRANDED.id) === null || A.servableAt(STRANDED, 2).length >= LEVEL_FLOOR);
} finally {
  CHAPTERS.splice(CHAPTERS.indexOf(STRANDED), 1);
  reset();
}

// ---------------------------------------------------------------------------
// Cross-chapter rounds. These are the ones the student hits straight off the
// map, and they used to serve each question at its own chapter's level - so
// three questions in a row could arrive in three different shapes.
// ---------------------------------------------------------------------------
const spreads = {
  'all at level 1': (c) => 1,
  'all at level 2': (c) => 2,
  'all at level 3': (c) => 3,
  'one chapter per level': (c, i) => (i % MAX_LEVEL) + 1
};
const modes = [
  ['Ghost Duel', A.startGhostDuel, A.GHOST_SIZE],
  ['Standing Order', A.startStandingOrder, A.SO_SIZE],
  ['Three Certainties', A.startCertainties, A.CERT_SIZE]
];
for (const [spread, pick] of Object.entries(spreads)) {
  for (const [name, start, size] of modes) {
    let mixed = 0, ran = 0, short = 0, mislabelled = 0;
    for (let i = 0; i < 15; i++) {
      reset();
      CHAPTERS.forEach((c, idx) => { S.levels[c.id] = pick(c, idx); });
      start();
      if (!S.run) continue;                       // bank too small for this mode
      ran++;
      const served = new Set(S.run.views.map((v) => v.q._level || 1));
      if (served.size > 1) mixed++;
      if (S.run.level !== (S.run.views[0].q._level || 1)) mislabelled++;
      if (S.run.views.length < size) short++;
    }
    check(name + ' serves one level (' + spread + ')', mixed === 0, mixed + ' mixed rounds');
    check(name + ' records the level it served (' + spread + ')', mislabelled === 0);
    if (ran) check(name + ' still fills the round (' + spread + ')', short === 0, short + ' short rounds');
  }
}

// WHICH level a cross-chapter round runs at, when the chapters disagree.
//
// It used to be the LOWEST level any chapter sat at, so one chapter left behind
// decided for all five: four chapters at Recall and one still at Recognise ran
// Ghost Duel, the Standing Order and Three Certainties at level 1 - paying 10
// XP for work worth 25, and writing records under level-1 keys that the four
// higher chapters never read again, which is what silently broke Ghost Duel's
// blind spot. It is now the level the MOST chapters sit at, drawn only from the
// chapters that are really there, ties breaking upward.
//
// The expected level is counted here rather than hardcoded, so these hold on
// the single sample chapter of a fresh clone as well as on the full bank.
const CAP = { 'Ghost Duel': MAX_LEVEL, 'Standing Order': MAX_LEVEL, 'Three Certainties': 2 };
const hasOptions = (q) => q.type === 'mc' || q.type === 'scenario' || q.type === 'multi';
const cappedAt = (chId, cap) => Math.min(cap, A.levelOf(chId));
const poolAt = (lv, cap, keep) => CHAPTERS
  .filter((c) => cappedAt(c.id, cap) === lv)
  .reduce((n, c) => n + A.servableAt(c, lv).filter(keep || (() => true)).length, 0);

const shapes = [
  ['one chapter lags behind', (i) => (i === 0 ? 1 : MAX_LEVEL)],
  ['one chapter runs ahead', (i) => (i === 0 ? MAX_LEVEL : 1)],
  ['half and half', (i) => (i % 2 ? MAX_LEVEL : 1)],
  // An even split has to break UPWARD. Two chapters at Recognise and two at
  // Discriminate serves Discriminate: a round pitched a little high is study,
  // a round pitched low is XP for work the student has already been paid for.
  ['an even split, two and two', (i) => (i < 2 ? 1 : i < 4 ? 2 : MAX_LEVEL)]
];
for (const [label, shape] of shapes) {
  for (const [name, start, size] of modes) {
    const cap = CAP[name];
    const keep = name === 'Three Certainties' ? hasOptions : null;
    reset();
    CHAPTERS.forEach((c, i) => { S.levels[c.id] = shape(i); });

    const tally = [0, 0, 0, 0];
    CHAPTERS.forEach((c) => { tally[cappedAt(c.id, cap)]++; });
    let want = 1;
    for (let lv = 1; lv <= cap; lv++) if (tally[lv] >= tally[want]) want = lv;   // ties upward
    // A bank too small to fill the round at that level is the one case where
    // stepping down is right, and it is already covered above.
    if (poolAt(want, cap, keep) < size) continue;

    start();
    if (!S.run) { check(name + ' opens (' + label + ')', false, 'no run built'); continue; }
    check(name + ' runs at the level MOST chapters sit at (' + label + ')', S.run.level === want,
      'ran at ' + S.run.level + ', most chapters at ' + want);
    check(name + ' draws only from chapters that are at that level (' + label + ')',
      S.run.views.every((v) => cappedAt(v.q.chapter, cap) === S.run.level),
      [...new Set(S.run.views.map((v) => v.q.chapter + '@' + A.levelOf(v.q.chapter)))].join(' '));
    check(name + ' serves one level under a spread (' + label + ')',
      new Set(S.run.views.map((v) => v.q._level || 1)).size === 1);
    // The record lands on the rung the round is CAPPED to, which for the two
    // uncapped modes is the rung the chapter card reads - that is what stops
    // Ghost Duel's blind spot zeroing a box nothing will ever show again.
    // Three Certainties caps at 2, so for a chapter standing at Recall the two
    // differ by design: certStrip has no bet bar for a write-in, so the round
    // cannot go to level 3, and a level-2 answer must be filed at level 2.
    // What that costs is stated on the card by crossReach and in GAMES.md
    // rule 8; the assertion below is deliberately against the capped level,
    // because filing anywhere else would be the level-honesty bug returning.
    check(name + ' files on the rung it was really served at (' + label + ')',
      S.run.views.every((v) => A.recKey(v.q.id, v.q._level || 1) ===
                               A.recKey(v.q.id, cappedAt(v.q.chapter, cap))));
    // And where the two DO differ, the mode's own card has to say so - the
    // student is owed the reason her chapter bar did not move.
    if (name === 'Three Certainties') {
      const past = CHAPTERS.filter((c) => cappedAt(c.id, cap) === S.run.level &&
                                          A.levelOf(c.id) > S.run.level);
      const card = A.crossReach(A.allQuestions().filter(hasOptions), size, cap);
      check(name + ' says on its card when a chapter has climbed past the round (' + label + ')',
        past.length === 0 || /climbed past/.test(card),
        past.length + ' chapters above the round; card read: ' + card);
      for (const c of past) {
        check(name + ' names Ch ' + c.number + ' as past the round (' + label + ')',
          card.indexOf('Ch ' + c.number) > -1, card);
      }
    }
  }
}
reset();

// Three Certainties cannot go to level 3: certStrip only shows the bet bar once
// an option is picked, and a write-in has no option to pick, so the student
// would be unable to bet at all on the one round that is only about betting.
reset();
CHAPTERS.forEach((c) => { S.levels[c.id] = MAX_LEVEL; });
A.startCertainties();
if (S.run) {
  check('Three Certainties stays on a question with options',
    S.run.views.every((v) => v.type === 'mc' || v.type === 'scenario' || v.type === 'multi'),
    'served ' + [...new Set(S.run.views.map((v) => v.type))].join('/'));
}

// ---------------------------------------------------------------------------
// serve() is the only thing that may name a level.
// ---------------------------------------------------------------------------
const q3 = A.allQuestions().filter((q) => q.type === 'fill');
check('a question authored as free recall is served at level 3',
  q3.every((q) => A.effectiveLevel(q, MAX_LEVEL) === MAX_LEVEL),
  q3.filter((q) => A.effectiveLevel(q, MAX_LEVEL) !== MAX_LEVEL).length + ' dropped to level 1');

for (const q of A.allQuestions()) {
  for (const lv of LEVELS) {
    const served = A.serve(q, lv);
    // A question authored as free recall is the single exception, and it has to
    // be: the shape it is served in is the level-3 shape whatever level was
    // asked for, so stamping it 1 would pay 10 XP for work worth 25 and file
    // the record on a rung the chapter never reads. It must claim 3 every time,
    // never a level that depends on what was asked for.
    if (q.type === 'fill') {
      check('free recall is stamped level 3 whatever level is asked for',
        served._level === MAX_LEVEL, q.id + ' at L' + lv + ' stamped ' + (served._level || 1));
    } else {
      check('serve never claims a level above the one asked for', (served._level || 1) <= lv, q.id + ' at L' + lv);
    }
    check('the level on the question is the level the view reports',
      A.viewLevel({ q: served }) === (served._level || 1), q.id + ' at L' + lv);
  }
}

// The defect was a view carrying a level its question did not. Nothing outside
// serve() may stamp one, and the cheapest way to keep it that way is to say so
// here: a fresh `._level =` in app.js is the bug coming back.
const stamps = (readFileSync(APP_JS, 'utf8').match(/\._level\s*=[^=]/g) || []).length;
check('nothing outside serve() stamps a level', stamps === 0, stamps + ' assignment(s) to ._level');

// ---------------------------------------------------------------------------
// Shown = recorded = paid = told.
//
// Driven through the REAL live round rather than a stand-in, because the live
// path is the only place in the app where those four were ever allowed to
// differ - and they did: the view was stamped with a predicted level, so a
// four-option question printed "Lv 3", paid 25 XP instead of 10, filed its
// record under qid@3 and asked the Worker for twelve seconds instead of five.
// Each of the four is read from the place the student or the room actually
// sees it: the badge off the rendered card, the key in S.progress, the XP
// delta on S.stats, and the body of the request the app put on the wire.
// ---------------------------------------------------------------------------
const answerCorrectly = (v) => {
  const q = v.q;
  if (q.type === 'mc' || q.type === 'scenario') v.picked = v.answerPos;
  else if (q.type === 'multi') { v.sel = {}; Object.keys(v.answerSet).forEach((i) => { v.sel[i] = true; }); }
  else if (q.type === 'match') { v.sel = {}; v.terms.forEach((t) => { v.sel[t.i] = t.i; }); }
  else if (q.type === 'order') v.order = v.correctOrder.slice();
  else if (q.type === 'fill') v.value = (q.answer || [])[0] || '';
};

for (const lv of LEVELS) {
  reset();
  CHAPTERS.forEach((c) => { S.levels[c.id] = lv; });
  S.profile.name = 'Test Student';
  S.profile.classCode = 'TEST';
  S.screen = 'live';
  Object.assign(A.LIVE, {
    code: 'ABCD', view: null, feedback: '', busy: false, done: false,
    fc: null, wt: null, misses: {}, lastJson: '', stale: '',
    room: { state: 'running', game: 'buytime', players: [], gs: { cleared: 0, target: 20, pool: [] } }
  });

  let graded = 0, offLevel = 0, badShown = 0, badBadge = 0, badRec = 0, strayRec = 0, badXp = 0, badWire = 0;
  for (let i = 0; i < 40; i++) {
    A.LIVE.view = null;
    A.LIVE.busy = false;
    A.serveNextLive();
    const v = A.LIVE.view;
    if (!v) continue;

    // The only truthful number in the round: the one serve() put on the
    // question when it chose the shape. Everything below is compared against
    // THIS, never against viewLevel - a bug that moved all four together would
    // otherwise pass a test that only checked they agreed with each other.
    const truth = v.q._level || 1;
    if (truth !== lv) offLevel++;
    if (A.viewLevel(v) !== truth) badShown++;

    // 1. SHOWN - the badge on the card, read out of the rendered HTML.
    if (A.viewLive().indexOf('Lv ' + truth + ' ') === -1) badBadge++;

    answerCorrectly(v);
    const xpBefore = S.stats.xp;
    sent.length = 0;
    A.liveAnswer();
    if (!v.correct) continue;               // the grader disagreed; nothing was paid
    graded++;

    // 2. RECORDED - under the level shown, and under no other.
    if (!S.progress[A.recKey(v.q.id, truth)]) badRec++;
    for (const other of LEVELS) {
      if (other !== truth && S.progress[A.recKey(v.q.id, other)]) strayRec++;
    }

    // 3. PAID - exactly the XP that level is worth.
    if (S.stats.xp - xpBefore !== A.LEVELS[truth].xp) badXp++;

    // 4. TOLD - the level on the wire, which is what buys the room its seconds.
    const clear = sent.filter((r) => r.body && r.body.type === 'clear')[0];
    if (!clear || clear.body.level !== truth) badWire++;
  }

  check('a live round serves the level the chapter sits at (L' + lv + ')', offLevel === 0, offLevel + ' off-level');
  check('live answers were gradeable (L' + lv + ')', graded > 0, graded + ' graded');
  check('viewLevel reports the level serve() chose (L' + lv + ')', badShown === 0, badShown + ' disagree');
  check('the badge shows the level served (L' + lv + ')', badBadge === 0, badBadge + ' wrong badges');
  check('the record is filed under the level shown (L' + lv + ')', badRec === 0, badRec + ' misfiled');
  check('no record is written under any other level (L' + lv + ')', strayRec === 0, strayRec + ' stray keys');
  check('the XP paid is the XP that level is worth (L' + lv + ')', badXp === 0, badXp + ' wrong payments');
  check('the level sent to the room is the level shown (L' + lv + ')', badWire === 0, badWire + ' wrong on the wire');
}

// The one live case where the level served and the chapter's level REALLY
// differ. Purity in a live round is stamp-not-refuse: a question the room put
// in the pool must be handed out whatever level the chapter sits at, or Buy
// Time's pool never clears and All Hands silently drops questions. So a pool
// item from a chapter sitting at level 3 that cannot become a write-in is
// served at level 2 - and level 2 is then what must be recorded, paid and sent.
// This is the shape the old predictor got wrong in the direction that paid out.
const dropsALevel = A.allQuestions().filter((q) => A.effectiveLevel(q, MAX_LEVEL) < MAX_LEVEL);
check('the bank contains a question that cannot take the top level', dropsALevel.length > 0);
if (dropsALevel.length) {
  const q = dropsALevel[0];
  reset();
  CHAPTERS.forEach((c) => { S.levels[c.id] = MAX_LEVEL; });
  S.profile.name = 'Test Student';
  S.profile.classCode = 'TEST';
  S.screen = 'live';
  Object.assign(A.LIVE, {
    code: 'ABCD', view: null, feedback: '', busy: false, done: false,
    fc: null, wt: null, misses: {}, lastJson: '', stale: '',
    room: { state: 'running', game: 'buytime', players: [],
            gs: { cleared: 0, target: 20, pool: [{ qid: q.id }] } }
  });
  A.serveNextLive();
  const v = A.LIVE.view;
  check('a pool question is served, not refused, from a level it cannot take', !!v && v.q.id === q.id);
  if (v) {
    const truth = v.q._level || 1;
    check('it is served at the level it can actually take', truth < MAX_LEVEL, 'served at ' + truth);
    check('and viewLevel agrees', A.viewLevel(v) === truth);
    answerCorrectly(v);
    const before = S.stats.xp;
    sent.length = 0;
    A.liveAnswer();
    if (v.correct) {
      check('a stepped-down pool question is recorded at the level served',
        !!S.progress[A.recKey(q.id, truth)] && !S.progress[A.recKey(q.id, MAX_LEVEL)]);
      check('a stepped-down pool question is paid at the level served',
        S.stats.xp - before === A.LEVELS[truth].xp,
        (S.stats.xp - before) + ' paid, ' + A.LEVELS[truth].xp + ' owed');
      const clear = sent.filter((r) => r.body && r.body.type === 'clear')[0];
      check('the room is told the level served, not the chapter level',
        !!clear && clear.body.level === truth, clear ? 'told ' + clear.body.level : 'nothing sent');
    }
  }
}

// The same three, on the practice path. Cheaper to check but it is the path
// nine rounds in ten take, so it is not enough to check the live one.
for (const ch of CHAPTERS) {
  for (const lv of LEVELS) {
    reset();
    S.levels[ch.id] = lv;
    A.startPractice(ch.id);
    if (!S.run || !S.run.views.length) continue;
    const runLevel = S.run.level;
    let paid = 0, expected = 0, misfiled = 0;
    while (S.run && S.run.idx < S.run.views.length) {
      const v = S.run.views[S.run.idx];
      const before = S.stats.xp;
      answerCorrectly(v);
      A.answerCurrent();
      if (v.correct) {
        expected += A.LEVELS[runLevel].xp;
        paid += S.stats.xp - before;
        if (!S.progress[A.recKey(v.q.id, runLevel)]) misfiled++;
      }
      S.run.idx++;
    }
    check('practice pays the level it ran at (' + ch.id + ' L' + lv + ')', paid === expected,
      paid + ' paid, ' + expected + ' owed');
    check('practice files under the level it ran at (' + ch.id + ' L' + lv + ')', misfiled === 0,
      misfiled + ' misfiled');
  }
}

// ---------------------------------------------------------------------------
// The shape the student's thumb meets.
//
// Everything above is about the level LABEL. The complaint that started this
// was about the label's consequence - "3 questions in a row that were all 3
// level types" - and the label being right does not by itself make the shapes
// agree. A blank typing box inside a round badged Lv 1 IS a level-3 question as
// far as the student can tell, however honestly the badge is printed.
//
// Two rules, and they are what the rest of this section checks:
//   1. a typing box appears at level 3 and nowhere else;
//   2. inside a round the shapes only ever get harder, never easier.
// ---------------------------------------------------------------------------
const shapeOf = (q) => (q.type === 'fill' ? 'type-it'
  : (q.type === 'mc' || q.type === 'scenario') ? (q.choices || []).length + '-option'
  : q.type);
// The ramp, in the order a thumb meets it. Must stay in step with SHAPE_RANK in
// src/app.js; read off the SERVED question, never the authored one.
const RANK = { mc: 0, scenario: 0, multi: 1, match: 2, order: 3, fill: 4 };
const rankOf = (q) => (RANK[q.type] === undefined ? 0 : RANK[q.type]);

// Rule 1, at the pool: nothing that serves as a typing box may be servable at
// level 1 or 2 in the first place. The five questions the bank authors as free
// recall used to be, which is the sharpest form of the mixing - the level-3
// widget inside a Recognise round, paid 10 XP and filed on the level-1 rung.
for (const lv of [1, 2]) {
  const boxes = [];
  CHAPTERS.forEach((ch) => A.servableAt(ch, lv).forEach((q) => {
    if (A.serve(q, lv).type === 'fill') boxes.push(q.id);
  }));
  check('no question is servable as a typing box at level ' + lv, boxes.length === 0,
    boxes.join(', '));
}

// Rule 1, at the round: the same thing again through the path the student
// actually takes, because servableAt is not the only way a question reaches a
// round - a stale saved level or a future caller can hand buildSession a pool
// it did not filter.
for (const ch of CHAPTERS) {
  for (const lv of [1, 2]) {
    reset();
    S.levels[ch.id] = lv;
    let boxes = 0, rounds = 0;
    for (let i = 0; i < 25; i++) {
      A.startPractice(ch.id);
      if (!S.run || !S.run.views.length) continue;
      rounds++;
      S.run.views.forEach((v) => { if (v.q.type === 'fill') boxes++; });
    }
    check('no level-' + lv + ' round contains a typing box (' + ch.id + ')', boxes === 0,
      boxes + ' typing boxes in ' + rounds + ' rounds');
  }
}

// Rule 2: within a round the shapes never go backwards. Selection is still by
// Leitner box - this is only the order they are shown in - so a round holds
// whatever mix of shapes the student's own history calls for, and walks up
// through it: four options, then the select-alls, then the grids, then the
// ordering lists. One flat shuffle is what put a grid between two four-option
// questions and read to the student as the levels being mixed up.
//
// EVERY round builder, not just chapter practice. This assertion used to drive
// A.startPractice and nothing else, which is why the ramp could ship to one of
// four builders and leave the reported symptom live on three screens that are
// ungated on day one - and 1786 checks stayed green over it.

// A Leitner history, so the box-ordering rule inside a shape group has
// something to order. Deterministic: a test that only fails on some seeds is a
// test nobody trusts.
const seedHistory = () => {
  let x = 17;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  A.allQuestions().forEach((q) => {
    for (const lv of LEVELS) {
      const r = rnd();
      if (r < 0.35) continue;                     // never seen at this level
      S.progress[A.recKey(q.id, lv)] =
        { box: r < 0.6 ? 1 : r < 0.85 ? 2 : 3, seen: 3, right: 2, wrong: 1, last: 1 };
    }
  });
};

// And a second one, because the first leaves the box-order rule with nothing
// to prove on one of the builders. seedHistory leaves about a third of every
// (question, level) pair unseen, so the box-0 bucket is far bigger than a
// round - and startCertainties takes the CERT_SIZE lowest boxes, which means
// ten box-0 questions every time. Every box in a shape group is then equal,
// so 'inside one shape, the weakest comes first' had no pair it could be
// wrong about: flat-shuffling startCertainties produced shape failures and not
// one box failure. A check that cannot fail reads as coverage and is not.
//
// This is the same phone late in the course: nearly everything has been seen
// at least once, so the box-0 bucket is smaller than a round and the selection
// has to reach up into boxes it must then order correctly.
// Counted out rather than rolled, because 'a small bucket' has to be small
// against SESSION_SIZE and a distribution only makes that likely. One question
// per chapter per level is still unseen, three are struggling, three are
// halfway and the rest are mastered - so no single box can fill a round and
// every builder has to span boxes it must then order.
const seedLateHistory = () => {
  const byChapter = {};
  A.allQuestions().forEach((q) => { (byChapter[q.chapter] = byChapter[q.chapter] || []).push(q); });
  for (const lv of LEVELS) {
    for (const id of Object.keys(byChapter)) {
      byChapter[id].forEach((q, i) => {
        const box = i === 0 ? 0 : i <= 3 ? 1 : i <= 6 ? 2 : 3;
        S.progress[A.recKey(q.id, lv)] =
          { box: box, seen: 4, right: 3, wrong: box === 0 ? 0 : 1, last: 1 };
      });
    }
  }
};
const histories = { 'mid-course': seedHistory, 'late course': seedLateHistory };

const levelSpreads = {
  'all L1': () => 1,
  'one per level': (i) => (i % MAX_LEVEL) + 1,
  'all L3': () => MAX_LEVEL
};

// Every way a round can be built, driven through the same door the student
// uses. A builder missing from this list is a builder with no shape coverage,
// which is the whole of finding [2]; the structural check below counts the
// builders in src/app.js so the list cannot silently fall behind.
const roundBuilders = [];
for (const ch of CHAPTERS) {
  for (const lv of LEVELS) {
    roundBuilders.push({
      name: 'practice ' + ch.id + ' L' + lv,
      spread: () => lv,
      start: () => A.startPractice(ch.id)
    });
  }
}
for (const [spread, pick] of Object.entries(levelSpreads)) {
  roundBuilders.push({ name: 'Ghost Duel (' + spread + ')', spread: pick, start: A.startGhostDuel });
  roundBuilders.push({ name: 'Standing Order (' + spread + ')', spread: pick, start: A.startStandingOrder });
  roundBuilders.push({ name: 'Three Certainties (' + spread + ')', spread: pick, start: A.startCertainties });
  roundBuilders.push({
    name: 'Final Boss (' + spread + ')',
    spread: pick,
    start: () => A.startTimed({
      mode: 'boss', title: 'Final Boss', chapters: CHAPTERS.map((c) => c.id), topics: [],
      count: 25, minutes: 15, passMark: 80
    })
  });
  for (const ex of A.EXAMS || []) {
    roundBuilders.push({
      name: ex.id + ' (' + spread + ')',
      spread: pick,
      start: () => A.startTimed({
        mode: 'exam', examId: ex.id, title: ex.name, chapters: ex.chapters || [],
        topics: ex.topics || [], count: ex.questionCount || 30, minutes: ex.minutes || 0,
        passMark: ex.passMark || 80
      })
    });
  }
}

// The Leitner box a view sits in at the level it was actually served at, which
// is the level its answer will be filed under.
const boxOfView = (v) => {
  const r = S.progress[A.recKey(v.q.id, v.q._level || 1)];
  return Math.min(3, Math.max(0, (r && r.box) || 0));
};

// Every builder is driven under both histories, and `chances` counts the
// adjacent same-shape pairs whose boxes actually differ - the pairs the
// box-order rule can be WRONG about. It is asserted below, per builder,
// because an out-of-order count of zero means one of two very different
// things and the number has to say which.
const chancesFor = {};
for (const [hName, seedFor] of Object.entries(histories)) {
  for (const b of roundBuilders) {
    let drops = 0, unsorted = 0, rounds = 0, chances = 0, worst = '';
    for (let i = 0; i < 15; i++) {
      reset();
      seedFor();
      CHAPTERS.forEach((c, idx) => { S.levels[c.id] = b.spread(idx); });
      b.start();
      if (!S.run || !S.run.views.length) continue;
      rounds++;
      const ranks = S.run.views.map((v) => rankOf(v.q));
      for (let k = 1; k < ranks.length; k++) {
        if (ranks[k] < ranks[k - 1]) {
          drops++;
          if (!worst) worst = S.run.views.map((v) => shapeOf(v.q)).join(' -> ');
        }
        // Weakest first inside a shape group. A deterministic sort by shape alone
        // pinned a chapter's one ordering list to the last position of every
        // round it appeared in, so the student who backs out on her phone always
        // skips the same items - and they are the ones she is worst at.
        if (ranks[k] === ranks[k - 1]) {
          const a = boxOfView(S.run.views[k - 1]), c = boxOfView(S.run.views[k]);
          if (a !== c) chances++;
          if (c < a) unsorted++;
        }
      }
    }
    chancesFor[b.name] = (chancesFor[b.name] || 0) + chances;
    check('a round only ever gets harder in shape (' + b.name + ', ' + hName + ')', drops === 0,
      drops + ' steps backwards in ' + rounds + ' rounds; ' + worst);
    check('inside one shape, the weakest comes first (' + b.name + ', ' + hName + ')',
      unsorted === 0, unsorted + ' out-of-order pairs in ' + rounds + ' rounds');
  }
}
// The check on the check. 'inside one shape, the weakest comes first' passed
// for Three Certainties at all three level spreads while having zero pairs it
// could have been wrong about, because the only fixture in the file handed it
// ten box-0 questions every time. It read as coverage and was not. Now every
// builder has to have had a real chance to fail under at least one fixture, or
// this goes red and names the builder.
for (const b of roundBuilders) {
  check('the box-order rule had a pair it could get wrong (' + b.name + ')',
    (chancesFor[b.name] || 0) > 0,
    'no adjacent same-shape pair with different boxes in any fixture');
}
reset();

// The guard that makes the rule unforgettable. The ramp lived inside
// buildSession, buildSession has one caller, and the other three round builders
// assembled their own views arrays from a flat shuffle - nothing anywhere said
// so. Now buildViews is the only thing allowed to build a views array, and this
// reads src/app.js and fails if anything else does, so a fifth round builder
// cannot start a round without going through the ordering rule.
{
  const src = readFileSync(APP_JS, 'utf8');
  const made = src.match(/views\s*:/g) || [];
  const viaBuildViews = src.match(/views\s*:\s*buildViews\(/g) || [];
  check('every round builder builds its views through buildViews',
    made.length === viaBuildViews.length && made.length > 0,
    viaBuildViews.length + ' of ' + made.length + ' views arrays go through buildViews');
  // The whole array replaced after the fact would dodge the check above.
  const reassigned = src.match(/\.views\s*=[^=]/g) || [];
  check('nothing replaces a run\'s views array after it is built',
    reassigned.length === 0, reassigned.join(' '));
  // Nor one element of it. `S.run.views[i] = v` does not match the pattern
  // above, and there is exactly one: Adapted Equipment, which re-serves the
  // current question a level down after the student has paid 4 tokens for it.
  // That is a shape step DOWN inside a round the ramp built, and it is allowed
  // precisely because she asked for it by name on the question in front of
  // her. A SECOND one would be the round getting easier without being asked,
  // which is the reported bug wearing a token's clothes - so the count is
  // pinned rather than the pattern merely tolerated.
  const spliced = src.match(/\.views\s*\[[^\]]+\]\s*=[^=]/g) || [];
  check('exactly one thing replaces a single view after the round is built',
    spliced.length === 1, spliced.length + ': ' + spliced.join(' '));
  // The list of builders above is only as good as its coverage of the file.
  check('the suite drives every round builder src/app.js has',
    made.length === 5, made.length + ' views arrays in src/app.js, 5 covered by roundBuilders');
}

// The ramp must not quietly become a sort that throws work away, and it must
// not collapse a round to one shape either - the student still meets the whole
// spread, just in order.
reset();
const mixedRound = (() => {
  for (const ch of CHAPTERS) {
    S.levels[ch.id] = 1;
    for (let i = 0; i < 25; i++) {
      A.startPractice(ch.id);
      if (S.run && new Set(S.run.views.map((v) => rankOf(v.q))).size > 1) return S.run.views.length;
    }
  }
  return 0;
})();
check('a ramped round still mixes shapes, it does not filter down to one', mixedRound > 0);
reset();

// ---------------------------------------------------------------------------
// The live round, and why nothing above applies to it.
//
// The ramp is a property of a finite list that one phone owns. A live round is
// none of those things: the next question depends on what the room and the
// other nine phones just did, two of its four sources are questions the ROOM
// chose, and in Buy Time its length is still being bought while it runs. So it
// does not ramp, on purpose, and the reasoning is written out at
// nextLiveQuestion in src/app.js.
//
// A decision like that is worth nothing without something pinning it, because
// the next person to read finding [1] will reach for a ramp and the suite has
// to stop them at the branches that cannot take one. These checks are that
// stop. They do NOT assert the shape sequence - asserting a whipsaw would be
// asserting a symptom - they assert the four properties a ramp would have to
// break to exist here:
//
//   1. All Hands outranks everything, and is served whatever shape it is;
//   2. the open pool is first-takeable-first and is never filtered or
//      reordered, so it always drains;
//   3. the branch this phone DOES choose never shows a widget the student has
//      not already met in that chapter's own practice;
//   4. a live round still mixes shapes. This one guards the other direction:
//      the ratchet that was measured and rejected removed every backward step
//      by collapsing a round from 3.33 distinct widgets to 2.25 and handing
//      back questions the student had just answered.
// ---------------------------------------------------------------------------
const liveJoin = (gs, game) => {
  S.profile.name = 'Test Student';
  S.profile.classCode = 'TEST';
  S.screen = 'live';
  Object.assign(A.LIVE, {
    code: 'ABCD', view: null, feedback: '', busy: false, done: false,
    fc: null, wt: null, misses: {}, lastJson: '', stale: '',
    room: { state: 'running', game: game || 'buytime', players: [],
            gs: Object.assign({ cleared: 0, target: 20, pool: [] }, gs) }
  });
};
const serveLive = () => {
  A.LIVE.view = null;
  A.LIVE.busy = false;
  A.serveNextLive();
  return A.LIVE.view;
};

// Two questions whose widgets are as far apart as the bank allows at level 1:
// an ordinary option list, and one authored as free recall, which serve()
// stamps 3 at every level and which therefore appears in no level-1 practice
// round at all. The second is the whole test - it is the shape a ramp would
// refuse and the shape the room is allowed to insist on.
reset();
CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
const atOwnLevel = (q) => A.serve(q, A.levelOf(q.chapter));
const easyQ = A.allQuestions().filter((q) => rankOf(atOwnLevel(q)) === 0)[0];
const hardQ = A.allQuestions().filter((q) => rankOf(atOwnLevel(q)) === RANK.fill)[0];
check('the bank has an option list to serve at level 1', !!easyQ);
check('the bank has a question that is a typing box even at level 1', !!hardQ,
  'no free-recall question in this bank');

if (easyQ && hardQ) {
  // 1. All Hands outranks the pool, and is served whatever it does to the
  // sequence. Refusing it is how a room of ten sits waiting on a question
  // nobody is being asked.
  reset();
  CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
  liveJoin({ pool: [{ qid: easyQ.id }],
             allHands: { qid: hardQ.id, solved: false,
                         endsAt: new Date(Date.now() + 60000).toISOString() } });
  const ah = serveLive();
  check('All Hands outranks the open pool', !!ah && ah.q.id === hardQ.id,
    ah ? 'served ' + ah.q.id : 'served nothing');
  check('an All Hands question is served whatever its shape', !!ah && rankOf(ah.q) === RANK.fill);
  check('and it is stamped the level it was really served at, not the chapter\'s',
    !!ah && (ah.q._level || 1) === MAX_LEVEL && A.levelOf(ah.q.chapter) === 1,
    ah ? 'stamped ' + (ah.q._level || 1) : '');

  // 2. The open pool is FIRST TAKEABLE FIRST. Both orders are pinned, so a
  // sort that happens to agree with one of them cannot pass. A shape ramp
  // would serve the option list first in both, which is the room's oldest
  // miss going unanswered while ten phones step over it.
  for (const [first, second] of [[hardQ, easyQ], [easyQ, hardQ]]) {
    reset();
    CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
    liveJoin({ pool: [{ qid: first.id }, { qid: second.id }] });
    const v = serveLive();
    check('the open pool serves its oldest miss first (' + first.id + ' before ' + second.id + ')',
      !!v && v.q.id === first.id && v._fromPool === true,
      v ? 'served ' + v.q.id : 'served nothing');
  }

  // A question this student has already missed herself is the one pool item
  // she is spared - and the pool moves on rather than stalling on it.
  reset();
  CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
  liveJoin({ pool: [{ qid: hardQ.id }, { qid: easyQ.id }] });
  A.LIVE.misses[hardQ.id] = true;
  const skipped = serveLive();
  check('a pool item this student already missed is skipped, not the whole pool',
    !!skipped && skipped.q.id === easyQ.id && skipped._fromPool === true,
    skipped ? 'served ' + skipped.q.id : 'served nothing');

  // 3. The pool DRAINS. Buy Time's target and the Walk-Through's audit are
  // both counted in cleared pool items, so a branch that filters even one
  // shape out of the pool is a room that can never finish.
  reset();
  CHAPTERS.forEach((c, i) => { S.levels[c.id] = (i % MAX_LEVEL) + 1; });
  // Deliberately seeded with the typing box and with one question from every
  // chapter, so a pool branch that quietly drops a shape - or a chapter on the
  // wrong rung - leaves an item behind and this goes red rather than the FIFO
  // check alone.
  const drainPool = [hardQ]
    .concat(CHAPTERS.map((c) => A.allQuestions().filter((q) => q.chapter === c.id)[0]))
    .concat(A.allQuestions().filter((q) => rankOf(atOwnLevel(q)) === RANK.match).slice(0, 2))
    .filter(Boolean)
    .filter((q, i, a) => a.findIndex((x) => x.id === q.id) === i)
    .map((q) => ({ qid: q.id }));
  liveJoin({ pool: drainPool.slice() });
  const wanted = new Set(drainPool.map((p) => p.qid));
  const cleared = new Set();
  for (let i = 0; i < 40 && cleared.size < wanted.size; i++) {
    const v = serveLive();
    if (!v) break;
    answerCorrectly(v);
    A.liveAnswer();
    if (v._fromPool && v.correct) {
      cleared.add(v.q.id);
      // what the Worker does on a clear
      const g = A.LIVE.room.gs;
      g.pool = g.pool.filter((p) => p.qid !== v.q.id);
    }
  }
  check('every question the room puts in the pool can be cleared',
    cleared.size === wanted.size,
    cleared.size + ' of ' + wanted.size + ' cleared; left ' +
    [...wanted].filter((id) => !cleared.has(id)).join(', '));
}

// 4. The branch this phone chooses. With the pool empty there is nothing the
// room is insisting on, so every question is the student's own material - and
// it may only be a widget her own practice at that chapter's rung can show.
// This is the guarantee the live round DOES give in place of a ramp.
const practiceWidgets = (chId, lv) => {
  const ch = CHAPTERS.filter((c) => c.id === chId)[0];
  const set = new Set();
  if (ch) A.servableAt(ch, lv).forEach((q) => set.add(rankOf(A.serve(q, lv))));
  return set;
};
for (const [spreadName, pick] of Object.entries(levelSpreads)) {
  reset();
  CHAPTERS.forEach((c, i) => { S.levels[c.id] = pick(i); });
  liveJoin({ pool: [] });
  let served = 0, unmet = 0, repeats = 0;
  const seen = new Set();
  const widgets = new Set();
  for (let i = 0; i < 20; i++) {
    const v = serveLive();
    if (!v) break;
    served++;
    widgets.add(rankOf(v.q));
    if (seen.has(v.q.id)) repeats++;
    seen.add(v.q.id);
    if (!practiceWidgets(v.q.chapter, A.levelOf(v.q.chapter)).has(rankOf(v.q))) unmet++;
    answerCorrectly(v);
    A.liveAnswer();
  }
  check('a live round serves questions (' + spreadName + ')', served === 20, served + ' served');
  check('the branch the phone chooses never shows a widget practice does not (' +
    spreadName + ')', unmet === 0, unmet + ' of ' + served + ' unmet');
  check('a live round never hands back a question it has just served (' + spreadName + ')',
    repeats === 0, repeats + ' repeats in ' + served);
  // The other direction. A ratchet bought 0 backward steps by narrowing the
  // round until it was serving one widget and repeating itself; 'all L3' is
  // the one spread where a single widget is honest, because every level-3
  // serving in the bank is a typing box.
  if (spreadName !== 'all L3') {
    check('a live round still meets more than one widget (' + spreadName + ')',
      widgets.size > 1, [...widgets].join(','));
  }
}
reset();

// ---------------------------------------------------------------------------
// A ghost belongs to a question AT A LEVEL.
//
// Serving one duel at one level makes the round internally uniform and does
// nothing about the race itself: the ghost is what past-you did, and past-you
// may have met this question on a rung you have since climbed off. ch3-06 at
// Recognise is four options and a click; at Recall it is a blank box and the
// term typed from memory. Racing across that printed 'you chose "Guided
// Imagery"' above a widget with no options and set the bar at a time that
// cannot be reached by typing, so the strongest students met an unwinnable
// race on the questions they knew best.
// ---------------------------------------------------------------------------
reset();
CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
// A level-1 ghost on every question, which is the state a phone that has been
// played since before the ladder existed is really in.
S.stats.ghosts = {};
A.allQuestions().forEach((q) => {
  S.stats.ghosts[A.recKey(q.id, 1)] =
    { correct: true, ms: 6000, pickedText: 'something with options', at: '2026-01-01T00:00:00.000Z' };
});
const seededGhosts = Object.keys(S.stats.ghosts).length;

const runDuel = () => {
  A.startGhostDuel();
  if (!S.run || !S.run.views.length) return null;
  const level = S.run.level;
  const hadGhost = [];
  while (S.run && S.run.idx < S.run.views.length) {
    const v = S.run.views[S.run.idx];
    answerCorrectly(v);
    A.answerCurrent();
    hadGhost.push(!!v._ghost);
    S.run.idx++;
  }
  return { level, raced: S.run.raced, n: S.run.views.length, hadGhost };
};

const duelAtOne = runDuel();
check('a duel at the level the ghosts were recorded at races them',
  !!duelAtOne && duelAtOne.level === 1 && duelAtOne.raced === duelAtOne.n,
  duelAtOne ? 'raced ' + duelAtOne.raced + ' of ' + duelAtOne.n + ' at L' + duelAtOne.level : 'no duel');

CHAPTERS.forEach((c) => { S.levels[c.id] = MAX_LEVEL; });
const duelAtTop = runDuel();
check('the top of the ladder is reachable for a duel', !!duelAtTop && duelAtTop.level === MAX_LEVEL,
  duelAtTop ? 'ran at ' + duelAtTop.level : 'no duel');
if (duelAtTop && duelAtTop.level === MAX_LEVEL) {
  check('a ghost from a lower rung is not raced at a higher one',
    duelAtTop.raced === 0 && duelAtTop.hadGhost.every((h) => !h),
    duelAtTop.raced + ' of ' + duelAtTop.n + ' raced across a level change');
  const topKeys = Object.keys(S.stats.ghosts).filter((k) => k.indexOf('@' + MAX_LEVEL) > -1);
  check('the duel records its own ghosts on the rung it ran at', topKeys.length === duelAtTop.n,
    topKeys.length + ' keys at level ' + MAX_LEVEL + ', ' + duelAtTop.n + ' questions');
  const again = runDuel();
  check('and the next duel on that rung races them',
    !!again && again.raced === again.n, again ? again.raced + ' of ' + again.n : 'no duel');
}

// Back down, to prove the key shape keeps every ghost a phone already holds.
// A level-1 ghost lives under the bare question id, which is what every ghost
// written before this existed is stored under, so none of them are orphaned.
CHAPTERS.forEach((c) => { S.levels[c.id] = 1; });
const backDown = runDuel();
check('ghosts already on the phone are not orphaned by the level key',
  !!backDown && backDown.level === 1 && backDown.raced === backDown.n,
  backDown ? backDown.raced + ' of ' + backDown.n + ' raced' : 'no duel');
check('the level-1 ghost store is still keyed by the bare question id',
  Object.keys(S.stats.ghosts).filter((k) => k.indexOf('@') === -1).length === seededGhosts,
  'seeded ' + seededGhosts);
reset();
S.stats.ghosts = {};

// ---------------------------------------------------------------------------
// The ladder has to run one way.
//
// Select-alls had no level-2 form at all, so they lived only at level 1 - and
// a twelve-option select-all is plainly harder than the six-option single
// answer level 2 hands back. A student who promoted was handed something
// easier than what she had been clearing, which reads as a demotion and takes
// the point out of climbing.
// ---------------------------------------------------------------------------
const widestAt = (lv) => CHAPTERS.reduce((m, ch) => A.servableAt(ch, lv)
  .reduce((n, q) => Math.max(n, (A.serve(q, lv).choices || []).length), m), 0);
check('level 2 never offers a narrower choice than the widest level 1 can show',
  widestAt(2) >= widestAt(1), 'widest L1 ' + widestAt(1) + ' options, widest L2 ' + widestAt(2));

// The level-2 transform appends its two extra options. A select-all's "answer"
// is an array of indices into choices, so anything other than appending
// re-keys every answer after the insert - and nothing would report it, the
// question would simply start grading a different option as correct.
let misplaced = [], duped = [], outOfRange = [];
for (const q of A.allQuestions()) {
  const served = A.serve(q, 2);
  if ((served._level || 1) !== 2 || !served.choices) continue;
  const extra = q.extra || [];
  if (extra.length) {
    if (served.choices.length !== q.choices.length + extra.length ||
        served.choices.slice(-extra.length).join('\u0001') !== extra.join('\u0001')) misplaced.push(q.id);
  }
  const seen = served.choices.map((c) => String(c).toLowerCase().trim());
  if (new Set(seen).size !== seen.length) duped.push(q.id);
  const want = Array.isArray(q.answer) ? q.answer : [q.answer];
  if (want.some((i) => typeof i === 'number' && (i < 0 || i >= q.choices.length))) outOfRange.push(q.id);
}
check('the level-2 extras are appended, never inserted', misplaced.length === 0, misplaced.join(', '));
check('a level-2 option list never shows the same option twice', duped.length === 0, duped.join(', '));
check('every answer index still points inside the authored choices', outOfRange.length === 0,
  outOfRange.join(', '));
reset();

// ---------------------------------------------------------------------------
// Accepted spellings: both forms of a name are right.
//
// A level-3 write-in built out of a matching pair used to accept the pair's
// term and the mechanical variants of it and nothing else. Where the term is
// an acronym, that marks a student wrong for typing the name she was taught -
// she meets the thing spelled out in the chapter's own text and types that.
// build.js reads "Spelled Out Name (ACRO)" out of the chapter and records the
// long form as an accepted spelling, which fixes it.
//
// The fix is the most fragile thing in the bundle, because it has no source of
// its own: it is derived at build time from ANOTHER question's prompt. Drop
// the parenthetical from that question, or hyphenate it differently, and the
// spelling silently disappears - node build.js still exits 0, every other
// check here still passes, and the only trace is a build log line moving from
// 1 to 0. So this tests the property from both sides: with the recorded
// spelling the answer grades right, and with it taken away the same answer
// grades WRONG, which is the failure itself rather than the machinery that
// produces it.
//
// Written against whatever spellings the bank carries, not against a question
// id, so it holds on the sample chapter of a fresh clone too.
// ---------------------------------------------------------------------------
reset();
const aliasQs = A.allQuestions().filter((q) => q.aliases && Object.keys(q.aliases).length);
const accepts = (served, text) =>
  A.grade({ q: served, type: served.type, value: text, answered: false, correct: null });
// serve() draws a different pair out of a matching grid every call, so ask
// until it hands back the one that asks for this term.
const servingFor = (q, term) => {
  for (let i = 0; i < 500; i++) {
    const s = A.serve(q, MAX_LEVEL);
    if (s.type === 'fill' && (s.answer || [])[0] === term) return s;
  }
  return null;
};
// The live object inside CHAPTERS, not the copy allQuestions() hands out -
// taking the spelling away has to be visible to serve().
const authored = (id) => {
  for (const c of CHAPTERS) for (const q of c.questions) if (q.id === id) return q;
  return null;
};

for (const aq of aliasQs) {
  for (const term of Object.keys(aq.aliases)) {
    const served = servingFor(aq, term);
    check('a write-in that carries an accepted spelling can be asked for', !!served, aq.id);
    if (!served) continue;
    check('the term the question asks for is accepted', accepts(served, term), aq.id);
    for (const spelling of aq.aliases[term]) {
      check('so is the spelling the bank itself uses for it',
        accepts(served, spelling), aq.id + ' rejected its own recorded spelling');
      // And it is load-bearing: without it, that answer is marked wrong.
      const live = authored(aq.id);
      const kept = live && live.aliases;
      if (live) delete live.aliases;
      const bare = servingFor(live || aq, term);
      check('and without it the same answer would be marked wrong',
        !!bare && !accepts(bare, spelling),
        aq.id + ' accepts it anyway, so this check is measuring nothing');
      if (live) live.aliases = kept;
    }
  }
}

// The floor. Everything above runs over the spellings the bank HAS, so a
// build that derives none passes it by having nothing to check - which is
// exactly the silent revert. A bank that still asks a student to type an
// acronym must carry at least one spelled-out form of one. A fresh clone asks
// for none and is not held to it; an instructor who strips the abbreviations
// out of her own bank, which is what she asked for, is not held to it either.
const isAcronym = (t) => {
  const s = String(t).trim();
  return /^[A-Z][A-Z0-9.\/-]*$/.test(s) && /[A-Z][^a-z]*[A-Z]/.test(s);
};
const acronymAsked = [];
for (const q of A.allQuestions()) {
  if (A.effectiveLevel(q, MAX_LEVEL) !== MAX_LEVEL) continue;
  if (q.key && isAcronym(q.key)) acronymAsked.push(q.id);
  if (q.type === 'match' && q.pairs) {
    q.pairs.forEach((p) => { if (isAcronym(p[0])) acronymAsked.push(q.id); });
  }
}
check('a bank that asks for an acronym still spells at least one of them out',
  acronymAsked.length === 0 || aliasQs.length > 0,
  acronymAsked.length + ' acronym write-ins [' + [...new Set(acronymAsked)].join(', ') +
  '] and 0 accepted spellings in the whole bank');
reset();

// ---------------------------------------------------------------------------
// Adapted Equipment is a way DOWN the ladder, and it costs 4 tokens. It may
// only be offered where serving one level down actually changes the widget.
// It used to be offered on anything above level 1, which meant offering it on
// a question authored as free recall: the token was spent, the identical
// typing box was redrawn, and the answer was then paid 10 XP instead of 25 and
// filed on a rung the chapter is not on.
// ---------------------------------------------------------------------------
const seenSig = (q) => q.type + '|' + (q.choices || []).join('\u0001') + '|' + q.prompt +
  '|' + (q.pairs || []).length + '|' + (q.items || []).join('\u0001');
reset();
CHAPTERS.forEach((c) => { S.levels[c.id] = MAX_LEVEL; });
let idle = [], withheld = [];
for (const q of A.allQuestions()) {
  for (const lv of LEVELS) {
    const served = A.serve(q, lv);
    const at = served._level || 1;
    if (at <= 1) continue;                       // nothing below level 1 to step down to
    const offered = A.offersFor({ q: served, type: served.type, answered: false }, false)
      .indexOf('adapted') > -1;
    const changes = seenSig(A.serve(q, at - 1)) !== seenSig(served);
    if (offered && !changes) idle.push(q.id + '@' + at);
    if (!offered && changes) withheld.push(q.id + '@' + at);
  }
}
check('Adapted Equipment is never offered where it would change nothing', idle.length === 0,
  [...new Set(idle)].join(', '));
check('Adapted Equipment is still offered wherever it is a real way down', withheld.length === 0,
  [...new Set(withheld)].join(', '));
reset();

// ---------------------------------------------------------------------------
// The overall bar has to be able to fill, for the same reason a chapter does.
// ---------------------------------------------------------------------------
reset();
CHAPTERS.forEach((ch) => LEVELS.forEach((lv) => masterAll(ch, lv)));
const o = A.overall();
check('overall mastery can reach 100%', o.pct === 1, o.done + '/' + o.total);
reset();

if (failures.length) {
  console.error('LEVEL LADDER FAILURES (' + failures.length + ' of ' + n + '):');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('all ' + n + ' level ladder checks hold');
