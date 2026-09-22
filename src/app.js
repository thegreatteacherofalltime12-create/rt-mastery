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
  var UNLOCK_AT = 0.8;          // mastery that marks a chapter cleared, and gates the boss
  var SESSION_SIZE = 12;        // questions per practice round
  var API = '/api';

  // ---------------------------------------------------------------- state

  var S = {
    screen: 'welcome',
    profile: { name: '', classCode: '' },
    progress: {},               // qid -> { box, seen, right, wrong, last }
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
        S.stats = Object.assign({ xp: 0, bestStreak: 0, sessions: 0, examRuns: [] }, d.stats || {});
        S.theme = d.theme || 'dark';
      }
    } catch (e) { /* corrupt or blocked storage — start fresh */ }
    document.documentElement.setAttribute('data-theme', S.theme);
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        profile: S.profile, progress: S.progress, stats: S.stats, theme: S.theme
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

  function rec(qid) {
    if (!S.progress[qid]) S.progress[qid] = { box: 0, seen: 0, right: 0, wrong: 0, last: 0 };
    return S.progress[qid];
  }

  function isMastered(qid) { return (S.progress[qid] && S.progress[qid].box) >= MASTERY_BOX; }

  function chapterMastery(ch) {
    var total = ch.questions.length, done = 0;
    ch.questions.forEach(function (q) { if (isMastered(q.id)) done++; });
    return { done: done, total: total, pct: total ? done / total : 0 };
  }

  function bossUnlocked() {
    return CHAPTERS.length > 0 && CHAPTERS.every(function (c) { return chapterMastery(c).pct >= UNLOCK_AT; });
  }

  function overall() {
    var total = 0, done = 0;
    CHAPTERS.forEach(function (c) {
      var m = chapterMastery(c); total += m.total; done += m.done;
    });
    return { done: done, total: total, pct: total ? done / total : 0 };
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

  // ---------------------------------------------------------------- session building

  // Pick questions weighted toward what the student has not locked in yet.
  function buildSession(pool, size) {
    var byBox = [[], [], [], []];
    pool.forEach(function (q) {
      var b = Math.min(3, Math.max(0, (S.progress[q.id] && S.progress[q.id].box) || 0));
      byBox[b].push(q);
    });
    var picked = [];
    // box 0 and 1 first (never seen / struggling), then 2, then mastered review
    [0, 1, 2, 3].forEach(function (b) {
      if (picked.length >= size) return;
      var need = size - picked.length;
      picked = picked.concat(shuffle(byBox[b]).slice(0, need));
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
      return (q.answer || []).some(function (a) { return norm(a) === got2; });
    }
    return false;
  }

  function applyResult(qid, ok, practice) {
    var r = rec(qid);
    r.seen++; r.last = Date.now();
    if (ok) {
      r.right++;
      if (practice) r.box = Math.min(MASTERY_BOX, r.box + 1);
      S.stats.xp += 10;
    } else {
      r.wrong++;
      if (practice) r.box = Math.max(0, r.box - 2);  // miss it, and it comes back soon
    }
  }

  // ---------------------------------------------------------------- backend sync

  function syncEnabled() { return !!(S.profile.name && S.profile.classCode); }

  // One batched write per finished round keeps us inside Firebase's free tier.
  function syncProgress(extra) {
    if (!syncEnabled()) return Promise.resolve({ skipped: true });
    var o = overall();
    var perChapter = {};
    CHAPTERS.forEach(function (c) {
      var m = chapterMastery(c);
      perChapter[c.id] = { done: m.done, total: m.total };
    });
    var weak = weakestTopics(6).map(function (w) { return w.topic + ' (' + w.pct + '%)'; });

    var body = {
      name: S.profile.name,
      classCode: S.profile.classCode,
      xp: S.stats.xp,
      sessions: S.stats.sessions,
      bestStreak: S.stats.bestStreak,
      mastered: o.done,
      totalQuestions: o.total,
      chapters: perChapter,
      weakTopics: weak,
      examRuns: (S.stats.examRuns || []).slice(-10),
      updatedAt: new Date().toISOString()
    };
    if (extra) body.event = extra;

    return fetch(API + '/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok ? r.json() : { error: r.status }; })
      .catch(function () { return { error: 'offline' }; });
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
      default: html = viewMap();
    }
    app.innerHTML = html;
    bind();
    window.scrollTo(0, 0);
  }

  function topbar(title, backTo) {
    var o = overall();
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
      var m = chapterMastery(c);
      var done = m.pct >= UNLOCK_AT;
      h += '<button class="zone ' + (done ? 'done' : '') + '" data-chapter="' + c.id + '">' +
        '<span class="orb" style="background:var(--' + c.color + ')22;color:var(--' + c.color + ')">' +
        'Ch' + c.number + '</span>' +
        '<span class="grow">' +
        '<div class="ztitle">' + esc(c.title) + (done ? ' &#10003;' : '') + '</div>' +
        '<div class="zmeta">' + m.done + ' of ' + m.total + ' locked in &middot; ' +
        Math.round(m.pct * 100) + '%</div>' +
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

    h += '<div class="btn-row" style="margin-top:14px">' +
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
      if (v.answered && !v.correct) {
        h += '<p class="faint">Accepted answer: <b>' + esc((q.answer || [])[0]) + '</b></p>';
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

    if (r.mode === 'practice') {
      var ch = chapterById(r.chapterId);
      if (ch) {
        var m = chapterMastery(ch);
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

  // ---------------------------------------------------------------- runs

  function startPractice(chapterId) {
    var ch = chapterById(chapterId);
    if (!ch) return;
    var pool = ch.questions.map(function (q) { return Object.assign({ chapter: ch.id }, q); });
    var picked = buildSession(pool, Math.min(SESSION_SIZE, pool.length));
    S.run = {
      mode: 'practice', chapterId: chapterId,
      title: 'Ch ' + ch.number,
      views: picked.map(prep), idx: 0, streak: 0,
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
      if (!v.answered) { v.answered = true; v.correct = false; applyResult(v.q.id, false, r.mode === 'practice'); }
    });

    var right = r.views.filter(function (v) { return v.correct; }).length;
    var pct = Math.round(100 * right / r.views.length);

    if (r.mode === 'practice') S.stats.sessions++;
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
    applyResult(v.q.id, v.correct, r.mode === 'practice');

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
    var r = S.run;
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

    // question interactions
    app.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () {
        var v = S.run.views[S.run.idx];
        if (v.answered) return;
        v.picked = parseInt(b.getAttribute('data-pick'), 10);
        answerCurrent();
      };
    });

    app.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.onclick = function () {
        var v = S.run.views[S.run.idx];
        if (v.answered) return;
        var i = parseInt(b.getAttribute('data-toggle'), 10);
        v.sel[i] = !v.sel[i];
        render();
      };
    });

    app.querySelectorAll('[data-match]').forEach(function (sel) {
      sel.onchange = function () {
        var v = S.run.views[S.run.idx];
        v.sel[parseInt(sel.getAttribute('data-match'), 10)] = sel.value;
      };
    });

    app.querySelectorAll('[data-up]').forEach(function (b) {
      b.onclick = function () {
        var v = S.run.views[S.run.idx];
        var i = parseInt(b.getAttribute('data-up'), 10);
        var t = v.order[i - 1]; v.order[i - 1] = v.order[i]; v.order[i] = t;
        render();
      };
    });
    app.querySelectorAll('[data-down]').forEach(function (b) {
      b.onclick = function () {
        var v = S.run.views[S.run.idx];
        var i = parseInt(b.getAttribute('data-down'), 10);
        var t = v.order[i + 1]; v.order[i + 1] = v.order[i]; v.order[i] = t;
        render();
      };
    });

    var fill = app.querySelector('#fillin');
    if (fill) {
      fill.oninput = function () { S.run.views[S.run.idx].value = fill.value; };
      fill.onkeydown = function (e) { if (e.key === 'Enter') answerCurrent(); };
      if (!S.run.views[S.run.idx].answered) fill.focus();
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
