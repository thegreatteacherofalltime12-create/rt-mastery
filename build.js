#!/usr/bin/env node
/**
 * Bundles content/*.json + src/* into dist/.
 * Also emits dist/standalone.html — a single self-contained file you can
 * email, drop in an LMS, or open straight from a USB stick.
 */
const fs = require('fs');
const path = require('path');

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

  fs.mkdirSync(DIST, { recursive: true });

  const payload = { chapters, exams, builtAt: new Date().toISOString() };
  const contentJS = 'window.RT_CONTENT=' + JSON.stringify(payload) + ';';

  fs.writeFileSync(path.join(DIST, 'content.js'), contentJS);
  for (const f of ['index.html', 'styles.css', 'app.js', 'dashboard.html']) {
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
  const flagged = chapters.reduce((n, c) => n + c.questions.filter((q) => q.flag === 'test').length, 0);

  console.log(`\n  Built dist/ — ${count} questions (${flagged} flagged as likely test questions)`);
  console.log(`  ${totals}`);
  console.log(`  Exams configured: ${(exams.exams || []).length}`);
  if (usingSample) {
    console.log('  Using the sample chapter — add your own content/ch*.json files to replace it.');
  }
  console.log(`  Standalone file: dist/standalone.html (${(standalone.length / 1024).toFixed(0)} KB)\n`);
}

build();
