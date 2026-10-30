/* ==========================================================
   DOM に依存しない純粋ロジック（data-format.md §6。土台は P1-7 の試作）
   - ブラウザでは window.LGCore、node では require() で読める
   - タイムライン構築（未アライメント語の補間、文、hl: "phrase"）、二分探索、
     ページ判定、時刻補正、URL、報告 URL 生成、テキスト再構成、ID 生成
   - 本文の HTML（renderTranscript）は build 段の src/lgr/build/render.py と同じ規則で作る。
     片方を変えたらもう片方も変える（tests/test_build.py が node で突き合わせる）
   ========================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LGCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REPORT_REPO = 'tomatty-na/librivox-gutenberg';
  var REPORT_LABEL = 'correction';
  var REPORT_KINDS = {
    text: 'テキストの誤り',
    timing: 'タイミングのずれ',
    other: 'その他',
  };
  // GitHub の issues/new は長すぎる URL を受け付けないことがあるので控えめにする
  var MAX_URL_LENGTH = 6000;
  var MAX_QUOTE_CHARS = 300;
  var DARK_LABEL = '原本に無い歌（本文なし）';   // ♪ の印（page.dark。D-122）。render.py と同じ
  // [[extra]] の種類ごとの文言（page.dark[].kind。D-125、D-126）。印の文字は style.css の .dk-<kind>::before
  var DARK_LABELS = { surplus: '録音の余分（本文なし）', other: '本文に無い音' };
  var DARK_EPS = 0.005;

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function num(v) {
    return isNum(v) ? v : null;
  }

  // ── ID ──────────────────────────────────────────────
  // 段落（ブロック）ID はデータに明示（例 "c01.p012"）。句 ID もデータに明示（"c01.p012.c003"）。
  // 語 ID はデータに持たず、段落 ID + 段落内の通し番号（1 始まり）から導出する。
  // 長い段落がページで分かれても、w_off で通し番号を保つので ID は変わらない。
  function wordId(para, localIndex) {
    return para.id + '.w' + pad((para.w_off || 0) + localIndex + 1, 4);
  }

  // 文 ID：句の s（ブロック内の文の添字）から（D-053）
  function sentenceId(para, s) {
    return para.id + '.s' + pad(s + 1, 2);
  }

  function sectionId(index) {
    return 's' + pad(index, 2);
  }

  function pageId(sectionIndex, pageIndex) {
    return sectionId(sectionIndex) + '.p' + pad(pageIndex, 3);
  }

  // ── URL（D-052） ─────────────────────────────────────
  // ページの HTML は <作品>/sNN/pNNN/、JSON は <作品>/sNN/pNNN.json。どちらも作品のディレクトリからの相対
  function pageDir(sectionIndex, pageIndex) {
    return sectionId(sectionIndex) + '/p' + pad(pageIndex, 3) + '/';
  }

  // "#t=123.45" → 123.45。無い・壊れていれば NaN
  function parseHashTime(hash) {
    var m = /(?:^#|[#&])t=([0-9]+(?:\.[0-9]+)?)/.exec(hash || '');
    return m ? parseFloat(m[1]) : NaN;
  }

  function hashForTime(t) {
    return isNum(t) ? '#t=' + (Math.round(t * 100) / 100) : '';
  }

  // ── 時刻補正 ─────────────────────────────────────────
  // ハイライトを判定する時刻。lookahead は描画の遅れの分だけ先を見る。
  // offset は音が耳に届くまでの遅れ（Bluetooth など）。正なら、その分だけハイライトを遅らせる
  function effectiveTime(t, lookahead, offset) {
    return t + (lookahead || 0) - (offset || 0);
  }

  function clampOffset(v, lo, hi) {
    v = Math.round(Number(v) * 100) / 100;
    if (!isFinite(v)) return 0;
    return Math.max(lo, Math.min(hi, v));
  }

  // ── テキスト再構成 ───────────────────────────────────
  // 段落（の断片）の表示テキスト = lead + Σ(x + s)
  function paragraphText(para) {
    var out = para.lead || '';
    for (var i = 0; i < para.words.length; i++) {
      out += para.words[i].x + para.words[i].s;
    }
    return out;
  }

  function phraseText(para, phrase) {
    var out = '';
    for (var i = phrase.w[0]; i < phrase.w[1]; i++) {
      out += para.words[i].x;
      if (i < phrase.w[1] - 1) out += para.words[i].s;
    }
    return out;
  }

  // ── タイムライン ─────────────────────────────────────
  // page.paragraphs から、ページ全体で通し番号の words / phrases / sentences を作る。
  // 未アライメント語（t0/t1 が null）は、同じ句の中の前後の語（無ければ句の端、
  // それも無ければページ内の前後の語）の時刻のあいだを文字数比例で埋める。
  // 埋める区間が maxInterpGap 秒を超える、または片側が無い場合は null のまま（ハイライトしない）。
  // 文は、同じ段落で s（文の添字）が同じ句の並び（D-053）。番号の振り方は renderTranscript と同じ。
  // hl: "phrase" の句（D-039、D-044）とその語には hlp: true を付ける（語モードでも句でハイライトする）。
  function buildTimeline(page, opts) {
    opts = opts || {};
    var maxInterpGap = isNum(opts.maxInterpGap) ? opts.maxInterpGap : 8;
    var words = [];
    var phrases = [];
    var sentences = [];
    var rows = [];
    var paras = page.paragraphs || [];

    for (var pi = 0; pi < paras.length; pi++) {
      var para = paras[pi];
      var base = words.length;
      for (var li = 0; li < para.words.length; li++) {
        var w = para.words[li];
        var t0 = num(w.t0), t1 = num(w.t1);
        if (t0 === null || t1 === null || t1 < t0) { t0 = null; t1 = null; }
        words.push({ pi: pi, li: li, ci: -1, t0: t0, t1: t1, aligned: t0 !== null, hlp: false, len: Math.max(1, (w.x || '').length),
                     g0: base + li, g1: base + li + 1 });
      }
      // j: 1 の語は次の語と組になり、どれかが光る間は組の語を全部光らせる（[[join]]。D-127）。g0〜g1 が組の範囲
      for (var gj = base; gj < words.length; ) {
        var ge = gj;
        while (ge < words.length - 1 && para.words[ge - base].j) ge++;
        for (var gk = gj; gk <= ge; gk++) { words[gk].g0 = gj; words[gk].g1 = ge + 1; }
        gj = ge + 1;
      }
      // 表（para.table。D-147）の行：<pre> の表は lines の 1 行、HTML の表の行は断片全体
      if (para.table && para.words.length) {
        var rs = [0];
        if (para.table === 'pre') {
          var lns = para.lines || [];
          for (var ln = 0; ln < lns.length; ln++) if (lns[ln].w > rs[rs.length - 1] && lns[ln].w < para.words.length) rs.push(lns[ln].w);
        }
        // rt0：行の光り始め（行の名を補って読む付け足しの始まり。build 段が付ける。D-148）
        for (var r = 0; r < rs.length; r++) {
          rows.push([base + rs[r], base + (r + 1 < rs.length ? rs[r + 1] : para.words.length), num(para.words[rs[r]].rt0)]);
        }
      }
      var phs = para.phrases || [];
      for (var cj = 0; cj < phs.length; cj++) {
        var ph = phs[cj];
        var gi = phrases.length;
        var p0 = num(ph.t0), p1 = num(ph.t1);
        if (p0 === null || p1 === null || p1 < p0) { p0 = null; p1 = null; }
        var hlp = ph.hl === 'phrase';
        var none = ph.hl === 'none';
        if (cj === 0 || phs[cj - 1].s !== ph.s) sentences.push({ pi: pi, s: ph.s, c0: gi, c1: gi + 1, t0: null, t1: null });
        else sentences[sentences.length - 1].c1 = gi + 1;
        phrases.push({ pi: pi, cj: cj, si: sentences.length - 1, t0: p0, t1: p1, w0: base + ph.w[0], w1: base + ph.w[1], hlp: hlp, none: none });
        for (var k = base + ph.w[0]; k < base + ph.w[1]; k++) { words[k].ci = gi; words[k].hlp = hlp; }
      }
    }

    interpolateWords(words, phrases, maxInterpGap);

    // hl: "none" の句（表の見出しなど。D-117）は、補間した時刻も消して光らせない
    for (var n = 0; n < phrases.length; n++) {
      if (!phrases[n].none) continue;
      phrases[n].t0 = phrases[n].t1 = null;
      for (var m = phrases[n].w0; m < phrases[n].w1; m++) { words[m].t0 = words[m].t1 = null; words[m].none = true; }
    }

    // 句の時刻が無ければ、語の時刻から作る
    for (var c = 0; c < phrases.length; c++) {
      var P = phrases[c];
      if (P.t0 !== null) continue;
      var a = null, b = null;
      for (var j = P.w0; j < P.w1; j++) {
        if (words[j].t0 === null) continue;
        if (a === null || words[j].t0 < a) a = words[j].t0;
        if (b === null || words[j].t1 > b) b = words[j].t1;
      }
      P.t0 = a; P.t1 = b;
    }

    // 文の時刻は句の時刻の最小・最大
    for (var si = 0; si < sentences.length; si++) {
      var S = sentences[si];
      for (var q = S.c0; q < S.c1; q++) {
        if (phrases[q].t0 === null) continue;
        if (S.t0 === null || phrases[q].t0 < S.t0) S.t0 = phrases[q].t0;
        if (S.t1 === null || phrases[q].t1 > S.t1) S.t1 = phrases[q].t1;
      }
    }

    // 表の行（D-147）：行のどれかの語に時刻があれば、行の最初の時刻から最後の時刻まで、行の語を全部光らせる
    // （時刻の無い語も含める）。語の時刻を行の時刻に置き換え、組（g0〜g1）を行にする
    for (var ri = 0; ri < rows.length; ri++) {
      var r0 = rows[ri][0], r1 = rows[ri][1], ra = null, rb = null;
      for (var rk = r0; rk < r1; rk++) {
        if (words[rk].t0 === null) continue;
        if (ra === null || words[rk].t0 < ra) ra = words[rk].t0;
        if (rb === null || words[rk].t1 > rb) rb = words[rk].t1;
      }
      if (ra === null) continue;
      if (rows[ri][2] !== null && rows[ri][2] < ra) ra = rows[ri][2];
      for (var rw = r0; rw < r1; rw++) {
        if (words[rw].none) continue;   // [[highlight]] の none は光らせないまま（player も組の中で飛ばす）
        words[rw].t0 = ra; words[rw].t1 = rb; words[rw].g0 = r0; words[rw].g1 = r1; words[rw].row = true;
      }
    }

    return {
      words: words,
      phrases: phrases,
      sentences: sentences,
      wordIndex: buildIndex(words),
      phraseIndex: buildIndex(phrases),
      sentenceIndex: buildIndex(sentences),
      // 原本に無い歌の間（page.dark。D-122）。この間はどの語・句・文も光らせない
      darkIndex: buildIndex((page.dark || []).map(function (r) { return { t0: num(r.t0), t1: num(r.t1) }; })),
    };
  }

  // t が光らせない時間（page.dark）の中か
  function inDark(tl, t) {
    return !!tl.darkIndex && findActive(tl.darkIndex, t, 0) >= 0;
  }

  function interpolateWords(words, phrases, maxGap) {
    var n = words.length;
    var i = 0;
    while (i < n) {
      if (words[i].t0 !== null) { i++; continue; }
      var j = i;
      while (j < n && words[j].t0 === null && words[j].ci === words[i].ci) j++;
      // [i, j) は同じ句に属する未アライメント語の連続
      var ph = words[i].ci >= 0 ? phrases[words[i].ci] : null;
      var a = null, b = null;
      // 左端：同じ句の直前の語 → 句の開始 → ページ内の直前の語
      if (i > 0 && words[i - 1].t1 !== null && words[i - 1].ci === words[i].ci) a = words[i - 1].t1;
      else if (ph && ph.t0 !== null) a = ph.t0;
      else if (i > 0 && words[i - 1].t1 !== null) a = words[i - 1].t1;
      // 右端：同じ句の直後の語 → 句の終了 → ページ内の直後の語
      if (j < n && words[j].t0 !== null && words[j].ci === words[i].ci) b = words[j].t0;
      else if (ph && ph.t1 !== null) b = ph.t1;
      else if (j < n && words[j].t0 !== null) b = words[j].t0;

      if (a !== null && b !== null && b >= a && b - a <= maxGap) {
        var total = 0;
        for (var k = i; k < j; k++) total += words[k].len;
        var acc = 0;
        for (var k2 = i; k2 < j; k2++) {
          words[k2].t0 = a + (b - a) * (acc / total);
          acc += words[k2].len;
          words[k2].t1 = a + (b - a) * (acc / total);
          words[k2].interp = true;
        }
      }
      i = j;
    }
  }

  // 時刻のある要素だけを t0 の昇順に並べた探索用インデックス
  function buildIndex(items) {
    var order = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].t0 !== null && items[i].t1 !== null) order.push(i);
    }
    order.sort(function (x, y) { return items[x].t0 - items[y].t0 || x - y; });
    var starts = new Float64Array(order.length);
    var ends = new Float64Array(order.length);
    var ids = new Int32Array(order.length);
    for (var k = 0; k < order.length; k++) {
      starts[k] = items[order[k]].t0;
      ends[k] = items[order[k]].t1;
      ids[k] = order[k];
    }
    return { starts: starts, ends: ends, ids: ids, length: order.length };
  }

  // t の時点でハイライトすべき要素の番号（無ければ -1）。
  // t0 <= t の最後の要素 k を二分探索で求め、t < t1 ならそれ。
  // 次の要素が始まる前の短い無音（hold 秒以内）は、直前の要素を出したままにする。
  function findActive(index, t, hold) {
    var n = index.length;
    if (!n || !isNum(t)) return -1;
    var lo = 0, hi = n - 1, k = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (index.starts[mid] <= t) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (k < 0) return -1;
    if (t < index.ends[k]) return index.ids[k];
    var nextStart = k + 1 < n ? index.starts[k + 1] : Infinity;
    if (t < nextStart && t - index.ends[k] <= (hold || 0)) return index.ids[k];
    return -1;
  }

  // t 以前に始まった最後の要素（無ければ最初の要素）。報告対象の選択などに使う
  function findNearest(index, t) {
    var n = index.length;
    if (!n) return -1;
    var lo = 0, hi = n - 1, k = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (index.starts[mid] <= t) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return index.ids[k];
  }

  // セクション内のページ一覧（start 昇順）から、時刻 t を含むページの番号（0 始まり）
  // ページの隙間にいる場合は直前のページ。最初のページより前なら 0。
  function pageForTime(pages, t) {
    if (!pages || !pages.length) return -1;
    var lo = 0, hi = pages.length - 1, k = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (pages[mid].start <= t) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return k;
  }

  // ── 時刻の表示 ───────────────────────────────────────
  function formatTime(sec, frac) {
    if (!isNum(sec)) return '--:--';
    var neg = sec < 0;
    sec = Math.abs(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = frac ? s.toFixed(2) : String(Math.floor(s));
    if (frac && s < 10) ss = '0' + ss; else if (!frac) ss = pad(ss, 2);
    var out = (h ? h + ':' + pad(m, 2) : String(m)) + ':' + ss;
    return (neg ? '-' : '') + out;
  }

  // ── 本文の HTML ──────────────────────────────────────
  // ページ JSON（data-format.md §6.3）から本文の HTML 文字列を作る。build 段が静的 HTML に
  // 埋め込むものと 1 文字も違わないこと（render.py の render_transcript と同じ規則）。
  //   段落 <p|h2 class="para k-<kind>"> > 文 <span class="sn" data-s> > 句 <span class="ph" data-c> > 語 <span class="w" data-w>
  //   data-s / data-c / data-w はページ内の通し番号（buildTimeline の sentences / phrases / words と同じ）
  //   句の最後の語の区切りは句（と文）の外に出す。区切りの "\n" は <br>
  //   本文の無い区間（前口上など）は、時刻の順で段落のあいだに置く
  var STYLE_MARKS = ['i', 'b', 'sc', 'u'];
  var NOTE_CONT_PREV = '↑ 前のページから続く段落';
  var NOTE_CONT_NEXT = '段落は次のページに続く ↓';

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return escHtml(s).replace(/"/g, '&quot;');
  }

  function textHtml(s) {
    if (!s) return '';
    var parts = String(s).split('\n');
    for (var i = 0; i < parts.length; i++) parts[i] = escHtml(parts[i]);
    return parts.join('<br>');
  }

  function stClasses(st) {
    if (!st) return [];
    return String(st).split(' ').filter(function (x) { return x; });
  }

  // 語の表示（語の一部だけにかかる書式 marks を <span class="st-*"> で包む）
  function wordInner(x, a, marks, whole) {
    var z = a + x.length;
    var cuts = [a, z];
    var hits = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (STYLE_MARKS.indexOf(m[2]) < 0 || whole.indexOf(m[2]) >= 0) continue;
      if (!(m[0] < z && a < m[1])) continue;
      hits.push(m);
      if (m[0] > a) cuts.push(m[0]);
      if (m[1] < z) cuts.push(m[1]);
    }
    if (!hits.length) return escHtml(x);
    cuts.sort(function (p, q) { return p - q; });
    var out = '';
    for (var k = 0; k + 1 < cuts.length; k++) {
      var p0 = cuts[k], p1 = cuts[k + 1];
      if (p1 <= p0) continue;
      var seg = escHtml(x.slice(p0 - a, p1 - a));
      var st = [];
      for (var h = 0; h < hits.length; h++) {
        if (hits[h][0] <= p0 && p1 <= hits[h][1] && st.indexOf(hits[h][2]) < 0) st.push(hits[h][2]);
      }
      st.sort(function (u, v) { return STYLE_MARKS.indexOf(u) - STYLE_MARKS.indexOf(v); });
      out += st.length ? '<span class="st-' + st.join(' st-') + '">' + seg + '</span>' : seg;
    }
    return out;
  }

  function fmtNum(v) {
    return String(v);
  }

  // 段落の最初の時刻（句の t0 の最小。無ければ null）。本文の無い区間を置く位置に使う
  function paragraphStart(para) {
    var best = null;
    var phs = para.phrases || [];
    for (var i = 0; i < phs.length; i++) {
      if (isNum(phs[i].t0) && (best === null || phs[i].t0 < best)) best = phs[i].t0;
    }
    return best;
  }

  function nonTextHtml(r, i) {
    return '<div class="nt" data-nt="' + i + '">♪ ' + escHtml(r.label || r.kind) + '（' + formatTime(r.t0) + '–' +
      formatTime(r.t1) + '・本文なし）</div>';
  }

  // 光らせない時間（page.dark。D-122）ごとに、♪ の印を置く語（ページ内の通し番号）→ dark の添字の配列。
  // 印は、その区間より前に終わる最後の語の後ろ（区切りの後）。そういう語がページに無ければ -1（最初の語の前）。
  // render.py の dark_anchors と同じ規則
  function darkAnchors(page) {
    var words = [];
    var paras = page.paragraphs || [];
    for (var p = 0; p < paras.length; p++) for (var q = 0; q < paras[p].words.length; q++) words.push(paras[p].words[q]);
    var out = {};
    var darks = page.dark || [];
    for (var k = 0; k < darks.length; k++) {
      var at = -1;
      for (var i = 0; i < words.length; i++) {
        if (isNum(words[i].t1) && words[i].t1 <= darks[k].t0 + DARK_EPS) at = i;
      }
      (out[at] = out[at] || []).push(k);
    }
    return out;
  }

  function darkHtml(k, kind) {
    var label = kind ? (DARK_LABELS[kind] || DARK_LABEL) : DARK_LABEL;
    var cls = kind ? 'dk dk-' + escAttr(kind) : 'dk';
    return '<span class="' + cls + '" data-dk="' + k + '" role="img" aria-label="' + label + '" title="' + label + '"></span>';
  }

  function renderTranscript(page) {
    var out = [];
    var nts = page.non_text || [];
    var nk = 0;
    var gw = 0, gc = 0, gs = 0;
    var darks = darkAnchors(page);
    function pushDark(at) {
      var ks = darks[at] || [];
      for (var d = 0; d < ks.length; d++) out.push(darkHtml(ks[d], (page.dark[ks[d]] || {}).kind));
    }
    function flush(before) {
      while (nk < nts.length && (before === null || nts[nk].t0 <= before)) {
        out.push(nonTextHtml(nts[nk], nk));
        nk++;
      }
    }
    var paras = page.paragraphs || [];
    // 時刻の無い段落（読まれなかった見出しなど）は、後ろの段落の時刻で並べる（前口上を章の見出しより前に置く）
    var starts = new Array(paras.length);
    var next = null;
    for (var b = paras.length - 1; b >= 0; b--) {
      var st0 = paragraphStart(paras[b]);
      if (st0 !== null) next = st0;
      starts[b] = next;
    }
    function tableOf(i) {
      return i >= 0 && i < paras.length && paras[i].cell ? paras[i].cell.t : null;
    }
    for (var pi = 0; pi < paras.length; pi++) {
      var para = paras[pi];
      if (starts[pi] !== null) flush(starts[pi]);
      var cell = para.cell;
      // 原本の表（Robinson の Evil / Good）は、セルを行の順に並べたグリッドにする（D-117）
      if (cell && cell.t !== tableOf(pi - 1)) out.push('<div class="tbl" style="--cols:' + Math.floor(cell.n) + '">');
      var kind = para.kind || 'para';
      if (para.break_before && !para.cont_prev) out.push('<hr class="brk brk-' + escAttr(para.break_before) + '">');
      if (para.cont_prev) out.push('<div class="cont-note">' + NOTE_CONT_PREV + '</div>');
      var tag = kind === 'heading' ? 'h2' : 'p';
      // 表（D-147）は tb と tb-<row|pre>。<pre> の表は等幅で、列の空白（語の sp、lead_sp）をそのまま出す
      var cls = 'para k-' + kind + (para.role ? ' r-' + para.role : '') + (para.align ? ' a-' + para.align : '') +
        (para.table ? ' tb tb-' + para.table : '') +
        (para.cont_prev ? ' cont-prev' : '') +
        (para.cont_next ? ' cont-next' : '');
      out.push('<' + tag + ' class="' + escAttr(cls) + '" id="' + escAttr(para.id + (para.w_off ? '-' + para.w_off : '')) + '">');
      out.push(textHtml(para.lead_sp !== undefined ? para.lead_sp : para.lead));

      var phs = para.phrases || [];
      var phStart = {};
      for (var j = 0; j < phs.length; j++) phStart[phs[j].w[0]] = j;
      var indent = {};
      var lines = para.lines || [];
      for (var l = 0; l < lines.length; l++) if (lines[l].indent) indent[lines[l].w] = lines[l].indent;
      var marks = para.marks || [];
      var off = (para.x_off || 0) + (para.lead || '').length;
      var cur = -1;
      for (var li = 0; li < para.words.length; li++) {
        var w = para.words[li];
        if (gw === 0) pushDark(-1);
        if (phStart[li] !== undefined) {
          cur = phStart[li];
          var ph = phs[cur];
          if (cur === 0 || phs[cur - 1].s !== ph.s) { out.push('<span class="sn" data-s="' + gs + '">'); gs++; }
          out.push('<span class="ph' + (ph.hl === 'phrase' ? ' hlp' : '') + '" data-c="' + (gc + cur) + '">');
        }
        if (indent[li] !== undefined) out.push('<span class="ind" style="width:' + fmtNum(indent[li]) + 'em"></span>');
        var whole = stClasses(w.st);
        out.push('<span class="' + (whole.length ? 'w st-' + whole.join(' st-') : 'w') + '" data-w="' + gw + '">' +
          wordInner(w.x, off, marks, whole) + '</span>');
        off += w.x.length + w.s.length;
        gw++;
        if (cur >= 0 && li === phs[cur].w[1] - 1) {
          out.push('</span>');
          if (cur === phs.length - 1 || phs[cur + 1].s !== phs[cur].s) out.push('</span>');
          cur = -1;
        }
        out.push(textHtml(w.sp !== undefined ? w.sp : w.s));
        pushDark(gw - 1);
      }
      gc += phs.length;
      out.push('</' + tag + '>');
      if (para.cont_next) out.push('<div class="cont-note">' + NOTE_CONT_NEXT + '</div>');
      if (cell && cell.t !== tableOf(pi + 1)) out.push('</div>');
    }
    flush(null);
    return out.join('');
  }

  // ── 報告 URL ────────────────────────────────────────
  function truncate(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  // info: { kind, work:{slug,title}, section:{id,index,title}, page:{id,index,count},
  //         phraseId, wordId, wordText, time, text, pageUrl, userAgent }
  // 本文の末尾の <!-- lg-report {json} --> は data-format.md §6.6 の形（page はページ ID "s01.p002"）
  function buildReportUrl(info, opts) {
    opts = opts || {};
    var repo = opts.repo || REPORT_REPO;
    var label = opts.label === undefined ? REPORT_LABEL : opts.label;
    var kind = REPORT_KINDS[info.kind] ? info.kind : 'other';
    var quoteMax = opts.quoteMax || MAX_QUOTE_CHARS;

    for (var attempt = 0; attempt < 6; attempt++) {
      var title = '[' + REPORT_KINDS[kind] + '] ' + info.work.slug + ' ' + info.section.id +
        ' p' + info.page.index + ' ' + (info.phraseId || '');
      var quote = truncate(info.text, quoteMax);
      var meta = {
        v: 1,
        kind: kind,
        work: info.work.slug,
        section: info.section.id,
        page: info.page.id || pageId(info.section.index, info.page.index),
        phrase: info.phraseId || null,
        word: info.wordId || null,
        time: isNum(info.time) ? Math.round(info.time * 100) / 100 : null,
        url: info.pageUrl || null,
      };
      var lines = [
        '### 内容',
        '<!-- 何がおかしいかを書いてください（正しい表記、ずれの大きさなど） -->',
        '',
        '',
        '### 位置（自動入力）',
        '- 種類: ' + REPORT_KINDS[kind],
        '- 作品: ' + info.work.slug + (info.work.title ? '（' + info.work.title + '）' : ''),
        '- セクション: ' + info.section.id + (info.section.title ? '（' + info.section.title + '）' : ''),
        '- ページ: ' + info.page.index + (info.page.count ? ' / ' + info.page.count : ''),
        '- 句ID: `' + (info.phraseId || '-') + '`',
      ];
      if (info.wordId) lines.push('- 語ID: `' + info.wordId + '`' + (info.wordText ? '（' + truncate(info.wordText, 60) + '）' : ''));
      lines.push('- 時刻: ' + (isNum(info.time) ? formatTime(info.time, true) + '（' + meta.time + ' 秒）' : '-'));
      lines.push('- 句テキスト: ' + (quote ? '"' + quote + '"' : '-'));
      lines.push('- ページURL: ' + (info.pageUrl || '-'));
      if (info.userAgent) lines.push('- 端末: ' + truncate(info.userAgent, 160));
      lines.push('');
      lines.push('<!-- lg-report ' + JSON.stringify(meta) + ' -->');
      var body = lines.join('\n');

      var url = 'https://github.com/' + repo + '/issues/new' +
        '?title=' + encodeURIComponent(title) +
        '&body=' + encodeURIComponent(body) +
        (label ? '&labels=' + encodeURIComponent(label) : '');
      if (url.length <= MAX_URL_LENGTH || quoteMax <= 40) return url;
      quoteMax = Math.floor(quoteMax / 2);
    }
    return url;
  }

  // 報告用の lg-report コメントを本文から取り出す（/fix-issues 側で使う想定。テスト用）
  function parseReportBody(body) {
    var m = /<!-- lg-report (\{.*?\}) -->/.exec(body || '');
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  // ── localStorage（例外を出さない） ─────────────────────
  function storageGet(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    REPORT_REPO: REPORT_REPO,
    REPORT_LABEL: REPORT_LABEL,
    REPORT_KINDS: REPORT_KINDS,
    pad: pad,
    wordId: wordId,
    sentenceId: sentenceId,
    sectionId: sectionId,
    pageId: pageId,
    pageDir: pageDir,
    parseHashTime: parseHashTime,
    hashForTime: hashForTime,
    effectiveTime: effectiveTime,
    clampOffset: clampOffset,
    paragraphText: paragraphText,
    phraseText: phraseText,
    escHtml: escHtml,
    renderTranscript: renderTranscript,
    buildTimeline: buildTimeline,
    buildIndex: buildIndex,
    findActive: findActive,
    inDark: inDark,
    findNearest: findNearest,
    pageForTime: pageForTime,
    formatTime: formatTime,
    truncate: truncate,
    buildReportUrl: buildReportUrl,
    parseReportBody: parseReportBody,
    storageGet: storageGet,
    storageSet: storageSet,
  };
});
