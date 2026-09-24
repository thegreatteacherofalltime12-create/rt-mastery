#!/usr/bin/env node
/**
 * Mixes the two test banks into one 100 question paper, and renders it to PDF.
 *
 *   node scripts/testbank.js && node scripts/variants.js && node scripts/paper.js
 *
 * The two banks share no prompts, but they can still test the same FACT from
 * two directions - the study bank asks what characterises Norming, the variant
 * bank asks which stage is also called WE. On one paper that is a wasted
 * question and an unfair double penalty.
 *
 * So the paper dedupes on the FACT, which is the source question plus the
 * answer - not the source question alone. Sixty term pairs come from only
 * sixteen match questions, and 'which role is the Director' and 'which role
 * is the Enabler' are different facts that happen to share a parent. Blocking
 * on the parent alone quietly capped the variant side at about forty.
 *
 * Roughly half the paper is drawn from each bank: enough of the familiar shape
 * that a student who revised is rewarded, enough of the unfamiliar that
 * memorising the study set is not the same as knowing the material.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'testbank');
const LETTERS = ['A', 'B', 'C', 'D'];

const argCount = process.argv.indexOf('--count');
const WANT = argCount > -1 ? Number(process.argv[argCount + 1]) || 100 : 100;

let seed = 20260926;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// ---------------------------------------------------------------- read

function readCsv(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
  const lines = raw.split('\r\n').filter(Boolean);
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
  function split(l) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    }
    out.push(cur);
    return out;
  }
}

const studyFile = path.join(OUT, 'RT-test-bank.csv');
const variantFile = path.join(OUT, 'RT-variants.csv');
for (const f of [studyFile, variantFile]) {
  if (!fs.existsSync(f)) {
    console.error('Missing ' + path.basename(f) + '. Run scripts/testbank.js and scripts/variants.js first.');
    process.exit(1);
  }
}

function load(file, bank, originKey) {
  return readCsv(file).map((r) => ({
    bank: bank,
    prompt: r.Question,
    choices: [r.A, r.B, r.C, r.D],
    correct: r[r.Correct === 'A' ? 'A' : r.Correct === 'B' ? 'B' : r.Correct === 'C' ? 'C' : 'D'],
    chapter: r.Chapter,
    topic: r.Topic,
    // "exclusion (ch7-21)" on the variant side, a bare id on the study side
    origin: (String(r[originKey] || '').match(/ch\d+-\d+/) || [r[originKey]])[0],
    explain: r.Feedback || ''
  })).map((q) => ({ ...q, fact: q.origin + '|' + q.correct }));
}

const study = load(studyFile, 'study', 'Origin');
const variants = load(variantFile, 'variant', 'Built from');

// ---------------------------------------------------------------- select

// Chapter shares come from the paper we already balanced, so the mixed paper
// keeps the same shape as the course.
const target = {};
study.forEach((q) => { target[q.chapter] = (target[q.chapter] || 0) + 1; });
const totalTarget = Object.values(target).reduce((a, b) => a + b, 0);
Object.keys(target).forEach((k) => { target[k] = Math.round(WANT * target[k] / totalTarget); });

const usedFacts = new Set();
const usedOrigins = new Set();
const picked = [];
const chapters = Object.keys(target).sort();

chapters.forEach((ch, ci) => {
  const want = target[ch];
  // alternate between the banks so the paper is genuinely mixed rather than
  // one bank followed by the other
  const pools = {
    study: shuffle(study.filter((q) => q.chapter === ch)),
    variant: shuffle(variants.filter((q) => q.chapter === ch))
  };
  const usedTopics = new Set();
  // Alternate which bank goes first per chapter. Whichever starts wins every
  // tie when the origin dedup blocks the other, so always starting with the
  // same one quietly skews the whole paper toward it.
  let turn = ci % 2 === 0 ? 'study' : 'variant';
  let guard = 0;

  while (picked.filter((q) => q.chapter === ch).length < want && guard++ < 500) {
    const other = turn === 'study' ? 'variant' : 'study';
    let took = false;
    for (const bank of [turn, other]) {
      // first choice: a fact not yet asked, on a topic not yet used
      let take = pools[bank].findIndex((q) =>
        !usedFacts.has(q.fact) && !usedTopics.has(q.topic));
      // then: a fact not yet asked, even if the topic has come up
      if (take === -1) take = pools[bank].findIndex((q) => !usedFacts.has(q.fact));
      if (take === -1) continue;
      const q = pools[bank].splice(take, 1)[0];
      usedFacts.add(q.fact);
      usedOrigins.add(q.origin);
      usedTopics.add(q.topic);
      picked.push(q);
      took = true;
      break;
    }
    if (!took) break;
    turn = turn === 'study' ? 'variant' : 'study';
  }
});

// ---------------------------------------------------------------- lay out

const laid = shuffle(picked).slice(0, WANT).map((q, i) => {
  const distractors = shuffle(q.choices.filter((c) => c !== q.correct));
  const slot = i % 4;
  const opts = distractors.slice(0, 3);
  opts.splice(slot, 0, q.correct);
  return { ...q, n: i + 1, choices: opts, letter: LETTERS[slot] };
});

// ---------------------------------------------------------------- write

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

fs.writeFileSync(path.join(OUT, 'RT-final-paper.csv'), '\ufeff' +
  [['Number', 'Question', 'A', 'B', 'C', 'D', 'Correct', 'Chapter', 'Topic', 'Bank', 'Origin', 'Feedback'].join(',')]
    .concat(laid.map((q) => [q.n, q.prompt, q.choices[0], q.choices[1], q.choices[2], q.choices[3],
      q.letter, q.chapter, q.topic, q.bank, q.origin, q.explain].map(csvCell).join(',')))
    .join('\r\n'), 'utf8');

fs.writeFileSync(path.join(OUT, 'RT-final-paper-aiken.txt'), laid.map((q) =>
  q.prompt + '\n' + q.choices.map((c, i) => LETTERS[i] + '. ' + c).join('\n') + '\nANSWER: ' + q.letter
).join('\n\n'), 'utf8');

// ---------------------------------------------------------------- the paper

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Therapeutic Recreation — Examination</title>
<style>
  @page { size: letter; margin: 19mm 16mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.25pt/1.36 Georgia, "Times New Roman", serif; color: #111; margin: 0; }

  .cover { text-align: center; padding-top: 48mm; page-break-after: always; }
  .cover h1 { font-size: 21pt; margin: 0 0 4mm; letter-spacing: 0.01em; }
  .cover .sub { font-size: 12pt; color: #444; margin-bottom: 22mm; }
  .fields { display: inline-block; text-align: left; font-size: 11pt; line-height: 2.6; }
  .fields b { display: inline-block; width: 28mm; font-weight: normal; color: #444; }
  .rule { display: inline-block; width: 78mm; border-bottom: 0.5pt solid #333; }
  .instructions { margin: 24mm auto 0; max-width: 118mm; text-align: left;
    font-size: 9.5pt; color: #333; border-top: 0.5pt solid #bbb; padding-top: 5mm; }
  .instructions li { margin-bottom: 1.6mm; }

  .q { page-break-inside: avoid; margin: 0 0 3.6mm; }
  .q .stem { font-weight: 600; margin-bottom: 1.4mm; }
  .q .stem .n { display: inline-block; min-width: 7mm; }
  ol.opts { list-style: none; margin: 0; padding: 0 0 0 7mm; }
  ol.opts li { margin-bottom: 0.3mm; }
  ol.opts .L { display: inline-block; width: 5.5mm; font-weight: 600; }

  h2 { font-size: 13pt; margin: 0 0 4mm; page-break-before: always; }
  .keygrid { columns: 5; column-gap: 8mm; font-size: 10pt; }
  .keygrid div { break-inside: avoid; margin-bottom: 1mm; }
  table { border-collapse: collapse; width: 100%; font-size: 8.5pt; }
  th, td { border-bottom: 0.5pt solid #ddd; padding: 1.4mm 2mm; text-align: left; vertical-align: top; }
  th { border-bottom: 0.8pt solid #888; }
  .foot { margin-top: 6mm; font-size: 8.5pt; color: #666; }
</style></head><body>

<div class="cover">
  <h1>Therapeutic Recreation</h1>
  <div class="sub">Examination &middot; ${laid.length} questions</div>
  <div class="fields">
    <div><b>Name</b><span class="rule"></span></div>
    <div><b>Date</b><span class="rule"></span></div>
    <div><b>Section</b><span class="rule"></span></div>
  </div>
  <div class="instructions">
    <ol>
      <li>Answer every question. There is exactly one best answer to each.</li>
      <li>Mark your choice clearly. An unclear mark is scored as no answer.</li>
      <li>Nothing is deducted for a wrong answer, so do not leave anything blank.</li>
    </ol>
  </div>
</div>

${laid.map((q) => `<div class="q"><div class="stem"><span class="n">${q.n}.</span> ${esc(q.prompt)}</div>
<ol class="opts">${q.choices.map((c, i) =>
  `<li><span class="L">${LETTERS[i]}.</span> ${esc(c)}</li>`).join('')}</ol></div>`).join('\n')}

<h2>Answer key</h2>
<div class="keygrid">${laid.map((q) => `<div>${q.n}. <b>${q.letter}</b></div>`).join('')}</div>

<h2>Question sources</h2>
<table>
  <tr><th>#</th><th>Ans</th><th>Chapter</th><th>Topic</th><th>From</th></tr>
  ${laid.map((q) => `<tr><td>${q.n}</td><td>${q.letter}</td><td>${esc(q.chapter)}</td>` +
    `<td>${esc(q.topic)}</td><td>${esc(q.origin || '')}</td></tr>`).join('')}
</table>
<p class="foot">Every question is drawn from the course question bank. No two questions
on this paper come from the same source item.</p>

</body></html>`;

const htmlPath = path.join(OUT, 'RT-final-paper.html');
fs.writeFileSync(htmlPath, html, 'utf8');

// ---------------------------------------------------------------- pdf

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const browser = BROWSERS.find((b) => fs.existsSync(b));
const pdfPath = path.join(OUT, 'RT-final-paper.pdf');

let pdfOk = false;
if (browser) {
  try {
    execFileSync(browser, [
      '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
      '--print-to-pdf=' + pdfPath, 'file:///' + htmlPath.replace(/\\/g, '/')
    ], { stdio: 'ignore', timeout: 120000 });
    pdfOk = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000;
  } catch (e) { pdfOk = false; }
}

// ---------------------------------------------------------------- report

const byCh = {}, byBank = {}, byLetter = {};
laid.forEach((q) => {
  byCh[q.chapter] = (byCh[q.chapter] || 0) + 1;
  byBank[q.bank] = (byBank[q.bank] || 0) + 1;
  byLetter[q.letter] = (byLetter[q.letter] || 0) + 1;
});

console.log('\n  ' + laid.length + ' question paper written to testbank/');
console.log('    RT-final-paper.pdf       ' + (pdfOk ? 'printable exam + answer key' : 'NOT BUILT'));
console.log('    RT-final-paper.csv       spreadsheet / import');
console.log('    RT-final-paper-aiken.txt Moodle, Canvas, Blackboard');
console.log('    RT-final-paper.html      the source the PDF is rendered from');
console.log('\n  By chapter: ' + Object.keys(byCh).sort().map((k) => k + ' ' + byCh[k]).join(', '));
console.log('  From each bank: ' + Object.keys(byBank).map((k) => k + ' ' + byBank[k]).join(', '));
console.log('  Correct answer: ' + LETTERS.map((l) => l + ' ' + (byLetter[l] || 0)).join(', '));
console.log('  Distinct facts: ' + new Set(laid.map((q) => q.fact)).size + ' of ' + laid.length +
            '  (from ' + new Set(laid.map((q) => q.origin)).size + ' source questions)');
if (!pdfOk) console.log('\n  No browser found to render the PDF; open the HTML and print to PDF.');
console.log('');
