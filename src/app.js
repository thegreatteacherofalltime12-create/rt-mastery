/* RT Mastery — mastery-based study game for Therapeutic Recreation
 * Vanilla JS, no framework. State lives in localStorage; optionally syncs
 * to a Cloudflare Worker -> Firestore backend when a class code is set.
 */
(function () {
  'use strict';

  var CONTENT = window.RT_CONTENT || { chapters: [], exams: { exams: [] } };
  var CHAPTERS = CONTENT.chapters || [];
  var EXAMS = (CONTENT.exams && CONTENT.exams.exams) || [];

  var STORE_KEY = 'rt-mastery-v1';
  var MASTERY_BOX = 3;          // box number that counts as mastered
  var UNLOCK_AT = 0.8;          // mastery at the current level that promotes a chapter
  var SESSION_SIZE = 12;        // questions per practice round
  var MAX_LEVEL = 3;

  // Difficulty is a property of how a question is SERVED, not of the question.
  // The same item is worth more the harder the presentation.
  var LEVELS = {
    1: { name: 'Recognise', xp: 10, blurb: 'Four options' },
    2: { name: 'Discriminate', xp: 15, blurb: 'Six options' },
    3: { name: 'Recall', xp: 25, blurb: 'No options — type it' }
  };
  // ------------------------------------------------------------ Supply Closet
  //
  // Tokens are earned for ATTEMPTING a question, never for getting it right.
  // That is deliberate: purchasing power then tracks effort, so the student who
  // is behind is by construction the one attempting most and the one with the
  // most help available. A shop that paid for correctness would hand the most
  // help to whoever needed it least.
  //
  // Nothing spent here is ever shown to the class. The single exception is
  // Co-Treat, whose whole effect is to credit somebody else - so the only
  // publicly visible token in the game is an act of help.

  var TOKENS = {
    adapted: {
      name: 'Adapted Equipment', icon: '♿', cost: 4,
      blurb: 'Serve this question one level down.',
      // The one shipped gap this closes: promotion is automatic at 80%, but
      // servedLevel() only steps a question DOWN when it physically cannot be
      // written in. A student promoted to Recall and drowning had no way back.
      hint: 'Use it when a level is too much today. Nobody is told.'
    },
    chart: {
      name: 'Chart Review', icon: '📋', cost: 3,
      blurb: 'On a write-in, show the first letter and how long the answer is.',
      hint: 'The hint is always free. This is the detail underneath it.'
    },
    consult: {
      name: 'Consult', icon: '💬', cost: 3,
      blurb: 'Drop two wrong options.',
      hint: 'Turns four options into two.'
    },
    doc: {
      name: 'Documentation', icon: '🖊️', cost: 5,
      blurb: 'If you miss this one, it will not drop two boxes.',
      hint: 'Spend it before you answer, on the ones you are unsure of.'
    },
    cotreat: {
      name: 'Co-Treat', icon: '🤝', cost: 4,
      blurb: 'Credit your next live clear to a classmate.',
      hint: 'Live rounds only. The room sees their name, not yours.'
    },
    inservice: {
      name: 'Inservice', icon: '🎓', cost: 8,
      blurb: 'Your next finished session pays one and a half times XP.',
      hint: 'Worth most before a long session at a high level.'
    }
  };

  // XP is the second currency. It buys permanent competence rather than
  // consumables, so a student who has put the hours in keeps the benefit.
  var SKILLS = {
    assess1: { name: 'Chart Access', branch: 'Assessment', xp: 150,
               blurb: 'Chart Review costs 1 less.' },
    assess2: { name: 'Clinical Eye', branch: 'Assessment', xp: 400, needs: 'assess1',
               blurb: 'Consult drops three options instead of two.' },
    imp1:    { name: 'Equipment Room', branch: 'Implementation', xp: 150,
               blurb: 'Adapted Equipment costs 1 less.' },
    imp2:    { name: 'Co-Treatment', branch: 'Implementation', xp: 400, needs: 'imp1',
               blurb: 'Unlocks Co-Treat in live rounds.' },
    eval1:   { name: 'Charting Habit', branch: 'Evaluation', xp: 150,
               blurb: 'Every fifth question attempted pays a second token.' },
    eval2:   { name: 'Supervision', branch: 'Evaluation', xp: 400, needs: 'eval1',
               blurb: 'Documentation also protects your streak.' }
  };

  function hasSkill(id) { return !!(S.stats.skills && S.stats.skills[id]); }

  function tokenCost(id) {
    var c = TOKENS[id].cost;
    if (id === 'chart' && hasSkill('assess1')) c -= 1;
    if (id === 'adapted' && hasSkill('imp1')) c -= 1;
    return Math.max(1, c);
  }

  function tokenLocked(id) {
    return id === 'cotreat' && !hasSkill('imp2');
  }

  function skillAvailable(id) {
    var sk = SKILLS[id];
    if (hasSkill(id)) return false;
    return !sk.needs || hasSkill(sk.needs);
  }

  // Attempting is what pays. Correctness is already paid in XP.
  function earnTokens() {
    S.stats.attempts = (S.stats.attempts || 0) + 1;
    var n = 1;
    if (hasSkill('eval1') && S.stats.attempts % 5 === 0) n = 2;
    S.stats.tokens = (S.stats.tokens || 0) + n;
  }

  // Which tokens apply to the question on screen right now. A token that could
  // do nothing here is not offered, so nobody wastes one finding out.
  function viewLevel(v) {
    return (v && (v._level || (v.q && v.q._level))) || 1;
  }

  function offersFor(v, live) {
    if (!v || v.answered) return [];
    var out = [];
    var isChoice = v.type === 'mc' || v.type === 'scenario' || v.type === 'multi';
    if (isChoice && !v._dropped) out.push('consult');
    if (v.type === 'fill' && !v._chart) out.push('chart');
    if (!live && !v._protected) out.push('doc');
    if (!live && viewLevel(v) > 1 && !v._adapted) out.push('adapted');
    if (live && !tokenLocked('cotreat')) out.push('cotreat');
    return out.filter(function (id) { return !tokenLocked(id); });
  }

  // Drop wrong options. Three with Clinical Eye, two without - never so many
  // that the answer is left alone on screen.
  function applyConsult(v) {
    var want = hasSkill('assess2') ? 3 : 2;
    var wrong = [];
    v.opts.forEach(function (o, pos) {
      var right = v.type === 'multi' ? !!v.answerSet[o.i] : pos === v.answerPos;
      if (!right) wrong.push(pos);
    });
    // Never leave the answer standing alone: at least one wrong option stays,
    // so this narrows the choice without making it for you.
    want = Math.min(want, Math.max(0, wrong.length - 1));
    v._dropped = want > 0 ? shuffle(wrong).slice(0, want) : [];
  }

  function applyChart(v) {
    var best = (v.q.answer || []).slice().sort(function (a, b) { return a.length - b.length; })[0] || '';
    v._chart = best ? { first: best.charAt(0).toUpperCase(), len: best.replace(/s+/g, ' ').length } : null;
  }

  function spend(id) {
    var c = tokenCost(id);
    if (tokenLocked(id) || (S.stats.tokens || 0) < c) return false;
    S.stats.tokens -= c;
    save();
    return true;
  }

  // -------------------------------------------------------- Three Certainties
  //
  // The failure this attacks is the one that made the flashcards useless:
  // recognising an answer feels exactly like knowing it. So this does not ask
  // whether you are right. It asks whether you KNEW you were right, and it
  // charges most for being confidently wrong.
  //
  // The budget is what makes it a decision. Certainty is scarce - three in ten -
  // so spending one is a real claim rather than a mood.

  var CERT_SIZE = 10;
  var CERT_BUDGET = { certain: 3, sure: 4, guess: 3 };

  var CERT = {
    certain: { name: 'Certain', short: 'CERTAIN', win: 50, lose: -80,
               blurb: 'You would bet on this.' },
    sure:    { name: 'Fairly sure', short: 'FAIRLY SURE', win: 20, lose: -25,
               blurb: 'You think so.' },
    guess:   { name: 'Guess', short: 'GUESS', win: 5, lose: -5,
               blurb: 'No idea, picking anyway.' }
  };
  var CERT_ORDER = ['certain', 'sure', 'guess'];

  // Calibration cannot be read from one round. Three Certains can only ever
  // score 0, 33, 67 or 100 per cent, so a verdict from a single session is
  // reporting three coin flips as a measurement. The tally accumulates across
  // every round the student has ever played, and no verdict is offered until
  // there is enough of it to mean something.
  var CERT_MIN_FOR_VERDICT = 9;

  function certTally() {
    S.stats.calib = S.stats.calib || {};
    CERT_ORDER.forEach(function (k) {
      S.stats.calib[k] = S.stats.calib[k] || { n: 0, right: 0 };
    });
    return S.stats.calib;
  }

  function certVerdict() {
    var t = certTally().certain;
    if (t.n < CERT_MIN_FOR_VERDICT) {
      return { enough: false, n: t.n, need: CERT_MIN_FOR_VERDICT - t.n };
    }
    var pct = Math.round(100 * t.right / t.n);
    return {
      enough: true, n: t.n, right: t.right, pct: pct,
      // 'Certain' is a claim about nine times in ten. Anything under that is
      // overconfidence, which is the thing worth naming.
      over: pct < 90,
      line: pct >= 90
        ? 'When you say Certain, you are right ' + pct + '% of the time. That is what Certain should mean.'
        : 'When you say Certain, you are right ' + pct + '% of the time. Certain should mean nine times in ten.'
    };
  }

  var API = '/api';

  // ---------------------------------------------------------------- state

  var S = {
    screen: 'welcome',
    profile: { name: '', classCode: '' },
    progress: {},               // recKey -> { box, seen, right, wrong, last }
    levels: {},                 // chapterId -> current level (1..3)
    stats: { xp: 0, bestStreak: 0, sessions: 0, examRuns: [], tokens: 0, skills: {}, boost: 0, grantClaimed: 0, attempts: 0 },
    theme: 'dark',

    // transient run state
    run: null
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        S.profile = d.profile || S.profile;
        S.progress = d.progress || {};
        S.levels = d.levels || {};
        S.stats = Object.assign({ xp: 0, bestStreak: 0, sessions: 0, examRuns: [], tokens: 0, skills: {}, boost: 0, grantClaimed: 0, attempts: 0 }, d.stats || {});
        S.theme = d.theme || 'dark';
      }
    } catch (e) { /* corrupt or blocked storage — start fresh */ }
    document.documentElement.setAttribute('data-theme', S.theme);
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        profile: S.profile, progress: S.progress, levels: S.levels,
        stats: S.stats, theme: S.theme
      }));
    } catch (e) { /* private mode / blocked — game still works in memory */ }
  }

  // ---------------------------------------------------------------- helpers

  function allQuestions() {
    var out = [];
    CHAPTERS.forEach(function (c) {
      c.questions.forEach(function (q) { out.push(Object.assign({ chapter: c.id }, q)); });
    });
    return out;
  }

  function chapterById(id) {
    for (var i = 0; i < CHAPTERS.length; i++) if (CHAPTERS[i].id === id) return CHAPTERS[i];
    return null;
  }

  // Level 1 keeps the bare question id so progress saved before levels existed
  // still counts. Higher levels get their own record and their own climb.
  function recKey(qid, level) { return level > 1 ? qid + '@' + level : qid; }

  function levelOf(chapterId) {
    var l = S.levels[chapterId] || 1;
    return Math.min(MAX_LEVEL, Math.max(1, l));
  }

  // Write-in needs either an authored key, an invertible match pair, or a
  // question that was already free recall. Everything else falls back to level 2.
  function canWriteIn(q) {
    return !!(q.key && q.key.length) ||
           (q.type === 'match' && q.pairs && q.pairs.length) ||
           q.type === 'fill';
  }

  function servedLevel(q, level) {
    if (level >= 3 && !canWriteIn(q)) return 2;
    return level;
  }

  function rec(qid, level) {
    var k = recKey(qid, level || 1);
    if (!S.progress[k]) S.progress[k] = { box: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    return S.progress[k];
  }

  function isMastered(qid, level) {
    var r = S.progress[recKey(qid, level || 1)];
    return !!r && r.box >= MASTERY_BOX;
  }

  function chapterMastery(ch, level) {
    var lv = level || levelOf(ch.id);
    var total = ch.questions.length, done = 0;
    ch.questions.forEach(function (q) { if (isMastered(q.id, lv)) done++; });
    return { done: done, total: total, pct: total ? done / total : 0, level: lv };
  }

  // Promote a chapter once its current level is mastered. Returns the new level
  // if it moved, otherwise null — the caller decides whether to celebrate.
  function checkPromotion(chapterId) {
    var ch = chapterById(chapterId);
    if (!ch) return null;
    var lv = levelOf(chapterId);
    if (lv >= MAX_LEVEL) return null;
    if (chapterMastery(ch, lv).pct < UNLOCK_AT) return null;
    S.levels[chapterId] = lv + 1;
    save();
    return lv + 1;
  }

  // The boss needs every chapter cleared at whatever level it currently sits on.
  function bossUnlocked() {
    return CHAPTERS.length > 0 && CHAPTERS.every(function (c) {
      return levelOf(c.id) > 1 || chapterMastery(c, 1).pct >= UNLOCK_AT;
    });
  }

  // Overall counts every level a student has cleared, so the bar keeps moving
  // after a chapter promotes instead of snapping back to zero.
  function overall() {
    var total = 0, done = 0;
    CHAPTERS.forEach(function (c) {
      for (var lv = 1; lv <= MAX_LEVEL; lv++) {
        total += c.questions.length;
        c.questions.forEach(function (q) { if (isMastered(q.id, lv)) done++; });
      }
    });
    return { done: done, total: total, pct: total ? done / total : 0 };
  }

  // Chapter plaques read as inscriptions: II, III, IV...
  function roman(n) {
    var map = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    var out = '', v = Number(n) || 0;
    for (var i = 0; i < map.length; i++) while (v >= map[i][0]) { out += map[i][1]; v -= map[i][0]; }
    return out || String(n);
  }

  function shuffle(a) {
    var arr = a.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function norm(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ');
  }

  // True when two strings differ by at most one insert, delete or substitution.
  function editDistance1(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0, j = 0, diffs = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diffs > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else { i++; j++; }
    }
    return diffs + (la - i) + (lb - j) <= 1;
  }

  // ---------------------------------------------------------------- session building

  // Pick questions weighted toward what the student has not locked in yet.
  function buildSession(pool, size, level) {
    var lv = level || 1;
    var byBox = [[], [], [], []];
    pool.forEach(function (q) {
      var r = S.progress[recKey(q.id, lv)];
      var b = Math.min(3, Math.max(0, (r && r.box) || 0));
      byBox[b].push(q);
    });
    var picked = [];
    // box 0 and 1 first (never seen / struggling), then 2, then mastered review.
    // At level 3, put the genuinely write-in-able questions at the front of each
    // box so a Recall round actually feels like recall rather than more options.
    [0, 1, 2, 3].forEach(function (b) {
      if (picked.length >= size) return;
      var bucket = shuffle(byBox[b]);
      if (lv >= 3) {
        bucket = bucket.filter(canWriteIn).concat(bucket.filter(function (q) { return !canWriteIn(q); }));
      }
      picked = picked.concat(bucket.slice(0, size - picked.length));
    });
    return shuffle(picked);
  }

  function gradedPool(chapterIds, topics) {
    var pool = allQuestions().filter(function (q) {
      return chapterIds.indexOf(q.chapter) !== -1;
    });
    if (topics && topics.length) {
      pool = pool.filter(function (q) { return topics.indexOf(q.topic) !== -1; });
    }
    return pool;
  }

  // ---------------------------------------------------------------- grading

  // Serve a question at a difficulty level by rewriting it into a shape the
  // engine already renders and grades. Level 2 is still an `mc`; level 3 is
  // still a `fill`. No new question types, no new grading branches.
  function serve(q, level) {
    var lv = servedLevel(q, level || 1);

    if (lv === 2 && (q.type === 'mc' || q.type === 'scenario') && q.extra && q.extra.length) {
      var choices = q.choices.concat(q.extra);
      return Object.assign({}, q, { choices: choices, answer: q.answer, _level: 2 });
    }

    if (lv === 3 && q.key) {
      var accepted = [q.key].concat(q.accept || []);
      return Object.assign({}, q, {
        type: 'fill',
        answer: accepted,
        hint: q.hint || '',
        _level: 3,
        _origType: q.type
      });
    }

    // A matching question inverts cleanly into free recall: show one definition,
    // ask for the term. A different pair each time it comes round.
    if (lv === 3 && q.type === 'match' && q.pairs && q.pairs.length) {
      var pair = q.pairs[Math.floor(Math.random() * q.pairs.length)];
      return Object.assign({}, q, {
        type: 'fill',
        prompt: 'Which term means this?\n“' + pair[1] + '”',
        answer: [pair[0]].concat(termVariants(pair[0])),
        hint: 'One term from ' + q.topic + '.',
        _level: 3,
        _origType: 'match'
      });
    }

    return Object.assign({}, q, { _level: 1 });
  }

  // Accept the obvious ways a student might type a term they clearly know.
  function termVariants(term) {
    var t = String(term).trim();
    var out = [];
    var noArticle = t.replace(/^(the|a|an)\s+/i, '');
    if (noArticle !== t) out.push(noArticle);
    out.push('the ' + noArticle);
    var stripped = noArticle.replace(/\s+(therapy|model|ego|stage|approach|conditioning)$/i, '');
    if (stripped !== noArticle && stripped.length > 3) out.push(stripped);
    if (/s$/i.test(noArticle)) out.push(noArticle.replace(/s$/i, ''));
    else out.push(noArticle + 's');
    return out;
  }

  // Prepare a question for display: shuffle choices while tracking the answer.
  function prep(q) {
    var v = { q: q, type: q.type, answered: false, correct: null };

    if (q.type === 'mc' || q.type === 'scenario') {
      var opts = q.choices.map(function (t, i) { return { t: t, i: i }; });
      v.opts = shuffle(opts);
      v.answerPos = v.opts.findIndex(function (o) { return o.i === q.answer; });
      v.picked = null;

    } else if (q.type === 'multi') {
      var m = q.choices.map(function (t, i) { return { t: t, i: i }; });
      v.opts = shuffle(m);
      v.answerSet = {};
      q.answer.forEach(function (i) { v.answerSet[i] = true; });
      v.sel = {};

    } else if (q.type === 'match') {
      v.terms = q.pairs.map(function (p, i) { return { term: p[0], def: p[1], i: i }; });
      v.terms = shuffle(v.terms);
      v.defs = shuffle(q.pairs.map(function (p, i) { return { def: p[1], i: i }; }));
      v.sel = {};

    } else if (q.type === 'order') {
      v.correctOrder = q.items.slice();
      var scrambled = shuffle(q.items);
      // guarantee it does not start already solved
      if (scrambled.join('|') === v.correctOrder.join('|') && scrambled.length > 1) {
        var t = scrambled[0]; scrambled[0] = scrambled[1]; scrambled[1] = t;
      }
      v.order = scrambled;

    } else if (q.type === 'fill') {
      v.value = '';
    }
    return v;
  }

  function grade(v) {
    var q = v.q;
    if (q.type === 'mc' || q.type === 'scenario') {
      return v.picked === v.answerPos;
    }
    if (q.type === 'multi') {
      var want = Object.keys(v.answerSet).map(Number).sort().join(',');
      var got = Object.keys(v.sel).filter(function (k) { return v.sel[k]; }).map(Number).sort().join(',');
      return want === got;
    }
    if (q.type === 'match') {
      return v.terms.every(function (t) { return String(v.sel[t.i]) === String(t.i); });
    }
    if (q.type === 'order') {
      return v.order.join('|') === v.correctOrder.join('|');
    }
    if (q.type === 'fill') {
      var got2 = norm(v.value);
      if (!got2) return false;
      return (q.answer || []).some(function (a) {
        var want = norm(a);
        if (want === got2) return true;
        // Forgive a single typo, but only on words long enough that a near-miss
        // cannot be a different term. "id" and "ego" must stay exact.
        if (want.length >= 6 && Math.abs(want.length - got2.length) <= 1) {
          return editDistance1(want, got2);
        }
        return false;
      });
    }
    return false;
  }

  function applyResult(qid, ok, practice, level, protectedBox) {
    var lv = level || 1;
    var r = rec(qid, lv);
    r.seen++; r.last = Date.now();
    earnTokens();
    if (ok) {
      r.right++;
      if (practice) r.box = Math.min(MASTERY_BOX, r.box + 1);
      S.stats.xp += (LEVELS[lv] || LEVELS[1]).xp;   // harder levels pay more
    } else {
      r.wrong++;
      // Documentation softens the fall: the question still comes back, it just
      // does not fall all the way to the bottom of the pile.
      if (practice) r.box = Math.max(0, r.box - (protectedBox ? 1 : 2));
    }
  }

  // ---------------------------------------------------------------- backend sync

  function syncEnabled() { return !!(S.profile.name && S.profile.classCode); }

  // One batched write per finished round keeps us inside Firebase's free tier.
  // Every field here has a reader on the dashboard; anything write-only was a
  // document write that bought nothing. Nor is an identical body ever sent
  // twice - backing out of the live screen without playing used to cost a write.
  var lastSync = '';
  function syncProgress(extra, force) {
    if (!syncEnabled()) return Promise.resolve({ skipped: true });
    var o = overall();
    var levelSum = CHAPTERS.reduce(function (n, c) { return n + levelOf(c.id); }, 0);
    var weak = weakestTopics(6).map(function (w) { return w.topic + ' (' + w.pct + '%)'; });
    var runs = S.stats.examRuns || [];

    var body = {
      name: S.profile.name,
      classCode: S.profile.classCode,
      xp: S.stats.xp,
      sessions: S.stats.sessions,
      mastered: o.done,
      totalQuestions: o.total,
      avgLevel: CHAPTERS.length ? Math.round((levelSum / CHAPTERS.length) * 10) / 10 : 1,
      weakTopics: weak,
      tokens: S.stats.tokens || 0,
      bestExam: runs.reduce(function (m, r) { return Math.max(m, r.pct || 0); }, 0),
      examRuns: runs.slice(-3)
    };

    // The event kind is not sent - nothing reads it - but it does distinguish
    // two otherwise identical bodies, so it belongs in the signature.
    var json = JSON.stringify(body);
    var sig = json + '|' + ((extra && extra.type) || '');
    // A forced sync is the only way a student learns about tokens the
    // instructor granted: the reply carries the running total, and without a
    // request there is no reply. Opening the closet is deliberate and rare, so
    // it is worth one write; everything else still dedupes.
    if (!force && sig === lastSync) return Promise.resolve({ skipped: true });

    return fetch(API + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json
    }).then(function (r) {
      if (!r.ok) return { error: r.status };
      lastSync = sig;          // only a write that landed may suppress the next one
      return r.json();
    }).then(function (j) {
      if (j && j.ok) claimGrants(j.grantTotal);
      return j;
    }).catch(function () { return { error: 'offline' }; });
  }

  // Tokens the instructor has handed out. The server keeps a running total and
  // this takes the difference, so a grant is never applied twice and never lost
  // because a phone happened to be offline when she issued it.
  function claimGrants(total) {
    var got = Number(total) || 0;
    var claimed = S.stats.grantClaimed || 0;
    if (got <= claimed) return 0;
    var gained = got - claimed;
    S.stats.tokens = (S.stats.tokens || 0) + gained;
    S.stats.grantClaimed = got;
    S.stats.grantJustGot = gained;
    save();
    return gained;
  }

  function weakestTopics(n) {
    var map = {};
    allQuestions().forEach(function (q) {
      // Every question keeps a SEPARATE record per level, because recKey
      // namespaces anything above level 1. Reading the bare id therefore saw
      // level 1 only - so the better a student got, the less of their
      // struggling reached the instructor, which is backwards. Sum all three.
      for (var lv = 1; lv <= MAX_LEVEL; lv++) {
        var r = S.progress[recKey(q.id, lv)];
        if (!r || !r.seen) continue;
        if (!map[q.topic]) map[q.topic] = { right: 0, seen: 0 };
        map[q.topic].right += r.right;
        map[q.topic].seen += r.seen;
      }
    });
    return Object.keys(map).map(function (t) {
      return { topic: t, pct: Math.round(100 * map[t].right / map[t].seen), seen: map[t].seen };
    }).filter(function (x) { return x.seen >= 2; })
      .sort(function (a, b) { return a.pct - b.pct; })
      .slice(0, n || 5);
  }

  // ---------------------------------------------------------------- render

  var app = document.getElementById('app');

  function render() {
    var html = '';
    switch (S.screen) {
      case 'welcome': html = viewWelcome(); break;
      case 'map':
        // One cached read, once per session, for a number the map shows.
        if (!SO.loaded) { SO.loaded = true; loadStanding().then(function () { if (S.screen === 'map') render(); }); }
        html = viewMap();
        break;
      case 'play': html = viewPlay(); break;
      case 'results': html = viewResults(); break;
      case 'exams': html = viewExams(); break;
      case 'stats': html = viewStats(); break;
      case 'closet': html = viewCloset(); break;
      case 'live': html = viewLive(); break;
      default: html = viewMap();
    }
    app.innerHTML = html;
    bind();
    window.scrollTo(0, 0);
  }

  function topbar(title, backTo) {
    return '<div class="topbar">' +
      (backTo ? '<button class="iconbtn" data-go="' + backTo + '">&larr;</button>' : '') +
      '<strong style="font-size:1rem">' + esc(title) + '</strong>' +
      '<div class="spacer"></div>' +
      '<span class="pill">&#9889; <b>' + S.stats.xp + '</b></span>' +
      '<span class="pill">&#129689; <b>' + (S.stats.tokens || 0) + '</b></span>' +
      '<button class="iconbtn" data-theme-toggle>' + (S.theme === 'dark' ? '&#9788;' : '&#9789;') + '</button>' +
      '</div>';
  }

  // ---- welcome

  function viewWelcome() {
    return '<div style="height:36px"></div>' +
      '<div class="center">' +
      '<div style="font-size:3rem;line-height:1">&#129504;</div>' +
      '<h1>RT Mastery</h1>' +
      '<p class="dim">Therapeutic Recreation &mdash; Lindenwood University</p>' +
      '</div>' +
      '<div class="spacer-md"></div>' +
      '<div class="card pad-lg">' +
      '<p class="dim" style="font-size:0.92rem">Flashcards let you recognise an answer without knowing it. This does not. ' +
      'Every question has to be answered correctly <b>three separate times</b> before it locks in &mdash; and miss it once, it comes straight back.</p>' +
      '<div class="hr"></div>' +
      '<div class="field"><label for="nm">Your name</label>' +
      '<input id="nm" type="text" autocomplete="name" placeholder="First and last name" value="' + esc(S.profile.name) + '"></div>' +
      '<div class="field"><label for="cc">Class code <span class="faint">(from your instructor)</span></label>' +
      '<input id="cc" type="text" autocomplete="off" autocapitalize="characters" placeholder="e.g. RT101" value="' + esc(S.profile.classCode) + '"></div>' +
      '<button class="btn" data-start>Start studying</button>' +
      '<div class="spacer-sm"></div>' +
      '<button class="btn ghost sm" data-skip>Skip &mdash; just let me practise</button>' +
      '<p class="faint center" style="margin:12px 0 0">With a name and class code your progress saves so your instructor can see where the class is struggling. Without one, progress stays on this device only.</p>' +
      '</div>';
  }

  // ---- map

  function viewMap() {
    var granted = S.stats.grantJustGot;
    if (granted) S.stats.grantJustGot = 0;
    var o = overall();
    var h = topbar('Your map', null);

    if (granted) {
      h += '<div class="banner">🪙 Your instructor gave you <b>' + granted +
        '</b> token' + (granted === 1 ? '' : 's') + '. They are in the supply closet.</div>';
    }

    h += '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">' +
      '<strong>Overall mastery</strong>' +
      '<span class="dim">' + o.done + ' / ' + o.total + '</span></div>' +
      '<div class="bar"><i style="width:' + (o.pct * 100).toFixed(1) + '%"></i></div>' +
      (S.profile.name
        ? '<p class="faint" style="margin:10px 0 0">' + esc(S.profile.name) +
          (S.profile.classCode ? ' &middot; ' + esc(S.profile.classCode) : '') + '</p>'
        : '<p class="faint" style="margin:10px 0 0">Practising without a class code &mdash; progress saves on this device only.</p>') +
      '</div>';

    var weak = weakestTopics(4);
    if (weak.length && weak[0].pct < 80) {
      h += '<div class="banner warn"><b>Your weakest areas right now</b><div class="chiprow" style="margin:8px 0 0">' +
        weak.map(function (w) {
          return '<span class="chip ' + (w.pct < 60 ? 'bad' : '') + '">' + esc(w.topic) + ' &middot; ' + w.pct + '%</span>';
        }).join('') + '</div></div>';
    }

    CHAPTERS.forEach(function (c) {
      var lv = levelOf(c.id);
      var m = chapterMastery(c, lv);
      var maxed = lv >= MAX_LEVEL && m.pct >= UNLOCK_AT;
      var info = LEVELS[lv];
      h += '<button class="zone ' + (maxed ? 'done' : '') + '" data-chapter="' + c.id + '">' +
        '<span class="orb">' +
        roman(c.number) + '</span>' +
        '<span class="grow">' +
        '<div class="ztitle">' + esc(c.title) + (maxed ? ' &#10003;' : '') + '</div>' +
        '<div class="zmeta">' +
        '<span class="lvchip lv' + lv + '">Lv ' + lv + ' &middot; ' + info.name + '</span> ' +
        m.done + '/' + m.total + ' at this level' +
        '</div>' +
        '<span class="bar thin"><i style="width:' + (m.pct * 100).toFixed(1) + '%;background:var(--' + c.color + ')"></i></span>' +
        '</span>' +
        '<span class="chev">&rsaquo;</span>' +
        '</button>';
    });

    var bu = bossUnlocked();
    h += '<div class="card boss" style="margin-top:14px">' +
      '<h3 style="margin-bottom:4px">&#128081; Final Boss &mdash; Comprehensive Run</h3>' +
      '<p class="dim" style="font-size:0.88rem;margin-bottom:12px">' +
      (bu ? '25 questions, every chapter, 15 minutes, no second chances. Beat 80% to clear it.'
          : 'Locked. Reach ' + Math.round(UNLOCK_AT * 100) + '% mastery in every chapter to challenge it.') + '</p>' +
      '<button class="btn sm" data-boss ' + (bu ? '' : 'disabled') + '>' + (bu ? 'Enter the boss fight' : 'Locked') + '</button>' +
      '</div>';

    var gc = ghostCount();
    h += '<div class="card" style="margin-top:14px">' +
      '<h3 style="margin-bottom:4px">\uD83D\uDC7B Ghost Duel</h3>' +
      '<p class="faint" style="margin:0 0 10px">Seven questions against your own last attempt. ' +
      'Lock your answer, then see what you did last time and how long it took. ' +
      'Nobody else is involved.</p>' +
      (gc
        ? '<p class="faint" style="margin:0 0 10px">You have <b>' + gc + '</b> ghost' +
          (gc === 1 ? '' : 's') + ' on record.</p>'
        : '<p class="faint" style="margin:0 0 10px">No ghosts yet \u2014 your first run records them.</p>') +
      '<button class="btn ghost" data-ghost>Face yourself</button>' +
      '</div>';

    // The Standing Order. The holder is the ONLY name this card ever shows -
    // there is no second place because there is no list.
    var mk = SO.mark;
    h += '<div class="card" style="margin-top:14px">' +
      '<h3 style="margin-bottom:4px">\uD83C\uDFF4 The Standing Order</h3>' +
      (mk && mk.holder
        ? '<p class="faint" style="margin:0 0 6px">Held by <b>' + esc(mk.holder) + '</b> at <b>' +
          mk.rate + '</b> correct an hour.</p>' +
          (mk.easing
            ? '<p class="faint" style="margin:0 0 10px">It has been standing a while, so it is ' +
              'easing: <b>' + mk.bar + '</b> an hour takes it today.</p>'
            : '<p class="faint" style="margin:0 0 10px">Beat <b>' + mk.bar + '</b> an hour to take it.</p>')
        : '<p class="faint" style="margin:0 0 10px">Nobody holds it yet. Fifteen questions, ' +
          'as fast as you can get them right.</p>') +
      '<p class="faint" style="margin:0 0 10px">Fall short and nothing is written down and ' +
      'nobody is told. Chase it as often as you like.</p>' +
      '<button class="btn ghost" data-standing>Chase it</button>' +
      '</div>';

    var verdict = certVerdict();
    h += '<div class="card" style="margin-top:14px">' +
      '<h3 style="margin-bottom:4px">&#127919; Three Certainties</h3>' +
      '<p class="faint" style="margin:0 0 10px">Ten questions. Three Certains, four Fairly Sures, ' +
      'three Guesses. Being sure and wrong costs more than anything else &mdash; ' +
      'which is the point, because feeling sure is exactly what flashcards teach.</p>' +
      (verdict.enough
        ? '<p class="' + (verdict.over ? 'warnline' : 'goodline') + '" style="margin:0 0 10px">' +
          esc(verdict.line) + '</p>'
        : '') +
      '<button class="btn ghost" data-certainties>Place ten bets</button>' +
      '</div>';

    if (S.profile.classCode) {
      h += '<button class="btn" data-go="live" style="margin-top:14px">&#9201;&#65039; Join live round</button>';
    }

    h += '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn ghost sm" data-go="closet">&#129689; Supply closet</button>' +
      '<button class="btn ghost sm" data-go="exams">&#128220; Exam prep</button>' +
      '<button class="btn ghost sm" data-go="stats">&#128202; My stats</button>' +
      '</div>';

    return h;
  }

  // ---- exams

  function viewExams() {
    var h = topbar('Exam prep', 'map');

    // an exam whose chapters aren't loaded has nothing to ask — don't show it
    var live = EXAMS.filter(function (ex) {
      return gradedPool(ex.chapters || [], ex.topics || []).length > 0;
    });

    if (!live.length) {
      h += '<div class="card"><p class="dim">No exams have been set up yet. Your instructor adds them in <code>content/exams.json</code>.</p></div>';
      return h;
    }
    h += '<p class="dim" style="font-size:0.9rem">Timed runs built from the chapters your exam covers. These do <b>not</b> change your mastery map &mdash; they tell you where you stand.</p>';

    live.forEach(function (ex) {
      var pool = gradedPool(ex.chapters || [], ex.topics || []);
      var last = (S.stats.examRuns || []).filter(function (r) { return r.id === ex.id; }).slice(-1)[0];
      var days = '';
      if (ex.date) {
        var d = Math.ceil((new Date(ex.date + 'T23:59:59') - Date.now()) / 86400000);
        if (d >= 0) days = '<span class="chip ' + (d <= 3 ? 'bad' : '') + '">' + (d === 0 ? 'Today' : d + ' day' + (d === 1 ? '' : 's') + ' away') + '</span>';
      }
      h += '<div class="card">' +
        '<h3>' + esc(ex.name) + '</h3>' +
        '<div class="chiprow">' + days +
        '<span class="chip">' + Math.min(ex.questionCount || 30, pool.length) + ' questions</span>' +
        '<span class="chip">' + (ex.minutes ? ex.minutes + ' min' : 'Untimed') + '</span>' +
        '<span class="chip">Pass ' + (ex.passMark || 80) + '%</span>' +
        (last ? '<span class="chip ' + (last.pct >= (ex.passMark || 80) ? 'good' : 'bad') + '">Last: ' + last.pct + '%</span>' : '') +
        '</div>' +
        (ex.note ? '<p class="faint">' + esc(ex.note) + '</p>' : '') +
        '<button class="btn sm" data-exam="' + esc(ex.id) + '"' + (pool.length ? '' : ' disabled') + '>Start timed run</button>' +
        '</div>';
    });
    return h;
  }

  // ---- stats

  function viewStats() {
    var h = topbar('My stats', 'map');
    var o = overall();
    var seen = 0, right = 0;
    Object.keys(S.progress).forEach(function (k) { seen += S.progress[k].seen; right += S.progress[k].right; });

    h += '<div class="statgrid">' +
      '<div class="stat"><div class="n">' + Math.round(o.pct * 100) + '%</div><div class="l">Mastered</div></div>' +
      '<div class="stat"><div class="n">' + S.stats.sessions + '</div><div class="l">Rounds</div></div>' +
      '<div class="stat"><div class="n">' + S.stats.bestStreak + '</div><div class="l">Best streak</div></div>' +
      (typeof S.stats.bestCert === 'number'
        ? '<div class="stat"><div class="n">' + (S.stats.bestCert > 0 ? '+' : '') + S.stats.bestCert +
          '</div><div class="l">Best bet round</div></div>'
        : '') +
      '</div>' +
      '<div class="statgrid">' +
      '<div class="stat"><div class="n">' + S.stats.xp + '</div><div class="l">XP</div></div>' +
      '<div class="stat"><div class="n">' + seen + '</div><div class="l">Answered</div></div>' +
      '<div class="stat"><div class="n">' + (seen ? Math.round(100 * right / seen) : 0) + '%</div><div class="l">Accuracy</div></div>' +
      '</div>';

    h += '<div class="card"><h3>Chapter breakdown</h3><div class="tablewrap"><table>' +
      '<tr><th>Chapter</th><th class="num">Locked in</th><th class="num">%</th></tr>' +
      CHAPTERS.map(function (c) {
        var m = chapterMastery(c);
        return '<tr><td>Ch ' + c.number + ' &middot; ' + esc(c.title) + '</td>' +
          '<td class="num">' + m.done + '/' + m.total + '</td>' +
          '<td class="num">' + Math.round(m.pct * 100) + '%</td></tr>';
      }).join('') + '</table></div></div>';

    var weak = weakestTopics(10);
    if (weak.length) {
      h += '<div class="card"><h3>Topics to hit next</h3><div class="tablewrap"><table>' +
        '<tr><th>Topic</th><th class="num">Accuracy</th><th class="num">Tries</th></tr>' +
        weak.map(function (w) {
          return '<tr><td>' + esc(w.topic) + '</td><td class="num">' + w.pct + '%</td><td class="num">' + w.seen + '</td></tr>';
        }).join('') + '</table></div></div>';
    }

    h += '<button class="btn ghost sm" data-reset>Reset all my progress</button>';
    return h;
  }

  // ---- play

  // The shelf: what this student could spend right now, on this question, and
  // nothing else. Rendered on the question screen so the decision is made in
  // the moment of difficulty rather than in a menu beforehand.
  function viewCloset() {
    var bal = S.stats.tokens || 0;
    var h = topbar('Supply closet', 'map');

    h += '<div class="statgrid">' +
      '<div class="stat"><div class="n">' + bal + '</div><div class="l">Tokens</div></div>' +
      '<div class="stat"><div class="n">' + (S.stats.xp || 0) + '</div><div class="l">XP</div></div>' +
      '<div class="stat"><div class="n">' + (S.stats.attempts || 0) + '</div><div class="l">Attempted</div></div>' +
      '</div>';

    h += '<div class="card"><h3 style="margin-bottom:4px">How you earn</h3>' +
      '<p class="faint" style="margin:0">One token every time you <b>attempt</b> a question &mdash; ' +
      'right or wrong. Getting it wrong pays the same as getting it right, so the ' +
      'harder you are working, the more help you can afford.</p></div>';

    if (S.stats.grantJustGot) {
      h += '<div class="banner">🪙 Your instructor gave you <b>' + S.stats.grantJustGot +
        '</b> token' + (S.stats.grantJustGot === 1 ? '' : 's') + '.</div>';
      S.stats.grantJustGot = 0;
      save();
    }

    if (S.stats.boost) {
      h += '<div class="banner"><b>Inservice is active.</b> Your next finished session pays one and a half times XP.</div>';
    }

    h += '<div class="card"><h3>On the shelf</h3>' +
      '<p class="faint" style="margin:-4px 0 10px">Most of these are spent on a question while you are looking at it. ' +
      'Nothing you spend is ever shown to the class.</p>';
    Object.keys(TOKENS).forEach(function (id) {
      var t = TOKENS[id], c = tokenCost(id), locked = tokenLocked(id);
      var buyable = id === 'inservice' && !locked && bal >= c && !S.stats.boost;
      h += '<div class="shopitem' + (locked ? ' off' : '') + '">' +
        '<div class="shopicon">' + t.icon + '</div>' +
        '<div style="flex:1"><b>' + esc(t.name) + '</b> <span class="pill sm">' + c + '</span>' +
        '<div class="faint">' + esc(t.blurb) + '</div>' +
        '<div class="faint">' + (locked ? 'Locked — unlock it in the skill tree below.' : esc(t.hint)) + '</div></div>' +
        (buyable ? '<button class="btn ghost sm" data-buy="' + id + '">Use</button>' : '') +
        '</div>';
    });
    h += '</div>';

    // the skill tree: XP buys permanent competence rather than consumables
    var branches = {};
    Object.keys(SKILLS).forEach(function (id) {
      (branches[SKILLS[id].branch] = branches[SKILLS[id].branch] || []).push(id);
    });
    h += '<div class="card"><h3 style="margin-bottom:4px">Skill tree</h3>' +
      '<p class="faint" style="margin:0 0 10px">XP buys these once and you keep them. ' +
      'You earn XP for correct answers, and harder levels pay more.</p>';
    Object.keys(branches).forEach(function (br) {
      h += '<p class="faint" style="margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.08em">' + esc(br) + '</p>';
      branches[br].forEach(function (id) {
        var sk = SKILLS[id], owned = hasSkill(id), open = skillAvailable(id);
        var afford = (S.stats.xp || 0) >= sk.xp;
        h += '<div class="shopitem' + (owned ? ' owned' : open ? '' : ' off') + '">' +
          '<div class="shopicon">' + (owned ? '&#10003;' : open ? '&#9675;' : '&#128274;') + '</div>' +
          '<div style="flex:1"><b>' + esc(sk.name) + '</b> <span class="pill sm">' + sk.xp + ' XP</span>' +
          '<div class="faint">' + esc(sk.blurb) + '</div>' +
          (!owned && !open ? '<div class="faint">Needs ' + esc(SKILLS[sk.needs].name) + ' first.</div>' : '') +
          '</div>' +
          (!owned && open
            ? '<button class="btn ghost sm"' + (afford ? '' : ' disabled') + ' data-buyskill="' + id + '">' +
              (afford ? 'Learn' : 'Locked') + '</button>'
            : '') +
          '</div>';
      });
    });
    h += '</div>';

    return h;
  }

  // Adapted Equipment. The question is re-served a level easier, in place, and
  // nobody is told - the point is a private way down for a student who was
  // promoted automatically and is now drowning.
  function adaptDown(v) {
    var orig = allQuestions().filter(function (x) { return x.id === v.q.id; })[0] || v.q;
    var lv = Math.max(1, viewLevel(v) - 1);
    var nv = prep(serve(orig, lv));
    nv._level = servedLevel(orig, lv);
    nv._adapted = true;
    nv._protected = v._protected;
    if (S.screen === 'live') {
      nv._fromPool = v._fromPool;
      nv._askedAt = v._askedAt;
      LIVE.view = nv;
    } else if (S.run) {
      S.run.views[S.run.idx] = nv;
    }
  }

  // The bet. Shown only once an answer is selected, because betting before
  // choosing would measure bravado rather than knowledge.
  // The reveal. Nothing about past-you is on screen until the answer is
  // locked, because knowing what you picked last time would just be a hint.
  function ghostStrip(v) {
    if (!v.answered) {
      return ghosts()[v.q.id]
        ? '<p class="faint center" style="margin:8px 0 0">\uD83D\uDC7B You have met this one before. ' +
          'Answer, then see what you did last time.</p>'
        : '<p class="faint center" style="margin:8px 0 0">\uD83D\uDC7B New to you. This run records ' +
          'the ghost for next time.</p>';
    }
    var line = ghostLine(v);
    var secs = Math.max(1, Math.round((v._ms || 0) / 1000));
    if (!line) {
      return '<div class="ghostline">\uD83D\uDC7B Recorded \u2014 ' + secs + 's. ' +
        'Next time you meet this, you are racing that.</div>';
    }
    var cls = v._blind ? 'blind' : v._beatGhost ? 'beat' : 'lost';
    var verdict = v._blind
      ? 'You both missed it. That is a blind spot, not bad luck \u2014 back to the bottom of the pile.'
      : v._beatGhost ? 'You beat it. ' + secs + 's this time.'
      : 'The ghost holds. ' + secs + 's this time.';
    return '<div class="ghostline ' + cls + '">\uD83D\uDC7B ' + esc(line) +
      '<div style="margin-top:4px;font-weight:700">' + esc(verdict) + '</div></div>';
  }

  function certStrip(v) {
    var r = S.run;
    if (v.answered) {
      if (!v.conf) return '';
      var band = CERT[v.conf];
      var good = v.points > 0;
      return '<div class="betline ' + (good ? 'good' : 'bad') + '">' +
        '<b>' + band.short + '</b> &middot; ' +
        (v.points > 0 ? '+' : '') + v.points +
        (!v.correct && v.conf === 'certain'
          ? ' &mdash; back to the bottom of the pile, tagged <i>you were sure about this</i>'
          : '') +
        '</div>';
    }

    var chosen = v.picked !== null && v.picked !== undefined;
    if (v.type === 'multi') chosen = Object.keys(v.sel || {}).some(function (k) { return v.sel[k]; });

    if (!chosen) {
      return '<p class="faint center" style="margin:8px 0 0">Choose an answer, then say how sure you are.</p>';
    }

    return '<div class="betbar">' +
      CERT_ORDER.map(function (k) {
        var left = r.budget[k], band = CERT[k];
        return '<button class="bet bet-' + k + (left ? '' : ' off') + '" data-conf="' + k + '"' +
          (left ? '' : ' disabled') + '>' +
          '<span class="bet-name">' + band.short + '</span>' +
          '<span class="bet-odds">+' + band.win + ' / ' + band.lose + '</span>' +
          '<span class="bet-left">' + left + ' left</span>' +
          '</button>';
      }).join('') +
      '</div>';
  }

  function closetShelf(v, live) {
    var ids = offersFor(v, live);
    if (!ids.length) return '';
    var bal = S.stats.tokens || 0;
    var used = [];
    if (v._dropped) used.push('Consult');
    if (v._chart) used.push('Chart Review');
    if (v._protected) used.push('Documentation');
    if (v._adapted) used.push('Adapted Equipment');

    return '<div class="shelf">' +
      '<div class="shelf-head"><span class="faint">Supply closet</span>' +
      '<span class="pill sm">🪙 <b>' + bal + '</b></span></div>' +
      '<div class="shelf-row">' +
      ids.map(function (id) {
        var t = TOKENS[id], c = tokenCost(id), can = bal >= c;
        return '<button class="chip-btn' + (can ? '' : ' off') + '" data-spend="' + id + '"' +
          (can ? '' : ' disabled') + ' title="' + esc(t.blurb) + '">' +
          t.icon + ' ' + esc(t.name) + ' <b>' + c + '</b></button>';
      }).join('') +
      '</div>' +
      (used.length ? '<p class="faint" style="margin:6px 0 0">In use: ' + esc(used.join(', ')) + '</p>' : '') +
      '</div>';
  }

  function viewPlay() {
    var r = S.run;
    var v = r.views[r.idx];
    var q = v.q;
    var ch = chapterById(q.chapter);
    var isTimed = !!r.deadline;

    var h = '<div class="topbar">' +
      '<button class="iconbtn" data-quit>&larr;</button>' +
      '<strong style="font-size:0.95rem">' + esc(r.title) + '</strong>' +
      '<div class="spacer"></div>' +
      (isTimed
        ? '<span class="pill timer" id="tmr">--:--</span>'
        : '<span class="pill">&#128293; <b>' + r.streak + '</b></span>') +
      '</div>';

    h += '<div class="qhead">' +
      '<span class="faint">' + (r.idx + 1) + '/' + r.views.length + '</span>' +
      '<span class="bar"><i style="width:' + ((r.idx) / r.views.length * 100).toFixed(1) + '%"></i></span>' +
      (r.mode === 'certainty'
        ? '<span class="faint">' + (r.score > 0 ? '+' : '') + r.score + '</span>'
        : '') +
      '</div>';

    // The ghost races a clock, so the clock starts when the question appears.
    if (r.mode === 'ghost' && !v.answered && !v._askedAt) v._askedAt = Date.now();

    h += '<div class="card pad-lg">';
    h += '<span class="tag">' + (ch ? 'Ch ' + ch.number + ' &middot; ' : '') + esc(q.topic) + '</span>';
    h += '<div class="qprompt">' + esc(q.prompt) + '</div>';

    h += renderBody(v);
    h += '</div>';

    if (r.mode === 'ghost') h += ghostStrip(v);
    if (r.mode === 'certainty') h += certStrip(v);

    h += closetShelf(v, false);

    // feedback + advance
    if (v.answered && !r.hideFeedback) {
      h += '<div class="feedback ' + (v.correct ? 'good' : 'bad') + '">' +
        '<div class="fhead">' + (v.correct ? '&#10003; Correct' : '&#10007; Not quite') + '</div>' +
        esc(q.explain) + '</div>';
    }

    h += '<div class="sticky-actions">';
    if (!v.answered) {
      if (needsSubmit(v)) h += '<button class="btn" data-submit>Check answer</button>';
    } else {
      h += '<button class="btn" data-next>' + (r.idx + 1 >= r.views.length ? 'See results' : 'Next question') + '</button>';
    }
    h += '</div>';

    return h;
  }

  function needsSubmit(v) {
    return v.type === 'multi' || v.type === 'match' || v.type === 'order' || v.type === 'fill';
  }

  function renderBody(v) {
    var q = v.q, h = '';

    var dropped = v._dropped || [];

    if (q.type === 'mc' || q.type === 'scenario') {
      v.opts.forEach(function (o, pos) {
        if (dropped.indexOf(pos) > -1 && !v.answered) return;
        var cls = '';
        if (v.answered) {
          if (pos === v.answerPos) cls = 'correct';
          else if (pos === v.picked) cls = 'wrong';
        } else if (v.picked === pos) cls = 'picked';
        h += '<button class="choice ' + cls + '" data-pick="' + pos + '"' + (v.answered ? ' disabled' : '') + '>' +
          '<span class="key">' + String.fromCharCode(65 + pos) + '</span>' +
          '<span>' + esc(o.t) + '</span></button>';
      });

    } else if (q.type === 'multi') {
      h += '<p class="faint" style="margin:-6px 0 10px">Select every correct answer, then check.</p>';
      v.opts.forEach(function (o, pos) {
        if (dropped.indexOf(pos) > -1 && !v.answered) return;
        var on = !!v.sel[o.i];
        var cls = on ? 'picked' : '';
        if (v.answered) {
          if (v.answerSet[o.i]) cls = 'correct';
          else if (on) cls = 'wrong';
          else cls = '';
        }
        h += '<button class="choice ' + cls + '" data-toggle="' + o.i + '"' + (v.answered ? ' disabled' : '') + '>' +
          '<span class="key">' + (on ? '&#10003;' : '') + '</span>' +
          '<span>' + esc(o.t) + '</span></button>';
      });

    } else if (q.type === 'match') {
      h += '<p class="faint" style="margin:-6px 0 10px">Pick the matching description for each term.</p>';
      v.terms.forEach(function (t) {
        var cls = '';
        if (v.answered) cls = (String(v.sel[t.i]) === String(t.i)) ? 'correct' : 'wrong';
        h += '<div class="matchrow ' + cls + '">' +
          '<div class="term">' + esc(t.term) + '</div>' +
          '<select data-match="' + t.i + '"' + (v.answered ? ' disabled' : '') + '>' +
          '<option value="">Choose…</option>' +
          v.defs.map(function (d) {
            return '<option value="' + d.i + '"' + (String(v.sel[t.i]) === String(d.i) ? ' selected' : '') + '>' + esc(d.def) + '</option>';
          }).join('') +
          '</select></div>';
        if (v.answered && String(v.sel[t.i]) !== String(t.i)) {
          h += '<p class="faint" style="margin:-4px 0 10px 4px">Correct: ' + esc(t.def) + '</p>';
        }
      });

    } else if (q.type === 'order') {
      h += '<p class="faint" style="margin:-6px 0 10px">Put these in the correct order.</p>';
      v.order.forEach(function (item, i) {
        var cls = '';
        if (v.answered) cls = (item === v.correctOrder[i]) ? 'correct' : 'wrong';
        h += '<div class="orderitem ' + cls + '">' +
          '<span class="num">' + (i + 1) + '</span>' +
          '<span class="grow">' + esc(item) + '</span>' +
          (v.answered ? '' :
            '<span class="arrows">' +
            '<button data-up="' + i + '"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
            '<button data-down="' + i + '"' + (i === v.order.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
            '</span>') +
          '</div>';
      });
      if (v.answered && !v.correct) {
        h += '<p class="faint">Correct order: ' + v.correctOrder.map(esc).join(' &rarr; ') + '</p>';
      }

    } else if (q.type === 'fill') {
      h += '<div class="field"><input id="fillin" type="text" autocomplete="off" autocapitalize="off" ' +
        'placeholder="Type your answer" value="' + esc(v.value) + '"' + (v.answered ? ' disabled' : '') + '></div>';
      if (!v.answered && v._chart) {
        h += '<p class="faint" style="margin:-6px 0 4px">&#128203; Starts with <b>' +
          esc(v._chart.first) + '</b> &middot; ' + v._chart.len + ' characters</p>';
      }
      if (!v.answered && q.hint) {
        h += '<p class="faint" style="margin:-6px 0 4px">&#128161; ' + esc(q.hint) + '</p>';
      }
      if (v.answered && !v.correct) {
        h += '<p class="faint">Answer: <b>' + esc((q.answer || [])[0]) + '</b></p>';
      }
    }
    return h;
  }

  // ---- results

  // The point of the round is not the score, it is the sentence about Certain.
  // So that leads, and the percentage is demoted to the ordinary card below.
  // Two outcomes and only one of them is an event. Falling short is stated
  // plainly, once, with the fact that nothing was recorded - because that is
  // the reassurance that makes it safe to try again.
  function standingResults(r, right) {
    var rate = r.rate || 0;
    var res = SO.result;
    var h = '<div class="card pad-lg center">' +
      '<p class="dim" style="margin:0">Your rate</p>' +
      '<div style="font-size:2.6rem;font-weight:800;line-height:1.15">' + rate + '</div>' +
      '<p class="dim">correct an hour &middot; ' + right + ' of ' + r.views.length +
      ' in ' + clockText(r.seconds || 0) + '</p></div>';

    if (!syncEnabled()) {
      h += '<div class="card"><p class="faint" style="margin:0">Your best on this device is <b>' +
        (S.stats.bestRate || 0) + '</b>. Add a class code on the welcome screen to chase ' +
        'the class mark.</p></div>';
      return h;
    }

    if (!res) {
      h += '<div class="card"><p class="faint" style="margin:0">Checking the mark\u2026</p></div>';
      return h;
    }

    if (res.took) {
      h += '<div class="card levelup center">' +
        '<div style="font-size:2.2rem;line-height:1">\uD83C\uDFF4</div>' +
        '<h3 style="margin:6px 0 4px">You hold the Standing Order</h3>' +
        '<p class="dim" style="margin:0">The mark is yours at <b>' + res.rate +
        '</b> an hour until somebody clears it.</p></div>';
    } else {
      h += '<div class="card center">' +
        '<h3 style="margin:0 0 4px">Not this time</h3>' +
        '<p class="dim" style="margin:0">The mark stands at <b>' + res.bar + '</b> an hour.</p>' +
        '<p class="faint" style="margin:8px 0 0">Nothing was written down and nobody was told. ' +
        'Go again whenever you like.</p></div>';
    }
    return h;
  }

  function ghostResults(r, right) {
    var h = '<div class="card pad-lg center">' +
      '<div style="font-size:2.4rem;line-height:1">\uD83D\uDC7B</div>' +
      (r.raced
        ? '<div style="font-size:2.2rem;font-weight:800;line-height:1.2">' + r.beat + ' of ' + r.raced + '</div>' +
          '<p class="dim">times you beat your past self</p>'
        : '<p class="dim" style="margin:0">All new ground. Every one of these is now recorded, ' +
          'and next time you will be racing tonight\u2019s you.</p>') +
      '</div>';

    if (r.blind && r.blind.length) {
      h += '<div class="card"><h3 style="margin-bottom:4px">Blind spots</h3>' +
        '<p class="faint" style="margin:0 0 10px">You missed these twice, on different days. ' +
        'That is a hole rather than a slip, so they have gone back to the bottom of the pile.</p>' +
        r.blind.map(function (q) { return q.topic; })
          .filter(function (t, i, a) { return a.indexOf(t) === i; })
          .map(function (t) { return '<div class="betrow"><span>' + esc(t) + '</span></div>'; })
          .join('') + '</div>';
    }
    return h;
  }

  function certResults(r, right) {
    var used = {};
    CERT_ORDER.forEach(function (k) { used[k] = { n: 0, right: 0 }; });
    r.views.forEach(function (v) {
      if (!v.conf) return;
      used[v.conf].n++;
      if (v.correct) used[v.conf].right++;
    });

    var h = '<div class="card pad-lg center">' +
      '<p class="dim" style="margin:0">This round</p>' +
      '<div style="font-size:2.6rem;font-weight:800;line-height:1.15">' +
      (r.score > 0 ? '+' : '') + r.score + '</div>' +
      '<p class="dim">' + right + ' of ' + r.views.length + ' right</p></div>';

    h += '<div class="card"><h3 style="margin-bottom:8px">What you bet</h3>';
    CERT_ORDER.forEach(function (k) {
      var u = used[k], band = CERT[k];
      if (!u.n) return;
      h += '<div class="betrow"><span class="bet-name">' + band.short + '</span>' +
        '<span class="dim">' + u.right + ' of ' + u.n + ' right</span></div>';
    });

    var verdict = certVerdict();
    if (verdict.enough) {
      h += '<p class="' + (verdict.over ? 'warnline' : 'goodline') + '" style="margin:12px 0 0">' +
        esc(verdict.line) + '</p>' +
        '<p class="faint" style="margin:6px 0 0">Across every round you have played: ' +
        verdict.right + ' of ' + verdict.n + '.</p>';
    } else {
      // Three Certains a round can only ever read 0, 33, 67 or 100 per cent.
      // Saying anything definite from that would be dressing up a coin flip.
      h += '<p class="faint" style="margin:12px 0 0">You have spent Certain ' + verdict.n +
        ' time' + (verdict.n === 1 ? '' : 's') + ' so far. After ' + verdict.need +
        ' more this will tell you how much your Certain is actually worth &mdash; ' +
        'one round of three is too few to say anything true.</p>';
    }
    h += '</div>';

    var sure = r.views.filter(function (v) { return v.conf === 'certain' && !v.correct; });
    if (sure.length) {
      h += '<div class="card"><h3 style="margin-bottom:4px">You were sure about these</h3>' +
        '<p class="faint" style="margin:0 0 10px">Back to the bottom of the pile. These are the ' +
        'ones worth looking at tonight.</p>' +
        sure.map(function (v) { return v.q.topic; })
          .filter(function (t, i, a) { return a.indexOf(t) === i; })   // two misses in one topic is one thing to revise
          .map(function (t) { return '<div class="betrow"><span>' + esc(t) + '</span></div>'; })
          .join('') + '</div>';
    }
    return h;
  }

  function viewResults() {
    var r = S.run;
    var right = r.views.filter(function (v) { return v.correct; }).length;
    var pct = Math.round(100 * right / r.views.length);
    var passed = pct >= (r.passMark || 0);

    var h = topbar(r.title + ' — done', null);

    if (r.mode === 'certainty') h += certResults(r, right);
    if (r.mode === 'standing') h += standingResults(r, right);
    if (r.mode === 'ghost') h += ghostResults(r, right);

    h += '<div class="card pad-lg center">' +
      '<div style="font-size:2.8rem;line-height:1">' + (pct >= 90 ? '&#127942;' : pct >= 70 ? '&#128077;' : '&#128170;') + '</div>' +
      '<div style="font-size:2.4rem;font-weight:800;line-height:1.1">' + pct + '%</div>' +
      '<p class="dim">' + right + ' of ' + r.views.length + ' correct</p>' +
      (r.passMark ? '<p class="' + (passed ? '' : 'dim') + '" style="font-weight:600">' +
        (passed ? '&#10003; Passed (' + r.passMark + '% needed)' : 'Below the ' + r.passMark + '% pass mark') + '</p>' : '') +
      '</div>';

    if (r.promotedTo) {
      var pl = LEVELS[r.promotedTo];
      h += '<div class="card levelup center">' +
        '<div style="font-size:2.2rem;line-height:1">&#127882;</div>' +
        '<h3 style="margin:6px 0 4px">Level ' + r.promotedTo + ' unlocked</h3>' +
        '<p class="dim" style="margin:0">This chapter now serves <b>' + esc(pl.name) + '</b> &mdash; ' +
        esc(pl.blurb).toLowerCase() + '. Worth ' + pl.xp + ' XP a question.</p>' +
        '</div>';
    }

    if (r.mode === 'practice') {
      var ch = chapterById(r.chapterId);
      if (ch) {
        var m = chapterMastery(ch, r.level || 1);
        h += '<div class="card"><div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
          '<strong>Ch ' + ch.number + ' mastery</strong><span class="dim">' + m.done + '/' + m.total + '</span></div>' +
          '<div class="bar"><i style="width:' + (m.pct * 100).toFixed(1) + '%;background:var(--' + ch.color + ')"></i></div>' +
          (m.pct >= UNLOCK_AT
            ? '<p class="faint" style="margin:10px 0 0">&#10003; Chapter cleared.' +
              (bossUnlocked() ? ' Every chapter is cleared &mdash; the Final Boss is open.' : '') + '</p>'
            : '') +
          '</div>';
      }
    }

    var missed = r.views.filter(function (v) { return !v.correct; });
    if (missed.length) {
      h += '<div class="card"><h3>Review what you missed</h3>' +
        missed.map(function (v) {
          return '<div style="padding:11px 0;border-bottom:1px solid var(--line)">' +
            '<div style="font-weight:600;font-size:0.92rem;margin-bottom:4px">' + esc(v.q.prompt) + '</div>' +
            '<div class="faint">' + esc(v.q.explain) + '</div></div>';
        }).join('') + '</div>';
    }

    if (r.syncNote) h += '<p class="faint center">' + esc(r.syncNote) + '</p>';

    h += '<div class="btn-row">' +
      (r.mode === 'practice'
        ? '<button class="btn" data-again>Another round</button><button class="btn ghost" data-go="map">Back to map</button>'
        : '<button class="btn" data-go="map">Back to map</button>') +
      '</div>';
    return h;
  }

  // ---------------------------------------------------------------- live round
  //
  // Buy Time. One shared clock on the projector; this phone serves its own
  // questions at this student's own level. A miss costs the room nothing.

  // One entry per live format this bundle can play. The phone never asks which
  // game to run - it joins a code, and the room tells it. Students pick nothing
  // and are never shown a game name.
  var LIVE_GAMES = {
    buytime: {
      // the shared scoreboard strip above the question
      banner: function (r, g) {
        var pct = Math.min(100, 100 * (g.cleared || 0) / (g.target || 1));
        var h = '<div class="card" style="padding:12px 14px;margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px">' +
          '<span class="dim">The room</span><span><b>' + (g.cleared || 0) + '</b> / ' + g.target + '</span></div>' +
          '<div class="bar"><i style="width:' + pct.toFixed(1) + '%;background:var(--good)"></i></div></div>';
        var a = g.allHands;
        if (a && !a.solved && new Date(a.endsAt).getTime() > Date.now()) {
          h += '<div class="banner warn" style="text-align:center"><b>&#9995; ALL HANDS</b> &mdash; ' +
               '60 seconds for the room if you get this</div>';
        }
        return h;
      },
      clockMs: function (g) { return g.endsAtMs || null; },
      // what the end screen says
      outcome: function (r, g) {
        var won = g.won === true || r.state === 'won' || (g.cleared || 0) >= g.target;
        return {
          won: won,
          title: won ? 'The room made it' : 'Time',
          detail: (g.cleared || 0) + ' of ' + g.target + ' cleared together'
        };
      },
      // anything that closes on the wall clock rather than on a document change
      sig: function (g) {
        var a = g.allHands;
        return a && !a.solved && new Date(a.endsAt).getTime() > Date.now() ? '|ah' : '';
      },
      // what the student is told after an answer. Every word of this is Buy
      // Time's, so it lives with Buy Time.
      say: function (j, correct) {
        if (!correct) return 'Into the pool - costs the room nothing. Someone else can take it.';
        if (j.creditedTo) return '+' + j.seconds + 's for the room - credited to ' + j.creditedTo;
        if (j.allHands) return '+' + j.seconds + 's for the room - all hands cleared!';
        if (j.fromPool) return '+' + j.seconds + 's - you cleared one from the pool';
        if (j.atCap) return 'Correct - you are at your cap, let someone else buy the time';
        return '+' + j.seconds + 's for the room';
      }
    },

    fieldday: {
      // A phone shows the lane it just moved and how far the room has to go.
      // It deliberately does NOT show a per-student tally, because there is no
      // such thing in this format and inventing one on the small screen would
      // quietly reintroduce the ranking the projector was designed to avoid.
      banner: function (r, g) {
        var lanes = g.lanes || {};
        var ids = Object.keys(lanes);
        var laps = g.laps || 20;
        var lead = ids.length
          ? ids.reduce(function (m, id) { return lanes[id] > lanes[m] ? id : m; }, ids[0])
          : null;
        var h = '<div class="card" style="padding:12px 14px;margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:6px">' +
          '<span class="dim">Front runner</span><span><b>' +
          (lead ? chapterLabel(lead) : 'nobody yet') + '</b>' +
          (lead ? ' &middot; ' + lanes[lead] + '/' + laps : '') + '</span></div>' +
          '<div class="bar"><i style="width:' +
          (lead ? Math.min(100, 100 * lanes[lead] / laps).toFixed(1) : '0') +
          '%;background:var(--good)"></i></div></div>';
        if (g.focus) {
          h += '<div class="banner warn" style="text-align:center"><b>&#127919; FOCUS</b> &mdash; ' +
            esc(chapterLabel(g.focus.chapter)) + ' is worth double right now</div>';
        }
        return h;
      },
      clockMs: function (g) { return g.endsAtMs || null; },
      outcome: function (r, g) {
        var lanes = g.lanes || {};
        var ids = Object.keys(lanes);
        var lead = g.winner || (ids.length
          ? ids.reduce(function (m, id) { return lanes[id] > lanes[m] ? id : m; }, ids[0])
          : null);
        return {
          won: !!g.winner,
          title: lead ? chapterLabel(lead) + ' won' : 'Time',
          detail: lead
            ? (g.winner ? 'crossed the line first' : 'finished furthest ahead')
            : ''
        };
      },
      // the focus window closes when it is used up, not on a clock, so the
      // document changes and no signature hook is needed
      say: function (j, correct) {
        if (!correct) return 'No cost to anyone. It only tells your instructor what to go over.';
        if (j.won) return chapterLabel(j.won) + ' crossed the line!';
        if (j.focused) return 'Double step - ' + chapterLabel(j.lane) + ' was the focus';
        return chapterLabel(j.lane) + ' moves up one';
      }
    },

    forecast: {
      // The room's margin, and nothing else. A student's OWN margin is shown
      // below the question and never leaves this phone.
      banner: function (r, g) {
        var m = g.margin || 0;
        var mine = LIVE.fc ? LIVE.fc.mine : 0;
        return '<div class="card" style="padding:12px 14px;margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem">' +
          '<span class="dim">The room</span>' +
          '<span><b>' + (m > 0 ? '+' : '') + m.toFixed(1) + '</b> vs forecast</span></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-top:4px">' +
          '<span class="dim">You</span>' +
          '<span class="' + (mine > 0 ? 'goodline' : mine < 0 ? 'warnline' : '') + '">' +
          '<b>' + (mine > 0 ? '+' : '') + (mine / 100).toFixed(1) + '</b></span></div>' +
          '<p class="faint" style="margin:6px 0 0">Your number is yours. It is never sent to the wall.</p>' +
          '</div>';
      },
      clockMs: function (g) { return g.endsAtMs || null; },
      outcome: function (r, g) {
        var m = g.margin || 0;
        return {
          won: m > 0.05,
          title: m > 0.05 ? 'The room beat its forecast'
               : m < -0.05 ? 'The room came up short' : 'Exactly as predicted',
          detail: (m > 0 ? '+' : '') + m.toFixed(1) + ' across everyone'
        };
      },
      say: function (j, correct) {
        var d = (j.delta || 0) / 100;
        var head = j.weight > 1 ? 'Defending it \u00b7 ' : '';
        if (correct) {
          return head + 'Right. You were expected to get this ' + j.expected +
                 ' times in 100 \u2014 ' + (d > 0 ? '+' : '') + d.toFixed(1) + ' for you.';
        }
        return head + 'Missed. You were expected to get this ' + j.expected +
               ' times in 100 \u2014 ' + d.toFixed(1) + ' for you.';
      }
    },

    walkthrough: {
      banner: function (r, g) {
        var pick = LIVE.wt && LIVE.wt.cell;
        return '<div class="card" style="padding:12px 14px;margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem">' +
          '<span class="dim">The audit</span>' +
          '<span><b>' + (g.found || 0) + '</b> of ' + g.total + ' barriers found</span></div>' +
          (pick !== undefined && pick !== null
            ? '<p class="faint" style="margin:6px 0 0">Surveying <b>' +
              esc(areaName(pick)) + '</b> \u2014 get this right and you see what is wrong with it.</p>'
            : '') +
          '</div>';
      },
      clockMs: function (g) { return g.endsAtMs || null; },
      outcome: function (r, g) {
        return {
          won: !!g.done,
          title: g.done ? 'Building audited' : 'Time',
          detail: (g.found || 0) + ' of ' + g.total + ' barriers found'
        };
      },
      say: function (j, correct) {
        if (!correct) return 'Missed \u2014 that area stays unsurveyed. It costs the room nothing.';
        if (j.already) return 'Somebody else got there first. Pick another area.';
        if (j.barrier) {
          var b = barrierInfo(j.barrier);
          return areaName(j.cell) + ' \u2014 ' + b.name + '. ' + b.note;
        }
        return areaName(j.cell) + ' is clear. Nothing wrong with it.';
      }
    }
  };

  var AREAS = (window.RT_CONTENT && RT_CONTENT.areas) || [];
  var BARRIERS = (window.RT_CONTENT && RT_CONTENT.barriers) || [];

  function areaName(i) { return AREAS[i] || ('Area ' + i); }
  function barrierInfo(id) {
    return BARRIERS.filter(function (b) { return b.id === id; })[0] || { name: id, note: '' };
  }

  // What the app expects of THIS student on THIS question, from their own
  // Leitner history, as a percentage. A box they have mastered is a high
  // expectation; one they have never seen is a coin flip weighted down.
  var FORECAST_BY_BOX = [40, 60, 78, 90];

  function expectationFor(q, level) {
    var r = S.progress[recKey(q.id, level || 1)];
    var box = (r && r.box) || 0;
    var base = FORECAST_BY_BOX[Math.min(FORECAST_BY_BOX.length - 1, box)];
    // A question they keep missing is worth expecting less of, whatever box
    // it is nominally in.
    if (r && r.seen >= 3 && r.right / r.seen < 0.5) base = Math.max(20, base - 20);
    return base;
  }

  // Sent on join so the room can refuse a bundle that cannot render it, before
  // that phone costs a write or half-plays a game it does not have.
  var MY_GAMES = Object.keys(LIVE_GAMES);

  var LIVE = { code: '', room: null, poll: null, view: null, feedback: '', busy: false,
               fc: null, wt: null,
               misses: {}, lastJson: '', stale: '' };

  function chapterLabel(id) {
    var c = chapterById(id);
    return c ? 'Ch ' + c.number : id;
  }

  function liveGameOf(r) { return (r && r.game) || 'buytime'; }
  function liveDef(r) { return LIVE_GAMES[liveGameOf(r)] || null; }
  function liveState(r) { return (r && (r.gs || r)) || {}; }

  function liveApi(method, path, body) {
    var opt = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    return fetch(path, opt)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .catch(function () { return { ok: false, status: 0, j: { error: 'offline' } }; });
  }

  function liveEvent(type, extra) {
    var body = Object.assign({
      classCode: S.profile.classCode, code: LIVE.code, name: S.profile.name, type: type
    }, extra || {});
    if (type === 'join') body.games = MY_GAMES;
    return liveApi('POST', API + '/room/event', body);
  }

  // Pick the next question: a pool item if this student can clear one, otherwise
  // their own weakest material at their own level.
  function nextLiveQuestion() {
    var pool = liveState(LIVE.room).pool || [];
    var all = allQuestions();

    var ah = liveState(LIVE.room).allHands;
    if (ah && !ah.solved && new Date(ah.endsAt).getTime() > Date.now()) {
      var hit = all.filter(function (q) { return q.id === ah.qid; })[0];
      if (hit) return { q: hit, fromPool: true, allHands: true };
    }

    // do not hand a student back a question they just missed themselves
    var takeable = pool.filter(function (p) { return !LIVE.misses[p.qid]; });
    if (takeable.length) {
      var pq = all.filter(function (q) { return q.id === takeable[0].qid; })[0];
      if (pq) return { q: pq, fromPool: true, allHands: false };
    }

    var mine = shuffle(all).sort(function (a, b) {
      var ra = S.progress[recKey(a.id, levelOf(a.chapter))];
      var rb = S.progress[recKey(b.id, levelOf(b.chapter))];
      return ((ra && ra.box) || 0) - ((rb && rb.box) || 0);
    });
    return { q: mine[0], fromPool: false, allHands: false };
  }

  // The last hole of Beat the Forecast is 'defend it': the question this
  // student has mastered and gone longest without seeing. It pays double and
  // costs double, so the strongest students finally have something to lose.
  function defendQuestion() {
    var best = null, oldest = Infinity;
    allQuestions().forEach(function (q) {
      var lv = levelOf(q.chapter);
      var r = S.progress[recKey(q.id, lv)];
      if (!r || r.box < MASTERY_BOX) return;
      if ((r.last || 0) < oldest) { oldest = r.last || 0; best = q; }
    });
    return best;
  }

  function serveNextLive() {
    var defend = false;
    var pick = null;

    if (liveGameOf(LIVE.room) === 'forecast') {
      var g = liveState(LIVE.room);
      var done = (LIVE.fc && LIVE.fc.holes) || 0;
      if (done >= (g.holes || 10)) { LIVE.view = null; LIVE.done = true; return; }
      if (done === (g.holes || 10) - 1) {
        var dq = defendQuestion();
        if (dq) { pick = { q: dq, fromPool: false, allHands: false }; defend = true; }
      }
    }

    if (!pick) pick = nextLiveQuestion();
    if (!pick || !pick.q) { LIVE.view = null; return; }
    var lv = levelOf(pick.q.chapter);
    LIVE.view = prep(serve(pick.q, lv));
    LIVE.view._fromPool = pick.fromPool;
    LIVE.view._askedAt = Date.now();
    LIVE.view._level = servedLevel(pick.q, lv);
    LIVE.view._defend = defend;
    // Stamped at serve time on purpose. applyResult moves the Leitner box
    // the instant an answer lands, so computing this afterwards would charge
    // the student an expectation based on knowledge they proved in that very
    // answer - inflating it on a hit, deflating it on a miss, and quietly
    // shrinking every margin toward zero.
    LIVE.view._expected = expectationFor(LIVE.view.q, LIVE.view._level || 1);
  }

  function liveAnswer() {
    var v = LIVE.view;
    if (!v || v.answered || LIVE.busy) return;
    v.correct = grade(v);
    v.answered = true;
    LIVE.busy = true;

    var elapsed = (Date.now() - v._askedAt) / 1000;
    var bucket = elapsed < 10 ? 0 : elapsed < 20 ? 1 : 2;
    var lv = v._level || 1;

    applyResult(v.q.id, v.correct, true, lv, v._protected);
    save();

    if (v.correct) {
      var coTreat = !!LIVE.coTreat;
      LIVE.coTreat = false;
      var fcExtra = forecastExtra(v);
      liveEvent('clear', {
        qid: v.q.id, topic: v.q.topic, chapter: v.q.chapter,
        level: lv, bucket: bucket, fromPool: !!v._fromPool, coTreat: coTreat,
        expected: fcExtra.expected, defend: fcExtra.defend,
        cell: LIVE.wt ? LIVE.wt.cell : undefined
      }).then(function (res) {
        LIVE.busy = false;
        if (res.ok) {
          LIVE.room = res.j.room;
          forecastTally(res);
          var sdef = liveDef(LIVE.room);
          LIVE.feedback = sdef && sdef.say ? sdef.say(res.j, true) : 'Correct';
        } else {
          LIVE.feedback = 'Correct — saved locally, could not reach the room';
        }
        render();
      });
    } else {
      LIVE.misses[v.q.id] = true;
      var fcMiss = forecastExtra(v);
      liveEvent('miss', { qid: v.q.id, topic: v.q.topic, chapter: v.q.chapter,
                          expected: fcMiss.expected, defend: fcMiss.defend }).then(function (res) {
        LIVE.busy = false;
        if (res.ok) LIVE.room = res.j.room;
        forecastTally(res);
        var mdef = liveDef(LIVE.room);
        LIVE.feedback = res.ok && mdef && mdef.say ? mdef.say(res.j, false) : 'Saved locally.';
        render();
      });
    }
    render();
  }

  // Only Beat the Forecast cares about these, but sending them always is two
  // integers on a request that is already going, and it keeps liveAnswer from
  // having to know which game it is in.
  function forecastExtra(v) {
    if (!v) return { expected: 50, defend: false };
    return {
      // the number stamped when this question was served, never recomputed
      expected: typeof v._expected === 'number' ? v._expected : expectationFor(v.q, v._level || 1),
      defend: !!v._defend
    };
  }

  // Keep this student's own running margin, on this phone, in hundredths.
  function forecastTally(res) {
    if (liveGameOf(LIVE.room) !== 'forecast' || !res || !res.ok) return;
    LIVE.fc = LIVE.fc || { mine: 0, holes: 0 };
    LIVE.fc.mine += Number(res.j.delta) || 0;
    LIVE.fc.holes += 1;
  }

  function liveNext() {
    LIVE.feedback = '';
    // In The Walk-Through the next step is choosing where to look again, not
    // another question handed to you.
    if (liveGameOf(LIVE.room) === 'walkthrough') {
      LIVE.wt = null;
      LIVE.view = null;
      render();
      return;
    }
    serveNextLive();
    render();
  }

  function stopLivePolling() {
    if (LIVE.poll) { clearInterval(LIVE.poll); LIVE.poll = null; }
  }

  // Every poll that misses the Worker's cache is a billed Firestore read, so
  // the loop has to have a way to end. A finished round cannot change again.
  function startLivePolling() {
    stopLivePolling();
    LIVE.lastJson = '';
    LIVE.poll = setInterval(function () {
      if (S.screen !== 'live') { stopLivePolling(); return; }
      liveApi('GET', API + '/room?classCode=' + encodeURIComponent(S.profile.classCode) + '&code=' + LIVE.code)
        .then(function (res) {
          // Gone (404) or past its three-hour life (410): it will never answer
          // differently. A network blip has status 0 and is worth retrying.
          if (res.status === 404 || res.status === 410) { stopLivePolling(); return; }
          if (!res.ok) return;

          // An unchanged room means an unchanged screen, and render() replaces
          // the whole body - which would destroy the write-in box mid-word every
          // four seconds. The ALL HANDS banner is the one thing that closes on
          // the clock rather than in the document, so its open/shut state rides
          // in the signature: that buys one render when it opens and one when it
          // shuts, instead of one every tick until the round ends.
          var rm = res.j.room;
          var pdef = liveDef(rm);
          var j = JSON.stringify(rm) + (pdef && pdef.sig ? pdef.sig(liveState(rm)) : '');
          if (j === LIVE.lastJson) return;
          LIVE.lastJson = j;

          var wasRunning = LIVE.room && LIVE.room.state === 'running';
          LIVE.room = res.j.room;
          if (!wasRunning && LIVE.room.state === 'running' && !LIVE.view) serveNextLive();

          // ALL HANDS interrupts. The window is short, so waiting for the student
          // to finish whatever they were on would waste most of it.
          var ah = liveState(LIVE.room).allHands;
          if (ah && !ah.solved && new Date(ah.endsAt).getTime() > Date.now() &&
              LIVE.view && !LIVE.view.answered && LIVE.view.q.id !== ah.qid) {
            serveNextLive();
            LIVE.feedback = '';
          }
          render();
          if (LIVE.room.state === 'ended' || LIVE.room.state === 'won') stopLivePolling();
        });
    }, 4000);
  }

  function viewLive() {
    var r = LIVE.room;
    var def = r ? liveDef(r) : null;
    var g = liveState(r);
    var ends = def && def.clockMs ? def.clockMs(g) : null;

    // The topbar deliberately does NOT name the game. She reads out a code and
    // says nothing else; printing the name here would undo that on ten phones.
    var h = '<div class="topbar">' +
      '<button class="iconbtn" data-liveexit>&larr;</button>' +
      '<strong style="font-size:0.95rem">Live round</strong><div class="spacer"></div>' +
      (ends ? '<span class="pill timer" id="livetimer">--:--</span>' : '') +
      '</div>';

    // A code for a format this bundle does not carry. Say so and say what to
    // do - never fall back to another game, which would look like it worked.
    if (LIVE.stale) {
      return h + '<div class="card pad-lg center">' +
        '<div style="font-size:2.6rem">&#8634;</div>' +
        '<h2 style="margin-bottom:6px">Update needed</h2>' +
        '<p class="dim">This round needs the newest version of the game. ' +
        'Close this tab, open the game link again, then tap Join live round.</p>' +
        '<p class="faint">Your progress is saved.</p>' +
        '</div><button class="btn" data-livereload>Reload now</button>' +
        '<button class="btn ghost" data-liveexit2>Back to my map</button>';
    }

    if (r && !def) {
      return h + '<div class="card pad-lg center">' +
        '<div style="font-size:2.6rem">&#8634;</div>' +
        '<h2 style="margin-bottom:6px">Update needed</h2>' +
        '<p class="dim">Close this tab, open the game link again, then tap Join live round.</p>' +
        '<p class="faint">Your progress is saved.</p>' +
        '</div><button class="btn" data-livereload>Reload now</button>' +
        '<button class="btn ghost" data-liveexit2>Back to my map</button>';
    }

    if (!r) {
      return h + '<div class="card pad-lg">' +
        '<h2 style="margin-bottom:6px">Join the live round</h2>' +
        '<p class="dim" style="font-size:0.9rem">Your instructor will read out a four letter room code. ' +
        'Type it in and you are playing — you do not need to pick anything.</p>' +
        '<div class="field"><label for="roomcode">Room code</label>' +
        '<input id="roomcode" maxlength="4" autocapitalize="characters" autocomplete="off" ' +
        'placeholder="ABCD" style="text-transform:uppercase;letter-spacing:0.3em;font-size:1.4rem;text-align:center"></div>' +
        '<button class="btn" data-livejoin>Join</button>' +
        (LIVE.feedback ? '<p class="faint center" style="margin-top:10px">' + esc(LIVE.feedback) + '</p>' : '') +
        '</div>';
    }

    if (r.state === 'lobby') {
      return h + '<div class="card pad-lg center">' +
        '<div style="font-size:2.4rem">&#9203;</div>' +
        '<h2>You are in</h2>' +
        '<p class="dim">Waiting for your instructor to start the clock.</p>' +
        '<p class="faint">' + r.players.length + ' in the room</p></div>';
    }

    if (r.state !== 'running') {
      var out = def.outcome ? def.outcome(r, g) : { won: false, title: 'Time', detail: '' };
      return h + '<div class="card pad-lg center">' +
        '<div style="font-size:2.8rem">' + (out.won ? '&#127881;' : '&#9203;') + '</div>' +
        '<h2>' + esc(out.title) + '</h2>' +
        (out.detail ? '<p class="dim">' + esc(out.detail) + '</p>' : '') +
        '</div><button class="btn" data-liveexit2>Back to my map</button>';
    }

    // Everything above the question belongs to the format.
    if (def.banner) h += def.banner(r, g);

    // The Walk-Through asks where you want to look before it asks you
    // anything. Choosing first is what makes this an audit rather than a
    // lucky dip, and it means a wrong answer costs a decision, not a life.
    if (liveGameOf(r) === 'walkthrough' && !LIVE.wt) {
      var seen = g.seen || {};
      return h + '<div class="card pad-lg">' +
        '<h2 style="margin-bottom:4px">Where do you want to look?</h2>' +
        '<p class="dim" style="font-size:0.9rem;margin-top:0">Pick an area you have not surveyed. ' +
        'Answer the question correctly and you will see what is wrong with it.</p>' +
        '<div class="areagrid">' +
        AREAS.map(function (name, i) {
          var st = seen[i];
          if (st) {
            return '<span class="area done ' + (st === 'clear' ? 'ok' : 'bad') + '">' +
              esc(name) + '</span>';
          }
          return '<button class="area" data-cell="' + i + '">' + esc(name) + '</button>';
        }).join('') +
        '</div></div>';
    }

    var v = LIVE.view;
    if (!v && LIVE.done) {
      var myMargin = ((LIVE.fc && LIVE.fc.mine) || 0) / 100;
      return h + '<div class="card pad-lg center">' +
        '<div style="font-size:2.4rem">&#9203;</div>' +
        '<h2 style="margin-bottom:4px">That is your lot</h2>' +
        '<p class="dim">You finished <b>' + (myMargin > 0 ? '+' : '') + myMargin.toFixed(1) +
        '</b> against your own number.</p>' +
        '<p class="faint">Only you ever saw that. The wall has the room total and nothing else.</p>' +
        '</div>';
    }
    if (!v) return h + '<div class="card"><p class="dim">Finding you a question…</p></div>';

    if (liveGameOf(r) === 'forecast' && !v.answered) {
      h += '<p class="faint center" style="margin:0 0 8px">' +
        (v._defend ? '<b>Defending it</b> &middot; worth double &middot; ' : '') +
        'the app expects you to get this <b>' + forecastExtra(v).expected +
        '</b> times in 100</p>';
    }

    h += '<div class="card pad-lg">' +
      '<span class="tag' + (v._fromPool ? ' star' : '') + '">' +
      (v._fromPool ? '&#128293; From the pool &middot; double time' : 'Lv ' + (v._level || 1) + ' &middot; ' + esc(v.q.topic)) +
      '</span>' +
      '<div class="qprompt">' + esc(v.q.prompt) + '</div>' +
      renderBody(v) + '</div>';

    if (LIVE.feedback) {
      h += '<div class="feedback ' + (v.correct ? 'good' : 'bad') + '">' + esc(LIVE.feedback) + '</div>';
    }

    h += closetShelf(v, true);

    h += '<div class="sticky-actions">';
    if (!v.answered) {
      if (needsSubmit(v)) h += '<button class="btn" data-livesubmit>Check answer</button>';
    } else {
      h += '<button class="btn" data-livenext>Next question</button>';
    }
    h += '</div>';
    return h;
  }

  // ---------------------------------------------------------------- runs

  function startPractice(chapterId) {
    var ch = chapterById(chapterId);
    if (!ch) return;
    var lv = levelOf(chapterId);
    var pool = ch.questions.map(function (q) { return Object.assign({ chapter: ch.id }, q); });
    var picked = buildSession(pool, Math.min(SESSION_SIZE, pool.length), lv);
    S.run = {
      mode: 'practice', chapterId: chapterId, level: lv,
      title: 'Ch ' + ch.number + ' · L' + lv,
      views: picked.map(function (q) { return prep(serve(q, lv)); }),
      idx: 0, streak: 0, xpStart: S.stats.xp,
      deadline: null, hideFeedback: false, passMark: 0
    };
    S.screen = 'play';
    render();
  }

  // -------------------------------------------------------- The Standing Order
  //
  // One mark, held by one student, chased alone or between classes. Fall short
  // and nothing is written, nothing is shown and nobody is told - so it can be
  // chased as often as you like with no possibility of an audience.

  var SO_SIZE = 15;
  var SO = { mark: null, loaded: false, result: null };

  // Must match the Worker: the denominator is clamped to a minute so a lucky
  // sprint cannot post a rate nobody can reach. Shown live during a run only
  // so the student can pace themselves; the Worker computes the real one.
  function clockText(seconds) {
    var t = Math.max(0, Math.round(seconds));
    return Math.floor(t / 60) + String.fromCharCode(58) + String(t % 60).padStart(2, String.fromCharCode(48));
  }

  function perHour(correct, seconds) {
    return Math.round(correct / (Math.max(seconds, 60) / 3600));
  }

  function loadStanding() {
    if (!syncEnabled()) { SO.loaded = true; return Promise.resolve(); }
    return fetch(API + '/standing?classCode=' + encodeURIComponent(S.profile.classCode))
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) SO.mark = j.standing; SO.loaded = true; })
      .catch(function () { SO.loaded = true; });
  }

  // ---------------------------------------------------------------- Ghost Duel
  //
  // You against your own last attempt. You lock an answer, and only THEN does
  // the ghost slide up with what you did last time and how long it took.
  //
  // The original design put a classmate on the other side of this, and that is
  // exactly why it never shipped: at ten students a full round robin makes the
  // bottom two nought-and-three in public every Monday, and those are the two
  // who most need to keep playing. Racing your own past self keeps the whole
  // reveal and has nobody to come last to.
  //
  // The mechanic worth keeping from the original is the BLIND SPOT: if you and
  // past-you both got it wrong, that is not bad luck, it is a hole. It goes
  // back to the bottom of the pile and gets named at the end.

  var GHOST_SIZE = 7;

  function ghosts() {
    S.stats.ghosts = S.stats.ghosts || {};
    return S.stats.ghosts;
  }

  function ghostCount() { return Object.keys(ghosts()).length; }

  function startGhostDuel() {
    var g = ghosts();
    var all = allQuestions();
    // Questions that already have a ghost come first - those are the ones with
    // somebody to race. The rest of the set records a ghost for next time.
    var haunted = shuffle(all.filter(function (q) { return g[q.id]; }));
    var fresh = shuffle(all.filter(function (q) { return !g[q.id]; }));
    var picked = haunted.concat(fresh).slice(0, Math.min(GHOST_SIZE, all.length));
    if (!picked.length) return;

    S.run = {
      mode: 'ghost',
      title: 'Ghost Duel',
      views: shuffle(picked).map(function (q) { return prep(serve(q, levelOf(q.chapter))); }),
      idx: 0, streak: 0, xpStart: S.stats.xp,
      deadline: null, hideFeedback: false, passMark: 0,
      beat: 0, raced: 0, blind: []
    };
    S.run.views.forEach(function (v) { v._askedAt = 0; });
    S.screen = 'play';
    render();
  }

  // What past-you did, in a sentence.
  function ghostLine(v) {
    // Read the ghost CAPTURED before this answer, never the live store:
    // recordGhost has already overwritten it by the time this renders, so
    // reading the store made a brand new question report “last time you got
    // this wrong” about the answer just given.
    var was = v._ghost;
    if (!was) return null;
    var secs = Math.max(1, Math.round((was.ms || 0) / 1000));
    return (was.correct ? 'Last time you got this right' : 'Last time you got this wrong') +
           ' in ' + secs + 's' + (was.pickedText ? ' \u2014 you chose \u201c' + was.pickedText + '\u201d' : '') + '.';
  }

  // Record this attempt so it becomes the ghost next time. The LATEST attempt
  // is kept rather than the best, so a student can see themselves slip as well
  // as improve - a ghost that only ever gets better is a ghost that lies.
  function recordGhost(v, ms) {
    var text = null;
    if ((v.type === 'mc' || v.type === 'scenario') && v.opts && v.picked !== null && v.picked !== undefined) {
      text = (v.opts[v.picked] || {}).t || null;
      if (text && text.length > 70) text = text.slice(0, 67) + '\u2026';
    }
    ghosts()[v.q.id] = {
      correct: !!v.correct, ms: ms, pickedText: text, at: new Date().toISOString()
    };
  }

  function startStandingOrder() {
    var pool = allQuestions();
    if (pool.length < SO_SIZE) return;
    var picked = shuffle(pool).slice(0, SO_SIZE);
    SO.result = null;
    S.run = {
      mode: 'standing',
      title: 'The Standing Order',
      views: picked.map(function (q) { return prep(serve(q, levelOf(q.chapter))); }),
      idx: 0, streak: 0, xpStart: S.stats.xp,
      deadline: null, hideFeedback: true, passMark: 0,
      startedAt: Date.now()
    };
    S.screen = 'play';
    render();
  }

  function startCertainties() {
    var pool = allQuestions().filter(function (q) { return q.type === 'mc' || q.type === 'scenario' || q.type === 'multi'; });
    if (pool.length < CERT_SIZE) return;
    // Weakest material first, at the level this student is actually working at,
    // so the bet is placed on something that matters.
    var picked = shuffle(pool).sort(function (a, b) {
      var ra = S.progress[recKey(a.id, levelOf(a.chapter))];
      var rb = S.progress[recKey(b.id, levelOf(b.chapter))];
      return ((ra && ra.box) || 0) - ((rb && rb.box) || 0);
    }).slice(0, CERT_SIZE);

    S.run = {
      mode: 'certainty',
      title: 'Three Certainties',
      views: picked.map(function (q) { return prep(serve(q, levelOf(q.chapter))); }),
      idx: 0, streak: 0, xpStart: S.stats.xp,
      deadline: null, hideFeedback: false, passMark: 0,
      budget: Object.assign({}, CERT_BUDGET),
      score: 0
    };
    S.screen = 'play';
    render();
  }

  function certLeft(kind) { return (S.run && S.run.budget && S.run.budget[kind]) || 0; }
  function certSpent() {
    if (!S.run || !S.run.budget) return 0;
    return CERT_ORDER.reduce(function (n, k) { return n + (CERT_BUDGET[k] - S.run.budget[k]); }, 0);
  }

  function startTimed(opts) {
    var pool = gradedPool(opts.chapters, opts.topics);
    if (!pool.length) return;
    var picked = shuffle(pool).slice(0, Math.min(opts.count, pool.length));
    S.run = {
      mode: opts.mode, examId: opts.examId,
      title: opts.title,
      views: picked.map(prep), idx: 0, streak: 0, xpStart: S.stats.xp,
      deadline: opts.minutes ? Date.now() + opts.minutes * 60000 : null,
      hideFeedback: true, passMark: opts.passMark || 0
    };
    S.screen = 'play';
    render();
    tick();
  }

  // The live clock is derived from the room's absolute deadline, so a dropped
  // poll never freezes it and phones never drift apart.
  setInterval(function () {
    var el = document.getElementById('livetimer');
    var tdef = liveDef(LIVE.room);
    var ends = tdef && tdef.clockMs ? tdef.clockMs(liveState(LIVE.room)) : null;
    if (!el || !ends) return;
    var left = ends - Date.now();
    if (left < 0) left = 0;
    var t = Math.ceil(left / 1000);
    el.textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    el.classList.toggle('low', left < 60000);
  }, 250);

  var tmrHandle = null;
  function tick() {
    if (tmrHandle) clearInterval(tmrHandle);
    if (!S.run || !S.run.deadline) return;
    tmrHandle = setInterval(function () {
      if (!S.run || !S.run.deadline || S.screen !== 'play') { clearInterval(tmrHandle); return; }
      var left = S.run.deadline - Date.now();
      var el = document.getElementById('tmr');
      if (left <= 0) { clearInterval(tmrHandle); finishRun(); return; }
      if (el) {
        var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
        el.classList.toggle('low', left < 60000);
      }
    }, 250);
  }

  function finishRun() {
    if (tmrHandle) clearInterval(tmrHandle);
    var r = S.run;
    // any unanswered questions (ran out of time) count as missed
    r.views.forEach(function (v) {
      if (!v.answered) {
        v.answered = true; v.correct = false;
        applyResult(v.q.id, false, r.mode === 'practice' || r.mode === 'certainty',
                    v.q._level || 1, v._protected);
      }
    });

    // Inservice pays on the whole session rather than per question, so it is
    // worth most on a long run at a high level - which is the run worth taking.
    if (S.stats.boost) {
      // NOT `r.xpStart || S.stats.xp`: a student who started the session on
      // zero XP has a perfectly valid xpStart of 0, and the falsy fallback made
      // the bonus silently evaluate to nothing for exactly the newest students.
      var gained = S.stats.xp - (typeof r.xpStart === 'number' ? r.xpStart : S.stats.xp);
      S.stats.xp += Math.round(gained * 0.5);
      r.boosted = Math.round(gained * 0.5);
      S.stats.boost = 0;
    }

    var right = r.views.filter(function (v) { return v.correct; }).length;
    var pct = Math.round(100 * right / r.views.length);

    if (r.mode === 'practice') {
      S.stats.sessions++;
      r.promotedTo = checkPromotion(r.chapterId);   // may be null
    }
    if (r.mode === 'standing') {
      var secs = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
      r.seconds = secs;
      r.rate = perHour(right, secs);
      // A personal best is kept on the device whether or not the mark moved,
      // because a student with no class code still deserves something to beat.
      S.stats.bestRate = Math.max(S.stats.bestRate || 0, r.rate);
      if (syncEnabled()) {
        fetch(API + '/standing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            classCode: S.profile.classCode, name: S.profile.name,
            correct: right, asked: r.views.length, seconds: secs
          })
        }).then(function (x) { return x.json(); })
          .then(function (j) {
            if (!j || !j.ok) return;
            SO.mark = j.standing;
            SO.result = { took: j.took, rate: j.rate, bar: j.bar };
            if (S.screen === 'results') render();
          })
          .catch(function () { /* offline: the run simply did not happen */ });
      }
    }
    if (r.mode === 'certainty') {
      S.stats.certRuns = (S.stats.certRuns || []).concat([{
        score: r.score, at: new Date().toISOString()
      }]).slice(-30);
      S.stats.bestCert = Math.max(S.stats.bestCert || -9999, r.score);
    }
    if (r.mode === 'exam' || r.mode === 'boss') {
      S.stats.examRuns = (S.stats.examRuns || []).concat([{
        id: r.examId || 'boss', name: r.title, pct: pct, at: new Date().toISOString()
      }]).slice(-30);
    }
    save();

    S.screen = 'results';
    render();

    if (syncEnabled()) {
      syncProgress({ type: r.mode, title: r.title, pct: pct }).then(function (res) {
        if (res && res.error) {
          S.run.syncNote = 'Saved on this device. Could not reach the server — it will sync next time.';
        } else if (res && !res.skipped) {
          S.run.syncNote = 'Progress saved for ' + S.profile.name + '.';
        }
        if (S.screen === 'results') render();
      });
    }
  }

  function answerCurrent() {
    var r = S.run, v = r.views[r.idx];
    if (v.answered) return;
    v.correct = grade(v);
    v.answered = true;

    if (r.mode === 'ghost') {
      var ms = v._askedAt ? Date.now() - v._askedAt : 0;
      var was = ghosts()[v.q.id];
      v._ghost = was || null;
      if (was) {
        r.raced++;
        // Beating the ghost means getting it right when they did not, or
        // getting it right faster than they did.
        var better = (v.correct && !was.correct) ||
                     (v.correct && was.correct && ms > 0 && ms < was.ms);
        if (better) r.beat++;
        v._beatGhost = better;
        // Both of you wrong is not bad luck, it is a hole.
        if (!v.correct && !was.correct) {
          v._blind = true;
          r.blind.push(v.q);
          var rr = rec(v.q.id, v.q._level || 1);
          rr.box = 0;
          rr.blindSpot = true;
        }
      }
      v._ms = ms;
      recordGhost(v, ms);
    }

    // Spaced repetition applies to practice AND to Three Certainties. The flag
    // is about whether a run feeds the Leitner boxes, not about the word
    // 'practice' - reading it as a mode name would have silently disabled the
    // whole punishment mechanic here, which is the mechanic.
    var feedsBoxes = r.mode === 'practice' || r.mode === 'certainty' || r.mode === 'ghost';
    applyResult(v.q.id, v.correct, feedsBoxes, v.q._level || 1, v._protected);

    if (r.mode === 'certainty' && v.conf) {
      var band = CERT[v.conf];
      v.points = v.correct ? band.win : band.lose;
      r.score += v.points;

      var t = certTally();
      t[v.conf].n++;
      if (v.correct) t[v.conf].right++;

      // Being sure and wrong is the most expensive thing on the board, and the
      // cost is not the points - it is that the question comes back from the
      // bottom, tagged with what you claimed about it.
      if (!v.correct && v.conf === 'certain') {
        var rr = rec(v.q.id, v.q._level || 1);
        rr.box = 0;
        rr.wasSure = true;
      }
    }

    if (v.correct) {
      r.streak++;
      if (r.streak > S.stats.bestStreak) S.stats.bestStreak = r.streak;
      if (r.streak > 0 && r.streak % 5 === 0 && !r.hideFeedback) flashStreak(r.streak);
    } else {
      r.streak = 0;
    }
    save();

    if (r.hideFeedback) { advance(); return; }
    render();
  }

  function advance() {
    // Only a practice run advances through a fixed list. A live round asks the
    // room for its next question instead, so this must never be reached with
    // S.run null - and must not throw if a future game's chrome wires it here.
    var r = S.run;
    if (!r) { if (S.screen === 'live') liveNext(); return; }
    if (r.idx + 1 >= r.views.length) { finishRun(); return; }
    r.idx++;
    render();
  }

  function flashStreak(n) {
    var d = document.createElement('div');
    d.className = 'streakflash';
    d.textContent = '🔥 ' + n + ' in a row!';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1200);
  }

  // ---------------------------------------------------------------- events

  function bind() {
    app.querySelectorAll('[data-go]').forEach(function (b) {
      b.onclick = function () {
        S.screen = b.getAttribute('data-go');
        render();
        // Opening the closet is the moment to find out whether the instructor
        // has handed anything out. It is the one place a forced sync is worth
        // a write, because otherwise a grant sits unseen until the student
        // happens to finish a session whose numbers actually changed.
        if (S.screen === 'closet' && syncEnabled()) {
          syncProgress({ type: 'closet' }, true).then(function (res) {
            if (res && res.ok && S.screen === 'closet' && S.stats.grantJustGot) render();
          });
        }
      };
    });

    var tt = app.querySelector('[data-theme-toggle]');
    if (tt) tt.onclick = function () {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', S.theme);
      save(); render();
    };

    var start = app.querySelector('[data-start]');
    if (start) start.onclick = function () {
      var nm = app.querySelector('#nm').value.trim();
      var cc = app.querySelector('#cc').value.trim().toUpperCase();
      if (!nm) { app.querySelector('#nm').focus(); return; }
      S.profile.name = nm; S.profile.classCode = cc;
      save(); S.screen = 'map'; render();
    };

    var skip = app.querySelector('[data-skip]');
    if (skip) skip.onclick = function () { S.screen = 'map'; render(); };

    app.querySelectorAll('[data-chapter]').forEach(function (b) {
      b.onclick = function () { startPractice(b.getAttribute('data-chapter')); };
    });

    var boss = app.querySelector('[data-boss]');
    if (boss && !boss.disabled) boss.onclick = function () {
      startTimed({
        mode: 'boss', title: 'Final Boss',
        chapters: CHAPTERS.map(function (c) { return c.id; }), topics: [],
        count: 25, minutes: 15, passMark: 80
      });
    };

    app.querySelectorAll('[data-exam]').forEach(function (b) {
      b.onclick = function () {
        var ex = EXAMS.filter(function (e) { return e.id === b.getAttribute('data-exam'); })[0];
        if (!ex) return;
        startTimed({
          mode: 'exam', examId: ex.id, title: ex.name,
          chapters: ex.chapters || [], topics: ex.topics || [],
          count: ex.questionCount || 30, minutes: ex.minutes || 0, passMark: ex.passMark || 80
        });
      };
    });

    // Question interactions. A practice question and a live one are the same
    // six types on the same markup, so they get one set of handlers that asks
    // at click time which run it belongs to. Two parallel sets is how the live
    // round used to die on a write-in question: S.run is null there.
    function curView() {
      return S.screen === 'live' ? LIVE.view : (S.run && S.run.views[S.run.idx]);
    }
    function submitCur() {
      return S.screen === 'live' ? liveAnswer() : answerCurrent();
    }

    app.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () {
        var v = curView();
        if (!v || v.answered) return;
        v.picked = parseInt(b.getAttribute('data-pick'), 10);
        // In Three Certainties the answer is not the last word: the student
        // still has to say how sure they are, and that is the measurement.
        if (S.run && S.run.mode === 'certainty') { render(); return; }
        submitCur();
      };
    });

    app.querySelectorAll('[data-conf]').forEach(function (b) {
      b.onclick = function () {
        var r = S.run, v = r && r.views[r.idx];
        if (!v || v.answered) return;
        var kind = b.getAttribute('data-conf');
        if (!r.budget[kind]) return;
        r.budget[kind]--;
        v.conf = kind;
        answerCurrent();
      };
    });

    app.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.onclick = function () {
        var v = curView();
        if (!v || v.answered) return;
        var i = parseInt(b.getAttribute('data-toggle'), 10);
        v.sel[i] = !v.sel[i];
        render();
      };
    });

    app.querySelectorAll('[data-match]').forEach(function (sel) {
      sel.onchange = function () {
        var v = curView();
        if (!v) return;
        v.sel[parseInt(sel.getAttribute('data-match'), 10)] = sel.value;
      };
    });

    function nudge(b, attr, step) {
      b.onclick = function () {
        var v = curView();
        if (!v) return;
        var i = parseInt(b.getAttribute(attr), 10);
        var t = v.order[i + step]; v.order[i + step] = v.order[i]; v.order[i] = t;
        render();
      };
    }
    app.querySelectorAll('[data-up]').forEach(function (b) { nudge(b, 'data-up', -1); });
    app.querySelectorAll('[data-down]').forEach(function (b) { nudge(b, 'data-down', 1); });

    var fill = app.querySelector('#fillin');
    if (fill) {
      var fv = curView();
      fill.oninput = function () { var v = curView(); if (v) v.value = fill.value; };
      fill.onkeydown = function (e) { if (e.key === 'Enter') submitCur(); };
      if (fv && !fv.answered) fill.focus();
    }

    var sub = app.querySelector('[data-submit]');
    if (sub) sub.onclick = answerCurrent;

    var nxt = app.querySelector('[data-next]');
    if (nxt) nxt.onclick = advance;

    var quit = app.querySelector('[data-quit]');
    if (quit) quit.onclick = function () {
      if (tmrHandle) clearInterval(tmrHandle);
      S.run = null; S.screen = 'map'; render();
    };

    var again = app.querySelector('[data-again]');
    if (again) again.onclick = function () { startPractice(S.run.chapterId); };

    // ---- live round
    var lj = app.querySelector('[data-livejoin]');
    if (lj) lj.onclick = function () {
      var code = (app.querySelector('#roomcode').value || '').trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) { LIVE.feedback = 'That needs to be four letters.'; render(); return; }
      // An impatient second tap on a cold start would write the player twice.
      if (LIVE.busy) return;
      LIVE.busy = true;
      LIVE.code = code; LIVE.misses = {}; LIVE.fc = null; LIVE.wt = null;
      liveEvent('join').then(function (res) {
        LIVE.busy = false;
        // 426: the room is running a format this bundle does not carry.
        if (res.status === 426) { LIVE.stale = res.j.game || 'that game'; render(); return; }
        if (!res.ok) { LIVE.feedback = res.j.error === 'room not found' ? 'No round with that code yet.' : 'Could not join.'; render(); return; }
        LIVE.room = res.j.room; LIVE.feedback = '';
        if (LIVE.room.state === 'running') serveNextLive();
        startLivePolling(); render();
      });
    };

    app.querySelectorAll('[data-cell]').forEach(function (b) {
      b.onclick = function () {
        LIVE.wt = { cell: parseInt(b.getAttribute('data-cell'), 10) };
        LIVE.feedback = '';
        serveNextLive();
        render();
      };
    });

    var ls = app.querySelector('[data-livesubmit]'); if (ls) ls.onclick = liveAnswer;
    var ln = app.querySelector('[data-livenext]'); if (ln) ln.onclick = liveNext;
    // Both the topbar arrow and the end screen's full-width button exist at the
    // same time, so binding only the first one left the obvious button dead -
    // and a student who cannot leave is a student still polling.
    function exitLive() {
      stopLivePolling();
      LIVE.room = null; LIVE.view = null; LIVE.feedback = '';
      LIVE.lastJson = ''; LIVE.stale = ''; LIVE.code = ''; LIVE.misses = {}; LIVE.fc = null; LIVE.wt = null;
      S.screen = 'map'; render();
      if (syncEnabled()) syncProgress({ type: 'live' });
    }
    var rl = app.querySelector('[data-livereload]');
    if (rl) rl.onclick = function () { location.reload(); };
    app.querySelectorAll('[data-liveexit],[data-liveexit2]').forEach(function (b) {
      b.onclick = exitLive;
    });

    // ---- supply closet
    app.querySelectorAll('[data-spend]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-spend');
        var v = curView();
        if (!v || v.answered || !spend(id)) return;
        if (id === 'consult') applyConsult(v);
        else if (id === 'chart') applyChart(v);
        else if (id === 'doc') v._protected = true;
        else if (id === 'adapted') adaptDown(v);
        else if (id === 'cotreat') LIVE.coTreat = true;
        render();
      };
    });

    app.querySelectorAll('[data-buy]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-buy');
        if (!spend(id)) return;
        if (id === 'inservice') S.stats.boost = 1;
        save(); render();
      };
    });

    app.querySelectorAll('[data-buyskill]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-buyskill');
        var sk = SKILLS[id];
        if (!sk || hasSkill(id) || !skillAvailable(id)) return;
        if ((S.stats.xp || 0) < sk.xp) return;
        S.stats.xp -= sk.xp;
        S.stats.skills = S.stats.skills || {};
        S.stats.skills[id] = true;
        save(); render();
      };
    });

    var gd = app.querySelector('[data-ghost]');
    if (gd) gd.onclick = startGhostDuel;

    var so = app.querySelector('[data-standing]');
    if (so) so.onclick = startStandingOrder;

    var tc = app.querySelector('[data-certainties]');
    if (tc) tc.onclick = startCertainties;

    var reset = app.querySelector('[data-reset]');
    if (reset) reset.onclick = function () {
      if (!confirm('Reset all progress on this device? This cannot be undone.')) return;
      S.progress = {}; S.stats = { xp: 0, bestStreak: 0, sessions: 0, examRuns: [], tokens: 0, skills: {}, boost: 0, grantClaimed: 0, attempts: 0 };
      save(); S.screen = 'map'; render();
    };
  }

  // keyboard shortcuts for multiple choice
  document.addEventListener('keydown', function (e) {
    if (S.screen !== 'play' || !S.run) return;
    var v = S.run.views[S.run.idx];
    if (e.key === 'Enter' && v.answered) { advance(); return; }
    if (v.answered || (v.type !== 'mc' && v.type !== 'scenario')) return;
    var i = 'abcdefgh'.indexOf(String(e.key).toLowerCase());
    if (i >= 0 && i < v.opts.length) { v.picked = i; answerCurrent(); }
  });

  // ---------------------------------------------------------------- boot

  load();
  S.screen = S.profile.name ? 'map' : 'welcome';
  if (!CHAPTERS.length) {
    app.innerHTML = '<div class="card" style="margin-top:40px"><h2>No content loaded</h2>' +
      '<p class="dim">Run <code>npm run build</code> to bundle the chapter files.</p></div>';
    return;
  }
  render();
})();
