#!/usr/bin/env node
/**
 * Bundles content/*.json + src/* into dist/.
 * Also emits dist/standalone.html — a single self-contained file you can
 * email, drop in an LMS, or open straight from a USB stick.
 */
const fs = require('fs');
const path = require('path');

// The Walk-Through floor plan. One source of truth: the projector and the
// phone both draw this, and the Worker only ever deals in indices, so the
// list must not drift between them. Emitting it from here makes that
// impossible rather than merely unlikely.
const WALK_AREAS = [
  'Main entrance', 'Reception desk', 'Front corridor', 'Lift lobby', 'Stairwell A',
  'Day room', 'Quiet room', 'Group therapy room', 'Art studio', 'Music room',
  'Kitchen', 'Dining hall', 'Servery', 'Staff office', 'Nurse station',
  'Accessible WC', 'Main WC', 'Changing places room', 'Shower room', 'Locker room',
  'Pool deck', 'Pool hoist', 'Gym floor', 'Equipment store', 'Therapy garden',
  'Garden path', 'Raised beds', 'Car park', 'Drop-off bay', 'Rear exit'
];

// What a walk-through can turn up. These are the barriers a Therapeutic
// Recreation student is meant to be able to name on sight.
const WALK_BARRIERS = [
  { id: 'stairs', name: 'Stairs only', note: 'No step-free route to this space at all.' },
  { id: 'curb', name: 'No curb cut', note: 'A wheelchair cannot get up off the path.' },
  { id: 'door', name: 'Narrow doorway', note: 'Under 32 inches clear - a chair will not pass.' },
  { id: 'heavy', name: 'Heavy door', note: 'Too much force to open one-handed or seated.' },
  { id: 'signage', name: 'No signage', note: 'Nothing readable for low vision or low literacy.' },
  { id: 'transfer', name: 'No transfer space', note: 'Nowhere beside the fixture to transfer from a chair.' },
  { id: 'noise', name: 'Uncontrolled noise', note: 'Hard surfaces and no quiet route through.' },
  { id: 'lighting', name: 'Glare and low light', note: 'Unusable for low vision, and a fall risk.' }
];

const ROOT = __dirname;
const CONTENT = path.join(ROOT, 'content');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const CHAPTER_ORDER = ['ch2', 'ch3', 'ch4', 'ch6', 'ch7'];

function readJSON(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path.basename(file)}: ${err.message}`);
  }
}

// ---- validate content so a typo fails the build instead of the game -------

function validate(chapters) {
  const problems = [];
  const seen = new Set();

  for (const ch of chapters) {
    if (!ch.id || !ch.title) problems.push(`Chapter missing id or title: ${ch.id || '?'}`);
    if (!Array.isArray(ch.questions) || !ch.questions.length) {
      problems.push(`${ch.id}: no questions`);
      continue;
    }
    for (const q of ch.questions) {
      const at = `${ch.id}/${q.id || '(no id)'}`;
      if (!q.id) problems.push(`${at}: missing id`);
      if (seen.has(q.id)) problems.push(`${at}: duplicate question id`);
      seen.add(q.id);
      if (!q.prompt) problems.push(`${at}: missing prompt`);
      if (!q.topic) problems.push(`${at}: missing topic`);
      if (!q.explain) problems.push(`${at}: missing explain`);

      switch (q.type) {
        case 'mc':
        case 'scenario':
          if (!Array.isArray(q.choices) || q.choices.length < 2) problems.push(`${at}: needs 2+ choices`);
          if (typeof q.answer !== 'number') problems.push(`${at}: answer must be a number`);
          else if (!q.choices || q.answer < 0 || q.answer >= q.choices.length) problems.push(`${at}: answer index out of range`);
          break;
        case 'multi':
          if (!Array.isArray(q.choices) || q.choices.length < 2) problems.push(`${at}: needs 2+ choices`);
          if (!Array.isArray(q.answer) || !q.answer.length) problems.push(`${at}: answer must be a non-empty array`);
          else if (q.choices && q.answer.some((i) => i < 0 || i >= q.choices.length)) problems.push(`${at}: answer index out of range`);
          break;
        case 'match':
          if (!Array.isArray(q.pairs) || q.pairs.length < 2) problems.push(`${at}: needs 2+ pairs`);
          else if (q.pairs.some((p) => !Array.isArray(p) || p.length !== 2)) problems.push(`${at}: each pair must be [term, definition]`);
          break;
        case 'order':
          if (!Array.isArray(q.items) || q.items.length < 2) problems.push(`${at}: needs 2+ items`);
          break;
        case 'fill':
          if (!Array.isArray(q.answer) || !q.answer.length) problems.push(`${at}: answer must be a non-empty array of accepted strings`);
          break;
        default:
          problems.push(`${at}: unknown type "${q.type}"`);
      }
    }
  }
  return problems;
}

// ---- build ---------------------------------------------------------------

function build() {
  let chapters = CHAPTER_ORDER
    .map((id) => path.join(CONTENT, `${id}.json`))
    .filter((f) => fs.existsSync(f))
    .map(readJSON);

  // pick up any extra chapters the instructor added that aren't in the order list
  for (const f of fs.readdirSync(CONTENT)) {
    if (!f.endsWith('.json') || f === 'exams.json') continue;
    const id = f.replace(/\.json$/, '');
    if (!CHAPTER_ORDER.includes(id)) chapters.push(readJSON(path.join(CONTENT, f)));
  }
  chapters.sort((a, b) => (a.number || 99) - (b.number || 99));

  // The sample chapter exists so a fresh clone is playable. Once real chapters
  // are present it drops out, rather than gating the course behind a demo.
  const real = chapters.filter((c) => !c.sample);
  const usingSample = real.length === 0;
  if (!usingSample) chapters = real;

  const exams = fs.existsSync(path.join(CONTENT, 'exams.json'))
    ? readJSON(path.join(CONTENT, 'exams.json'))
    : { exams: [] };

  const problems = validate(chapters);
  if (problems.length) {
    console.error('\n  Content validation failed:\n');
    problems.forEach((p) => console.error('   • ' + p));
    console.error('');
    process.exit(1);
  }

  // ---- level 2: precompute two extra distractors per multiple-choice item ----
  //
  // Difficulty is a presentation transform: the same item is served with 4 options
  // at level 1 and 6 at level 2. Candidates are drawn from the same CHAPTER but a
  // DIFFERENT topic - same-topic borrowing risks pulling in a statement that is
  // actually true for this question. Precomputing here (rather than at runtime)
  // means the strings land in the bundle where they can be read and corrected.
  function addExtras(chapters) {
    let filled = 0, thin = 0;
    for (const ch of chapters) {
      const mc = ch.questions.filter((q) => q.type === 'mc' || q.type === 'scenario');
      for (const q of mc) {
        const mine = new Set(q.choices.map((c) => normStr(c)));
        const sameTopicAnswers = new Set(
          mc.filter((o) => o.topic === q.topic && o.id !== q.id)
            .map((o) => normStr(o.choices[o.answer]))
        );

        const pool = [];
        for (const other of mc) {
          if (other.id === q.id || other.topic === q.topic) continue;
          for (const c of other.choices) {
            const n = normStr(c);
            if (mine.has(n) || sameTopicAnswers.has(n)) continue;
            if (pool.some((p) => normStr(p) === n)) continue;
            pool.push(c);
          }
        }

        // deterministic pick so a rebuild does not reshuffle what the instructor reviewed
        const seed = q.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const picked = [];
        for (let i = 0; i < 2 && pool.length; i++) {
          picked.push(pool.splice((seed * (i + 7)) % pool.length, 1)[0]);
        }
        if (picked.length === 2) filled++; else thin++;
        q.extra = picked;
      }
    }
    return { filled, thin };
  }

  function normStr(s) {
    return String(s || '').toLowerCase().trim().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ');
  }

  const extras = addExtras(chapters);

  fs.mkdirSync(DIST, { recursive: true });

  // `flag` is authoring metadata. Shipping it would let a student read off
  // which questions the instructor expects on the exam, so strip it from the
  // bundle while leaving the source files untouched.
  const shipped = chapters.map((c) => ({
    ...c,
    questions: c.questions.map(({ flag, ...q }) => q)
  }));

  const payload = { chapters: shipped, exams, areas: WALK_AREAS, barriers: WALK_BARRIERS,
                    builtAt: new Date().toISOString() };
  const contentJS = 'window.RT_CONTENT=' + JSON.stringify(payload) + ';';

  fs.writeFileSync(path.join(DIST, 'content.js'), contentJS);

  // The projector labels one lane per chapter, so it needs their names - but it
  // has no business carrying 236 questions to get them. This is the manifest
  // only: id, number, title. A few hundred bytes against ~200KB.
  const manifest = shipped.map((c) => ({ id: c.id, number: c.number, title: c.title }));
  fs.writeFileSync(path.join(DIST, 'chapters.js'),
    'window.RT_CHAPTERS=' + JSON.stringify(manifest) + ';\n' +
    'window.RT_AREAS=' + JSON.stringify(WALK_AREAS) + ';\n' +
    'window.RT_BARRIERS=' + JSON.stringify(WALK_BARRIERS) + ';');
  for (const f of ['index.html', 'styles.css', 'app.js', 'dashboard.html', 'room.html']) {
    fs.copyFileSync(path.join(SRC, f), path.join(DIST, f));
  }

  // single-file version
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const standalone = html
    .replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>')
    .replace('<script src="content.js"></script>', '<script>\n' + contentJS + '\n</script>')
    .replace('<script src="app.js"></script>', '<script>\n' + js + '\n</script>');
  fs.writeFileSync(path.join(DIST, 'standalone.html'), standalone);

  const totals = chapters.map((c) => `Ch ${c.number}: ${c.questions.length}`).join(', ');
  const count = chapters.reduce((n, c) => n + c.questions.length, 0);
  const flagged = chapters.reduce((n, c) => n + c.questions.filter((q) => q.flag === "test").length, 0);

  console.log(`\n  Built dist/ — ${count} questions (${flagged} instructor-flagged, stripped from the bundle)`);
  console.log(`  ${totals}`);
  console.log(`  Exams configured: ${(exams.exams || []).length}`);
  console.log(`  Level 2 distractors: ${extras.filled} items filled${extras.thin ? `, ${extras.thin} short of two` : ''}`);
  const withKey = chapters.reduce((n, c) => n + c.questions.filter((q) => q.key).length, 0);
  console.log(`  Level 3 write-in ready: ${withKey} items`);
  if (usingSample) {
    console.log('  Using the sample chapter — add your own content/ch*.json files to replace it.');
  }
  console.log(`  Standalone file: dist/standalone.html (${(standalone.length / 1024).toFixed(0)} KB)\n`);
}

build();
