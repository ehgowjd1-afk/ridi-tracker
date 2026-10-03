/* 리디 트래커 — 화면 동작
   저장된 JSON을 읽어서 그리기만 합니다. 서버도 빌드도 없습니다. */
"use strict";

// ────────────────────────────────────────── 데이터 보관함
var D = {
  index: null,
  latest: null,
  events: null,           // 진행 중 이벤트
  endedEvents: null,      // 종료된 이벤트 ('종료됨'을 누를 때만 불러옴)
  catalog: null,          // 전체 작품 (검색할 때만 불러옴)
  tagIndex: null,         // 작품별 태그 모음 (키워드 화면에서만 불러옴)
  axes: null,             // 리디 키워드 분류(축) (조합 탭에서만 불러옴)
  history: {},            // "2026-08" → 추이 데이터
  detail: {},             // 작품ID → 상세
  dailyCache: {},         // 날짜 → daily 스냅샷 (조합 탭 과거 시점용)
  review: {},             // 작품ID → 리뷰
  tree: {},               // 섹션 → 장르 → {parent, subs}
};

var UI = {
  // view 는 "webnovel"·"ebook"·"webtoon"(각각 랭킹 화면) 또는 "move"·"event"·"search"
  view: null,
  section: null, group: null, sub: "", period: "DAILY",
  hideAdult: false,
  moveKey: null, moveKind: "rise",
  eventSort: "end",
  eventStatus: "ongoing",   // ongoing / ended / all
};

// 리디 화면에 쓰인 이름 그대로. 연재물(웹소설·웹툰)은 오늘/주간/월간,
// 단행본(E북)은 주간/월간/스테디셀러만 존재한다. '연간'은 리디에 없다.
var PERIOD_ORDER = ["DAILY", "WEEKLY", "MONTHLY", "STEADY"];
var PERIOD_LABEL = {
  DAILY: "오늘의 베스트",
  WEEKLY: "주간 베스트",
  MONTHLY: "월간 베스트",
  STEADY: "스테디셀러"
};
function periodLabel(p) { return PERIOD_LABEL[p] || p; }

// ────────────────────────────────────────── 잔심부름
function $(s, r) { return (r || document).querySelector(s); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function coverUrl(id, size) { return "https://img.ridicdn.net/cover/" + id + "/" + (size || "small"); }
function bookUrl(id) { return "https://ridibooks.com/books/" + id; }
function num(n) { return (n === null || n === undefined) ? "-" : n.toLocaleString("ko-KR"); }

var cache = {};
function getJSON(path) {
  if (cache[path]) return cache[path];
  cache[path] = fetch(path, { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw new Error(path + " 없음");
    return r.json();
  });
  return cache[path];
}
function softJSON(path) { return getJSON(path).catch(function () { return null; }); }

function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.add("hidden"); }, 2200);
}

/** 어떤 시각을 한국시간 기준 날짜(YYYY-MM-DD)로 바꾼다. */
function kstDay(iso) {
  var t = new Date(iso);
  if (isNaN(t)) return null;
  return new Date(t.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

/** 두 날짜(YYYY-MM-DD) 사이의 날짜 수. 시각이 아니라 달력 기준으로 센다. */
function dayGap(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
}

function fmtDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0")
    + "." + String(d.getDate()).padStart(2, "0");
}

// ────────────────────────────────────────── 시작
function boot() {
  Promise.all([getJSON("data/index.json"), getJSON("data/latest.json")])
    .then(function (r) {
      D.index = r[0];
      D.latest = r[1];
      buildTree();
      $("#asof").textContent = D.latest.date + " 기준 · 작품 "
        + num(D.index.book_count) + "종";
      setupTabs();
      setupRank();
      setupMove();
      setupKeyword();
      setupCombo();
      setupEvent();
      setupSearch();
      setupTheme();
      render();
    })
    .catch(function (e) {
      $("#main").innerHTML = '<p class="empty">데이터를 아직 불러올 수 없습니다.<br>'
        + '첫 수집이 끝나면 표시됩니다.<br><small>(' + e.message + ')</small></p>';
    });
}

function buildTree() {
  var R = D.latest.rankings;
  Object.keys(R).forEach(function (key) {
    var t = R[key];
    var sec = D.tree[t.section] || (D.tree[t.section] = { label: t.section, groups: {} });
    var g = sec.groups[t.group] || (sec.groups[t.group] = { name: t.group, parent: null, subs: {}, order: t.is_all ? 0 : 1 });
    // 랭킹 키를 period별로 그대로 보관한다. category_id 로 키를 조립하면
    // '전체 웹소설'처럼 여러 카테고리를 콤마로 묶은 경우 키가 깨진다.
    if (t.is_sub) {
      var s = g.subs[t.name] || (g.subs[t.name] = { name: t.name, keys: {}, periods: [] });
      s.keys[t.period] = key;
      s.periods.push(t.period);
    } else {
      if (!g.parent) g.parent = { name: t.name, keys: {}, periods: [] };
      g.parent.keys[t.period] = key;
      g.parent.periods.push(t.period);
    }
  });
  var labels = (D.index && D.index.sections) || {};
  Object.keys(D.tree).forEach(function (k) { D.tree[k].label = labels[k] || k; });
}

// ────────────────────────────────────────── 탭
function isRankView(v) { return !!D.tree[v]; }

function setupTabs() {
  var bar = $("#mainTabs");
  // 웹소설 / E북 단행본 / 웹툰 — 순위 기준이 서로 다르므로 각각 독립 탭으로
  Object.keys(D.tree).reverse().forEach(function (sec) {
    var b = el("button", "", D.tree[sec].label);
    b.dataset.view = sec;
    bar.insertBefore(b, bar.firstChild);
  });

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-view]");
    if (!b) return;
    UI.view = b.dataset.view;
    if (isRankView(UI.view) && UI.section !== UI.view) {
      UI.section = UI.view; UI.group = null; UI.sub = "";
      fillGroups();
    }
    render();
  });

  UI.view = Object.keys(D.tree)[0];
  UI.section = UI.view;
}

function render() {
  Array.prototype.forEach.call($("#mainTabs").children, function (b) {
    b.classList.toggle("on", b.dataset.view === UI.view);
  });
  var rank = isRankView(UI.view);
  $("#view-rank").classList.toggle("hidden", !rank);
  ["move", "keyword", "combo", "event", "search"].forEach(function (v) {
    $("#view-" + v).classList.toggle("hidden", v !== UI.view);
  });
  if (rank) drawRank();
  if (UI.view === "move") drawMove();
  if (UI.view === "keyword") drawKeyword();
  if (UI.view === "combo") drawCombo();
  if (UI.view === "event") drawEvents();
}

function setupTheme() {
  var saved = localStorage.getItem("ridi-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeBtn").addEventListener("click", function () {
    var cur = document.documentElement.dataset.theme;
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("ridi-theme", next);
  });
}

// ────────────────────────────────────────── 랭킹 화면
function setupRank() {
  $("#groupPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.group = b.dataset.g; UI.sub = "";
    fillGroups(); drawRank();
  });
  $("#subPick").addEventListener("change", function () {
    UI.sub = this.value; fillPeriods(); drawRank();
  });
  $("#periodPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.period = b.dataset.p; fillPeriods(); drawRank();
  });
  $("#hideAdult").addEventListener("change", function () {
    UI.hideAdult = this.checked; drawRank(); drawMove();
  });

  fillGroups();
}

function fillGroups() {
  var box = $("#groupPick");
  var groups = D.tree[UI.section].groups;
  if (!UI.group || !groups[UI.group]) UI.group = Object.keys(groups)[0];
  box.innerHTML = "";
  Object.keys(groups).forEach(function (g) {
    var b = el("button", UI.group === g ? "on" : "", g);
    b.dataset.g = g;
    box.appendChild(b);
  });
  fillSubs();
  fillPeriods();
}

function fillSubs() {
  var sel = $("#subPick");
  sel.innerHTML = "";
  var g = D.tree[UI.section].groups[UI.group];
  sel.appendChild(new Option("전체", ""));
  Object.keys(g.subs).forEach(function (s) { sel.appendChild(new Option(s, s)); });
  sel.value = UI.sub;
  sel.classList.toggle("hidden", Object.keys(g.subs).length === 0);
}

function currentTarget() {
  var g = D.tree[UI.section].groups[UI.group];
  return UI.sub ? g.subs[UI.sub] : g.parent;
}

function fillPeriods() {
  var t = currentTarget();
  var box = $("#periodPick");
  box.innerHTML = "";
  if (!t) return;
  var avail = PERIOD_ORDER.filter(function (p) { return t.periods.indexOf(p) >= 0; });
  if (avail.indexOf(UI.period) < 0) UI.period = avail[0];
  avail.forEach(function (p) {
    var b = el("button", UI.period === p ? "on" : "", periodLabel(p));
    b.dataset.p = p;
    box.appendChild(b);
  });
}

function rankKey() {
  var t = currentTarget();
  return t ? (t.keys[UI.period] || null) : null;
}

function drawRank() {
  if (!isRankView(UI.view)) return;
  var key = rankKey();
  var table = key && D.latest.rankings[key];
  var list = $("#rankList");
  list.innerHTML = "";
  if (!table) {
    $("#rankHead").textContent = "";
    list.appendChild(el("li", "empty", "이 조합의 랭킹은 아직 모으지 않았습니다."));
    return;
  }
  var ch = D.latest.changes[key] || { moves: {}, new: [] };
  var shown = 0;
  table.ids.forEach(function (id, i) {
    var b = D.latest.books[id];
    if (!b) return;
    if (UI.hideAdult && b.ad) return;
    list.appendChild(bookRow(id, b, i + 1, ch, key));
    shown++;
  });
  $("#rankHead").innerHTML = "<b>" + table.name + "</b> · " + periodLabel(table.period)
    + " · " + shown + "위까지"
    + (ch.has_prev ? " · " + D.latest.prev_date + " 대비 변동 표시" : " · 첫 수집이라 변동 없음");
  if (!shown) list.appendChild(el("li", "empty", "표시할 작품이 없습니다."));
}

function deltaEl(id, ch) {
  var d = el("div", "d");
  if (ch.new && ch.new.indexOf(id) >= 0) { d.textContent = "NEW"; d.className = "d new"; return d; }
  var m = ch.moves && ch.moves[id];
  if (m === undefined || m === 0) { d.textContent = ch.has_prev ? "–" : ""; d.className = "d same"; return d; }
  d.textContent = (m > 0 ? "▲" : "▼") + Math.abs(m);
  d.className = "d " + (m > 0 ? "up" : "down");
  return d;
}

function bookRow(id, b, rank, ch, ctxKey) {
  var li = el("li", "bookrow");
  li.tabIndex = 0;

  var rk = el("div", "rk");
  rk.appendChild(el("div", "n", rank));
  if (ch) rk.appendChild(deltaEl(id, ch));
  li.appendChild(rk);

  var img = el("img", "cover");
  img.loading = "lazy";
  img.src = coverUrl(id, "small");
  img.alt = "";
  img.onerror = function () { this.style.visibility = "hidden"; };
  li.appendChild(img);

  var info = el("div", "info");
  info.appendChild(el("div", "tt", b.t || "(제목 없음)"));
  info.appendChild(el("div", "au", (b.a || []).join(", ")));
  var sub = el("div", "sub");
  // 세트(묶음) 상품은 리디 순위에 단행본과 따로 올라온다. 합치지 않고 표시만 한다.
  if (b.st) sub.appendChild(el("span", "badge set", b.sn ? "세트 " + b.sn + "권" : "세트"));
  if (b.x) sub.appendChild(el("span", "badge ex", "독점"));
  if (b.ad) sub.appendChild(el("span", "badge ad", "19+"));
  if (b.c) sub.appendChild(el("span", "badge", "완결"));
  if (b.ep) sub.appendChild(el("span", "badge", b.ep + (b.u || "화")));
  if (b.dc) sub.appendChild(el("span", "badge", b.dc + "% 할인"));
  info.appendChild(sub);
  li.appendChild(info);

  var star = el("div", "star");
  star.innerHTML = b.r ? ("★ " + b.r + "<br><span style='opacity:.65'>" + num(b.rc) + "</span>") : "";
  li.appendChild(star);

  // ctxKey = 지금 보고 있는 랭킹 키(예: "1650-WEEKLY"). 작품을 열면 그 랭킹 기준으로
  // 추이를 먼저 보여준다. (없으면 대표 랭킹으로 기본 표시)
  li.addEventListener("click", function () { openBook(id, ctxKey); });
  li.addEventListener("keydown", function (e) { if (e.key === "Enter") openBook(id, ctxKey); });
  return li;
}

// ────────────────────────────────────────── 변동 화면
function setupMove() {
  var sel = $("#movePick");
  // 순위 기준이 다른 것끼리 섞이지 않도록 웹소설·E북·웹툰으로 묶어서 보여준다
  Object.keys(D.tree).forEach(function (sec) {
    var grp = document.createElement("optgroup");
    grp.label = D.tree[sec].label;
    Object.keys(D.latest.rankings).forEach(function (key) {
      var t = D.latest.rankings[key];
      if (t.is_sub || t.section !== sec) return;
      grp.appendChild(new Option(t.name + " · " + periodLabel(t.period), key));
    });
    if (grp.children.length) sel.appendChild(grp);
  });
  UI.moveKey = sel.value;
  sel.addEventListener("change", function () { UI.moveKey = this.value; drawMove(); });
  $("#moveKind").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.moveKind = b.dataset.kind;
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    drawMove();
  });
}

function drawMove() {
  if (UI.view !== "move") return;
  var key = UI.moveKey;
  var table = D.latest.rankings[key];
  var ch = D.latest.changes[key];
  var list = $("#moveList");
  list.innerHTML = "";

  if (!table || !ch) { $("#moveHead").textContent = ""; return; }
  if (!ch.has_prev) {
    $("#moveHead").innerHTML = "<b>" + table.name + "</b> · " + periodLabel(table.period);
    list.appendChild(el("li", "empty", "비교할 이전 기록이 없습니다.\n내일부터 변동이 표시됩니다."));
    return;
  }

  var rankOf = {};
  table.ids.forEach(function (id, i) { rankOf[id] = i + 1; });

  var rows = [], label = "";
  if (UI.moveKind === "rise") {
    label = "가장 많이 오른 작품";
    rows = (ch.top_risers || []).map(function (p) { return { id: p[0], rank: rankOf[p[0]], delta: p[1] }; });
  } else if (UI.moveKind === "new") {
    label = "새로 순위에 든 작품";
    rows = (ch.new || []).map(function (id) { return { id: id, rank: rankOf[id], isNew: true }; })
      .sort(function (a, b) { return a.rank - b.rank; });
  } else {
    label = "순위 밖으로 밀려난 작품";
    rows = (ch.out || []).map(function (id) { return { id: id, rank: null }; });
  }

  $("#moveHead").innerHTML = "<b>" + table.name + "</b> · " + periodLabel(table.period)
    + " · " + label + " " + rows.length + "건 (" + D.latest.prev_date + " 대비)";

  var shown = 0;
  rows.forEach(function (r) {
    var b = D.latest.books[r.id];
    if (!b) return;                       // 순위 밖으로 나간 작품은 오늘 정보가 없을 수 있음
    if (UI.hideAdult && b.ad) return;
    var fake = { moves: {}, new: [], has_prev: true };
    if (r.isNew) fake.new = [r.id];
    else if (r.delta) fake.moves[r.id] = r.delta;
    list.appendChild(bookRow(r.id, b, r.rank || "–", fake, UI.moveKey));
    shown++;
  });
  if (!shown) list.appendChild(el("li", "empty", "해당하는 작품이 없습니다."));
}

// ────────────────────────────────────────── 키워드 화면
// 특정 시점의 랭킹 TOP N 안에서 어떤 태그가 몇 번 나오는지 세어 막대로 보여준다.
// 태그는 tags.json 한 파일에 모여 있고, 그날의 순위는 daily/날짜.json 에 있다.

var KW = {
  section: null, group: null, sub: "", period: null,
  when: null,          // 선택한 시점의 실제 날짜 (YYYY-MM-DD)
  topN: 100,
  hideAdult: false,
  query: "",           // 키워드 검색어 (있으면 '작품 점수순' 모드)
};

function mondayOf(dateStr) {
  var d = new Date(dateStr + "T00:00:00");
  var day = (d.getDay() + 6) % 7;          // 월요일=0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function setupKeyword() {
  KW.section = Object.keys(D.tree)[0];

  $("#kwSecPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    KW.section = b.dataset.sec; KW.group = null; KW.sub = "";
    fillKwPickers(); drawKeyword();
  });
  $("#kwGroupPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    KW.group = b.dataset.g; KW.sub = "";
    fillKwPickers(); drawKeyword();
  });
  $("#kwSubPick").addEventListener("change", function () {
    KW.sub = this.value; fillKwPickers(); drawKeyword();
  });
  $("#kwPeriodPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    KW.period = b.dataset.p; fillKwPickers(); drawKeyword();
  });
  $("#kwWhen").addEventListener("change", function () {
    KW.when = this.value; drawKeyword();
  });
  $("#kwTopN").addEventListener("input", function () {
    var n = parseInt(this.value, 10);
    KW.topN = (isFinite(n) && n > 0) ? Math.min(n, 200) : 0;
    if (KW.topN) drawKeyword();
  });
  $("#kwHideAdult").addEventListener("change", function () {
    KW.hideAdult = this.checked; drawKeyword();
  });
  var _kwT = null;
  $("#kwSearch").addEventListener("input", function () {
    KW.query = this.value;
    clearTimeout(_kwT);
    _kwT = setTimeout(drawKeyword, 200);
  });

  var box = $("#kwSecPick");
  Object.keys(D.tree).forEach(function (s) {
    var b = el("button", "", D.tree[s].label);
    b.dataset.sec = s;
    box.appendChild(b);
  });
  fillKwPickers();
}

function kwTarget() {
  var g = D.tree[KW.section].groups[KW.group];
  if (!g) return null;
  return KW.sub ? g.subs[KW.sub] : g.parent;
}

function fillKwPickers() {
  var groups = D.tree[KW.section].groups;
  if (!KW.group || !groups[KW.group]) KW.group = Object.keys(groups)[0];

  Array.prototype.forEach.call($("#kwSecPick").children, function (b) {
    b.classList.toggle("on", b.dataset.sec === KW.section);
  });

  var gbox = $("#kwGroupPick");
  gbox.innerHTML = "";
  Object.keys(groups).forEach(function (g) {
    var b = el("button", KW.group === g ? "on" : "", g);
    b.dataset.g = g;
    gbox.appendChild(b);
  });

  var sub = $("#kwSubPick");
  sub.innerHTML = "";
  sub.appendChild(new Option("전체", ""));
  Object.keys(groups[KW.group].subs).forEach(function (s) {
    sub.appendChild(new Option(s, s));
  });
  sub.value = KW.sub;
  sub.classList.toggle("hidden", Object.keys(groups[KW.group].subs).length === 0);

  var t = kwTarget();
  var pbox = $("#kwPeriodPick");
  pbox.innerHTML = "";
  if (!t) return;
  var avail = PERIOD_ORDER.filter(function (p) { return t.periods.indexOf(p) >= 0; });
  if (avail.indexOf(KW.period) < 0) KW.period = avail[0];
  avail.forEach(function (p) {
    var b = el("button", KW.period === p ? "on" : "", periodLabel(p));
    b.dataset.p = p;
    pbox.appendChild(b);
  });

  fillKwWhen();
}

/** 기간 종류에 맞춰 '시점' 목록을 만든다 — 일간은 날짜, 주간은 주, 월간은 달. */
function fillKwWhen() {
  var sel = $("#kwWhen");
  var dates = (D.index.dates || []).slice().sort();
  sel.innerHTML = "";
  if (!dates.length) return;

  var opts = [];
  if (KW.period === "MONTHLY") {
    var byMonth = {};
    dates.forEach(function (d) { byMonth[d.slice(0, 7)] = d; });   // 그 달의 마지막 기록
    Object.keys(byMonth).sort().reverse().forEach(function (m) {
      var y = m.slice(0, 4), mm = parseInt(m.slice(5, 7), 10);
      opts.push([byMonth[m], y + "년 " + mm + "월"]);
    });
  } else if (KW.period === "WEEKLY") {
    var byWeek = {};
    dates.forEach(function (d) { byWeek[mondayOf(d)] = d; });      // 그 주의 마지막 기록
    Object.keys(byWeek).sort().reverse().forEach(function (mon) {
      var s = new Date(mon + "T00:00:00");
      var e = new Date(s); e.setDate(e.getDate() + 6);
      var f = function (x) { return (x.getMonth() + 1) + "/" + x.getDate(); };
      opts.push([byWeek[mon], f(s) + "~" + f(e) + " 주"]);
    });
  } else {
    dates.slice().reverse().forEach(function (d) { opts.push([d, d]); });
  }

  opts.forEach(function (o) { sel.appendChild(new Option(o[1], o[0])); });
  var values = opts.map(function (o) { return o[0]; });
  if (values.indexOf(KW.when) < 0) KW.when = values[0];
  sel.value = KW.when;
}

function loadDaily(date) {
  return softJSON("data/daily/" + date + ".json");
}

function drawKeyword() {
  if (UI.view !== "keyword") return;
  var t = kwTarget();
  var body = $("#kwBody");
  if (!t) { body.innerHTML = '<p class="empty">고를 수 있는 자료가 없습니다.</p>'; return; }

  // ── 검색 모드: 키워드를 치면 그 키워드 작품들을 점수순으로 ──
  if ((KW.query || "").trim()) {
    body.innerHTML = '<p class="empty">찾는 중…</p>';
    (D.tagIndex ? Promise.resolve(D.tagIndex)
      : softJSON("data/tags.json").then(function (j) { D.tagIndex = j; return j; })
    ).then(function () { fillTagList(); renderKeywordWorks(t); });
    return;
  }

  // ── 분포 모드(기존): 키워드가 비어 있으면 TOP N 안의 키워드 분포 ──
  if (!KW.when) { body.innerHTML = '<p class="empty">고를 수 있는 자료가 없습니다.</p>'; return; }
  var key = t.keys[KW.period];
  var name = (KW.sub || KW.group);
  $("#kwHead").innerHTML = "<b>" + name + "</b> · " + periodLabel(KW.period)
    + " · " + KW.when + " 기준 · TOP " + KW.topN;
  body.innerHTML = '<p class="empty">세는 중…</p>';

  var needCatalog = KW.hideAdult && !D.catalog;
  Promise.all([
    D.tagIndex ? Promise.resolve(D.tagIndex)
      : softJSON("data/tags.json").then(function (j) { D.tagIndex = j; return j; }),
    loadDaily(KW.when),
    needCatalog ? getJSON("data/books.json").then(function (j) { D.catalog = j; return j; })
      .catch(function () { return null; }) : Promise.resolve(null)
  ]).then(function (r) {
    renderKeyword(r[0], r[1], key, name);
  });
}

function renderKeyword(tagIndex, daily, key, name) {
  var body = $("#kwBody");
  body.innerHTML = "";

  if (!tagIndex || !tagIndex.books) {
    body.appendChild(el("p", "empty", "키워드 자료(tags.json)가 아직 없습니다.\n다음 수집이 끝나면 생깁니다."));
    return;
  }
  if (!daily || !daily.rankings || !daily.rankings[key]) {
    body.appendChild(el("p", "empty", "이 시점에는 해당 랭킹 기록이 없습니다.\n다른 시점을 골라보세요."));
    return;
  }

  var ids = daily.rankings[key].ids || [];
  if (KW.hideAdult && D.catalog) {
    ids = ids.filter(function (id) { var b = D.catalog[id]; return !(b && b.ad); });
  }
  ids = ids.slice(0, KW.topN);

  var counts = {}, tagged = 0;
  ids.forEach(function (id) {
    var list = tagIndex.books[id];
    if (!list || !list.length) return;
    tagged++;
    var seen = {};
    list.forEach(function (ti) {
      if (seen[ti]) return;               // 한 작품 안의 중복은 한 번만
      seen[ti] = 1;
      counts[ti] = (counts[ti] || 0) + 1;
    });
  });

  // 태그를 아직 못 모은 작품이 많으면 솔직히 알려준다
  var pct = ids.length ? Math.round(tagged / ids.length * 100) : 0;
  var note = el("p", "covernote");
  if (pct >= 90) {
    note.textContent = ids.length + "개 작품 중 " + tagged + "개의 키워드를 반영했습니다 (" + pct + "%).";
  } else {
    note.innerHTML = ids.length + "개 작품 중 <b>" + tagged + "개(" + pct + "%)</b>만 키워드를 확보했습니다. "
      + "작품 태그는 하루에 정해진 양만 모으므로, 며칠 지나면 채워집니다. "
      + "지금 그래프는 참고용으로만 보세요.";
  }
  body.appendChild(note);

  var rows = Object.keys(counts).map(function (ti) {
    return [tagIndex.dict[ti], counts[ti]];
  }).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });

  if (!rows.length) {
    body.appendChild(el("p", "empty", "이 범위에서 확보된 키워드가 없습니다."));
    return;
  }

  var top = rows.slice(0, 40);
  var max = top[0][1];
  var list = el("div", "kwlist");
  top.forEach(function (p, i) {
    var row = el("div", "kwrow");
    row.dataset.tag = p[0];
    row.title = "누르면 이 키워드 작품들을 점수순으로 봅니다";
    row.appendChild(el("div", "kn", i + 1));
    row.appendChild(el("div", "kw", "#" + p[0]));
    var track = el("div", "ktrack");
    var fill = el("div", "kfill");
    fill.style.width = (p[1] / max * 100).toFixed(1) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    var share = tagged ? Math.round(p[1] / tagged * 100) : 0;
    row.appendChild(el("div", "kval", p[1] + "편 · " + share + "%"));
    row.addEventListener("click", function () {
      $("#kwSearch").value = p[0]; KW.query = p[0]; drawKeyword();   // 작품 목록(점수순)으로
    });
    list.appendChild(row);
  });
  body.appendChild(list);

  var foot = el("p", "hint");
  foot.style.marginTop = "10px";
  foot.textContent = "서로 다른 키워드 " + rows.length + "종 중 상위 40개. "
    + "%는 키워드를 확보한 " + tagged + "개 작품 대비 비율입니다. "
    + "키워드를 누르면 그 작품들이 점수순으로 나옵니다. (조합 분석은 ‘조합’ 탭)";
  body.appendChild(foot);
}

// ── 키워드 검색(작품 점수순) ──────────────────────────────
// 자동완성 목록(datalist)을 한 번만 채운다. (키워드 2천여 개)
function fillTagList() {
  var dl = $("#kwTagList");
  if (!dl || dl.childElementCount || !D.tagIndex) return;
  var frag = document.createDocumentFragment();
  D.tagIndex.dict.forEach(function (tg) {
    var o = document.createElement("option");
    o.value = tg;
    frag.appendChild(o);
  });
  dl.appendChild(frag);
}

// 입력어 → 실제 키워드로 해석 (정확히 일치할 때만)
function resolveTag(q) {
  if (!q || !D.tagIndex) return null;
  q = q.trim().replace(/^#/, "");
  if (!q) return null;
  var dict = D.tagIndex.dict;
  if (dict.indexOf(q) >= 0) return q;
  var qn = q.toLowerCase();
  for (var i = 0; i < dict.length; i++) {
    if (dict[i].toLowerCase() === qn) return dict[i];
  }
  return null;
}

function tagSuggestions(q, limit) {
  var out = [];
  if (!D.tagIndex) return out;
  var qn = (q || "").trim().replace(/^#/, "").toLowerCase();
  if (!qn) return out;
  var dict = D.tagIndex.dict;
  for (var i = 0; i < dict.length && out.length < limit; i++) {
    if (dict[i].toLowerCase().indexOf(qn) >= 0) out.push(dict[i]);
  }
  return out;
}

function kwScopeLabel() { return KW.sub || KW.group; }

// 키워드를 가진 작품들을 복합 점수로 정렬해 보여준다.
//   점수 = 순위 가중평균 70% + 누적 별점수 30%
//   순위 가중평균: 장기 기간일수록 무겁게 (월간>주간>일간 = 3:2:1,
//                 E북은 스테디>월간>주간 = 3:2:1). 작품이 든 기간만으로 계산.
//   정규화: 두 값 모두 결과 집합 안에서 min-max → 0~100 점.
//   순위 기준은 '현재(latest)' — 한 스냅샷에 일·주·월이 다 들어 있다.
function renderKeywordWorks(target) {
  var body = $("#kwBody");
  var head = $("#kwHead");
  body.innerHTML = "";
  head.textContent = "";

  var tagName = resolveTag(KW.query);
  if (!tagName) {
    var sugg = tagSuggestions(KW.query, 30);
    head.appendChild(el("span", "", "“" + (KW.query || "").trim() + "” 와 꼭 맞는 키워드가 없습니다."));
    if (sugg.length) {
      body.appendChild(el("p", "hint", "혹시 이 중에 있나요? 눌러서 선택:"));
      var wrap = el("div", "tags");
      sugg.forEach(function (tg) {
        var s = el("span", "tag k", "#" + tg);
        s.style.cursor = "pointer";
        s.addEventListener("click", function () {
          $("#kwSearch").value = tg; KW.query = tg; drawKeyword();
        });
        wrap.appendChild(s);
      });
      body.appendChild(wrap);
    } else {
      body.appendChild(el("p", "empty", "비슷한 키워드도 없습니다. 철자를 확인해 보세요."));
    }
    return;
  }

  var tagId = D.tagIndex.dict.indexOf(tagName);
  var books = D.tagIndex.books;

  // 선택한 분류의 기간 키들 (짧은→긴 순). 긴 기간일수록 가중치가 크다.
  var periods = PERIOD_ORDER.filter(function (p) { return target.keys[p]; });
  var weightOf = {};
  periods.forEach(function (p, i) { weightOf[p] = i + 1; });   // 1,2,3...

  // 각 기간 랭킹의 순위맵 (현재 기준)
  var rankOf = {};
  periods.forEach(function (p) {
    var tbl = D.latest.rankings[target.keys[p]];
    var m = {};
    if (tbl) tbl.ids.forEach(function (id, i) { m[id] = i + 1; });
    rankOf[p] = m;
  });

  // 후보: 이 분류 랭킹에 든 작품 중 그 키워드를 가진 것
  var seen = {}, cand = [];
  periods.forEach(function (p) {
    var tbl = D.latest.rankings[target.keys[p]];
    if (!tbl) return;
    tbl.ids.forEach(function (id) {
      if (seen[id]) return; seen[id] = 1;
      var tl = books[id];
      if (!tl || tl.indexOf(tagId) < 0) return;         // 키워드 없음
      var b = D.latest.books[id] || {};
      if (KW.hideAdult && b.ad) return;
      var sumW = 0, sumWR = 0, nP = 0;
      periods.forEach(function (pp) {
        var r = rankOf[pp][id];
        if (r) { sumW += weightOf[pp]; sumWR += weightOf[pp] * r; nP++; }
      });
      if (!nP) return;
      cand.push({ id: id, mean: sumWR / sumW, rc: (b.rc || 0), nP: nP });
    });
  });

  var weightDesc = periods.slice().reverse().map(function (p) {
    return periodLabel(p) + "×" + weightOf[p];
  }).join(" · ");

  if (!cand.length) {
    head.appendChild(el("b", "", "#" + tagName));
    head.appendChild(document.createTextNode(" · " + kwScopeLabel() + " 범위"));
    body.appendChild(el("p", "empty",
      "이 범위의 현재 순위 안에 ‘#" + tagName + "’ 작품이 없습니다.\n위의 분류/장르를 넓혀 보세요 (예: 전체 웹소설)."));
    return;
  }

  // 정규화: 순위평균은 낮을수록↑, 별점수는 많을수록↑
  var means = cand.map(function (c) { return c.mean; });
  var rcs = cand.map(function (c) { return c.rc; });
  var minM = Math.min.apply(null, means), maxM = Math.max.apply(null, means);
  var minR = Math.min.apply(null, rcs), maxR = Math.max.apply(null, rcs);
  cand.forEach(function (c) {
    var rankNorm = (maxM === minM) ? 1 : (maxM - c.mean) / (maxM - minM);
    var rateNorm = (maxR === minR) ? 1 : (c.rc - minR) / (maxR - minR);
    c.score = 100 * (0.7 * rankNorm + 0.3 * rateNorm);
  });
  cand.sort(function (a, b) { return b.score - a.score || a.mean - b.mean; });

  var total = cand.length;
  var shown = cand.slice(0, KW.topN || 100);

  head.appendChild(el("b", "", "#" + tagName));
  head.appendChild(document.createTextNode(
    " · " + kwScopeLabel() + " 범위 · " + total + "작품"
    + (total > shown.length ? " 중 상위 " + shown.length : "")));

  body.appendChild(el("p", "covernote",
    "점수 = 순위 가중평균 70% + 누적 별점수 30%. "
    + "순위 가중치 " + weightDesc + " (장기일수록 크게). "
    + "현재(" + D.latest.date + ") 순위 기준."));

  var ctxKey = target.keys[periods[0]];
  var list = el("ol", "booklist");
  shown.forEach(function (c, i) { list.appendChild(workScoreRow(c, i + 1, ctxKey)); });
  body.appendChild(list);
}

function workScoreRow(c, pos, ctxKey) {
  var b = D.latest.books[c.id] || (D.catalog && D.catalog[c.id]) || {};
  var li = el("li", "bookrow"); li.tabIndex = 0;

  var rk = el("div", "rk");
  rk.appendChild(el("div", "n", pos));
  li.appendChild(rk);

  var img = el("img", "cover");
  img.loading = "lazy"; img.src = coverUrl(c.id, "small"); img.alt = "";
  img.onerror = function () { this.style.visibility = "hidden"; };
  li.appendChild(img);

  var info = el("div", "info");
  info.appendChild(el("div", "tt", b.t || "(제목 없음)"));
  info.appendChild(el("div", "au", (b.a || []).join(", ")));
  var sub = el("div", "sub");
  sub.appendChild(el("span", "badge", "평균 " + (Math.round(c.mean * 10) / 10) + "위"));
  sub.appendChild(el("span", "badge", "별점 " + num(c.rc)));
  if (c.nP < 3) sub.appendChild(el("span", "badge", c.nP + "개 기간만"));
  if (b.x) sub.appendChild(el("span", "badge ex", "독점"));
  if (b.ad) sub.appendChild(el("span", "badge ad", "19+"));
  info.appendChild(sub);
  li.appendChild(info);

  var star = el("div", "star");
  star.innerHTML = "<b>" + Math.round(c.score) + "</b>"
    + "<br><span style='opacity:.6;font-size:.7rem'>점</span>";
  li.appendChild(star);

  li.addEventListener("click", function () { openBook(c.id, ctxKey); });
  li.addEventListener("keydown", function (e) { if (e.key === "Enter") openBook(c.id, ctxKey); });
  return li;
}

// ════════════════════════════════════════════════════════════
//  조합 탭 — 리디 키워드 분류(축)로 키워드를 묶고, 조합을 쌓아
//  작품/강도를 본다. "어떤 조합이 순위·누적수·유의미도에서 강한가".
// ════════════════════════════════════════════════════════════
var CB = { section: null, group: null, period: null, when: null,
  hideAdult: false, sel: [], sort: "rank", _cache: {}, _src: null };

// 조합 분석에서 뺄 축/키워드 (운영·형식·통계성)
var CB_DROP_AXIS = { "뿌리를 찾아서": 1, "BL브랜드": 1, "만웹대여제": 1 };
var CB_DROP_KW = {
  "기다리면무료": 1, "만웹대여제": 1, "대여": 1, "전권대여": 1, "고화질": 1,
  "연재": 1, "완결": 1, "연재중": 1, "연재완결": 1, "단행본": 1, "단행본완결": 1,
  "단편": 1, "단편모음": 1, "비욘드": 1,
  // 거의 모든 작품에 붙어 조합 구분에 도움이 안 되는 키워드 (현대극 같은 배경성은 유지)
  "한국BL": 1, "소설원작": 1
};
function cbKeepKw(n) { return !CB_DROP_KW[n] && !/^(별점|리뷰|평점|조회)/.test(n); }

// 우리 분류(section/group) → 리디 키워드파인더 (genre, setId)
function cbSetKey(section, group) {
  var bl = /BL/.test(group);
  if (section === "webtoon") return bl ? ["bl", 17] : ["comic", 21];
  if (bl) return ["bl", 15];
  if (/판타지|라이트노벨/.test(group)) return ["fantasy", 18];
  return ["romance", 1];
}

// 해당 카테고리의 축 분류(필터 적용) + 키워드 유니버스
function cbResolveSet() {
  if (!D.axes || !D.axes.genres) return null;
  var sk = cbSetKey(CB.section, CB.group);
  var genre = D.axes.genres[sk[0]];
  if (!genre) return null;
  var set = genre.sets.filter(function (s) { return s.setId === sk[1]; })[0] || genre.sets[0];
  if (!set) return null;
  var axes = [], uni = {};
  set.axes.forEach(function (a) {
    if (CB_DROP_AXIS[a.title]) return;
    var tags = a.tags.filter(cbKeepKw);
    if (!tags.length) return;
    tags.forEach(function (t) { uni[t] = 1; });
    axes.push({ title: a.title, tags: tags });
  });
  return { label: set.title, axes: axes, uni: uni };
}

// 선택한 기간(일/주/월) + 시점 하나의 랭킹으로 작품 목록을 만든다.
//   mean = 그 랭킹에서의 순위(1위=1). rc = 그 시점의 누적 별점수(스냅샷).
function cbBuildWorks() {
  var ck = CB.section + "|" + CB.group + "|" + CB.period + "|" + CB.when + "|" + (CB.hideAdult ? 1 : 0);
  if (CB._cache[ck]) return CB._cache[ck];
  var g = (D.tree[CB.section].groups[CB.group] || {}).parent;
  var out = { works: [], N: 0 };
  if (g && CB._src && CB.period) {
    var tbl = CB._src.rankings[g.keys[CB.period]];
    if (tbl) {
      var dict = D.tagIndex.dict, books = D.tagIndex.books, works = [];
      tbl.ids.forEach(function (id, i) {
        var b = CB._src.bookOf(id) || {};
        if (CB.hideAdult && b.ad) return;
        works.push({ id: id, mean: i + 1, rc: CB._src.rcOf(id),
          t: b.t, a: b.a, x: b.x, ad: b.ad,
          tags: (books[id] || []).map(function (ti) { return dict[ti]; }) });
      });
      out = { works: works, N: works.length };
    }
  }
  CB._cache[ck] = out;
  return out;
}

// 시점(날짜/주/월) 목록. 일간=하루마다, 주간=일요일 기준, 월간=말일 기준.
function cbSundayKey(dateStr) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7);   // 그 주의 일요일(주 끝)
  return d.toISOString().slice(0, 10);
}
function cbWhenOptions(period) {
  var dates = (D.index.dates || []).slice().sort();
  var opts = [];
  if (!dates.length) return opts;
  if (period === "MONTHLY") {
    var byM = {}; dates.forEach(function (d) { byM[d.slice(0, 7)] = d; });  // 그 달 마지막 수집일
    Object.keys(byM).sort().reverse().forEach(function (m) {
      opts.push([byM[m], m.slice(0, 4) + "년 " + (+m.slice(5, 7)) + "월 (말일 기준)"]);
    });
  } else if (period === "WEEKLY") {
    var byW = {}; dates.forEach(function (d) { byW[cbSundayKey(d)] = d; });  // 그 주 마지막 수집일
    Object.keys(byW).sort().reverse().forEach(function (sun) {
      var e = new Date(sun + "T00:00:00Z"), s = new Date(e); s.setUTCDate(s.getUTCDate() - 6);
      var f = function (x) { return (x.getUTCMonth() + 1) + "/" + x.getUTCDate(); };
      opts.push([byW[sun], f(s) + "~" + f(e) + " 주 (일요일 기준)"]);
    });
  } else {  // DAILY, STEADY
    dates.slice().reverse().forEach(function (d) { opts.push([d, d]); });
  }
  return opts;
}

// 선택 시점의 랭킹·별점수 출처. 최신이면 메모리(latest), 과거면 daily 파일.
function cbSnapshot(when) {
  function srcLatest() {
    return {
      rankings: D.latest.rankings, date: D.latest.date,
      bookOf: function (id) { return D.latest.books[id] || (D.catalog && D.catalog[id]) || {}; },
      rcOf: function (id) { var b = D.latest.books[id] || (D.catalog && D.catalog[id]) || {}; return b.rc || 0; }
    };
  }
  function srcDaily(j) {
    return {
      rankings: j.rankings || {}, date: j.date || when,
      bookOf: function (id) { return (D.catalog && D.catalog[id]) || D.latest.books[id] || {}; },
      rcOf: function (id) {
        var s = j.snapshots && j.snapshots[id];
        if (s && s.rc != null) return s.rc;
        var b = (D.catalog && D.catalog[id]) || D.latest.books[id] || {}; return b.rc || 0;
      }
    };
  }
  if (!when || when === D.index.latest_date) return Promise.resolve(srcLatest());
  if (D.dailyCache[when]) return Promise.resolve(srcDaily(D.dailyCache[when]));
  return softJSON("data/daily/" + when + ".json").then(function (j) {
    if (!j) return srcLatest();
    D.dailyCache[when] = j; return srcDaily(j);
  });
}

function cbFiltered(works, sel) {
  if (!sel.length) return works;
  return works.filter(function (wk) {
    return sel.every(function (k) { return wk.tags.indexOf(k) >= 0; });
  });
}

function setupCombo() {
  CB.section = Object.keys(D.tree)[0];
  $("#cbSecPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    CB.section = b.dataset.sec; CB.group = null; CB.sel = []; drawCombo();
  });
  $("#cbGroupPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    CB.group = b.dataset.g; CB.sel = []; drawCombo();
  });
  $("#cbPeriodPick").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    CB.period = b.dataset.p; CB.when = null; drawCombo();
  });
  $("#cbWhen").addEventListener("change", function () { CB.when = this.value; drawCombo(); });
  $("#cbExcel").addEventListener("click", cbExcel);
  $("#cbSort").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    CB.sort = b.dataset.s;
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    drawCombo();
  });
  $("#cbHideAdult").addEventListener("change", function () {
    CB.hideAdult = this.checked; drawCombo();
  });
  Object.keys(D.tree).forEach(function (s) {
    var b = el("button", "", D.tree[s].label); b.dataset.sec = s;
    $("#cbSecPick").appendChild(b);
  });
}

function drawCombo() {
  if (UI.view !== "combo") return;
  var body = $("#cbBody");
  body.innerHTML = '<p class="empty">불러오는 중…</p>';
  Promise.all([
    D.tagIndex ? Promise.resolve(D.tagIndex) : softJSON("data/tags.json").then(function (j) { D.tagIndex = j; return j; }),
    D.axes ? Promise.resolve(D.axes) : softJSON("data/keyword-axes.json").then(function (j) { D.axes = j; return j; }),
    // 과거 시점/제목·성인 표시를 위해 전체 카탈로그도 필요
    D.catalog ? Promise.resolve(D.catalog) : softJSON("data/books.json").then(function (j) { D.catalog = j; return j; })
  ]).then(function () { renderCombo(); });
}

function renderCombo() {
  // 분류 버튼 상태 + 장르 버튼
  var groups = D.tree[CB.section].groups;
  if (!CB.group || !groups[CB.group]) CB.group = Object.keys(groups)[0];
  Array.prototype.forEach.call($("#cbSecPick").children, function (b) {
    b.classList.toggle("on", b.dataset.sec === CB.section);
  });
  var gbox = $("#cbGroupPick"); gbox.innerHTML = "";
  Object.keys(groups).forEach(function (gname) {
    var b = el("button", CB.group === gname ? "on" : "", gname);
    b.dataset.g = gname; gbox.appendChild(b);
  });

  // 기간 버튼 (카테고리가 제공하는 기간만)
  var g = (groups[CB.group] || {}).parent;
  var periods = g ? PERIOD_ORDER.filter(function (p) { return g.keys[p]; }) : [];
  if (periods.indexOf(CB.period) < 0) CB.period = periods[0] || null;
  var pbox = $("#cbPeriodPick"); pbox.innerHTML = "";
  periods.forEach(function (p) {
    var b = el("button", CB.period === p ? "on" : "", periodLabel(p));
    b.dataset.p = p; pbox.appendChild(b);
  });

  // 시점 드롭다운
  var opts = cbWhenOptions(CB.period);
  var wsel = $("#cbWhen"); wsel.innerHTML = "";
  opts.forEach(function (o) { wsel.appendChild(new Option(o[1], o[0])); });
  var vals = opts.map(function (o) { return o[0]; });
  if (vals.indexOf(CB.when) < 0) CB.when = vals[0] || null;
  wsel.value = CB.when;

  var body = $("#cbBody");
  if (!D.tagIndex || !D.axes) { body.innerHTML = '<p class="empty">자료를 불러오지 못했습니다.</p>'; return; }
  if (!cbResolveSet()) { body.innerHTML = '<p class="empty">이 분류의 키워드 분류표가 아직 없습니다.</p>'; return; }

  // 선택 시점 스냅샷을 불러온 뒤 그린다
  body.innerHTML = '<p class="empty">불러오는 중…</p>';
  cbSnapshot(CB.when).then(function (src) { CB._src = src; cbPaint(); });
}

function cbPaint() {
  var body = $("#cbBody");
  var set = cbResolveSet();
  if (!set) return;
  var all = cbBuildWorks();
  var filtered = cbFiltered(all.works, CB.sel);

  // 선택한 키워드 칩
  var chosen = $("#cbChosen"); chosen.innerHTML = "";
  CB.sel.forEach(function (k) {
    var s = el("span", "tag k", "#" + k + " ✕");
    s.addEventListener("click", function () {
      CB.sel = CB.sel.filter(function (x) { return x !== k; }); cbPaint();
    });
    chosen.appendChild(s);
  });
  if (CB.sel.length) {
    var clr = el("span", "tag", "전체해제");
    clr.style.cursor = "pointer";
    clr.addEventListener("click", function () { CB.sel = []; cbPaint(); });
    chosen.appendChild(clr);
  }

  // 축별 키워드 picker — 현재 필터된 작품 안에서의 등장 수
  var cnt = {};
  filtered.forEach(function (wk) {
    var seen = {};
    wk.tags.forEach(function (t) { if (set.uni[t] && !seen[t]) { seen[t] = 1; cnt[t] = (cnt[t] || 0) + 1; } });
  });
  var axbox = $("#cbAxes"); axbox.innerHTML = "";
  set.axes.forEach(function (a) {
    var kws = a.tags.filter(function (t) { return cnt[t] || CB.sel.indexOf(t) >= 0; })
      .sort(function (x, y) { return (cnt[y] || 0) - (cnt[x] || 0); }).slice(0, 18);
    if (!kws.length) return;
    var row = el("div", "cbaxis");
    row.appendChild(el("div", "cbaxname", a.title));
    var kwrap = el("div", "cbkws");
    kws.forEach(function (t) {
      var on = CB.sel.indexOf(t) >= 0;
      var chip = el("span", "tag" + (on ? " on" : ""));
      chip.appendChild(document.createTextNode("#" + t));
      if (cnt[t]) { var c = el("span", "c", cnt[t]); chip.appendChild(c); }
      chip.addEventListener("click", function () {
        if (on) CB.sel = CB.sel.filter(function (x) { return x !== t; });
        else CB.sel = CB.sel.concat([t]);
        cbPaint();
      });
      kwrap.appendChild(chip);
    });
    row.appendChild(kwrap);
    axbox.appendChild(row);
  });

  // 강도 요약 + 결과
  var ctx = periodLabel(CB.period) + " · " + cbWhenLabel();
  var strength = $("#cbStrength");
  if (!all.N) {
    strength.textContent = set.label + " · " + ctx;
    $("#cbHead").textContent = "";
    $("#cbBody").innerHTML = '<p class="empty">이 시점·기간에는 순위 자료가 없습니다. 다른 시점을 골라보세요.</p>';
    return;
  }
  if (CB.sel.length) {
    var means = filtered.map(function (w) { return w.mean; });
    var avg = means.length ? means.reduce(function (a, b) { return a + b; }, 0) / means.length : 0;
    var sumRc = filtered.reduce(function (a, w) { return a + w.rc; }, 0);
    strength.textContent = CB.sel.map(function (k) { return "#" + k; }).join(" + ")
      + " → " + filtered.length + "작품(" + (Math.round(filtered.length / all.N * 1000) / 10) + "%)"
      + " · 평균 " + (Math.round(avg * 10) / 10) + "위 · 별점수 " + num(sumRc)
      + "  [" + ctx + "]";
    $("#cbHead").textContent = "";
    renderComboWorks(filtered, g_firstKey());
  } else {
    strength.textContent = set.label + " " + all.N + "작품 · " + ctx
      + " · 키워드를 눌러 조합을 만들거나, 아래 추천 조합을 고르세요.";
    cbAutoTop(all, set);
  }
}

function cbWhenLabel() {
  var s = $("#cbWhen");
  return (s && s.selectedIndex >= 0) ? s.options[s.selectedIndex].text : (CB.when || "");
}

function g_firstKey() {
  var g = (D.tree[CB.section].groups[CB.group] || {}).parent;
  if (!g) return null;
  var p = PERIOD_ORDER.filter(function (x) { return g.keys[x]; })[0];
  return p ? g.keys[p] : null;
}

// 선택 조합의 작품: 복합점수 순 (검색/키워드와 동일)
function renderComboWorks(works, ctxKey) {
  var body = $("#cbBody"); body.innerHTML = "";
  if (!works.length) { body.appendChild(el("p", "empty", "이 조합에 맞는 작품이 없습니다. 키워드를 줄여보세요.")); return; }
  var means = works.map(function (w) { return w.mean; }), rcs = works.map(function (w) { return w.rc; });
  var mn = Math.min.apply(null, means), mx = Math.max.apply(null, means);
  var rn = Math.min.apply(null, rcs), rx = Math.max.apply(null, rcs);
  works.forEach(function (w) {
    var rank = (mx === mn) ? 1 : (mx - w.mean) / (mx - mn);
    var rate = (rx === rn) ? 1 : (w.rc - rn) / (rx - rn);
    w.score = 100 * (0.7 * rank + 0.3 * rate);
  });
  works = works.slice().sort(function (a, b) { return b.score - a.score || a.mean - b.mean; });
  var list = el("ol", "booklist");
  works.slice(0, 100).forEach(function (w, i) { list.appendChild(workScoreRow(w, i + 1, ctxKey)); });
  body.appendChild(list);
}

// 빈발 쌍 계산 (지지도 문턱 넘는 쌍) + 정렬 — 자동 TOP / 엑셀 공용
function cbComputePairs(all, set) {
  var works = all.works, N = all.N;
  var minSup = Math.max(4, Math.round(N * 0.03));
  var cnt = {};
  works.forEach(function (wk) {
    var seen = {};
    wk.tags.forEach(function (t) { if (set.uni[t] && !seen[t]) { seen[t] = 1; cnt[t] = (cnt[t] || 0) + 1; } });
  });
  var f1 = Object.keys(cnt).filter(function (t) { return cnt[t] >= minSup; });
  var pairs = [];
  for (var i = 0; i < f1.length; i++) for (var j = i + 1; j < f1.length; j++) {
    var a = f1[i], b = f1[j], n = 0, sm = 0, sr = 0;
    works.forEach(function (wk) {
      if (wk.tags.indexOf(a) >= 0 && wk.tags.indexOf(b) >= 0) { n++; sm += wk.mean; sr += wk.rc; }
    });
    if (n >= minSup) {
      pairs.push({ set: [a, b], n: n, avg: sm / n, rc: sr, ratio: n / N, lift: n * N / (cnt[a] * cnt[b]) });
    }
  }
  if (CB.sort === "rc") pairs.sort(function (x, y) { return y.rc - x.rc; });
  else if (CB.sort === "lift") pairs.sort(function (x, y) { return y.lift - x.lift; });
  else pairs.sort(function (x, y) { return x.avg - y.avg; });
  return pairs;
}

// 자동 "강한 조합 TOP": 빈발 쌍을 순위/누적수/유의미도로 정렬
function cbAutoTop(all, set) {
  var body = $("#cbBody"); body.innerHTML = "";
  var pairs = cbComputePairs(all, set);
  if (!pairs.length) { body.appendChild(el("p", "empty", "조합을 뽑을 만큼 자료가 충분하지 않습니다.")); return; }
  $("#cbHead").innerHTML = "자주·강하게 묶이는 조합 <b>" + pairs.length + "</b>개 중 상위 "
    + Math.min(30, pairs.length) + " · 조합을 누르면 작품이 나오고 키워드를 더 쌓을 수 있어요";
  pairs.slice(0, 30).forEach(function (p) {
    var row = el("div", "cbcombo");
    var names = el("div", "cbnames", p.set.map(function (t) { return "#" + t; }).join(" + "));
    var metric = el("div", "cbmetric",
      p.n + "작품 · 평균 " + (Math.round(p.avg * 10) / 10) + "위 · 별점수 " + num(p.rc)
      + " · 유의미 ×" + (Math.round(p.lift * 10) / 10));
    row.appendChild(names); row.appendChild(metric);
    row.addEventListener("click", function () { CB.sel = p.set.slice(); cbPaint(); });
    body.appendChild(row);
  });
}

// 엑셀 내려받기 — 조합이 선택돼 있으면 그 작품들, 아니면 강한 조합 TOP 표.
function cbExcel() {
  if (!CB._src || !D.tagIndex) { if (typeof toast === "function") toast("자료를 먼저 불러오세요."); return; }
  var set = cbResolveSet(); if (!set) return;
  var all = cbBuildWorks();
  var per = periodLabel(CB.period), when = CB.when || D.index.latest_date;
  var rows, fname, sheet;
  if (CB.sel.length) {
    var works = cbFiltered(all.works, CB.sel).slice();
    var means = works.map(function (w) { return w.mean; }), rcs = works.map(function (w) { return w.rc; });
    var mn = Math.min.apply(null, means), mx = Math.max.apply(null, means);
    var rn = Math.min.apply(null, rcs), rx = Math.max.apply(null, rcs);
    works.forEach(function (w) {
      var rk = (mx === mn) ? 1 : (mx - w.mean) / (mx - mn);
      var rt = (rx === rn) ? 1 : (w.rc - rn) / (rx - rn);
      w.score = 100 * (0.7 * rk + 0.3 * rt);
    });
    works.sort(function (a, b) { return b.score - a.score || a.mean - b.mean; });
    rows = [["조합", CB.sel.map(function (k) { return "#" + k; }).join(" + ")],
      ["분류", CB.group], ["기간", per], ["시점", cbWhenLabel()], ["작품 수", works.length], [],
      ["표시순위", "제목", "작가", "해당기간순위", "별점수", "점수", "키워드"]];
    works.forEach(function (w, i) {
      rows.push([i + 1, w.t || "", (w.a || []).join(", "), w.mean, w.rc, Math.round(w.score), (w.tags || []).join(", ")]);
    });
    fname = "리디_조합_" + CB.sel.join("_") + "_" + per + "_" + when;
    sheet = "조합 작품";
  } else {
    var pairs = cbComputePairs(all, set);
    var sortName = { rank: "순위강한순", rc: "별점수많은순", lift: "유의미도순" }[CB.sort];
    rows = [["분류", CB.group], ["기간", per], ["시점", cbWhenLabel()], ["정렬", sortName], [],
      ["조합", "작품수", "비율(%)", "평균순위", "별점수", "유의미도(배)"]];
    pairs.forEach(function (p) {
      rows.push([p.set.map(function (k) { return "#" + k; }).join(" + "),
        p.n, Math.round(p.ratio * 1000) / 10, Math.round(p.avg * 10) / 10, p.rc, Math.round(p.lift * 100) / 100]);
    });
    fname = "리디_강한조합_" + CB.group + "_" + per + "_" + when;
    sheet = "강한 조합";
  }
  MiniXlsx.download(rows, fname + ".xlsx", sheet);
  if (typeof toast === "function") toast("엑셀을 내려받았습니다.");
}

/** 고른 키워드가 붙은 작품들 안에서, 함께 붙은 다른 키워드의 비율을 보여준다. */
function showCooccur(tag, ids, tagIndex) {
  var tagId = tagIndex.dict.indexOf(tag);
  if (tagId < 0) return;

  // 이 키워드를 가진 작품만 추린다
  var withTag = ids.filter(function (id) {
    var l = tagIndex.books[id];
    return l && l.indexOf(tagId) >= 0;
  });
  // 전체(범위 안에서 태그를 확보한 작품) 대비 비교용
  var allTagged = ids.filter(function (id) {
    var l = tagIndex.books[id];
    return l && l.length;
  });

  function tally(list) {
    var c = {};
    list.forEach(function (id) {
      var seen = {};
      (tagIndex.books[id] || []).forEach(function (ti) {
        if (seen[ti]) return;
        seen[ti] = 1;
        c[ti] = (c[ti] || 0) + 1;
      });
    });
    return c;
  }
  var withC = tally(withTag);
  var allC = tally(allTagged);

  var rows = Object.keys(withC).map(function (ti) {
    var n = withC[ti];
    var base = allTagged.length ? (allC[ti] || 0) / allTagged.length : 0;   // 전체 비율
    var here = withTag.length ? n / withTag.length : 0;                     // 이 안에서의 비율
    return {
      name: tagIndex.dict[ti],
      n: n,
      here: here,
      lift: base > 0 ? here / base : 0,
      isSelf: parseInt(ti, 10) === tagId
    };
  }).filter(function (r) { return !r.isSelf && r.n >= 2; })
    .sort(function (a, b) { return b.here - a.here; });

  var sheet = $("#sheet");
  sheet.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  var body = $("#sheetBody");
  body.innerHTML = "";

  var h = el("div");
  h.appendChild(el("h2", "", "#" + tag + " 와(과) 같이 붙는 키워드"));
  h.appendChild(el("p", "hint",
    "지금 보고 있는 범위에서 #" + tag + "이(가) 붙은 작품 " + withTag.length + "편 기준입니다."));
  body.appendChild(h);

  if (!rows.length) {
    body.appendChild(el("p", "empty", "같이 붙은 키워드가 아직 충분하지 않습니다."));
    return;
  }

  var card = el("div", "card");
  card.appendChild(el("h3", "", "함께 나오는 비율"));
  var listBox = el("div", "kwlist");
  rows.slice(0, 30).forEach(function (r, i) {
    var row = el("div", "kwrow");
    row.appendChild(el("div", "kn", i + 1));
    row.appendChild(el("div", "kw", "#" + r.name));
    var track = el("div", "ktrack");
    var fill = el("div", "kfill");
    fill.style.width = (r.here * 100).toFixed(1) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("div", "kval", Math.round(r.here * 100) + "% · " + r.n + "편"));
    listBox.appendChild(row);
  });
  card.appendChild(listBox);
  body.appendChild(card);

  // 이 키워드와 유난히 붙어 다니는 조합 (전체 평균 대비 몇 배인지)
  var strong = rows.filter(function (r) { return r.lift >= 1.5 && r.n >= 3; })
    .sort(function (a, b) { return b.lift - a.lift; }).slice(0, 15);
  if (strong.length) {
    var c2 = el("div", "card");
    c2.appendChild(el("h3", "", "특히 자주 붙는 조합"));
    c2.appendChild(el("p", "hint",
      "이 범위 전체에서 나오는 비율보다 유난히 높게 함께 나오는 키워드입니다."));
    var tb = el("div", "tags");
    tb.style.marginTop = "8px";
    strong.forEach(function (r) {
      tb.appendChild(el("span", "tag k", "#" + r.name + " ×" + r.lift.toFixed(1)));
    });
    c2.appendChild(tb);
    body.appendChild(c2);
  }
}

// ────────────────────────────────────────── 이벤트 화면
function setupEvent() {
  $("#eventQ").addEventListener("input", drawEvents);
  $("#eventSort").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.eventSort = b.dataset.sort;
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    drawEvents();
  });
  $("#eventStatus").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.eventStatus = b.dataset.st;
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    drawEvents();
  });
}

/** 지금 화면에 필요한 이벤트 목록을 (필요하면 불러와서) 돌려준다. */
function eventPool() {
  var need = UI.eventStatus;
  if (!D.events) return null;
  if (need === "ongoing") return D.events;
  if (!D.endedEvents) return null;                 // 종료분은 누를 때만 불러온다
  if (need === "ended") return D.endedEvents;
  return D.events.concat(D.endedEvents);
}

function drawEvents() {
  if (UI.view !== "event") return;
  var box = $("#eventList");

  var pool = eventPool();
  if (!pool) {
    box.innerHTML = '<p class="empty">불러오는 중…</p>';
    var jobs = [];
    if (!D.events) {
      jobs.push(softJSON("data/events/latest.json").then(function (j) {
        D.events = (j && j.events) || [];
      }));
    }
    if (UI.eventStatus !== "ongoing" && !D.endedEvents) {
      jobs.push(softJSON("data/events/ended.json").then(function (j) {
        D.endedEvents = (j && j.events) || [];
      }));
    }
    Promise.all(jobs).then(drawEvents);
    return;
  }

  var q = $("#eventQ").value.trim().toLowerCase();
  var today = kstDay(new Date());
  var list = pool.filter(function (e) {
    return !q || (e.title || "").toLowerCase().indexOf(q) >= 0;
  });

  var endedView = UI.eventStatus === "ended";
  list.sort(function (a, b) {
    if (UI.eventSort === "start") {
      return new Date(b.start_date || 0) - new Date(a.start_date || 0);
    }
    // 진행 중은 곧 끝나는 것부터, 종료된 것은 최근에 끝난 것부터
    var d = new Date(a.end_date || 0) - new Date(b.end_date || 0);
    return endedView ? -d : d;
  });

  var LIMIT = 500;
  var label = { ongoing: "진행 중", ended: "종료됨", all: "전체" }[UI.eventStatus];
  $("#eventHead").innerHTML = label + " <b>" + num(list.length) + "</b>건"
    + (list.length > LIMIT ? " (앞의 " + LIMIT + "건만 표시)" : "")
    + (UI.eventStatus === "ongoing" && D.index && D.index.ended_count
        ? " · 종료된 이벤트 " + num(D.index.ended_count) + "건은 '종료됨'에서" : "");

  box.innerHTML = "";
  list.slice(0, LIMIT).forEach(function (e) {
    var isEnded = e.status === "ended";
    var row = el("div", "eventrow");

    var h = el("h3");
    if (isEnded) h.appendChild(el("span", "badge", "종료"));
    var a = el("a", "", " " + e.title);
    a.href = e.url; a.target = "_blank"; a.rel = "noopener";
    h.appendChild(a);
    row.appendChild(h);

    var when = el("div", "when");
    when.textContent = fmtDate(e.start_date) + " ~ " + fmtDate(e.end_date) + "  ";
    // 한국시간 '날짜' 기준으로 센다. 시각으로 재면 어제 밤에 끝난 것이
    // '오늘 종료'로 보이는 등 하루씩 어긋난다.
    var gap = dayGap(kstDay(e.end_date), today);
    if (gap !== null) {
      if (gap > 0 && !isEnded) {
        if (gap < 3650) {
          when.appendChild(el("span", "dday" + (gap <= 3 ? " soon" : ""), "D-" + gap));
        }
      } else if (gap === 0) {
        when.appendChild(el("span", "dday soon", "오늘 종료"));
      } else {
        when.appendChild(el("span", "dday",
          gap === -1 ? "어제 종료" : (-gap) + "일 전 종료"));
      }
    }
    row.appendChild(when);

    if (e.description) row.appendChild(el("div", "desc", e.description));
    box.appendChild(row);
  });
  if (!list.length) box.appendChild(el("p", "empty", "해당하는 이벤트가 없습니다."));
}

// ────────────────────────────────────────── 검색 화면
function setupSearch() {
  var t = null;
  $("#searchQ").addEventListener("input", function () {
    clearTimeout(t);
    t = setTimeout(runSearch, 220);
  });
}

function runSearch() {
  var q = $("#searchQ").value.trim().toLowerCase();
  var list = $("#searchList");
  list.innerHTML = "";
  if (q.length < 1) { $("#searchHint").textContent = "모아둔 데이터 전체에서 찾습니다."; return; }

  if (!D.catalog) {
    $("#searchHint").textContent = "작품 목록을 불러오는 중…";
    getJSON("data/books.json").then(function (j) { D.catalog = j; runSearch(); })
      .catch(function () { $("#searchHint").textContent = "작품 목록을 불러오지 못했습니다."; });
    return;
  }

  var hits = [];
  for (var id in D.catalog) {
    var b = D.catalog[id];
    if (UI.hideAdult && b.ad) continue;
    var hay = (b.t || "") + " " + (b.a || []).join(" ");
    if (hay.toLowerCase().indexOf(q) >= 0) hits.push([id, b]);
    if (hits.length > 300) break;
  }
  hits.sort(function (x, y) { return (y[1].rc || 0) - (x[1].rc || 0); });

  $("#searchHint").textContent = hits.length + "건 찾았습니다."
    + (hits.length > 300 ? " (많아서 일부만 표시)" : "");
  hits.slice(0, 100).forEach(function (h, i) {
    list.appendChild(bookRow(h[0], h[1], i + 1, null));
  });
  if (!hits.length) list.appendChild(el("li", "empty", "찾는 작품이 없습니다."));
}

// ────────────────────────────────────────── 작품 상세
function openBook(id, ctxKey) {
  var sheet = $("#sheet");
  sheet.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  var body = $("#sheetBody");
  body.innerHTML = '<p class="empty">불러오는 중…</p>';

  // 추이 파일은 한 달치가 6MB쯤 된다. 최근 3개월만 읽어 화면이 무거워지지 않게 한다.
  // (더 긴 기간이 필요해지면 파일을 분류별로 쪼개야 한다)
  var months = (D.index.months || []).slice(-3);
  Promise.all([
    softJSON("data/books/" + id + ".json"),
    softJSON("data/reviews/" + id + ".json"),
    Promise.all(months.map(function (m) {
      return D.history[m] ? Promise.resolve(D.history[m])
        : softJSON("data/history/" + m + ".json").then(function (j) { D.history[m] = j; return j; });
    })),
    D.events ? Promise.resolve(D.events)
      : softJSON("data/events/latest.json").then(function (j) { D.events = (j && j.events) || []; return D.events; })
  ]).then(function (r) {
    drawBook(id, r[0], r[1], r[2].filter(Boolean), ctxKey);
  });
}

function closeSheet() {
  $("#sheet").classList.add("hidden");
  document.body.style.overflow = "";
}
document.addEventListener("click", function (e) {
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") closeSheet();
});

function drawBook(id, detail, reviewData, months, ctxKey) {
  var b = D.latest.books[id] || (D.catalog && D.catalog[id]) || {};
  var body = $("#sheetBody");
  body.innerHTML = "";

  // ── 머리말 ──
  var head = el("div", "dhead");
  var img = el("img");
  img.src = coverUrl(id, "large"); img.alt = "";
  img.onerror = function () { this.style.visibility = "hidden"; };
  head.appendChild(img);

  var hi = el("div");
  // 제목은 카탈로그(books.json)가 항상 최신이다. 상세 파일은 다시 받을 때만 갱신된다.
  hi.appendChild(el("h2", "", b.t || (detail && detail.title) || id));
  hi.appendChild(el("div", "au", (b.a || (detail && (detail.authors_full || []).map(function (a) { return a.name; })) || []).join(", ")));
  var stats = el("div", "dstats");
  if (b.st) stats.appendChild(el("span", "badge set", b.sn ? "세트 " + b.sn + "권" : "세트"));
  if (b.r) stats.appendChild(el("span", "badge", "★ " + b.r + " (" + num(b.rc) + ")"));
  if (b.x) stats.appendChild(el("span", "badge ex", (detail && detail.exclusive_label) || "리디 독점"));
  if (b.ad) stats.appendChild(el("span", "badge ad", "19+"));
  stats.appendChild(el("span", "badge", b.c ? "완결" : "연재중"));
  if (b.ep) stats.appendChild(el("span", "badge", "총 " + b.ep + (b.u || "화")));
  if (b.pb) stats.appendChild(el("span", "badge", b.pb));
  hi.appendChild(stats);

  var btns = el("div", "btnrow");
  var open = el("a", "btn", "리디에서 보기");
  open.href = bookUrl(id); open.target = "_blank"; open.rel = "noopener";
  btns.appendChild(open);
  var dl = el("button", "btn pri", "엑셀로 내려받기");
  dl.addEventListener("click", function () { exportBook(id, b, detail, months); });
  btns.appendChild(dl);
  hi.appendChild(btns);
  head.appendChild(hi);
  body.appendChild(head);

  // ── 순위 추이 ──
  body.appendChild(rankTrendCard(id, months, ctxKey));

  // ── 별점 개수 추이 ──
  // 평균 별점(4.9x)은 거의 안 변해서 추이로 의미가 없다. 대신 별점(참여) 개수가
  // 며칠간 얼마나 늘었는지를 보여준다. 값이 늘수록 위로 올라간다(invert 안 함).
  var countSeries = collectSeries(months, function (h) { return (h.count || {})[id]; });
  var cPts = countSeries.pts.filter(function (p) { return p.v !== null; });
  if (cPts.length >= 2) {
    var rc = el("div", "card");
    rc.appendChild(el("h3", "", "별점 개수 추이"));
    var w = el("div", "chartwrap");
    w.appendChild(lineChart(countSeries.pts, {
      invert: false, fmt: function (v) { return num(Math.round(v)); }
    }));
    rc.appendChild(w);
    var first = cPts[0].v, last = cPts[cPts.length - 1].v, diff = last - first;
    rc.appendChild(el("p", "hint",
      cPts.length + "일간 " + num(first) + "개 → " + num(last) + "개"
      + " (" + (diff >= 0 ? "+" : "") + num(diff) + "개)"
      + (countSeries.gaps ? " · 수집 없던 날 " + countSeries.gaps + "일 빈칸" : "")));
    body.appendChild(rc);
  } else if (b.rc) {
    // 아직 추이가 쌓이지 않은 작품(오늘 처음 잡힌 등)은 현재 개수만 안내.
    var rc0 = el("div", "card");
    rc0.appendChild(el("h3", "", "별점 개수 추이"));
    rc0.appendChild(el("p", "hint",
      "현재 별점 " + num(b.rc) + "개. 며칠 더 모이면 늘어나는 추이가 그려집니다."));
    body.appendChild(rc0);
  }

  // ── 태그 ──
  var tags = (detail && detail.tags) || [];
  // "별점1000개이상" 같은 통계성 표시는 이미 위에 별점으로 나오므로 화면에서는 뺀다
  var metaTags = ((detail && detail.meta_tags) || []).filter(function (t) {
    return !/^(별점|리뷰|평점|조회)/.test(t);
  });
  if (tags.length || metaTags.length) {
    var tc = el("div", "card");
    tc.appendChild(el("h3", "", "키워드 · 태그"));
    var tb = el("div", "tags");
    tags.forEach(function (t) { tb.appendChild(el("span", "tag k", "#" + t)); });
    metaTags.forEach(function (t) { tb.appendChild(el("span", "tag", t)); });
    tc.appendChild(tb);
    body.appendChild(tc);
  }

  // ── 현재 걸린 이벤트 ──
  var evIds = (detail && detail.event_ids) || [];
  if (evIds.length && D.events) {
    var byId = {};
    D.events.forEach(function (e) { byId[String(e.id)] = e; });
    var hits = evIds.map(function (x) { return byId[String(x)]; }).filter(Boolean);
    if (hits.length) {
      var ec = el("div", "card");
      ec.appendChild(el("h3", "", "지금 걸려 있는 이벤트"));
      hits.forEach(function (e) {
        var row = el("div", "rv");
        var a = el("a", "", e.title);
        a.href = e.url; a.target = "_blank"; a.rel = "noopener";
        a.style.fontWeight = "600";
        row.appendChild(a);
        row.appendChild(el("div", "m", fmtDate(e.start_date) + " ~ " + fmtDate(e.end_date)));
        ec.appendChild(row);
      });
      body.appendChild(ec);
    }
  }

  // ── 기다리면 무료 ──
  var wff = detail && detail.wait_for_free;
  if (wff && wff.interval_hours) {
    var wc = el("div", "card");
    wc.appendChild(el("h3", "", "기다리면 무료"));
    var kv = el("dl", "kv");
    kv.appendChild(el("dt", "", "대기 시간")); kv.appendChild(el("dd", "", wff.interval_hours + "시간"));
    if (wff.closing_date) {
      kv.appendChild(el("dt", "", "종료일")); kv.appendChild(el("dd", "", fmtDate(wff.closing_date)));
    }
    wc.appendChild(kv);
    body.appendChild(wc);
  }

  // ── 작품 소개 ──
  if (detail && detail.description) {
    var dc = el("div", "card");
    dc.appendChild(el("h3", "", "작품 소개"));
    var p = el("div", "desc", detail.description);
    dc.appendChild(p);
    var more = el("button", "more", "더 보기");
    more.addEventListener("click", function () {
      p.classList.toggle("open");
      more.textContent = p.classList.contains("open") ? "접기" : "더 보기";
    });
    dc.appendChild(more);
    body.appendChild(dc);
  }

  // ── 별점 분포 ──
  if (detail && detail.rating_dist) {
    var dist = detail.rating_dist;
    var total = [1, 2, 3, 4, 5].reduce(function (s, k) { return s + (dist[k] || 0); }, 0);
    if (total > 0) {
      var bc = el("div", "card");
      bc.appendChild(el("h3", "", "별점 분포"));
      var bars = el("div", "bars");
      [5, 4, 3, 2, 1].forEach(function (k) {
        bars.appendChild(barRow(k + "점", dist[k] || 0, total));
      });
      bc.appendChild(bars);
      body.appendChild(bc);
    }
  }

  // ── 리뷰 분석 ──
  body.appendChild(reviewCard(reviewData));
}

function barRow(label, value, total, cls) {
  var row = el("div", "bar");
  row.appendChild(el("div", "", label));
  var track = el("div", "track");
  var fill = el("div", "fill" + (cls ? " " + cls : ""));
  fill.style.width = (total ? (value / total * 100) : 0).toFixed(1) + "%";
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el("div", "n", num(value)));
  return row;
}

// ── 순위 추이 카드 (일간/주간/월간/연간 전환) ──
// 랭킹 키 접두어(카테고리ID) → 사람이 읽는 이름·성격. latest.json 에서 한 번만 만든다.
var _catLabels = null;
function catLabelMap() {
  if (_catLabels) return _catLabels;
  _catLabels = {};
  var R = (D.latest && D.latest.rankings) || {};
  Object.keys(R).forEach(function (k) {
    var t = R[k];
    var pfx = k.slice(0, k.lastIndexOf("-"));
    if (!_catLabels[pfx]) {
      _catLabels[pfx] = { name: t.name, isAll: !!t.is_all, isSub: !!t.is_sub };
    }
  });
  return _catLabels;
}

// 순위 추이 카드.
//   한 작품은 여러 랭킹에 동시에 오른다 (예: '전체 웹소설' + '로맨스 웹소설' + '현대물').
//   예전에는 그중 하나를 임의로(사실상 '전체') 골라 그려서, 로맨스에서 눌러도
//   전체 순위가 나왔다. 이제 '어느 랭킹 기준으로 볼지'를 고를 수 있게 하고,
//   작품을 열었던 그 랭킹(ctxKey)을 기본값으로 보여준다.
function rankTrendCard(id, months, ctxKey) {
  var card = el("div", "card");
  card.appendChild(el("h3", "", "순위 추이"));

  var labels = catLabelMap();

  // 이 작품이 실제로 오른 랭킹들을 카테고리별로 모은다: {접두어: {기간: 전체키}}
  var byCat = {};
  months.forEach(function (m) {
    var slot = (m.rank || {})[id];
    if (!slot) return;
    Object.keys(slot).forEach(function (k) {
      var dash = k.lastIndexOf("-");
      var pfx = k.slice(0, dash), per = k.slice(dash + 1);
      if (!labels[pfx]) return;               // latest 에 없는(사라진) 랭킹은 무시
      (byCat[pfx] || (byCat[pfx] = {}))[per] = k;
    });
  });
  var cats = Object.keys(byCat);
  if (!cats.length) {
    card.appendChild(el("p", "hint", "아직 추이 데이터가 없습니다. 며칠 모으면 그래프가 그려집니다."));
    return card;
  }
  // 정렬: 전체 → 대표 장르 → 세부 장르
  function order(c) { return labels[c].isAll ? 0 : (labels[c].isSub ? 2 : 1); }
  cats.sort(function (a, b) { return order(a) - order(b); });

  // 기본 선택: 열었던 랭킹(ctxKey). 없으면 대표 장르, 그것도 없으면 첫째.
  var ctxPfx = ctxKey ? ctxKey.slice(0, ctxKey.lastIndexOf("-")) : null;
  var state = {
    cat: (ctxPfx && byCat[ctxPfx]) ? ctxPfx
       : (cats.filter(function (c) { return order(c) === 1; })[0] || cats[0]),
    period: null,
  };

  var catSeg = el("div", "seg small");
  var perSeg = el("div", "seg small");
  perSeg.style.marginTop = "6px";
  var wrap = el("div", "chartwrap");
  var note = el("p", "hint");

  function periodsOf(cat) {
    return PERIOD_ORDER.filter(function (p) { return byCat[cat][p]; });
  }

  function draw() {
    Array.prototype.forEach.call(catSeg.children, function (b) {
      b.classList.toggle("on", b.dataset.c === state.cat);
    });
    var pers = periodsOf(state.cat);
    if (pers.indexOf(state.period) < 0) state.period = pers[0];
    perSeg.innerHTML = "";
    pers.forEach(function (p) {
      var b = el("button", state.period === p ? "on" : "", periodLabel(p));
      b.dataset.p = p;
      b.addEventListener("click", function () { state.period = p; draw(); });
      perSeg.appendChild(b);
    });

    var key = byCat[state.cat][state.period];
    var s = collectSeries(months, function (h) { return ((h.rank || {})[id] || {})[key]; });
    wrap.innerHTML = "";
    var pts = s.pts.filter(function (p) { return p.v !== null; });
    if (pts.length < 2) {
      wrap.appendChild(el("p", "hint", "기록이 " + pts.length + "일치뿐이라 아직 선을 그릴 수 없습니다."));
    } else {
      wrap.appendChild(lineChart(s.pts, { invert: true, fmt: function (v) { return v + "위"; } }));
    }
    var vals = pts.map(function (p) { return p.v; });
    note.textContent = vals.length
      ? labels[state.cat].name + " 기준 · 최고 " + Math.min.apply(null, vals) + "위 · 최근 "
        + vals[vals.length - 1] + "위 · " + vals.length + "일 기록"
        + (s.gaps ? " · 수집 없던 날 " + s.gaps + "일 빈칸" : "")
      : "";
  }

  // 랭킹이 둘 이상일 때만 '어느 랭킹으로 볼지' 버튼을 보인다.
  if (cats.length > 1) {
    cats.forEach(function (c) {
      var b = el("button", "", labels[c].name);
      b.dataset.c = c;
      b.addEventListener("click", function () { state.cat = c; draw(); });
      catSeg.appendChild(b);
    });
    card.appendChild(catSeg);
  }
  card.appendChild(perSeg);
  card.appendChild(wrap);
  card.appendChild(note);
  draw();
  return card;
}

/** 월별 파일들에서 하나의 시계열을 뽑아 [{d:날짜, v:값}] 로 만든다.
 *
 * 수집이 없던 날(예: 2026-08-27 — GitHub 예약 실행이 누락된 날)은 빈칸으로 채운다.
 * 그냥 앞뒤를 이어 그리면 없는 데이터가 있는 것처럼 보이기 때문이다.
 */
function collectSeries(months, pick) {
  var byDate = {}, seen = [];
  months.forEach(function (h) {
    if (!h || !h.days) return;
    var arr = pick(h) || [];
    h.days.forEach(function (day, i) {
      var v = (i < arr.length) ? arr[i] : null;
      byDate[day] = (v === undefined ? null : v);
      seen.push(day);
    });
  });
  if (!seen.length) return { pts: [], gaps: 0 };

  seen.sort();
  var pts = [], gaps = 0;
  var cur = new Date(seen[0] + "T00:00:00Z");
  var end = new Date(seen[seen.length - 1] + "T00:00:00Z");
  while (cur <= end) {
    var key = cur.toISOString().slice(0, 10);
    if (key in byDate) {
      pts.push({ d: key, v: byDate[key] });
    } else {
      pts.push({ d: key, v: null, missing: true });   // 그날은 수집 자체가 없었다
      gaps++;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { pts: pts, gaps: gaps };
}

// ── 선 그래프 (SVG 직접 그리기) ──
function lineChart(pts, opt) {
  opt = opt || {};
  var W = 640, H = 200, L = 42, R = 10, T = 12, B = 26;
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("class", "chart");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.height = "200px";

  function mk(tag, attrs, text) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var vals = pts.map(function (p) { return p.v; }).filter(function (v) { return v !== null; });
  if (!vals.length) return svg;
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (min === max) { min -= 1; max += 1; }
  var pad = (max - min) * 0.12;
  min -= pad; max += pad;
  if (opt.invert) { min = Math.max(1, min); }

  function X(i) { return L + (pts.length <= 1 ? 0 : i * (W - L - R) / (pts.length - 1)); }
  function Y(v) {
    var t = (v - min) / (max - min);
    return opt.invert ? (T + t * (H - T - B)) : (H - B - t * (H - T - B));
  }

  [0, 0.5, 1].forEach(function (f) {
    var v = min + f * (max - min);
    var y = Y(v);
    svg.appendChild(mk("line", { x1: L, y1: y, x2: W - R, y2: y, class: "grid" }));
    svg.appendChild(mk("text", { x: 4, y: y + 3.5 }, opt.fmt ? opt.fmt(Math.round(v * 100) / 100) : v));
  });

  // 값이 없는 날에는 두 가지가 있다.
  //   · missing  = 우리가 그날 수집을 못 한 날  → 앞뒤를 이어 그린다 (가로 간격은 그대로 둠)
  //   · 그 외     = 그날 순위 밖이었던 것       → 선을 끊는다
  var d = "", started = false;
  pts.forEach(function (p, i) {
    if (p.v === null) {
      if (!p.missing) started = false;
      return;
    }
    d += (started ? " L" : " M") + X(i) + " " + Y(p.v);
    started = true;
  });
  svg.appendChild(mk("path", { d: d.trim(), class: "ln" }));

  pts.forEach(function (p, i) {
    if (p.v === null) return;
    var c = mk("circle", { cx: X(i), cy: Y(p.v), r: 2.5, class: "dot" });
    c.appendChild(mk("title", {}, p.d + " · " + (opt.fmt ? opt.fmt(p.v) : p.v)));
    svg.appendChild(c);
  });

  if (pts.length) {
    svg.appendChild(mk("text", { x: L, y: H - 8 }, pts[0].d.slice(5)));
    var last = pts[pts.length - 1];
    svg.appendChild(mk("text", { x: W - R, y: H - 8, "text-anchor": "end" }, last.d.slice(5)));
  }
  return svg;
}

// ── 리뷰 분석 ──
var STOPWORDS = ("그리고 그래서 하지만 그런데 그러나 정말 진짜 너무 아주 완전 조금 약간 다시 계속 " +
  "이거 저거 그거 여기 저기 거기 이건 그건 저건 하나 진행 작품 소설 웹툰 내용 이야기 스토리 " +
  "생각 느낌 부분 정도 때문 그냥 역시 이제 아직 지금 나중 처음 마지막 다음 이번 저희 우리 " +
  "제가 저는 나는 근데 인데 라고 라는 하는 되는 있는 없는 같은 많은 좋은 보고 읽고 " +
  "합니다 했어요 해요 이런 저런 어떤 무슨 진심 완전히 굉장히 엄청 그램 편이 작가 작가님 " +
  "감사 감사합니다 기대 다음화 리디 소장 대여 결제 무료 최고 존잼 잘봤 잘보 재밌 재미 " +
  "이렇게 그렇게 저렇게 어떻게 않고 않은 않아 않네 읽었 봤어 봤네 좋아 좋네 제일 시작 " +
  "정주행 다음편 담편 계속 얼른 빨리 이건 그건 진짜로 완전 그저 여기 아마 혹시 " +
  "작가님 님의 작품이 소설이 웹툰이 이번화 회차 연재 결말 초반 후반 중반"
  ).split(/\s+/).filter(Boolean);
var STOPSET = {};
STOPWORDS.forEach(function (w) { STOPSET[w] = 1; });

function reviewKeywords(reviews, topN) {
  var freq = {};
  reviews.forEach(function (r) {
    var text = (r.content || "");
    var tokens = text.split(/[^가-힣A-Za-z0-9]+/);
    var seen = {};
    tokens.forEach(function (raw) {
      var w = raw.trim();
      if (w.length < 2 || w.length > 8) return;
      // 조사·어미를 대충 떼어낸다 (완벽하진 않지만 경향 파악에는 충분)
      w = w.replace(/(이었|였|하는|해서|하고|한테|에게|에서|으로|까지|부터|이라|라서|네요|어요|아요|습니다|입니다|는데|지만|면서|다가|이다|하다)$/, "");
      w = w.replace(/(은|는|이|가|을|를|의|에|도|만|과|와|랑|께|요)$/, "");
      if (w.length < 2 || STOPSET[w]) return;
      if (/^\d/.test(w)) return;                       // "200회" 같은 숫자 표현 제외
      if (/(작가님|작가)$/.test(w) && w.length > 3) return;
      if (seen[w]) return;            // 한 리뷰에서 같은 단어는 한 번만
      seen[w] = 1;
      freq[w] = (freq[w] || 0) + 1;
    });
  });
  return Object.keys(freq).map(function (w) { return [w, freq[w]]; })
    .filter(function (p) { return p[1] >= 2; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, topN || 24);
}

function reviewCard(data) {
  var card = el("div", "card");
  if (!data || !data.reviews || !data.reviews.length) {
    card.appendChild(el("h3", "", "리뷰"));
    card.appendChild(el("p", "hint", "이 작품의 리뷰는 아직 모으지 않았습니다.\n리뷰는 순위가 높은 작품부터 차례로 모읍니다."));
    return card;
  }

  var rs = data.reviews;
  var h = el("h3");
  h.innerHTML = "리뷰 분석 <span class='r'>모아둔 " + num(rs.length) + "건 기준</span>";
  card.appendChild(h);

  // 긍정/부정 (별점 기준 — 지어내지 않고 실제 점수로 계산)
  var pos = rs.filter(function (r) { return r.rating >= 4; }).length;
  var neu = rs.filter(function (r) { return r.rating === 3; }).length;
  var neg = rs.filter(function (r) { return r.rating <= 2; }).length;
  var bars = el("div", "bars");
  bars.appendChild(barRow("긍정", pos, rs.length, "pos"));
  bars.appendChild(barRow("보통", neu, rs.length));
  bars.appendChild(barRow("부정", neg, rs.length, "neg"));
  card.appendChild(bars);
  card.appendChild(el("p", "hint", "별점 4~5점을 긍정, 3점을 보통, 1~2점을 부정으로 계산했습니다."));

  // 리뷰 수 추이
  if (data.history && data.history.length >= 2) {
    var pts = data.history.map(function (x) { return { d: x.date, v: x.count }; });
    var w = el("div", "chartwrap");
    w.style.marginTop = "12px";
    w.appendChild(lineChart(pts, { invert: false, fmt: function (v) { return num(Math.round(v)) + "건"; } }));
    card.appendChild(el("h3", "", "모은 리뷰 수 추이"));
    card.appendChild(w);
  }

  // 자주 나오는 말
  var kws = reviewKeywords(rs);
  if (kws.length) {
    card.appendChild(el("h3", "", "리뷰에 자주 나오는 말"));
    var tb = el("div", "tags");
    kws.forEach(function (p) {
      var t = el("span", "tag", p[0] + " " + p[1]);
      t.style.fontSize = Math.min(1.05, 0.74 + p[1] / (kws[0][1] * 4)) + "rem";
      tb.appendChild(t);
    });
    card.appendChild(tb);
  }

  // 최근 리뷰
  card.appendChild(el("h3", "", "최근 리뷰"));
  var box = el("div", "reviews");
  rs.slice(0, 12).forEach(function (r) {
    var rv = el("div", "rv");
    var m = el("div", "m");
    m.appendChild(el("span", "", "★".repeat(Math.max(0, r.rating)) ));
    m.appendChild(el("span", "", r.user || ""));
    m.appendChild(el("span", "", (r.at || "").slice(0, 10)));
    if (r.likes) m.appendChild(el("span", "", "공감 " + r.likes));
    if (r.buyer) m.appendChild(el("span", "", "구매자"));
    rv.appendChild(m);
    rv.appendChild(el("div", "c", r.content || ""));
    box.appendChild(rv);
  });
  card.appendChild(box);
  return card;
}

// ── 엑셀 내보내기 ──
function exportBook(id, b, detail, months) {
  var keys = {};
  months.forEach(function (h) {
    var slot = (h.rank || {})[id];
    if (slot) Object.keys(slot).forEach(function (k) { keys[k] = 1; });
  });
  var keyList = Object.keys(keys).sort(function (a, b2) {
    return PERIOD_ORDER.indexOf(a.split("-")[1]) - PERIOD_ORDER.indexOf(b2.split("-")[1]);
  });

  var byDate = {};
  months.forEach(function (h) {
    if (!h || !h.days) return;
    h.days.forEach(function (day, i) {
      var row = byDate[day] || (byDate[day] = {});
      keyList.forEach(function (k) {
        var arr = ((h.rank || {})[id] || {})[k];
        if (arr && i < arr.length && arr[i] !== null) row[k] = arr[i];
      });
      var ra = (h.rating || {})[id];
      if (ra && i < ra.length && ra[i] !== null) row.__r = ra[i];
    });
  });

  var dates = Object.keys(byDate).sort();
  if (!dates.length) { toast("아직 내려받을 추이 기록이 없습니다."); return; }

  var header = ["날짜"].concat(keyList.map(function (k) {
    var t = D.latest.rankings[k];
    return (t ? t.name : k.split("-")[0]) + " " + periodLabel(k.split("-")[1]);
  })).concat(["평균 별점"]);

  var rows = [
    ["작품", (detail && detail.title) || b.t || id],
    ["작가", (b.a || []).join(", ")],
    ["작품 주소", bookUrl(id)],
    ["내려받은 날", D.latest.date],
    [],
    header
  ];
  dates.forEach(function (d) {
    var r = byDate[d];
    rows.push([d].concat(keyList.map(function (k) {
      return (r[k] === undefined ? "" : r[k]);
    })).concat([r.__r === undefined ? "" : r.__r]));
  });

  var name = ((detail && detail.title) || b.t || id).replace(/[\\\/:*?"<>|]/g, "").slice(0, 40);
  MiniXlsx.download(rows, "리디_" + name + "_순위추이.xlsx", "순위 추이");
  toast("엑셀 파일을 내려받았습니다.");
}

boot();
