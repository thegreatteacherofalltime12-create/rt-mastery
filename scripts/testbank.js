#!/usr/bin/env node
/**
 * Builds a 100-question multiple-choice test bank out of the course question
 * bank, for import into whatever platform the quiz is actually delivered in.
 *
 *   node scripts/testbank.js            -> testbank/
 *   node scripts/testbank.js --count 50
 *
 * Nothing here is invented. Every question is one of the instructor's own,
 * already written against her textbook and already reviewed, so the test cannot
 * drift away from what was taught. Questions she flagged as likely test
 * material are chosen first.
 *
 * The output contains her question bank, so testbank/ is gitignored for the
 * same reason content/ is.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'testbank');

const argCount = process.argv.indexOf('--count');
const WANT = argCount > -1 ? Number(process.argv[argCount + 1]) || 100 : 100;
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// A fixed seed, so re-running gives the same paper unless the bank changes.
let seed = 20260924;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- load

const chapters = [];
for (const f of fs.readdirSync(CONTENT).sort()) {
  if (!/^ch\d+\.json$/.test(f)) continue;
  const c = JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'));
  chapters.push(c);
}
if (!chapters.length) {
  console.error('No chapter files in content/. This needs the real question bank.');
  process.exit(1);
}

const pool = [];
for (const c of chapters) {
  for (const q of c.questions || []) {
    // Single-answer only: everything else has to be rewritten to be a fair
    // multiple-choice item, and rewriting is how a test stops matching a
    // textbook.
    if (q.type !== 'mc' && q.type !== 'scenario') continue;
    if (!Array.isArray(q.choices) || q.choices.length < 4) continue;
    pool.push({
      id: q.id, chapter: c.id, chNum: c.number, chTitle: c.title,
      topic: q.topic, prompt: q.prompt, choices: q.choices.slice(),
      answer: q.answer, explain: q.explain || '', flag: !!q.flag
    });
  }
}

// ---------------------------------------------------------------- select

// Proportional to the size of each chapter in the bank, so the paper reflects
// the course rather than whichever chapter happened to be written up most.
const perChapter = {};
const totalQs = chapters.reduce((n, c) => n + (c.questions || []).length, 0);
let assigned = 0;
chapters.forEach((c, i) => {
  const share = Math.round(WANT * (c.questions || []).length / totalQs);
  perChapter[c.id] = share;
  assigned += share;
});
// nudge the largest chapter to make the total land exactly on WANT
const biggest = chapters.slice().sort((a, b) => b.questions.length - a.questions.length)[0];
perChapter[biggest.id] += WANT - assigned;

const picked = [];
const shortfalls = [];
for (const c of chapters) {
  const want = perChapter[c.id];
  const mine = pool.filter((q) => q.chapter === c.id);
  const flagged = shuffle(mine.filter((q) => q.flag));
  const rest = shuffle(mine.filter((q) => !q.flag));

  // Spread across topics before doubling up on any one of them.
  const take = [];
  const usedTopics = new Set();
  for (const list of [flagged, rest]) {
    for (const q of list) {
      if (take.length >= want) break;
      if (usedTopics.has(q.topic)) continue;
      take.push(q); usedTopics.add(q.topic);
    }
  }
  for (const list of [flagged, rest]) {
    for (const q of list) {
      if (take.length >= want) break;
      if (take.indexOf(q) > -1) continue;
      take.push(q);
    }
  }
  if (take.length < want) shortfalls.push(c.id + ' wanted ' + want + ', had ' + take.length);
  picked.push(...take);
}

// ---------------------------------------------------------------- lay out

// The correct answer is placed round-robin across the letters. In the source
// bank it sits at B seventy-one times out of a hundred and sixty-nine, which on
// a real paper is a pattern a student can ride.
const ordered = shuffle(picked);
const items = ordered.map((q, i) => {
  const correctText = q.choices[q.answer];
  const distractors = shuffle(q.choices.filter((_, idx) => idx !== q.answer));
  const slot = i % 4;
  const laid = distractors.slice();
  laid.splice(slot, 0, correctText);
  return {
    n: i + 1, id: q.id, chapter: 'Ch ' + q.chNum, chTitle: q.chTitle,
    topic: q.topic, prompt: q.prompt.replace(/\s+/g, ' ').trim(),
    choices: laid, correct: slot, letter: LETTERS[slot],
    explain: q.explain.replace(/\s+/g, ' ').trim(), flag: q.flag
  };
});

// ---------------------------------------------------------------- write

fs.mkdirSync(OUT, { recursive: true });

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const csv = [
  ['Number', 'Question', 'A', 'B', 'C', 'D', 'Correct', 'Chapter', 'Topic', 'Feedback'].join(',')
].concat(items.map((q) => [
  q.n, q.prompt, q.choices[0], q.choices[1], q.choices[2], q.choices[3],
  q.letter, q.chapter, q.topic, q.explain
].map(csvCell).join(','))).join('\r\n');
fs.writeFileSync(path.join(OUT, 'RT-test-bank.csv'), '﻿' + csv, 'utf8');

// Aiken: the simplest format Moodle, Canvas and Blackboard all import directly.
const aiken = items.map((q) =>
  q.prompt + '\n' +
  q.choices.map((c, i) => LETTERS[i] + '. ' + c).join('\n') + '\n' +
  'ANSWER: ' + q.letter
).join('\n\n');
fs.writeFileSync(path.join(OUT, 'RT-test-bank-aiken.txt'), aiken, 'utf8');

// Something printable, with the key at the back rather than beside the answers.
const paper = [
  '# Therapeutic Recreation — test bank',
  '',
  items.length + ' multiple-choice questions, drawn from the course question bank.',
  'Answer key is at the end.',
  '',
  '---',
  ''
].concat(items.map((q) =>
  '**' + q.n + '.** ' + q.prompt + '  \n' +
  q.choices.map((c, i) => LETTERS[i] + '. ' + c).join('  \n') + '\n'
)).concat([
  '---',
  '',
  '## Answer key',
  '',
  items.map((q) => q.n + '. ' + q.letter).join('  \n'),
  '',
  '## Where each question came from',
  '',
  '| # | Answer | Chapter | Topic |',
  '|---|---|---|---|',
  items.map((q) => '| ' + q.n + ' | ' + q.letter + ' | ' + q.chapter + ' | ' + q.topic + ' |').join('\n')
]).join('\n');
fs.writeFileSync(path.join(OUT, 'RT-test-bank.md'), paper, 'utf8');

// ---------------------------------------------------------------- report

const byCh = {};
const byLetter = {};
const topics = new Set();
items.forEach((q) => {
  byCh[q.chapter] = (byCh[q.chapter] || 0) + 1;
  byLetter[q.letter] = (byLetter[q.letter] || 0) + 1;
  topics.add(q.topic);
});

console.log('\n  ' + items.length + ' questions written to testbank/');
console.log('    RT-test-bank.csv         spreadsheet / most import tools');
console.log('    RT-test-bank-aiken.txt   direct import: Moodle, Canvas, Blackboard');
console.log('    RT-test-bank.md          printable, answer key at the back');
console.log('\n  By chapter: ' + Object.keys(byCh).sort().map((k) => k + ' ' + byCh[k]).join(', '));
console.log('  Correct answer: ' + LETTERS.slice(0, 4).map((l) => l + ' ' + (byLetter[l] || 0)).join(', '));
console.log('  Distinct topics covered: ' + topics.size);
console.log('  Flagged by the instructor as likely test material: ' +
            items.filter((q) => q.flag).length + ' of ' + items.length);
if (shortfalls.length) console.log('\n  SHORT: ' + shortfalls.join('; '));
console.log('');
