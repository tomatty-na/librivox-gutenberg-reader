/* ==========================================================
   プレイヤー（DOM 操作）。純粋ロジックは core.js（LGCore）にある。土台は P1-7 の試作
   - ページの HTML（<作品>/sNN/pNNN/）は本文を埋め込んである（D-052）。開いたときはそれをそのまま使い、
     ページ JSON（<作品>/sNN/pNNN.json）から時刻を読む。位置は #t=秒 で渡す
   - 表示ページは再生位置に従う。同じセクションの中では <audio> を止めずに、本文を JSON から作り直して
     差し替え、history.replaceState で URL を変える（D-024）。セクションの終わりでは次のセクションへ進む
   - ハイライトは語・句・文（D-053）。hl: "phrase" の句は語モードでも句でハイライトする（D-039）
   - 音の遅れの補正（Bluetooth など）は、ハイライトの判定だけを遅らせる
   - 作品ページ（data-view="work"）では「続きから」のリンクだけを出す
   ========================================================== */
(function () {
  'use strict';

  var C = window.LGCore;
  var SETTINGS_KEY = 'lg.settings.v1';
  var RESUME_PREFIX = 'lg.resume.v1.';

  var view = document.body.dataset.view;
  if (view === 'work') { initWorkPage(); return; }
  if (view !== 'page') return;

  // 作品ページ：前回の位置へのリンク
  function initWorkPage() {
    var slug = document.body.dataset.slug;
    var r = C.storageGet(RESUME_PREFIX + slug, null);
    if (!r || !(r.s >= 1) || !(r.p >= 1) || !isFinite(r.t)) return;
    var li = document.getElementById(C.sectionId(r.s));
    if (!li || !li.classList.contains('sec-mapped')) return;
    var box = document.getElementById('resume');
    var a = document.createElement('a');
    a.href = C.pageDir(r.s, r.p) + C.hashForTime(r.t);
    var title = li.querySelector('.sec-title');
    a.textContent = '続きから（' + (title ? title.textContent : C.sectionId(r.s)) + ' ' + C.formatTime(r.t) + '）';
    box.appendChild(a);
    box.hidden = false;
  }

  // 実機デバッグ用（?debuglog=1 のときだけ）。http.server のアクセスログに残すため GET を投げる（404 でよい）
  var DEBUG_LOG = false;
  try {
    if (/[?&]debuglog=1/.test(location.search)) localStorage.setItem('lg-debuglog', '1');
    if (/[?&]debuglog=0/.test(location.search)) localStorage.removeItem('lg-debuglog');
    DEBUG_LOG = localStorage.getItem('lg-debuglog') === '1';
  } catch (e) {}
  function dlog(ev, data) {
    if (!DEBUG_LOG) return;
    var o = { ev: ev, sy: Math.round(scroller.scrollTop), ih: window.innerHeight };
    for (var k in data) o[k] = data[k];
    try { new Image().src = '/__log?' + encodeURIComponent(JSON.stringify(o)) + '&_=' + Date.now(); } catch (e) {}
  }

  var RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  var RATE_CYCLE = [0.75, 1, 1.25, 1.5, 1.75, 2];
  var MODES = ['word', 'phrase', 'sentence'];
  var FONT_MIN = 0.85, FONT_MAX = 1.6, FONT_STEP = 0.075;
  var OFFSET_MIN = -0.5, OFFSET_MAX = 1.5, OFFSET_STEP = 0.05;
  var WORD_HOLD = 0.35;      // 語と語のあいだの短い無音は直前の語を出したまま
  var PHRASE_HOLD = 1.5;     // 句と句（文と文）のあいだ
  var SEEK_LEAD = 0.05;      // タップで飛ぶとき、頭が欠けないよう少し前から
  var LOOKAHEAD = 0.06;      // ハイライトは少しだけ先の時刻で判定する（描画の遅れと SEEK_LEAD を相殺）
  var INTRO_LEAD = 0.5;      // 前口上を飛ばすとき、本文の何秒前から
  var SKIP_SEC = 10;
  var LONG_PRESS_MS = 500;
  var MOVE_TOLERANCE = 10;   // px。これ以上動いたら長押しではなくスクロール
  var TAP_HIT_MAX_MS = 1000; // pointerdown で覚えた語を click で使う猶予
  var PREFETCH_SEC = 30;     // ページ末尾の何秒前から次のページを先読みするか

  var DEFAULTS = {
    mode: 'word',      // 'word' | 'phrase' | 'sentence'
    rate: 1,
    fontScale: 1,
    theme: 'auto',     // 'auto' | 'light' | 'dark'
    offset: 0,         // 秒。音が耳に届くまでの遅れ（正ならハイライトを遅らせる）
    follow: true,      // 自動スクロール
    autoNext: true,    // 章の終わりで次の章へ
    skipIntro: false,  // 章の頭（1 ページ目）を本文の始まりから再生する
    debug: false,
  };

  function $(id) { return document.getElementById(id); }
  var audio = $('audio');
  var transcript = $('transcript');
  var bar = $('bar');
  var scroller = $('scroller') || document.scrollingElement;

  var S = {
    settings: null,
    slug: document.body.dataset.slug,
    workBase: new URL('../../', location.href).href.replace(/#.*$/, ''),
    work: null,
    sIdx: 0,
    pIdx: 0,
    page: null,
    tl: null,
    nonIndex: null,
    wordEls: [],
    phraseEls: [],
    sentenceEls: [],
    nonEls: [],
    darkEls: [],
    active: { word: -1, phrase: -1, sentence: -1, non: -1, dark: -1 },
    lastFollowEl: null,
    pendingSeek: null,
    verifySeek: null,
    srcUrl: null,
    followPaused: false,
    loading: false,
    loadToken: 0,
    failedHref: null,
    pageCache: {},
    raf: 0,
    dragging: false,
    lastSave: 0,
    lastPosState: 0,
    lp: null,
    tap: null,
    suppressClickUntil: 0,
    sheetOpenedAt: 0,
    sheetTarget: null,
  };

  // ── 設定 ─────────────────────────────────────────────
  function loadSettings() {
    var saved = C.storageGet(SETTINGS_KEY, {});
    S.settings = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    if (MODES.indexOf(S.settings.mode) < 0) S.settings.mode = DEFAULTS.mode;
    S.settings.offset = C.clampOffset(S.settings.offset, OFFSET_MIN, OFFSET_MAX);
  }

  function saveSettings() {
    C.storageSet(SETTINGS_KEY, S.settings);
  }

  function applySettings() {
    var st = S.settings;
    MODES.forEach(function (m) { document.body.classList.toggle('mode-' + m, st.mode === m); });
    document.body.classList.toggle('debug', !!st.debug);
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode));
    });
    if (st.theme === 'light' || st.theme === 'dark') document.documentElement.setAttribute('data-theme', st.theme);
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('[data-theme-opt]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.themeOpt === st.theme);
    });
    document.documentElement.style.setProperty('--font-scale', String(st.fontScale));
    $('font-value').textContent = Math.round(st.fontScale * 100) + '%';
    $('offset-value').textContent = fmtOffset(st.offset);
    audio.playbackRate = st.rate;
    audio.defaultPlaybackRate = st.rate;
    $('rate').textContent = fmtRate(st.rate);
    document.querySelectorAll('#rate-chips .chip').forEach(function (b) {
      b.classList.toggle('on', Number(b.dataset.rate) === st.rate);
    });
    $('opt-follow').checked = !!st.follow;
    $('opt-autonext').checked = !!st.autoNext;
    $('opt-skipintro').checked = !!st.skipIntro;
    $('opt-debug').checked = !!st.debug;
  }

  function setSetting(key, value) {
    S.settings[key] = value;
    saveSettings();
    applySettings();
  }

  function fmtRate(r) {
    return (Math.round(r * 100) / 100) + '×';
  }

  function fmtOffset(v) {
    return (v > 0 ? '+' : '') + v.toFixed(2) + ' 秒';
  }

  // ── データの取得 ─────────────────────────────────────
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return r.json();
    });
  }

  function getPage(sIdx, pIdx) {
    var url = S.workBase + S.work.sections[sIdx].pages[pIdx].href;
    if (!S.pageCache[url]) {
      S.pageCache[url] = fetchJson(url).catch(function (e) {
        delete S.pageCache[url];
        throw e;
      });
    }
    return S.pageCache[url];
  }

  function curSection() {
    return S.work.sections[S.sIdx];
  }

  function hasPages(sec) {
    return sec && sec.status === 'mapped' && sec.pages && sec.pages.length > 0;
  }

  // dir の向きで、ページのある次のセクション（無ければ -1）
  function publishedFrom(sIdx, dir) {
    for (var i = sIdx + dir; i >= 0 && i < S.work.sections.length; i += dir) {
      if (hasPages(S.work.sections[i])) return i;
    }
    return -1;
  }

  // セクションの頭から再生するときの位置（前口上を飛ばす設定なら本文の少し前）
  function sectionStart(sec) {
    var p0 = sec.pages[0];
    if (S.settings.skipIntro && p0.text_start != null && isFinite(p0.text_start)) return Math.max(p0.start, p0.text_start - INTRO_LEAD);
    return p0.start;
  }

  // ── 音声 ─────────────────────────────────────────────
  // セクションの音声を設定する。最初の位置はメディアフラグメント（#t=）でも渡す
  // （iOS で 0 秒から一瞬鳴ってから飛ぶのを避けるため）。loadedmetadata でも念のため合わせる。
  function setSource(sIdx, t) {
    S.sIdx = sIdx;
    var sec = curSection();
    updateMediaMetadata();
    if (S.srcUrl === sec.audio_url && audio.readyState >= 1) {
      seekTo(t); // 同じ音声なら読み込み直さない
      return;
    }
    S.srcUrl = sec.audio_url;
    audio.src = sec.audio_url + '#t=' + Math.max(0, t).toFixed(2);
    audio.playbackRate = S.settings.rate;
    S.pendingSeek = Math.max(0, t);
    S.verifySeek = S.pendingSeek;
  }

  function now() {
    return S.pendingSeek !== null ? S.pendingSeek : audio.currentTime;
  }

  function seekTo(t) {
    t = Math.max(0, t);
    if (audio.readyState >= 1) {
      try {
        audio.currentTime = t;
        S.pendingSeek = null;
      } catch (e) {
        S.pendingSeek = t;
      }
    } else {
      S.pendingSeek = t;
    }
    S.verifySeek = t;
    tick();
  }

  // ユーザー操作（click など）の中から同期的に呼ぶこと。iOS は操作起点でないと再生できない
  function play() {
    var p;
    try {
      audio.playbackRate = S.settings.rate;
      p = audio.play();
    } catch (e) {
      onPlayError(e);
      return;
    }
    if (p && typeof p.catch === 'function') p.catch(onPlayError);
  }

  function onPlayError(e) {
    if (e && e.name === 'AbortError') return; // src の切り替えで中断されただけ
    if (e && e.name === 'NotAllowedError') {
      showBanner('再生にはタップが必要です。', '▶ 再生', function () { hideBanner(); play(); });
      return;
    }
    showBanner('再生できませんでした（' + (e && e.message ? e.message : e) + '）', '再試行', function () {
      hideBanner(); audio.load(); play();
    });
  }

  function togglePlay() {
    if (audio.paused) play();
    else audio.pause();
  }

  function setupAudio() {
    audio.addEventListener('loadedmetadata', function () {
      if (S.pendingSeek !== null) {
        var t = S.pendingSeek;
        S.pendingSeek = null;
        try { audio.currentTime = t; } catch (e) { /* 次の canplay で再試行 */ S.pendingSeek = t; }
      }
      audio.playbackRate = S.settings.rate;
      tick();
    });
    audio.addEventListener('canplay', function () {
      if (S.pendingSeek !== null) {
        var t = S.pendingSeek;
        S.pendingSeek = null;
        try { audio.currentTime = t; } catch (e) {}
      }
    });
    // iOS ではシーク直後の play で 0 秒に戻ることがあるので、再生開始時に確かめる
    audio.addEventListener('playing', function () {
      setBusy(false);
      if (S.verifySeek !== null && Math.abs(audio.currentTime - S.verifySeek) > 1.5) {
        try { audio.currentTime = S.verifySeek; } catch (e) {}
      }
      S.verifySeek = null;
    });
    audio.addEventListener('seeked', function () {
      if (S.verifySeek !== null && Math.abs(audio.currentTime - S.verifySeek) < 1.5) S.verifySeek = null;
      tick();
    });
    audio.addEventListener('play', function () {
      setPlayIcon(true);
      startLoop();
    });
    audio.addEventListener('pause', function () {
      setPlayIcon(false);
      setBusy(false);
      saveResume(true);
      tick();
    });
    audio.addEventListener('waiting', function () { setBusy(true); });
    audio.addEventListener('stalled', function () { if (!audio.paused) setBusy(true); });
    audio.addEventListener('timeupdate', function () {
      // 画面ロック中やバックグラウンドでは rAF が止まるので、timeupdate で補う
      if (!S.raf || document.hidden) tick();
    });
    audio.addEventListener('ratechange', function () {
      // iOS は src の切り替えで playbackRate が戻ることがある
      if (Math.abs(audio.playbackRate - S.settings.rate) > 0.001 && !audio.paused) audio.playbackRate = S.settings.rate;
    });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', function () {
      var code = audio.error ? audio.error.code : 0;
      showBanner('音声を読み込めませんでした（code ' + code + '）。archive.org が一時的に不調かもしれません。', '再試行', function () {
        hideBanner();
        var t = now();
        S.srcUrl = null;
        setSource(S.sIdx, t);
        play();
      });
    });
  }

  function onEnded() {
    setPlayIcon(false);
    var next = publishedFrom(S.sIdx, 1);
    if (!S.settings.autoNext || next < 0) return;
    gotoSection(next, { page: 0, play: true });
  }

  function startLoop() {
    if (!S.raf) S.raf = requestAnimationFrame(loop);
  }

  function loop() {
    S.raf = 0;
    tick();
    if (!audio.paused && !document.hidden) S.raf = requestAnimationFrame(loop);
  }

  // ── 毎フレームの処理 ─────────────────────────────────
  function tick() {
    if (!S.work || !S.page) return;
    var t = now();
    var sec = curSection();
    // 表示ページは補正前の時刻で決める（ページの頭へシークした直後に前のページへ戻らないように）
    var want = C.pageForTime(sec.pages, t);
    if (want >= 0 && want !== S.pIdx && !S.loading) {
      var href = sec.pages[want].href;
      if (S.failedHref !== href) loadPage(S.sIdx, want, { auto: true });
    }
    if (!S.loading) updateHighlight(t);
    updateSeekUI(t);
    // 次のページを先読み
    var pm = sec.pages[S.pIdx];
    if (pm && S.pIdx + 1 < sec.pages.length && t > pm.end - PREFETCH_SEC) getPage(S.sIdx, S.pIdx + 1).catch(function () {});
    if (!audio.paused) saveResume(false);
    updatePositionState(false);
  }

  // ── ページの読み込みと描画 ───────────────────────────
  function loadPage(sIdx, pIdx, opts) {
    opts = opts || {};
    var token = ++S.loadToken;
    S.loading = true;
    var href = S.work.sections[sIdx].pages[pIdx].href;
    return getPage(sIdx, pIdx).then(function (page) {
      if (token !== S.loadToken) return;
      S.failedHref = null;
      var same = transcript.dataset.page === page.page.id;
      S.page = page;
      S.pIdx = pIdx;
      S.tl = C.buildTimeline(page);
      S.nonIndex = C.buildIndex((page.non_text || []).map(function (r) { return { t0: r.t0, t1: r.t1 }; }));
      render(same);
      updateHeader();
      if (!opts.initial) updateUrl();
      S.loading = false;
      S.active = { word: -1, phrase: -1, sentence: -1, non: -1, dark: -1 };
      S.lastFollowEl = null;
      // 新しいページは先頭から表示し、自動スクロールが有効ならハイライト位置まで追従させる
      if (!same) scroller.scrollTop = 0;
      tick();
    }).catch(function (e) {
      if (token !== S.loadToken) return;
      S.loading = false;
      S.failedHref = href;
      showBanner('ページを読み込めませんでした（' + e.message + '）', '再試行', function () {
        hideBanner();
        S.failedHref = null;
        loadPage(sIdx, pIdx, opts);
      });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 本文は build 段が埋め込んだもの（same）か、ページ JSON から同じ規則で作ったもの
  function render(same) {
    if (!same) {
      transcript.innerHTML = C.renderTranscript(S.page);
      transcript.dataset.page = S.page.page.id;
    }
    S.wordEls = collect('.w', 'w');
    S.phraseEls = collect('.ph', 'c');
    S.sentenceEls = collect('.sn', 's');
    S.nonEls = collect('.nt', 'nt');
    S.darkEls = collect('.dk', 'dk');   // 原本に無い歌の ♪ の印（D-122）
    // 検証表示用：時刻の無い語（na）と補間した語（ip）
    var tw = S.tl.words;
    for (var i = 0; i < tw.length; i++) {
      var e = S.wordEls[i];
      if (!e || tw[i].aligned) continue;
      e.classList.add(tw[i].interp ? 'ip' : 'na');
    }
    renderCredit();
  }

  function collect(sel, key) {
    var out = [];
    transcript.querySelectorAll(sel).forEach(function (e) { out[Number(e.dataset[key])] = e; });
    return out;
  }

  function renderCredit() {
    var c = $('credit');
    var w = S.work.work, sec = curSection();
    c.textContent = '';
    c.appendChild(document.createTextNode('音声: LibriVox（パブリックドメイン）、朗読 ' + (sec.reader || '?') + '。archive.org から直接再生しています。 '));
    if (w.librivox_url) {
      var a = el('a', null, 'LibriVox のページ');
      a.href = w.librivox_url; a.target = '_blank'; a.rel = 'noopener';
      c.appendChild(a);
    }
    if (w.gutenberg_id) {
      c.appendChild(document.createTextNode(' ／ テキスト: '));
      var g = el('a', null, 'Project Gutenberg #' + w.gutenberg_id);
      g.href = 'https://www.gutenberg.org/ebooks/' + encodeURIComponent(w.gutenberg_id); g.target = '_blank'; g.rel = 'noopener';
      c.appendChild(g);
    }
  }

  // ページ移動の行き先（[セクションの添字, ページの添字]。無ければ null）
  function navTarget(kind) {
    var sec = curSection();
    var ps = publishedFrom(S.sIdx, -1), ns = publishedFrom(S.sIdx, 1);
    if (kind === 'prev-page') {
      if (S.pIdx > 0) return [S.sIdx, S.pIdx - 1];
      return ps >= 0 ? [ps, S.work.sections[ps].pages.length - 1] : null;
    }
    if (kind === 'next-page') {
      if (S.pIdx + 1 < sec.pages.length) return [S.sIdx, S.pIdx + 1];
      return ns >= 0 ? [ns, 0] : null;
    }
    if (kind === 'prev-section') return ps >= 0 ? [ps, 0] : null;
    if (kind === 'next-section') return ns >= 0 ? [ns, 0] : null;
    return null;
  }

  function pageHref(sIdx, pIdx) {
    return S.workBase + C.pageDir(S.work.sections[sIdx].index, pIdx + 1);
  }

  function updateHeader() {
    var w = S.work.work, sec = curSection();
    $('hdr-work').textContent = w.title + ' — ' + w.author;
    $('hdr-section').textContent = sec.title;
    $('hdr-page').textContent = 'p.' + (S.pIdx + 1) + '/' + sec.pages.length;
    document.title = sec.title + ' p.' + (S.pIdx + 1) + ' — ' + w.title;
    document.body.dataset.section = String(sec.index);
    document.body.dataset.page = String(S.pIdx + 1);
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var tgt = navTarget(a.dataset.nav);
      if (tgt) { a.href = pageHref(tgt[0], tgt[1]); a.removeAttribute('aria-disabled'); }
      else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
    });
  }

  function pageUrl(t) {
    return pageHref(S.sIdx, S.pIdx) + C.hashForTime(t);
  }

  function updateUrl() {
    try { history.replaceState(null, '', pageUrl(null)); } catch (e) {}
  }

  // ── ハイライト ───────────────────────────────────────
  function setActive(kind, els, idx) {
    var prev = S.active[kind];
    if (prev === idx) return false;
    if (prev >= 0 && els[prev]) els[prev].classList.remove('on');
    if (idx >= 0 && els[idx]) els[idx].classList.add('on');
    S.active[kind] = idx;
    return true;
  }

  function updateHighlight(t) {
    var tl = S.tl;
    var mode = S.settings.mode;
    var te = C.effectiveTime(t, LOOKAHEAD, S.settings.offset);
    var ci = C.findActive(tl.phraseIndex, te, PHRASE_HOLD);
    var si = mode === 'sentence' ? C.findActive(tl.sentenceIndex, te, PHRASE_HOLD) : -1;
    var wi = mode === 'word' ? C.findActive(tl.wordIndex, te, WORD_HOLD) : -1;
    if (wi >= 0 && tl.words[wi].hlp) wi = -1; // hl: "phrase" の句は句でハイライトする（CSS の .hlp）
    var dk = C.findActive(tl.darkIndex, te, 0);
    if (dk >= 0) ci = si = wi = -1; // 原本に無い歌の間は何も光らせず、その間の ♪ の印だけを囲む（D-122）
    var ni = C.findActive(S.nonIndex, te, 0);
    setActive('phrase', S.phraseEls, ci);
    setActive('sentence', S.sentenceEls, si);
    setActive('word', S.wordEls, wi);
    setActive('non', S.nonEls, ni);
    setActive('dark', S.darkEls, dk);
    var target = wi >= 0 ? S.wordEls[wi] : ci >= 0 ? S.phraseEls[ci] : si >= 0 ? S.sentenceEls[si] : ni >= 0 ? S.nonEls[ni] : null;
    if (target && target !== S.lastFollowEl) {
      S.lastFollowEl = target;
      follow(target, false);
    }
  }

  // ── 自動スクロール ───────────────────────────────────
  function barHeight() {
    return bar.offsetHeight || 0;
  }

  function follow(target, force) {
    if (!target) return;
    if (!force && (!S.settings.follow || S.followPaused || document.hidden)) return;
    var r = target.getBoundingClientRect();
    var top = 0, bottom = window.innerHeight - barHeight();
    var h = Math.max(100, bottom - top);
    if (!force && r.top >= top + h * 0.12 && r.bottom <= top + h * 0.7) return;
    var dy = r.top - (top + h * 0.3);
    try {
      scroller.scrollBy({ top: dy, behavior: force ? 'auto' : 'smooth' });
    } catch (e) {
      scroller.scrollTop += dy;
    }
  }

  function currentTarget() {
    var a = S.active;
    if (a.word >= 0) return S.wordEls[a.word];
    if (a.phrase >= 0) return S.phraseEls[a.phrase];
    if (a.sentence >= 0) return S.sentenceEls[a.sentence];
    if (a.non >= 0) return S.nonEls[a.non];
    if (!S.tl) return null;
    var ci = C.findNearest(S.tl.phraseIndex, now());
    return ci >= 0 ? S.phraseEls[ci] : null;
  }

  function pauseFollow() {
    if (!S.settings.follow || S.followPaused) return;
    S.followPaused = true;
    updateReturnBtn();
  }

  function resumeFollow(scroll) {
    S.followPaused = false;
    updateReturnBtn();
    if (scroll) follow(currentTarget(), true);
  }

  var returnRaf = 0;
  function updateReturnBtn() {
    var btn = $('return-btn');
    if (!S.followPaused) { btn.hidden = true; return; }
    var t = currentTarget();
    btn.hidden = false;
    if (t) {
      var r = t.getBoundingClientRect();
      var visible = r.bottom > 0 && r.top < window.innerHeight - barHeight();
      btn.textContent = (visible ? '' : r.top < 0 ? '↑ ' : '↓ ') + '現在位置に戻る';
    }
  }

  function inChrome(target) {
    return !!(target && target.closest && target.closest('.bar, .sheet, .sheet-backdrop, .return-btn, .top, .pager'));
  }

  // ── UI の結線 ────────────────────────────────────────
  function bindUI() {
    $('play').addEventListener('click', togglePlay);
    $('back').addEventListener('click', function () { skip(-SKIP_SEC); });
    $('fwd').addEventListener('click', function () { skip(SKIP_SEC); });
    $('rate').addEventListener('click', function () {
      var i = RATE_CYCLE.indexOf(S.settings.rate);
      var next = RATE_CYCLE[(i + 1) % RATE_CYCLE.length];
      setSetting('rate', next);
      toast('再生速度 ' + fmtRate(next));
    });
    $('menu-btn').addEventListener('click', function () { openSheet('settings-sheet'); });

    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        setSetting('mode', b.dataset.mode);
        S.lastFollowEl = null;
        if (S.tl) updateHighlight(now());
      });
    });
    var chips = $('rate-chips');
    RATES.forEach(function (r) {
      var b = el('button', 'chip', fmtRate(r));
      b.type = 'button';
      b.dataset.rate = String(r);
      b.addEventListener('click', function () { setSetting('rate', r); });
      chips.appendChild(b);
    });
    $('font-dec').addEventListener('click', function () { changeFont(-FONT_STEP); });
    $('font-inc').addEventListener('click', function () { changeFont(FONT_STEP); });
    $('offset-dec').addEventListener('click', function () { changeOffset(-OFFSET_STEP); });
    $('offset-inc').addEventListener('click', function () { changeOffset(OFFSET_STEP); });
    $('offset-reset').addEventListener('click', function () { changeOffset(null); });
    document.querySelectorAll('[data-theme-opt]').forEach(function (b) {
      b.addEventListener('click', function () { setSetting('theme', b.dataset.themeOpt); });
    });
    $('opt-follow').addEventListener('change', function () {
      setSetting('follow', this.checked);
      if (this.checked) resumeFollow(true); else { S.followPaused = false; updateReturnBtn(); }
    });
    $('opt-autonext').addEventListener('change', function () { setSetting('autoNext', this.checked); });
    $('opt-skipintro').addEventListener('change', function () { setSetting('skipIntro', this.checked); });
    $('opt-debug').addEventListener('change', function () { setSetting('debug', this.checked); });
    $('report-current').addEventListener('click', function () {
      closeSheets();
      if (!S.tl || !S.tl.phrases.length) return;
      var ci = S.active.phrase >= 0 ? S.active.phrase : C.findNearest(S.tl.phraseIndex, now());
      if (ci < 0) ci = 0;
      openActionSheet({ ci: ci, wi: S.active.word, ni: -1 });
    });

    // ページ・章の移動（リンクは JS が無くても動く。JS では音声を止めずに移る）
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return; // 新しいタブなどはブラウザに任せる
        e.preventDefault();
        if (S.work) navigate(a.dataset.nav);
      });
    });

    // シーク
    var seek = $('seek');
    seek.addEventListener('input', function () {
      S.dragging = true;
      var pm = curSection().pages[S.pIdx];
      var t = pm.start + (seek.value / 1000) * (pm.end - pm.start);
      $('time').textContent = C.formatTime(t - pm.start) + ' / ' + C.formatTime(pm.end - pm.start);
    });
    seek.addEventListener('change', function () {
      var pm = curSection().pages[S.pIdx];
      S.dragging = false;
      seekTo(pm.start + (seek.value / 1000) * (pm.end - pm.start));
      resumeFollow(true);
    });

    // 本文：タップで再生、長押し・右クリックで操作シート
    transcript.addEventListener('click', onTranscriptClick);
    transcript.addEventListener('pointerdown', onPointerDown);
    transcript.addEventListener('pointermove', onPointerMove);
    // 長押しでシートが開いたあと指を離す位置はシートの上なので、window で受ける
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', clearLongPress);
    transcript.addEventListener('contextmenu', function (e) {
      var hit = hitTest(e.target);
      if (!hit || hit.ci < 0) return;
      e.preventDefault();
      if (S.lp && S.lp.fired) return; // タイマー側で開いた
      clearLongPress();
      openActionSheet(hit);
    });

    // シート
    $('sheet-backdrop').addEventListener('click', function () {
      // 長押しを離したときのクリックで閉じない
      if (performance.now() - S.sheetOpenedAt < 450 || performance.now() < S.suppressClickUntil) return;
      closeSheets();
    });
    document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeSheets); });
    $('as-play-phrase').addEventListener('click', function () {
      var h = S.sheetTarget; closeSheets();
      if (h) startFrom({ ci: h.ci, wi: -1, ni: -1 }, 'phrase');
    });
    $('as-play-word').addEventListener('click', function () {
      var h = S.sheetTarget; closeSheets();
      if (h) startFrom(h, 'word');
    });
    document.querySelectorAll('.sheet-report').forEach(function (a) {
      a.addEventListener('click', function () { setTimeout(closeSheets, 0); });
    });

    $('return-btn').addEventListener('click', function () { resumeFollow(true); });

    // 手動スクロールの検出（自動スクロール自体はこれらのイベントを出さない）
    window.addEventListener('touchmove', function (e) { if (!inChrome(e.target)) pauseFollow(); }, { passive: true });
    window.addEventListener('wheel', function (e) { if (!inChrome(e.target)) pauseFollow(); }, { passive: true });
    scroller.addEventListener('scroll', function () {
      if (!S.followPaused || returnRaf) return;
      returnRaf = requestAnimationFrame(function () { returnRaf = 0; updateReturnBtn(); });
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { closeSheets(); return; }
      if (e.key === ' ' && !(e.target && e.target.closest && e.target.closest('button, a'))) { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); skip(5); }
      else if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) pauseFollow();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { saveResume(true); return; }
      tick();
      if (!audio.paused) startLoop();
      if (S.settings.follow && !S.followPaused) follow(currentTarget(), false);
    });
    window.addEventListener('pagehide', function () { saveResume(true); });
    // 同じページの #t= だけを変えたリンク（再読み込みされない）でも、その位置へ移る
    window.addEventListener('hashchange', function () {
      var t = C.parseHashTime(location.hash);
      if (!S.work || !isFinite(t)) return;
      resumeFollow(false);
      seekTo(t);
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        document.documentElement.style.setProperty('--bar-h', barHeight() + 'px');
      }).observe(bar);
    }
    document.documentElement.style.setProperty('--bar-h', barHeight() + 'px');
  }

  function changeFont(delta) {
    var v = Math.round((S.settings.fontScale + delta) * 1000) / 1000;
    v = Math.max(FONT_MIN, Math.min(FONT_MAX, v));
    var anchor = currentTarget();
    setSetting('fontScale', v);
    if (anchor && S.settings.follow && !S.followPaused) follow(anchor, true);
  }

  function changeOffset(delta) {
    var v = delta === null ? 0 : C.clampOffset(S.settings.offset + delta, OFFSET_MIN, OFFSET_MAX);
    setSetting('offset', v);
    if (S.tl) updateHighlight(now());
  }

  function skip(delta) {
    var sec = curSection();
    var t = now() + delta;
    if (t < 0) t = 0;
    if (sec.duration && t > sec.duration) t = sec.duration - 0.5;
    seekTo(t);
    resumeFollow(false);
  }

  // ページと章の移動。表示ページは再生位置に従うので、移動 = そのページの先頭へシーク
  function navigate(kind) {
    var tgt = navTarget(kind);
    if (!tgt) return;
    if (tgt[0] === S.sIdx) gotoPage(tgt[1]);
    else gotoSection(tgt[0], { page: tgt[1] });
  }

  function gotoPage(pIdx) {
    var pm = curSection().pages[pIdx];
    S.followPaused = false;
    updateReturnBtn();
    if (S.pendingSeek !== null || audio.readyState < 1) S.pendingSeek = pm.start;
    else { try { audio.currentTime = pm.start; } catch (e) { S.pendingSeek = pm.start; } }
    S.verifySeek = pm.start;
    loadPage(S.sIdx, pIdx, {});
  }

  function gotoSection(sIdx, opts) {
    opts = opts || {};
    var wasPlaying = !audio.paused;
    var sec = S.work.sections[sIdx];
    var pIdx = Math.max(0, Math.min(sec.pages.length - 1, opts.page || 0));
    var t = opts.time != null ? opts.time : pIdx === 0 ? sectionStart(sec) : sec.pages[pIdx].start;
    S.followPaused = false;
    updateReturnBtn();
    setSource(sIdx, t);
    // ここは click の中から同期的に呼ばれる（ended からの自動遷移を除く）ので、play() をすぐ呼ぶ
    if (opts.play || wasPlaying) play();
    loadPage(sIdx, C.pageForTime(sec.pages, t), {});
  }

  // ── 本文のタップと長押し ─────────────────────────────
  function hitTest(target) {
    if (!target || !target.closest || !S.tl) return null;
    var nEl = target.closest('.nt');
    if (nEl) return { ci: -1, wi: -1, ni: Number(nEl.dataset.nt) };
    var wEl = target.closest('.w');
    var pEl = target.closest('.ph');
    var wi = wEl ? Number(wEl.dataset.w) : -1;
    var ci = pEl ? Number(pEl.dataset.c) : wi >= 0 ? S.tl.words[wi].ci : -1;
    if (wi < 0 && ci < 0) return null;
    return { ci: ci, wi: wi, ni: -1 };
  }

  // タップの行き先。語モードでは語の頭（hl: "phrase" の句と時刻の無い語は句の頭）、句・文モードでは句の頭
  function timeFor(hit, mode) {
    if (hit.ni >= 0) return S.page.non_text[hit.ni].t0;
    var w = hit.wi >= 0 ? S.tl.words[hit.wi] : null;
    if (mode === 'word' && w && w.t0 !== null && !w.hlp) return w.t0;
    if (hit.ci >= 0 && S.tl.phrases[hit.ci].t0 !== null) return S.tl.phrases[hit.ci].t0;
    return null;
  }

  function startFrom(hit, mode) {
    var t = timeFor(hit, mode);
    if (t === null) { toast('この位置には時刻がありません'); return; }
    dlog('start', { hitW: hit.wi, hitC: hit.ci, t: t, mode: mode, cur: audio.currentTime });
    resumeFollow(false);
    seekTo(Math.max(0, t - SEEK_LEAD));
    if (audio.paused) play();
  }

  function onTranscriptClick(e) {
    if (performance.now() < S.suppressClickUntil) { e.preventDefault(); return; }
    // click の座標は指を離した時点で判定されるため、その間にツールバーの出入りや
    // 自動スクロールで画面が動くと別の語に当たる。指が触れた瞬間の判定を優先する
    var tap = S.tap;
    S.tap = null;
    var hit = tap && performance.now() - tap.t < TAP_HIT_MAX_MS ? tap.hit : hitTest(e.target);
    dlog('click', { cx: Math.round(e.clientX), cy: Math.round(e.clientY), usedTap: !!(tap && tap.hit === hit), hitW: hit && hit.wi, hitC: hit && hit.ci });
    if (!hit) return;
    if (S.settings.debug && hit.wi >= 0) {
      var w = S.tl.words[hit.wi], para = S.page.paragraphs[w.pi];
      toast(C.wordId(para, w.li) + '  ' + (w.t0 === null ? '時刻なし' : w.t0.toFixed(2) + '–' + w.t1.toFixed(2) + (w.interp ? '（補間）' : '')) +
        (w.hlp ? '  句単位' : '') + (S.settings.offset ? '  補正 ' + fmtOffset(S.settings.offset) : ''));
    }
    startFrom(hit, S.settings.mode);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var hit = hitTest(e.target);
    clearLongPress();
    S.tap = hit ? { hit: hit, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    if (!hit || hit.ci < 0) return;
    var lp = { x: e.clientX, y: e.clientY, hit: hit, fired: false, timer: 0 };
    lp.timer = setTimeout(function () {
      lp.fired = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      openActionSheet(hit);
    }, LONG_PRESS_MS);
    S.lp = lp;
  }

  function onPointerMove(e) {
    if (S.tap && (Math.abs(e.clientX - S.tap.x) > MOVE_TOLERANCE || Math.abs(e.clientY - S.tap.y) > MOVE_TOLERANCE)) S.tap = null;
    if (!S.lp || S.lp.fired) return;
    if (Math.abs(e.clientX - S.lp.x) > MOVE_TOLERANCE || Math.abs(e.clientY - S.lp.y) > MOVE_TOLERANCE) clearLongPress();
  }

  function onPointerUp() {
    if (S.lp && S.lp.fired) S.suppressClickUntil = performance.now() + 450;
    clearLongPress();
  }

  function clearLongPress() {
    if (S.lp) clearTimeout(S.lp.timer);
    S.lp = null;
  }

  // ── シート ───────────────────────────────────────────
  function openSheet(id) {
    closeSheets();
    $('sheet-backdrop').hidden = false;
    $(id).hidden = false;
    S.sheetOpenedAt = performance.now();
    document.body.classList.add('sheet-open');
  }

  function closeSheets() {
    document.querySelectorAll('.sheet').forEach(function (s) { s.hidden = true; });
    $('sheet-backdrop').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  function openActionSheet(hit) {
    if (hit.ci < 0) return;
    var tl = S.tl;
    var ph = tl.phrases[hit.ci];
    var para = S.page.paragraphs[ph.pi];
    var phd = para.phrases[ph.cj];
    var quote = C.phraseText(para, phd);
    var w = hit.wi >= 0 ? tl.words[hit.wi] : null;
    var wordText = w ? para.words[w.li].x : null;
    S.sheetTarget = hit;

    $('as-title').textContent = 'この句' + (wordText ? '・語「' + wordText + '」' : '');
    $('as-quote').textContent = quote;
    $('as-meta').textContent = phd.id + (w ? '  /  ' + C.wordId(para, w.li) : '') + '  /  ' +
      (ph.t0 !== null ? C.formatTime(ph.t0, true) : '時刻なし') + (ph.hlp ? '  /  句単位' : '');
    $('as-play-word').hidden = !(w && w.t0 !== null && !w.hlp);

    var kinds = { text: 'as-report-text', timing: 'as-report-timing', other: 'as-report-other' };
    Object.keys(kinds).forEach(function (k) {
      $(kinds[k]).href = reportUrl(k, hit);
    });
    openSheet('action-sheet');
  }

  function reportUrl(kind, hit) {
    var tl = S.tl;
    var ph = tl.phrases[hit.ci];
    var para = S.page.paragraphs[ph.pi];
    var phd = para.phrases[ph.cj];
    var w = hit.wi >= 0 ? tl.words[hit.wi] : null;
    var time = w && w.t0 !== null ? w.t0 : ph.t0;
    var sec = curSection();
    return C.buildReportUrl({
      kind: kind,
      work: { slug: S.slug, title: S.work.work.title },
      section: { id: sec.id, index: sec.index, title: sec.title },
      page: { id: S.page.page.id, index: S.pIdx + 1, count: sec.pages.length },
      phraseId: phd.id,
      wordId: w ? C.wordId(para, w.li) : null,
      wordText: w ? para.words[w.li].x : null,
      time: time,
      text: C.phraseText(para, phd),
      pageUrl: pageUrl(time),
      userAgent: navigator.userAgent,
    });
  }

  // ── 再生バーの表示 ───────────────────────────────────
  var lastTimeText = '';
  function updateSeekUI(t) {
    var pm = curSection().pages[S.pIdx];
    if (!pm) return;
    var span = Math.max(0.001, pm.end - pm.start);
    if (!S.dragging) {
      var v = Math.round(Math.max(0, Math.min(1, (t - pm.start) / span)) * 1000);
      var seek = $('seek');
      if (Number(seek.value) !== v) seek.value = String(v);
      var txt = C.formatTime(Math.max(0, t - pm.start)) + ' / ' + C.formatTime(span);
      if (S.settings.debug) txt += '  [' + t.toFixed(2) + ']';
      if (txt !== lastTimeText) { $('time').textContent = txt; lastTimeText = txt; }
    }
  }

  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
  function setPlayIcon(playing) {
    var b = $('play');
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    b.setAttribute('aria-label', playing ? '一時停止' : '再生');
  }

  function setBusy(busy) {
    $('play').classList.toggle('busy', !!busy);
  }

  // ── バナーとトースト ─────────────────────────────────
  function showBanner(msg, actionLabel, action) {
    var b = $('banner');
    b.textContent = '';
    b.appendChild(el('span', null, msg));
    if (actionLabel) {
      var btn = el('button', 'banner-btn', actionLabel);
      btn.type = 'button';
      btn.addEventListener('click', action);
      b.appendChild(btn);
    }
    b.hidden = false;
  }

  function hideBanner() {
    $('banner').hidden = true;
  }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2500);
  }

  // ── 続きから ─────────────────────────────────────────
  function saveResume(force) {
    if (!S.work || !S.page) return;
    var n = Date.now();
    if (!force && n - S.lastSave < 5000) return;
    S.lastSave = n;
    C.storageSet(RESUME_PREFIX + S.slug, { s: curSection().index, p: S.pIdx + 1, t: Math.round(now() * 10) / 10, at: n });
  }

  // ── Media Session（ロック画面の表示と操作） ──────────
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    var handlers = {
      play: function () { play(); },
      pause: function () { audio.pause(); },
      seekbackward: function (d) { skip(-((d && d.seekOffset) || SKIP_SEC)); },
      seekforward: function (d) { skip((d && d.seekOffset) || SKIP_SEC); },
      seekto: function (d) { if (d && isFinite(d.seekTime)) seekTo(d.seekTime); },
      // previoustrack / nexttrack は設定しない（iOS では ±秒のボタンが曲送りに置き換わるため）
    };
    Object.keys(handlers).forEach(function (k) {
      try { ms.setActionHandler(k, handlers[k]); } catch (e) {}
    });
  }

  function updateMediaMetadata() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata !== 'function' || !S.work) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: curSection().title,
        artist: S.work.work.author,
        album: S.work.work.title,
      });
    } catch (e) {}
  }

  function updatePositionState(force) {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    var n = Date.now();
    if (!force && n - S.lastPosState < 5000) return;
    S.lastPosState = n;
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(d, Math.max(0, audio.currentTime)) });
    } catch (e) {}
  }

  // ── 起動 ─────────────────────────────────────────────
  function start() {
    loadSettings();
    bindUI();
    applySettings();
    setPlayIcon(false);
    setupAudio();
    setupMediaSession();

    var secIndex = Number(document.body.dataset.section);
    var pageIndex = Number(document.body.dataset.page);
    fetchJson(S.workBase + 'work.json').then(function (work) {
      S.work = work;
      var sIdx = -1;
      for (var i = 0; i < work.sections.length; i++) if (work.sections[i].index === secIndex) sIdx = i;
      if (sIdx < 0 || !hasPages(work.sections[sIdx])) throw new Error('セクション ' + secIndex + ' が work.json に無い');
      var sec = work.sections[sIdx];
      var pIdx = Math.max(0, Math.min(sec.pages.length - 1, pageIndex - 1));
      var t = C.parseHashTime(location.hash);
      if (isFinite(t)) pIdx = C.pageForTime(sec.pages, t);
      else t = pIdx === 0 ? sectionStart(sec) : sec.pages[pIdx].start;
      setSource(sIdx, t);
      return loadPage(sIdx, pIdx, { initial: pIdx === pageIndex - 1 });
    }).catch(function (e) {
      showBanner('データを読み込めませんでした（' + e.message + '）。本文は読めますが、再生とハイライトは使えません。');
    });
  }

  // テストやデバッグ用に一部を公開
  window.LGPlayer = { state: S, seekTo: seekTo, navigate: navigate, buildReport: reportUrl, updateHighlight: function () { if (S.tl) updateHighlight(now()); } };

  start();
})();
