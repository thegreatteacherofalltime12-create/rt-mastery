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
  var API = '/api';

  // ---------------------------------------------------------------- state

  var S = {
    screen: 'welcome',
    profile: { name: '', classCode: '' },
    progress: {},               // recKey -> { box, seen, right, wrong, last }
    levels: {},                 // chapterId -> current level (1..3)
    stats: { xp: 0, bestStreak: 0, sessions: 0, examRuns: [] },
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
        S.stats = Object.assign({ xp: 0, bestStreak: 0, sessions: 0, examRuns: [] }, d.stats || {});
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

  function applyResult(qid, ok, practice, level) {
    var lv = level || 1;
    var r = rec(qid, lv);
    r.seen++; r.last = Date.now();
    if (ok) {
      r.right++;
      if (practice) r.box = Math.min(MASTERY_BOX, r.box + 1);
      S.stats.xp += (LEVELS[lv] || LEVELS[1]).xp;   // harder levels pay more
    } else {
      r.wrong++;
      if (practice) r.box = Math.max(0, r.box - 2);  // miss it, and it comes back soon
    }
  }

  // ---------------------------------------------------------------- backend sync

  function syncEnabled() { return !!(S.profile.name && S.profile.classCode); }

  // One batched write per finished round keeps us inside Firebase's free tier.
  // Every field here has a reader on the dashboard; anything write-only was a
  // document write that bought nothing. Nor is an identical body ever sent
  // twice - backing out of the live screen without playing used to cost a write.
  var lastSync = '';
  function syncProgress(extra) {
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
      bestExam: runs.reduce(function (m, r) { return Math.max(m, r.pct || 0); }, 0),
      examRuns: runs.slice(-3)
    };

    // The event kind is not sent - nothing reads it - but it does distinguish
    // two otherwise identical bodies, so it belongs in the signature.
    var json = JSON.stringify(body);
    var sig = json + '|' + ((extra && extra.type) || '');
    if (sig === lastSync) return Promise.resolve({ skipped: true });

    return fetch(API + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json
    }).then(function (r) {
      if (!r.ok) return { error: r.status };
      lastSync = sig;          // only a write that landed may suppress the next one
      return r.json();
    }).catch(function () { return { error: 'offline' }; });
  }

  function weakestTopics(n) {
    var map = {};
    allQuestions().forEach(function (q) {
      var r = S.progress[q.id];
      if (!r || !r.seen) return;
      if (!map[q.topic]) map[q.topic] = { right: 0, seen: 0 };
      map[q.topic].right += r.right;
      map[q.topic].seen += r.seen;
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
      case 'map': html = viewMap(); break;
      case 'play': html = viewPlay(); break;
      case 'results': html = viewResults(); break;
      case 'exams': html = viewExams(); break;
      case 'stats': html = viewStats(); break;
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
    var o = overall();
    var h = topbar('Your map', null);

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

    if (S.profile.classCode) {
      h += '<button class="btn" data-go="live" style="margin-top:14px">&#9201;&#65039; Join live round</button>';
    }

    h += '<div class="btn-row" style="margin-top:10px">' +
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
      '</div>';

    h += '<div class="card pad-lg">';
    h += '<span class="tag">' + (ch ? 'Ch ' + ch.number + ' &middot; ' : '') + esc(q.topic) + '</span>';
    h += '<div class="qprompt">' + esc(q.prompt) + '</div>';

    h += renderBody(v);
    h += '</div>';

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

    if (q.type === 'mc' || q.type === 'scenario') {
      v.opts.forEach(function (o, pos) {
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

  function viewResults() {
    var r = S.run;
    var right = r.views.filter(function (v) { return v.correct; }).length;
    var pct = Math.round(100 * right / r.views.length);
    var passed = pct >= (r.passMark || 0);

    var h = topbar(r.title + ' — done', null);

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
      }
    }
  };

  // Sent on join so the room can refuse a bundle that cannot render it, before
  // that phone costs a write or half-plays a game it does not have.
  var MY_GAMES = Object.keys(LIVE_GAMES);

  var LIVE = { code: '', room: null, poll: null, view: null, feedback: '', busy: false,
               misses: {}, lastJson: '', stale: '' };

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

  function serveNextLive() {
    var pick = nextLiveQuestion();
    if (!pick || !pick.q) { LIVE.view = null; return; }
    var lv = levelOf(pick.q.chapter);
    LIVE.view = prep(serve(pick.q, lv));
    LIVE.view._fromPool = pick.fromPool;
    LIVE.view._askedAt = Date.now();
    LIVE.view._level = servedLevel(pick.q, lv);
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

    applyResult(v.q.id, v.correct, true, lv);
    save();

    if (v.correct) {
      liveEvent('clear', {
        qid: v.q.id, topic: v.q.topic, chapter: v.q.chapter,
        level: lv, bucket: bucket, fromPool: !!v._fromPool
      }).then(function (res) {
        LIVE.busy = false;
        if (res.ok) {
          LIVE.room = res.j.room;
          LIVE.feedback = res.j.allHands ? '+' + res.j.seconds + 's for the room — all hands cleared!'
            : res.j.fromPool ? '+' + res.j.seconds + 's — you cleared one from the pool'
            : res.j.atCap ? 'Correct — you are at your cap, let someone else buy the time'
            : '+' + res.j.seconds + 's for the room';
        } else {
          LIVE.feedback = 'Correct — saved locally, could not reach the room';
        }
        render();
      });
    } else {
      LIVE.misses[v.q.id] = true;
      liveEvent('miss', { qid: v.q.id, topic: v.q.topic, chapter: v.q.chapter }).then(function (res) {
        LIVE.busy = false;
        if (res.ok) LIVE.room = res.j.room;
        LIVE.feedback = 'Into the pool — costs the room nothing. Someone else can take it.';
        render();
      });
    }
    render();
  }

  function liveNext() {
    LIVE.feedback = '';
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

    var v = LIVE.view;
    if (!v) return h + '<div class="card"><p class="dim">Finding you a question…</p></div>';

    h += '<div class="card pad-lg">' +
      '<span class="tag' + (v._fromPool ? ' star' : '') + '">' +
      (v._fromPool ? '&#128293; From the pool &middot; double time' : 'Lv ' + (v._level || 1) + ' &middot; ' + esc(v.q.topic)) +
      '</span>' +
      '<div class="qprompt">' + esc(v.q.prompt) + '</div>' +
      renderBody(v) + '</div>';

    if (LIVE.feedback) {
      h += '<div class="feedback ' + (v.correct ? 'good' : 'bad') + '">' + esc(LIVE.feedback) + '</div>';
    }

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
      idx: 0, streak: 0,
      deadline: null, hideFeedback: false, passMark: 0
    };
    S.screen = 'play';
    render();
  }

  function startTimed(opts) {
    var pool = gradedPool(opts.chapters, opts.topics);
    if (!pool.length) return;
    var picked = shuffle(pool).slice(0, Math.min(opts.count, pool.length));
    S.run = {
      mode: opts.mode, examId: opts.examId,
      title: opts.title,
      views: picked.map(prep), idx: 0, streak: 0,
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
      if (!v.answered) { v.answered = true; v.correct = false; applyResult(v.q.id, false, r.mode === "practice", v.q._level || 1); }
    });

    var right = r.views.filter(function (v) { return v.correct; }).length;
    var pct = Math.round(100 * right / r.views.length);

    if (r.mode === 'practice') {
      S.stats.sessions++;
      r.promotedTo = checkPromotion(r.chapterId);   // may be null
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
    applyResult(v.q.id, v.correct, r.mode === "practice", v.q._level || 1);

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
      b.onclick = function () { S.screen = b.getAttribute('data-go'); render(); };
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
        submitCur();
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
      LIVE.code = code; LIVE.misses = {};
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

    var ls = app.querySelector('[data-livesubmit]'); if (ls) ls.onclick = liveAnswer;
    var ln = app.querySelector('[data-livenext]'); if (ln) ln.onclick = liveNext;
    // Both the topbar arrow and the end screen's full-width button exist at the
    // same time, so binding only the first one left the obvious button dead -
    // and a student who cannot leave is a student still polling.
    function exitLive() {
      stopLivePolling();
      LIVE.room = null; LIVE.view = null; LIVE.feedback = '';
      LIVE.lastJson = ''; LIVE.stale = ''; LIVE.code = ''; LIVE.misses = {};
      S.screen = 'map'; render();
      if (syncEnabled()) syncProgress({ type: 'live' });
    }
    var rl = app.querySelector('[data-livereload]');
    if (rl) rl.onclick = function () { location.reload(); };
    app.querySelectorAll('[data-liveexit],[data-liveexit2]').forEach(function (b) {
      b.onclick = exitLive;
    });

    var reset = app.querySelector('[data-reset]');
    if (reset) reset.onclick = function () {
      if (!confirm('Reset all progress on this device? This cannot be undone.')) return;
      S.progress = {}; S.stats = { xp: 0, bestStreak: 0, sessions: 0, examRuns: [] };
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
