#!/usr/bin/env node
/**
 * Builds a variant test bank: multiple-choice questions on the same material as
 * the study game, but which have never appeared there as multiple choice.
 *
 *   node scripts/variants.js        -> testbank/
 *
 * WHY THESE SOURCES, AND NOT THE OTHERS
 *
 * Every item here is recombined out of the instructor's own text. Nothing is
 * invented, because a graded paper that drifts from the textbook is worse than
 * no paper.
 *
 *   match pairs  - 60 term/definition pairs. A match question's pairs are
 *                  one-to-one by construction, so its siblings are guaranteed
 *                  wrong for each other: the safest distractors in the bank.
 *   order steps  - "which step comes immediately after X". The other steps in
 *                  the same sequence are guaranteed wrong.
 *
 *   exclusions   - 'which of these is NOT one of the four behavioural
 *                  domains'. The instructor's own false options are the
 *                  answer and her own true options are the distractors, so
 *                  correctness is guaranteed by the data rather than by me.
 *                  These are the confusions she wrote the false options to
 *                  catch in the first place.
 *   counts       - 'how many functions of a group does the textbook list'.
 *                  Only generated where her prompt STATES the number and it
 *                  matches the number of true options, so the list is known
 *                  to be complete. Otherwise the count is an artefact of how
 *                  many options she happened to write, not a fact.
 *
 * DELIBERATELY NOT USED:
 *
 *   multi as MC  - turning 'select all' into 'pick the one that is true'
 *                  needs three false options and no question in the bank has
 *                  three (26 have one, 16 have two). Borrowing a TRUE
 *                  statement from another question as a distractor can easily
 *                  make it also a correct answer, which breaks the item
 *                  silently. Not worth it on a graded paper.
 *   fill-in      - the answer is a term, but there are no sibling terms to
 *                  serve as distractors without inventing them.
 *   MC rewording - changing the words of an existing question does not stop a
 *                  student recognising it, so it buys nothing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'testbank');
const LETTERS = ['A', 'B', 'C', 'D'];

const argCount = process.argv.indexOf('--count');
const WANT = argCount > -1 ? Number(process.argv[argCount + 1]) || 100 : 100;

let seed = 20260925;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- load

const chapters = [];
for (const f of fs.readdirSync(CONTENT).sort()) {
  if (!/^ch\d+\.json$/.test(f)) continue;
  chapters.push(JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')));
}
if (!chapters.length) { console.error('No chapter files in content/.'); process.exit(1); }

const all = [];
chapters.forEach((c) => (c.questions || []).forEach((q) =>
  all.push({ ...q, chapter: c.id, chNum: c.number })));

const totalQs = chapters.reduce((n, c) => n + (c.questions || []).length, 0);
const items = [];

// ------------------------------------------------- term and definition pairs

// Her prompt already says what is being matched to what - 'Match each
// leadership role to its description', 'Match each group stage to its
// alternate name'. Reusing those two nouns gives a stem that reads like a
// question, instead of a generic one that turns into nonsense the moment a
// 'definition' is a two-word alternate name.
function matchNouns(prompt) {
  const m = tidy(prompt).match(/^Match each (?:of the \S+ )?(.+?) to (?:its|their) (.+?)\.?$/i);
  if (!m) return null;
  let subject = m[1].replace(/\s+in\s+.+$/, '').trim().replace(/s$/, '');
  const attribute = m[2].trim();
  if (!subject || !attribute || subject.length > 40 || attribute.length > 40) return null;
  return { subject: subject, attribute: attribute };
}

const matchQs = all.filter((q) => q.type === 'match' && Array.isArray(q.pairs) && q.pairs.length >= 2);

// every term in a chapter, so a 2-pair or 3-pair question can still be given
// four options without reaching into a different chapter
const termsByChapter = {};
matchQs.forEach((q) => {
  termsByChapter[q.chapter] = termsByChapter[q.chapter] || [];
  q.pairs.forEach((p) => termsByChapter[q.chapter].push({ term: p[0], def: p[1], from: q.id }));
});

matchQs.forEach((q) => {
  const siblings = q.pairs.map((p) => ({ term: p[0], def: p[1] }));
  const nouns = matchNouns(q.prompt);
  q.pairs.forEach((pair, idx) => {
    const [term, def] = pair;
    // Alternate direction per pair so the paper is not thirty of the same shape,
    // and so no pair is ever asked both ways on one paper.
    const askForTerm = (idx % 2) === 0;

    const others = siblings.filter((s) => s.term !== term);
    const pool = shuffle(others).slice(0, 3);
    // top up from elsewhere in the same chapter if this question is small
    if (pool.length < 3) {
      const extra = shuffle((termsByChapter[q.chapter] || [])
        .filter((t) => t.from !== q.id && !pool.some((p) => p.term === t.term) && t.term !== term));
      pool.push(...extra.slice(0, 3 - pool.length));
    }
    if (pool.length < 3) return;   // not enough safe distractors: skip, never pad

    items.push({
      source: 'term pair',
      chapter: q.chapter, chNum: q.chNum, topic: q.topic, origin: q.id,
      prompt: askForTerm
        ? (nouns
            ? 'Which ' + nouns.subject + ' matches this ' + nouns.attribute + '? “' + tidy(def) + '”'
            : 'Which term does this describe? “' + tidy(def) + '”')
        : (nouns
            ? 'Which ' + nouns.attribute + ' matches the ' + nouns.subject + ' “' + tidy(term) + '”?'
            : 'Which of these best describes ' + tidy(term) + '?'),
      correct: askForTerm ? tidy(term) : tidy(def),
      distractors: pool.map((p) => tidy(askForTerm ? p.term : p.def)),
      explain: tidy(q.explain || (term + ' — ' + def))
    });
  });
});

// ------------------------------------------------------------- ordered steps

all.filter((q) => q.type === 'order' && Array.isArray(q.items) && q.items.length >= 3)
  .forEach((q) => {
    const steps = q.items;
    // 'Put the 5 steps of implementing EBP in order.' -> 'the 5 steps of
    // implementing EBP'. The old pattern only caught 'correct order', so the
    // rest kept a trailing 'in order.' in the middle of the question.
    const what = tidy(q.prompt)
      .replace(/^Put\s+/i, '')
      .replace(/\s+in\s+(the\s+)?(correct\s+)?order\.?$/i, '')
      .replace(/\.$/, '');
    for (let i = 0; i < steps.length - 1; i++) {
      const others = steps.filter((_, j) => j !== i + 1);
      if (others.length < 3) continue;
      items.push({
        source: 'sequence',
        chapter: q.chapter, chNum: q.chNum, topic: q.topic, origin: q.id,
        prompt: 'In ' + what + ', which comes immediately after ' + tidy(steps[i]) + '?',
        correct: tidy(steps[i + 1]),
        distractors: shuffle(others).slice(0, 3).map(tidy),
        explain: tidy(q.explain || (what + ': ' + steps.join(' → ')))
      });
    }
  });

// ------------------------------------------------- exclusions and counts

// Turn her prompt into a noun phrase we can put after 'NOT one of the'.
// Anything that will not reduce cleanly is skipped rather than forced: an
// awkward stem on a graded paper costs more than a missing question.
function listPhrase(prompt) {
  let p = String(prompt).replace(/\s+/g, ' ').trim();
  p = p.replace(/\s*Select all that apply\.?\s*$/i, '');
  p = p.replace(/[?.]\s*$/, '');
  let m = p.match(/^Select ALL of the (.+)$/i) ||
          p.match(/^Select ALL (.+)$/i) ||
          p.match(/^What are the (.+)$/i) ||
          p.match(/^What (\d+ .+)$/i);
  if (!m) return null;
  let phrase = m[1].trim();
  // drop anything that has turned into a clause rather than a noun phrase
  if (/\b(which|that are|can be|should|is |are used|used for|used to)\b/i.test(phrase)) return null;
  if (phrase.length < 6 || phrase.length > 90) return null;
  return phrase;
}

const NUM_WORD = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six',
                   7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve' };

all.filter((q) => q.type === 'multi' && Array.isArray(q.answer) && Array.isArray(q.choices))
  .forEach((q) => {
    const trueOpts = q.choices.filter((_, i) => q.answer.indexOf(i) > -1);
    const falseOpts = q.choices.filter((_, i) => q.answer.indexOf(i) === -1);
    const phrase = listPhrase(q.prompt);
    if (!phrase) return;

    // EXCLUSION. Her false option is the answer; her true options are the
    // distractors. Both sides come from her, so this cannot be wrong unless
    // her own question was.
    if (falseOpts.length >= 1 && trueOpts.length >= 3) {
      const answer = shuffle(falseOpts)[0];
      items.push({
        source: 'exclusion',
        chapter: q.chapter, chNum: q.chNum, topic: q.topic, origin: q.id,
        prompt: 'Which of the following is NOT one of the ' + phrase + '?',
        correct: tidy(answer),
        distractors: shuffle(trueOpts).slice(0, 3).map(tidy),
        explain: tidy(q.explain || '')
      });
    }

    // COUNT. Only when she states the number herself and it matches what she
    // wrote, which is the only way to know the list is complete.
    const stated = (q.prompt.match(/\b(\d+)\b/) || [])[1];
    const n = trueOpts.length;
    if (stated && Number(stated) === n && NUM_WORD[n]) {
      const near = [n - 2, n - 1, n + 1, n + 2].filter((x) => NUM_WORD[x] && x !== n);
      if (near.length >= 3) {
        // 'leadership roles listed in the textbook' followed by 'does the
        // textbook list' reads badly, so the attribution comes off first.
        const clean = phrase.replace(new RegExp('^' + n + '\\s+'), '')
          .replace(/\s+listed in the textbook$/i, '');
        items.push({
          source: 'count',
          chapter: q.chapter, chNum: q.chNum, topic: q.topic, origin: q.id,
          prompt: 'How many ' + clean + ' does the textbook list?',
          correct: NUM_WORD[n],
          distractors: shuffle(near).slice(0, 3).map((x) => NUM_WORD[x]),
          explain: tidy(q.explain || '')
        });
      }
    }
  });

// ---------------------------------------------------------------- lay out

// drop anything where a distractor equals the answer after tidying
const clean = items.filter((it) => !it.distractors.some((d) => d === it.correct));
const dropped = items.length - clean.length;

// Trim to the wanted size by taking from whichever chapter is furthest over
// its share of the bank, so cutting improves the balance rather than just
// lopping off the end.
const targetShare = {};
chapters.forEach((c) => { targetShare[c.id] = WANT * (c.questions || []).length / totalQs; });
const held = {};
clean.forEach((it) => { held[it.chapter] = (held[it.chapter] || 0) + 1; });
const kept = [];
shuffle(clean).forEach((it) => {
  kept.push(it);
});
while (kept.length > WANT) {
  const over = {};
  kept.forEach((it) => { over[it.chapter] = (over[it.chapter] || 0) + 1; });
  const worst = Object.keys(over).sort((a, b) =>
    (over[b] - (targetShare[b] || 0)) - (over[a] - (targetShare[a] || 0)))[0];
  const i = kept.map((x) => x.chapter).lastIndexOf(worst);
  kept.splice(i === -1 ? kept.length - 1 : i, 1);
}
const trimmed = clean.length - kept.length;

const laid = kept.map((it, i) => {
  const slot = i % 4;
  const opts = it.distractors.slice();
  opts.splice(slot, 0, it.correct);
  return { ...it, n: i + 1, choices: opts, letter: LETTERS[slot] };
});

// ---------------------------------------------------------------- write

fs.mkdirSync(OUT, { recursive: true });
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const csv = [['Number', 'Question', 'A', 'B', 'C', 'D', 'Correct', 'Chapter', 'Topic', 'Built from', 'Feedback'].join(',')]
  .concat(laid.map((q) => [q.n, q.prompt, q.choices[0], q.choices[1], q.choices[2], q.choices[3],
    q.letter, 'Ch ' + q.chNum, q.topic, q.source + ' (' + q.origin + ')', q.explain]
    .map(csvCell).join(','))).join('\r\n');
fs.writeFileSync(path.join(OUT, 'RT-variants.csv'), '﻿' + csv, 'utf8');

fs.writeFileSync(path.join(OUT, 'RT-variants-aiken.txt'), laid.map((q) =>
  q.prompt + '\n' + q.choices.map((c, i) => LETTERS[i] + '. ' + c).join('\n') + '\nANSWER: ' + q.letter
).join('\n\n'), 'utf8');

fs.writeFileSync(path.join(OUT, 'RT-variants.md'), [
  '# Therapeutic Recreation — variant test bank',
  '',
  laid.length + ' multiple-choice questions on the same material as the study game,',
  'built from parts of the question bank that have never appeared there as',
  'multiple choice. Answer key at the end.',
  '',
  '---',
  ''
].concat(laid.map((q) =>
  '**' + q.n + '.** ' + q.prompt + '  \n' + q.choices.map((c, i) => LETTERS[i] + '. ' + c).join('  \n') + '\n'
)).concat([
  '---', '', '## Answer key', '',
  laid.map((q) => q.n + '. ' + q.letter).join('  \n'), '',
  '## Where each question came from', '',
  '| # | Answer | Chapter | Topic | Built from |',
  '|---|---|---|---|---|',
  laid.map((q) => '| ' + q.n + ' | ' + q.letter + ' | Ch ' + q.chNum + ' | ' + q.topic + ' | ' + q.source + ' |').join('\n')
]).join('\n'), 'utf8');

// ---------------------------------------------------------------- report

const byCh = {}, byLetter = {}, bySrc = {};
laid.forEach((q) => {
  byCh['Ch ' + q.chNum] = (byCh['Ch ' + q.chNum] || 0) + 1;
  byLetter[q.letter] = (byLetter[q.letter] || 0) + 1;
  bySrc[q.source] = (bySrc[q.source] || 0) + 1;
});
console.log('\n  ' + laid.length + ' variant questions written to testbank/');
console.log('    RT-variants.csv / -aiken.txt / .md');
console.log('\n  By chapter: ' + Object.keys(byCh).sort().map((k) => k + ' ' + byCh[k]).join(', '));
console.log('  Built from: ' + Object.keys(bySrc).map((k) => k + ' ' + bySrc[k]).join(', '));
console.log('  Correct answer: ' + LETTERS.map((l) => l + ' ' + (byLetter[l] || 0)).join(', '));
if (dropped) console.log('  Dropped for a duplicate option: ' + dropped);
if (trimmed) console.log('  Trimmed to balance the chapters: ' + trimmed + ' (of ' + clean.length + ' possible)');
console.log('');
