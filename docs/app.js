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
  promo: null,            // 작품별 프로모션 기간 (analysis/promo.json, 작품을 열 때 한 번만)
  shifts: null,           // 순위대 변화 판정 (analysis/shifts.json)
  shiftsById: {},         // 작품ID → 그 작품의 판정 목록
};

var UI = {
  // view 는 "webnovel"·"ebook"·"webtoon"(각각 랭킹 화면) 또는 "move"·"event"·"search"
  view: null,
  section: null, group: null, sub: "", period: "DAILY",
  hideAdult: false,
  moveKey: null, moveKind: "rise",
  moveWhen: null,           // 변동 탭 '시점'에서 마지막으로 고른 값(날짜 또는 "all"). null = 기본값
  moveSeq: 0,               // 변동 탭 그리기 차례 번호(늦게 온 이전 요청 무시용)
  shiftFilter: "all",       // 순위대 변화: all / promo / none / noep
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

// ────────────────────────────────────────── 시점(일간·주간·월간) 공용
// 변동 탭과 조합 탭이 같은 규칙을 쓴다.
//   일간 = 수집일 하나, 주간 = 일요일에 끝나는 주(월~일), 월간 = 달력 달.
//   목록의 값은 그 하루/주/달의 마지막 수집일이다. 그날 스냅샷(daily/날짜.json)을 읽는다.

/** 그 날짜가 든 주의 일요일(주 끝) */
function sundayOf(dateStr) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()) % 7);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 그 날짜가 든 달의 말일 */
function monthEndOf(dateStr) {
  var d = new Date(dateStr.slice(0, 7) + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** 시점 목록 [[값(마지막 수집일), 이름], …] — 최신 것부터.
 *  이름 괄호: 말일/일요일 기록이면 '(말일 기준)'·'(일요일 기준)', 아직 진행 중이거나 그날 기록이 없으면
 *  실제로 쓰는 마지막 수집일 '(10/4까지)'. whenShort 의 '(10/4 기록)'과 같은 규칙이다. */
function whenOptions(period) {
  var dates = ((D.index && D.index.dates) || []).slice().sort();
  var opts = [];
  if (!dates.length) return opts;
  if (period === "MONTHLY") {
    var byM = {}; dates.forEach(function (d) { byM[d.slice(0, 7)] = d; });  // 그 달 마지막 수집일
    Object.keys(byM).sort().reverse().forEach(function (m) {
      var d = byM[m];
      opts.push([d, m.slice(0, 4) + "년 " + (+m.slice(5, 7)) + "월 ("
        + (d === monthEndOf(d) ? "말일 기준" : mdDay(d) + "까지") + ")"]);
    });
  } else if (period === "WEEKLY") {
    var byW = {}; dates.forEach(function (d) { byW[sundayOf(d)] = d; });  // 그 주 마지막 수집일
    Object.keys(byW).sort().reverse().forEach(function (sun) {
      var e = new Date(sun + "T00:00:00Z"), s = new Date(e); s.setUTCDate(s.getUTCDate() - 6);
      var f = function (x) { return (x.getUTCMonth() + 1) + "/" + x.getUTCDate(); };
      var d = byW[sun];
      opts.push([d, f(s) + "~" + f(e) + " 주 (" + (d === sun ? "일요일 기준" : mdDay(d) + "까지") + ")"]);
    });
  } else {  // DAILY, STEADY
    dates.slice().reverse().forEach(function (d) { opts.push([d, d]); });
  }
  return opts;
}

/** 그 날짜가 속한 묶음의 열쇠 — 일간 '2026-09-14', 주간 그 주 일요일, 월간 '2026-09' */
function whenBucket(period, d) {
  if (!d) return null;
  d = String(d).slice(0, 10);
  if (period === "MONTHLY") return d.slice(0, 7);
  if (period === "WEEKLY") return sundayOf(d);
  return d;
}
/** 묶음 이름(짧게): '9/14' · '9/28~10/4 주' · '9월' */
function whenSpan(period, d) {
  if (period === "MONTHLY") return (+d.slice(5, 7)) + "월";
  if (period === "WEEKLY") { var e = sundayOf(d); return mdDay(addDays(e, -6)) + "~" + mdDay(e) + " 주"; }
  return mdDay(d);
}
/** 스냅샷 이름: 묶음 끝까지 모으기 전이면 실제 기록일을 붙인다. 예: '10월(10/4 기록)' */
function whenShort(period, d) {
  var span = whenSpan(period, d);
  var end = period === "MONTHLY" ? monthEndOf(d) : (period === "WEEKLY" ? sundayOf(d) : d);
  return d === end ? span : span + "(" + mdDay(d) + " 기록)";
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
  $("#moveWhen").addEventListener("change", function () { UI.moveWhen = this.value; drawMove(); });
  $("#moveKind").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.moveKind = b.dataset.kind;
    Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    drawMove();
  });
  $("#shiftFilter").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    UI.shiftFilter = b.dataset.f;
    drawMove();
  });
}

/** 지금 고른 랭킹의 기간(DAILY/WEEKLY/MONTHLY/STEADY) */
function movePeriod() {
  var t = D.latest.rankings[UI.moveKey];
  return t ? t.period : "DAILY";
}

/** '시점' 목록을 다시 채우고 실제로 고른 값을 돌려준다.
 *  순위대 변화는 맨 위에 '전체 기간'(기본값)이 있고, 나머지는 최신 시점이 기본값이다.
 *  기간을 바꾸면 고른 날이 든 하루/주/달로 옮긴다(예: 9/14 → 9/14~9/20 주). */
function fillMoveWhen(isShift) {
  var per = movePeriod();
  var opts = whenOptions(per);
  if (isShift) opts.unshift(["all", "전체 기간"]);
  var sel = $("#moveWhen");
  sel.innerHTML = "";
  opts.forEach(function (o) { sel.appendChild(new Option(o[1], o[0])); });
  var vals = opts.map(function (o) { return o[0]; });
  var v = UI.moveWhen;          // 사용자가 마지막으로 고른 값(기간이 바뀌어도 그대로 둔다)
  if (v && v !== "all" && vals.indexOf(v) < 0) {
    var bk = whenBucket(per, v);
    var hit = opts.filter(function (o) { return o[0] !== "all" && whenBucket(per, o[0]) === bk; })[0];
    v = hit ? hit[0] : null;
  }
  if (!v || vals.indexOf(v) < 0) v = vals[0] || null;
  if (v) sel.value = v;
  return v;
}

function drawMove() {
  if (UI.view !== "move") return;
  var isShift = UI.moveKind === "shift";
  $("#shiftTools").classList.toggle("hidden", !isShift);
  $("#moveWhen").closest(".field").classList.remove("hidden");
  var when = fillMoveWhen(isShift);
  UI.moveSeq = (UI.moveSeq || 0) + 1;    // 늦게 도착한 이전 요청이 화면을 덮지 않게
  if (isShift) { drawShifts(when); return; }
  drawMoveChanges(when, UI.moveSeq);
}

/** collect.py compute_changes 와 같은 규칙으로 두 시점의 순위를 비교한다.
 *  moves = 이전 순위 − 지금 순위(양수면 상승), new = 이전에 없던 작품(이전 순위가 있을 때만),
 *  out = 지금 없는 이전 작품, top_risers = 많이 오른 순 20개(같으면 지금 순위 순). */
function compareRanks(ids, prevIds) {
  function rankMap(list) {
    var at = Object.create(null), order = [];
    list.forEach(function (id, i) { if (!(id in at)) order.push(id); at[id] = i + 1; });
    return { at: at, order: order };
  }
  var now = rankMap(ids || []), prev = rankMap(prevIds || []);
  var hasPrev = prev.order.length > 0;
  var moves = {}, moveList = [], newIds = [];
  now.order.forEach(function (id) {
    if (id in prev.at) {
      var diff = prev.at[id] - now.at[id];
      if (diff !== 0) { moves[id] = diff; moveList.push([id, diff]); }
    } else if (hasPrev) {
      newIds.push(id);
    }
  });
  var out = hasPrev ? prev.order.filter(function (id) { return !(id in now.at); }) : [];
  var risers = moveList.slice().sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20);
  return { moves: moves, new: newIds, out: out, top_risers: risers, has_prev: hasPrev };
}

/** 그날 스냅샷. 최신 날은 이미 받은 latest 를 쓰고, 지난 날은 daily 파일(한 번 받으면 캐시). */
function snapOf(date) {
  if (date === D.latest.date) return Promise.resolve({ date: date, rankings: D.latest.rankings });
  return loadDaily(date);
}

// 최고 급상승 · 신규 진입 · 순위권 이탈
//   선택 시점 S 와 목록에서 바로 앞 시점 P 의 랭킹을 비교한다
//   (일간 = 직전 수집일, 주간 = 직전 주의 마지막 수집일, 월간 = 직전 달의 마지막 수집일).
//   S 가 최신이고 P 가 어제 기록이면 Actions가 계산해 둔 latest.changes 를 그대로 쓴다(추가 다운로드 없음).
var MOVE_PREV_TRIES = 3;   // 일간 비교에서 P 에 랭킹이 없을 때 더 앞 수집일로 내려가 볼 횟수
function drawMoveChanges(S, seq) {
  var key = UI.moveKey;
  var table = D.latest.rankings[key];
  var list = $("#moveList"), head = $("#moveHead");
  list.innerHTML = "";
  if (!table) { head.textContent = ""; return; }

  var per = table.period;
  var opts = whenOptions(per);
  var vals = opts.map(function (o) { return o[0]; });
  var i = vals.indexOf(S);
  var P = i >= 0 ? vals[i + 1] : null;
  var title = "<b>" + table.name + "</b> · " + periodLabel(per);

  function notice(msg) {
    head.innerHTML = title + (S ? " · " + whenShort(per, S) : "");
    list.innerHTML = "";
    list.appendChild(el("li", "empty", msg));
  }

  // 수집 기록이 아직 없으면 예전처럼 latest 만으로
  if (!S) {
    var ch0 = D.latest.changes[key];
    if (!ch0 || !ch0.has_prev) { notice("비교할 이전 기록이 없어요."); return; }
    paintMoveRows(table.ids, ch0, title + " · " + mdDay(D.latest.date) + " · " + mdDay(D.latest.prev_date) + " 대비", seq);
    return;
  }
  if (!P) {
    notice("가장 이른 시점이라 비교할 이전 기록이 없어요.");
    return;
  }
  var head2 = title + " · " + whenShort(per, S) + " · " + whenShort(per, P) + " 대비";

  // 최신 하루 비교는 이미 계산돼 있다
  var chL = D.latest.changes[key];
  if (S === D.latest.date && P === D.latest.prev_date && chL && chL.has_prev) {
    paintMoveRows(table.ids, chL, head2, seq);
    return;
  }

  head.innerHTML = head2;
  list.appendChild(el("li", "empty", "불러오는 중…"));
  // 일간(·스테디)에서 바로 앞 수집일에 이 랭킹이 없으면(예: 직접 옮겨 적은 8/27) 그 앞 수집일로
  // MOVE_PREV_TRIES 번까지 내려가 이 랭킹이 있는 첫 날과 비교한다. 주간·월간은 그대로 안내만 한다.
  var dailyLike = per !== "WEEKLY" && per !== "MONTHLY";
  var backups = dailyLike ? vals.slice(i + 2, i + 2 + MOVE_PREV_TRIES) : [];
  function rankIn(j) {
    var t = j && j.rankings && j.rankings[key];
    return t && (t.ids || []).length ? t : null;
  }
  Promise.all([snapOf(S), snapOf(P)]).then(function (r) {
    if (seq !== UI.moveSeq) return;
    var sj = r[0], pj = r[1];
    var sT = rankIn(sj);
    if (!sj) { notice(mdDay(S) + " 기록을 불러오지 못했어요."); return; }
    if (!sT) {
      notice(mdDay(S) + " 기록에는 이 랭킹이 없어요." + manualNote(sj));
      return;
    }
    if (!pj) { notice("비교할 이전 기록(" + mdDay(P) + ")을 불러오지 못했어요."); return; }
    var skipped = [];
    (function tryPrev(pDate, j, k) {
      if (seq !== UI.moveSeq) return;
      var pT = rankIn(j);
      if (pT) {
        var h = skipped.length
          ? title + " · " + whenShort(per, S) + " · " + mdDay(pDate) + " 대비("
            + skipped.map(mdDay).join("·") + "엔 이 랭킹이 없어요)"
          : head2;
        // 지난 시점이면 회차·완결·별점은 그날 값으로(선택 시점 → 비교 시점 순), 할인은 그날 값을 몰라 뺀다
        var snaps = S === D.latest.date ? null : [sj.snapshots || {}, (j && j.snapshots) || {}];
        paintMoveRows(sT.ids, compareRanks(sT.ids, pT.ids), h, seq, snaps);
        return;
      }
      if (j && k < backups.length) {
        skipped.push(pDate);
        snapOf(backups[k]).then(function (nj) { tryPrev(backups[k], nj, k + 1); });
        return;
      }
      if (!skipped.length) {
        notice("비교할 이전 기록(" + mdDay(P) + ")에는 이 랭킹이 없어요." + manualNote(pj));
      } else if (!j) {
        notice("비교할 이전 기록(" + mdDay(pDate) + ")을 불러오지 못했어요.");
      } else {
        notice("비교할 이전 기록(" + mdDay(pDate) + "~" + mdDay(P) + ")에는 이 랭킹이 없어요.");
      }
    })(P, pj, 0);
  });
}

/** 수동으로 옮겨 적은 날(예: 8/27)은 일부 랭킹만 있다 */
function manualNote(j) {
  return j && j.source === "manual" ? " 그날은 직접 옮겨 적은 기록이라 일부 랭킹만 있어요." : "";
}

/** 지난 시점의 작품 정보: 제목·작가 등은 그대로, 회차·완결·별점·별점 수는 그날 스냅샷 값으로.
 *  snaps = [선택 시점 snapshots, 비교 시점 snapshots] — 앞에 있는 것부터 찾는다(이탈작은 비교 시점에만 있을 수 있다).
 *  스냅샷엔 할인율이 없어 그날 할인 여부를 알 수 없으므로 할인 배지는 뺀다. */
function bookAt(b, id, snaps) {
  if (!snaps) return b;
  var o = {}, k;
  for (k in b) o[k] = b[k];
  delete o.dc;
  var s = null;
  for (var i = 0; i < snaps.length && !s; i++) s = snaps[i] && snaps[i][id];
  if (s) {
    o.r = s.r; o.rc = s.rc; o.ep = s.ep;
    if (s.c) o.c = 1; else delete o.c;
  }
  return o;
}

/** 비교 결과(ch)를 목록으로. ids = 선택 시점의 순위. 작품 정보는 latest → 없으면 전체 카탈로그.
 *  snaps 가 있으면(지난 시점) bookAt 으로 그날 값을 씌운다. */
function paintMoveRows(ids, ch, headHtml, seq, snaps) {
  var list = $("#moveList"), head = $("#moveHead");
  var rankOf = {};
  ids.forEach(function (id, i) { rankOf[id] = i + 1; });

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

  // 지난 시점의 작품(특히 이탈작)은 오늘 순위표에 없을 수 있다 → 그때만 전체 카탈로그를 받는다
  var missing = rows.some(function (r) { return !D.latest.books[r.id]; });
  var need = missing && !D.catalog;
  if (need) {
    head.innerHTML = headHtml;
    list.innerHTML = "";
    list.appendChild(el("li", "empty", "작품 정보를 불러오는 중…"));
  }
  (need ? softJSON("data/books.json").then(function (j) { if (j) D.catalog = j; }) : Promise.resolve())
    .then(function () {
      if (seq !== UI.moveSeq) return;
      head.innerHTML = headHtml + " · " + label + " <b>" + rows.length + "</b>건";
      list.innerHTML = "";
      var shown = 0;
      rows.forEach(function (r) {
        var b = D.latest.books[r.id] || (D.catalog && D.catalog[r.id]);
        if (!b) return;
        if (UI.hideAdult && b.ad) return;
        var fake = { moves: {}, new: [], has_prev: true };
        if (r.isNew) fake.new = [r.id];
        else if (r.delta) fake.moves[r.id] = r.delta;
        list.appendChild(bookRow(r.id, bookAt(b, r.id, snaps), r.rank || "–", fake, UI.moveKey));
        shown++;
      });
      if (!shown) list.appendChild(el("li", "empty", "해당하는 작품이 없어요."));
    });
}

// ── 순위대 변화 ─────────────────────────────
// 업데이트 주기 톱니(새 회차 날 튀었다가 밀리는 모양)를 빼고, 평소 순위대 자체가
// 바뀐 순간만 모은 목록. 판정은 Actions가 만든 analysis/shifts.json 을 그대로 쓴다.
// 웹툰(1600)·BL 웹툰(4250) 전체 랭킹만 분석하므로 다른 랭킹에서는 안내만 한다.
var SHIFT_FILTERS = [
  ["all", "전체"],
  ["promo", "프로모션 관련"],
  ["none", "확인된 프로모션 없음"],
  ["noep", "회차 없이 튐"],
];
function shiftPass(it, f) {
  if (f === "promo") return it.label !== "none";
  if (f === "none") return it.label === "none";
  if (f === "noep") return it.kind === "noep";
  return true;
}

// 순위대 변화는 오늘의/주간/월간 베스트마다 따로 판정돼 있다(shifts.items[].per).
// 고른 랭킹의 그룹(g)·기간(per)이 같은 항목만, 시점을 고르면 그 하루/주/달 안에 시작(d)한 항목만 보여준다.
function drawShifts(when) {
  var list = $("#moveList"), head = $("#moveHead");
  list.innerHTML = "";
  var key = UI.moveKey || "";
  var g = key.slice(0, key.lastIndexOf("-"));
  var table = D.latest.rankings[key];
  var per = movePeriod();

  if (g !== "1600" && g !== "4250") {
    $("#shiftTools").classList.add("hidden");
    $("#moveWhen").closest(".field").classList.add("hidden");
    head.innerHTML = table ? "<b>" + table.name + "</b> · 순위대 변화" : "";
    var li = el("li", "empty", "순위대 변화는 웹툰·BL 웹툰 전체 랭킹에서 볼 수 있어요.");
    var jump = el("div", "btnrow");
    jump.style.justifyContent = "center";
    jump.style.marginTop = "10px";
    // 지금 기간(주간·월간)을 그대로 살려서 옮긴다. 웹툰에 없는 기간(스테디셀러)이면 오늘의 베스트로.
    var jp = ["DAILY", "WEEKLY", "MONTHLY"].indexOf(per) >= 0 ? per : "DAILY";
    [["1600-" + jp, "웹툰 보기"], ["4250-" + jp, "BL 웹툰 보기"]].forEach(function (x) {
      if (!D.latest.rankings[x[0]]) return;
      var b = el("button", "btn", x[1]);
      b.addEventListener("click", function () {
        UI.moveKey = x[0];
        $("#movePick").value = x[0];
        drawMove();
      });
      jump.appendChild(b);
    });
    li.appendChild(jump);
    list.appendChild(li);
    return;
  }

  if (!D.shifts) {
    head.textContent = "";
    list.appendChild(el("li", "empty", "불러오는 중…"));
    loadAnalysis().then(drawMove);
    return;
  }

  var all = !when || when === "all";
  var bk = all ? null : whenBucket(per, when);
  var inRange = (D.shifts.items || []).filter(function (it) {
    return it.g === g && it.per === per && (all || whenBucket(per, it.d) === bk);
  });
  var mine = inRange.filter(function (it) { return !(UI.hideAdult && it.ad); });
  // 필터 버튼에 건수를 같이 적는다
  Array.prototype.forEach.call($("#shiftFilter").children, function (b) {
    var f = b.dataset.f, n = 0;
    mine.forEach(function (it) { if (shiftPass(it, f)) n++; });
    var name = SHIFT_FILTERS.filter(function (x) { return x[0] === f; })[0];
    b.textContent = (name ? name[1] : f) + " " + n;
    b.classList.toggle("on", f === UI.shiftFilter);
  });
  var rows = mine.filter(function (it) { return shiftPass(it, UI.shiftFilter); });

  var win = D.shifts.window || [];
  head.innerHTML = "<b>" + (table ? table.name : g) + "</b> · " + periodLabel(per)
    + " · 순위대 변화 <b>" + rows.length + "</b>건"
    + (all ? (win.length === 2 ? " · " + mdDay(win[0]) + "~" + mdDay(win[1]) + " 기록 기준" : "")
           : " · " + whenSpan(per, when) + "에 시작한 변화")
    + " · 최근 것부터";

  if (!(D.shifts.items || []).length) {
    list.appendChild(el("li", "empty", "아직 분석 결과가 없어요. 다음 수집 때 만들어져요."));
    return;
  }
  rows.forEach(function (it) { list.appendChild(shiftRow(it)); });
  if (!rows.length) {
    list.appendChild(el("li", "empty", !all && !inRange.length
      ? "이 시점에 시작한 순위대 변화가 없어요. 다른 시점이나 ‘전체 기간’을 골라 보세요."
      : (!mine.length && inRange.length ? "성인 작품을 숨겨서 보이는 작품이 없어요." : "해당하는 작품이 없어요.")));
  }
}

function shiftRow(it) {
  var li = el("li", "shiftrow");
  li.tabIndex = 0;
  var b = D.latest.books[it.id] || {};

  var img = el("img", "cover");
  img.loading = "lazy";
  img.src = coverUrl(it.id, "small");
  img.alt = "";
  img.onerror = function () { this.style.visibility = "hidden"; };
  li.appendChild(img);

  var info = el("div", "info");
  var tt = el("div", "tt", b.t || it.t || it.id);
  info.appendChild(tt);
  info.appendChild(shiftLine(it));

  var chips = el("div", "chips");
  chips.appendChild(shiftLabelChip(it));
  var pc = persistChip(it);
  if (pc) chips.appendChild(pc);
  if (it.ad) chips.appendChild(el("span", "badge ad", "19+"));
  if (typeof it.z === "number") {
    var zz = el("span", "zz", "평소 흔들림의 " + Math.abs(it.z) + "배");
    zz.title = "평소 순위가 흔들리는 폭과 비교한 변화 크기예요. 클수록 뚜렷한 변화예요.";
    chips.appendChild(zz);
  }
  info.appendChild(chips);

  if (it.note) info.appendChild(el("div", "nt", it.note));
  (it.promos || []).slice(0, 3).forEach(function (p) {
    var ev = el("div", "ev");
    ev.appendChild(el("span", "sw " + promoFamily(p.k)));
    ev.appendChild(document.createTextNode(" " + promoWhen(p) + " "));
    ev.appendChild(promoTitleEl(p));
    info.appendChild(ev);
  });
  li.appendChild(info);

  // 판정에 쓴 랭킹(예: 4250-WEEKLY)으로 상세를 연다
  var ctx = it.g + "-" + it.per;
  li.addEventListener("click", function (e) {
    if (e.target.closest("a")) return;      // 이벤트 링크는 그대로 새 탭으로
    openBook(it.id, ctx);
  });
  li.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.target.closest("a")) return;   // 링크에서 Enter = 링크만 연다
    openBook(it.id, ctx);
  });
  return li;
}

// 회차 없이 튄 경우(noep)는 분석기가 두 가지로 만든다.
//   · 급등(spike, 오늘의 베스트): before = 직전 7일 중앙값, after = 그날·다음날 중 더 높은 순위(최고)
//   · 창(window): before/after = 변화 전후 1주 평균
// 항목에 구분 필드가 없어서 설명문(note)의 '1주 평균'으로 가른다. 설명이 없으면 오늘의 베스트 상승 = 급등.
function noepIsSpike(it) {
  if (it.kind !== "noep") return false;
  if (it.note) return it.note.indexOf("1주 평균") < 0;
  return it.per === "DAILY" && it.dir === "up";
}
/** 급등 설명에 '회차 변화는 확인 못 했어요'가 붙은 경우(직전에 랭킹 밖이라 ep를 못 봄) */
function noepEpUnknown(it) {
  return it.kind === "noep" && !!it.note && it.note.indexOf("회차 변화는 확인 못") >= 0;
}
/** 숫자 부분: '평균 32위 → 22위' / '평소 200위 밖 → 최고 7위' / '1주 평균 94위 → 200위 밖' */
function shiftNums(it) {
  if (noepIsSpike(it)) return "평소 " + rankWord(it.before) + " → 최고 " + rankWord(it.after);
  return (it.kind === "noep" ? "1주 평균 " : "평균 ") + rankWord(it.before) + " → " + rankWord(it.after);
}
/** 앞머리. 목록 줄: '35화(9/29)부터 ' / '회차 변화 없이 10/1 ' / '회차 변화 없이 9/25부터 '
 *  그래프 ▲▼ 풍선(forMark, 날짜를 맨 앞에): '9/29 35화부터 ' / '10/1 회차 변화 없이 ' / '9/25부터 회차 변화 없이 ' */
function shiftLead(it, forMark) {
  var d = mdDay(it.d);
  if (it.kind === "episode") {
    if (!it.ep) return d + " 회차부터 ";
    return forMark ? d + " " + it.ep + "화부터 " : it.ep + "화(" + d + ")부터 ";
  }
  var day = d + (noepIsSpike(it) ? " " : "부터 ");
  var how = noepEpUnknown(it) ? "(회차 확인 못 함) " : "회차 변화 없이 ";
  return forMark || noepEpUnknown(it) ? day + how : how + day;
}

/** '35화(9/29)부터 ▲ 주간 평균 32위 → 22위' 한 줄 */
function shiftLine(it) {
  var line = el("div", "sline");
  line.appendChild(document.createTextNode(shiftLead(it, false)));
  line.appendChild(el("span", "arr " + (it.dir === "down" ? "down" : "up"), it.dir === "down" ? "▼" : "▲"));
  // 회차형은 '주간 평균 …', 회차 없는 창은 '주간 순위 1주 평균 …' (월간도 같은 꼴)
  var nm = it.per === "MONTHLY" ? "월간" : "주간";
  var per = it.per === "DAILY" ? "오늘의 베스트" : (it.kind === "episode" ? nm : nm + " 순위");
  line.appendChild(document.createTextNode(" " + per + " " + shiftNums(it)));
  return line;
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
//   점수 = 순위 가중평균 80% + 누적 별점수 20%
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
    c.score = 100 * (0.8 * rankNorm + 0.2 * rateNorm);
  });
  cand.sort(function (a, b) { return b.score - a.score || a.mean - b.mean; });

  var total = cand.length;
  var shown = cand.slice(0, KW.topN || 100);

  head.appendChild(el("b", "", "#" + tagName));
  head.appendChild(document.createTextNode(
    " · " + kwScopeLabel() + " 범위 · " + total + "작품"
    + (total > shown.length ? " 중 상위 " + shown.length : "")));

  body.appendChild(el("p", "covernote",
    "점수 = 순위 가중평균 80% + 누적 별점수 20%. "
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

// 시점(날짜/주/월) 목록은 변동 탭과 같이 쓰는 whenOptions() — 일간=하루마다, 주간=일요일 기준, 월간=말일 기준
// (진행 중인 주·달은 마지막 수집일 기준이라 이름이 '(10/4까지)'처럼 붙는다).

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
  var opts = whenOptions(CB.period);
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
    w.score = 100 * (0.8 * rank + 0.2 * rate);
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
      w.score = 100 * (0.8 * rk + 0.2 * rt);
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
      : softJSON("data/events/latest.json").then(function (j) { D.events = (j && j.events) || []; return D.events; }),
    loadAnalysis(),
    // 순위 밖 작품까지 매일 모은 별점 수 (작품 ID 끝 두 자리로 나눈 작은 파일) — 없으면 null
    Promise.all(months.map(function (m) {
      return softJSON("data/rc/" + m + "/" + rcShard(id) + ".json");
    })),
    // AI(Claude)가 자세한 리뷰를 읽고 분석한 결과 — 순위 상위 작품만 있음 (없으면 null)
    softJSON("data/reviews_ai/" + id + ".json"),
    // 별점 리뷰에서 반복되는 반응(AI가 묶고 개수는 프로그램이 셈) — 순위 상위 작품만 (scripts/cmt/rev_daily.mjs)
    softJSON("data/reviews_rx/" + id + ".json"),
    // 회차별 댓글 수 — 순위에 나온 웹툰 (scripts/cmt/cmt_counts.mjs)
    softJSON("data/cmt_counts/" + id + ".json")
  ]).then(function (r) {
    // 반복 반응 분석 뒤로 리뷰가 크게 늘었으면(순위 밖으로 나가 분석이 멈춘 작품 등) 낡은 카드 대신 매일 갱신되는 '공통 의견'을 보여 준다
    var rx = r[7];
    var cntNow = (r[1] && (r[1].count || (r[1].analysis && r[1].analysis.total))) || 0;
    var rb = (rx && rx.stats && rx.stats.all) || 0;
    if (rx && rb && cntNow > rb * 1.2 && cntNow - rb >= 30) rx = null;
    drawBook(id, r[0], mergeAi(r[1], r[6]), r[2].filter(Boolean), ctxKey, r[5].filter(Boolean), rx, r[8]);
  });
}

function closeSheet() {
  $("#sheet").classList.add("hidden");
  document.body.style.overflow = "";
}

// 전 작품 별점 파일(data/rc/<월>/<NN>.json)의 칸 번호 — 작품 ID 끝 두 자리.
// scripts/reviews_full.js 의 rcShard 와 같아야 한다.
function rcShard(id) { var s = String(id); return ("0" + s.slice(-2)).slice(-2); }

// 두 날짜별 시리즈를 합친다: 같은 날은 a(랭킹 기록)를 우선, 없으면 b(전 작품 별점)로 채움
function mergeSeries(a, b) {
  var byDate = {};
  (b.pts || []).forEach(function (p) { if (!p.missing) byDate[p.d] = p.v; });
  (a.pts || []).forEach(function (p) { if (!p.missing && p.v !== null) byDate[p.d] = p.v; else if (!(p.d in byDate) && !p.missing) byDate[p.d] = null; });
  // 값이 있는 첫날~마지막날만 그린다 (순위 밖 작품은 앞쪽 수십 일이 비어 그래프가 한쪽에 쏠리므로)
  var days = Object.keys(byDate).filter(function (d) { return byDate[d] !== null; }).sort();
  if (!days.length) return { pts: [], gaps: 0 };
  var pts = [], gaps = 0;
  var cur = new Date(days[0] + "T00:00:00Z"), end = new Date(days[days.length - 1] + "T00:00:00Z");
  while (cur <= end) {
    var key = cur.toISOString().slice(0, 10);
    if (key in byDate) pts.push({ d: key, v: byDate[key] });
    else { pts.push({ d: key, v: null, missing: true }); gaps++; }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { pts: pts, gaps: gaps };
}

// 상세 모달의 키워드 태그를 누르면 → 키워드 탭으로 이동해
// 그 키워드를 가진 작품들을 점수순(순위 80% + 별점수 20%)으로 보여준다.
// 작품이 속한 섹션/장르(ctxKey)로 범위를 맞춰 준다(넓게: 장르 전체).
function goKeywordFromTag(tag, ctxKey) {
  var r = ctxKey && D.latest && D.latest.rankings && D.latest.rankings[ctxKey];
  if (r && D.tree[r.section] && D.tree[r.section].groups[r.group]) {
    KW.section = r.section; KW.group = r.group; KW.sub = "";
    // 이 장르에 '전체' 랭킹이 없고 세부장르만 있으면 첫 세부장르로 — 빈 화면 방지
    var g = D.tree[r.section].groups[r.group];
    if (g && !g.parent) {
      var subs = Object.keys(g.subs || {});
      if (subs.length) KW.sub = subs[0];
    }
  }
  KW.query = tag;
  var box = $("#kwSearch"); if (box) box.value = tag;
  closeSheet();
  UI.view = "keyword";
  fillKwPickers();
  render();
  var main = $("#main"); if (main && main.scrollIntoView) main.scrollIntoView();
}
document.addEventListener("click", function (e) {
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") closeSheet();
});

function drawBook(id, detail, reviewData, months, ctxKey, rcMonths, rxData, ccData) {
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
  // 이 작품에 걸린 프로모션 기간은 그래프 뒤에 옅은 색 구간으로, 순위대가 바뀐 날은 ▲/▼로 표시한다.
  var promos = promosOf(id);
  var shifts = D.shiftsById[id] || [];
  var bands = promoBands(promos);
  body.appendChild(rankTrendCard(id, months, ctxKey, { bands: bands, shifts: shifts }));

  // ── 이 기간 걸린 프로모션 · 순위대 변화 판정 ──
  // 프로모션도 판정도 없는 작품에는 아무것도 붙이지 않는다.
  if (promos.length || shifts.length) body.appendChild(promoCard(promos, shifts));

  // ── 별점 개수 추이 ──
  // 평균 별점(4.9x)은 거의 안 변해서 추이로 의미가 없다. 대신 별점(참여) 개수가
  // 며칠간 얼마나 늘었는지를 보여준다. 값이 늘수록 위로 올라간다(invert 안 함).
  // 리뷰 보상 이벤트 기간에는 별점이 부풀었다가 마감 뒤 꺾이므로 같은 색 구간을 깐다.
  // 별점 수: 순위에 있던 날은 랭킹 기록, 순위 밖이었던 날은 전 작품 별점 수집(rc)으로 채운다
  var countSeries = mergeSeries(
    collectSeries(months, function (h) { return (h.count || {})[id]; }),
    collectSeries(rcMonths || [], function (h) { return (h.count || {})[id]; }));
  var cPts = countSeries.pts.filter(function (p) { return p.v !== null; });
  if (cPts.length >= 2) {
    var rc = el("div", "card");
    rc.appendChild(el("h3", "", "별점 개수 추이"));
    var w = el("div", "chartwrap");
    w.appendChild(lineChart(countSeries.pts, {
      invert: false, fmt: function (v) { return num(Math.round(v)); }, bands: bands
    }));
    rc.appendChild(w);
    var first = cPts[0].v, last = cPts[cPts.length - 1].v, diff = last - first;
    rc.appendChild(el("p", "hint",
      cPts.length + "일간 " + num(first) + "개 → " + num(last) + "개"
      + " (" + (diff >= 0 ? "+" : "") + num(diff) + "개)"
      + (countSeries.gaps ? " · 수집 없던 날 " + countSeries.gaps + "일 빈칸" : "")
      + (bands.length ? " · 색 구간은 프로모션 기간이에요(리뷰 이벤트 땐 별점이 빨리 늘 수 있어요)" : "")));
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
    tags.forEach(function (t) {
      var s = el("span", "tag k clickable", "#" + t);
      s.title = "이 키워드를 가진 작품들을 점수순(순위 80% + 별점수 20%)으로 보기";
      s.addEventListener("click", function () { goKeywordFromTag(t, ctxKey); });
      tb.appendChild(s);
    });
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

  // ── 회차별 댓글 수 (웹툰) ──
  var ccc = cmtCountCard(ccData);
  if (ccc) body.appendChild(ccc);

  // ── 독자 반응: 별점 리뷰에서 반복되는 말 ──
  //   예전 'AI 독자 반응 요약'(해석형)은 캐릭터에게 화내기·휴재 아쉬움 같은 애정 표현을 불만으로 읽는 문제가 있어 내렸다(2026-10-10).
  //   반복 반응이 아직 없는 작품은 규칙 엔진의 '공통 의견'을 대신 보여 준다.
  var rxc = reactionCard(rxData);
  if (rxc) body.appendChild(rxc);
  else { var oc = opinionCard(reviewData); if (oc) body.appendChild(oc); }

  // ── 리뷰 요소별 반응 (작화·스토리·캐릭터… 긍정/부정) ──
  var ac = aspectCard(reviewData);
  if (ac) body.appendChild(ac);

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
//   extra = { bands: 프로모션 색 구간, shifts: 이 작품의 순위대 변화 판정 } (없어도 됨)
function rankTrendCard(id, months, ctxKey, extra) {
  extra = extra || {};
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
  var ctxPer = ctxKey ? ctxKey.slice(ctxKey.lastIndexOf("-") + 1) : null;
  var state = {
    cat: (ctxPfx && byCat[ctxPfx]) ? ctxPfx
       : (cats.filter(function (c) { return order(c) === 1; })[0] || cats[0]),
    period: null,
  };
  // 기간도 열었던 랭킹을 따른다(예: 순위대 변화의 '주간' 판정 → 주간 그래프). 없으면 draw()가 첫 기간으로.
  if (ctxPer && byCat[state.cat][ctxPer]) state.period = ctxPer;

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
    // ▲/▼는 판정에 쓴 랭킹(웹툰·BL 웹툰 전체)과 기간(오늘/주간)이 지금 보는 그래프와 같은 것만 찍는다.
    // 주간 기준 하락을 오늘의 베스트 그래프에, 웹툰 전체 순위로 낸 판정을 세부 장르 그래프에
    // 찍으면 엉뚱한 날·엉뚱한 숫자를 가리키게 된다.
    var mine = (extra.shifts || []).filter(function (it) {
      return it.per === state.period && it.g === state.cat;
    });
    if (pts.length < 2) {
      wrap.appendChild(el("p", "hint", "기록이 " + pts.length + "일치뿐이라 아직 선을 그릴 수 없습니다."));
    } else {
      var marks = mine.map(function (it) { return { d: it.d, dir: it.dir, label: shiftMarkText(it) }; });
      wrap.appendChild(lineChart(s.pts, {
        invert: true, fmt: function (v) { return v + "위"; },
        bands: extra.bands, marks: marks
      }));
    }
    var vals = pts.map(function (p) { return p.v; });
    note.textContent = vals.length
      ? labels[state.cat].name + " 기준 · 최고 " + Math.min.apply(null, vals) + "위 · 최근 "
        + vals[vals.length - 1] + "위 · " + vals.length + "일 기록"
        + (s.gaps ? " · 수집 없던 날 " + s.gaps + "일 빈칸" : "")
        + ((extra.bands || []).length ? " · 색 구간은 프로모션 기간" : "")
        + marksElsewhere()
      : "";
  }

  // 이 그래프엔 ▲/▼가 없는데 다른 랭킹·기간 그래프에는 있으면 어디서 보는지 모두 알려 준다
  // (판정은 오늘의/주간/월간마다 따로라 여러 그래프에 나뉘어 있을 수 있다). 순서는 버튼 순서대로.
  function marksElsewhere() {
    var sh = extra.shifts || [];
    if (!sh.length || sh.some(function (it) { return it.per === state.period && it.g === state.cat; })) return "";
    var names = [];
    cats.forEach(function (c) {
      PERIOD_ORDER.forEach(function (p) {
        if (!byCat[c][p]) return;
        if (sh.some(function (x) { return x.g === c && x.per === p; })) {
          names.push("'" + labels[c].name + " " + periodLabel(p) + "'");
        }
      });
    });
    if (!names.length) return "";
    return " · ▲▼ 순위대 변화는 " + names.join("·") + " 그래프에 표시해요";
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
//   opt.bands = [{a, b, cls, title}]  a~b(수집일) 구간을 선 아래에 옅은 사각형으로 칠한다
//   opt.marks = [{d, dir, label}]     그날 아래쪽에 작은 ▲/▼ 를 찍는다
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

  // pts 는 수집 없던 날까지 하루씩 빠짐없이 이어져 있다(collectSeries).
  // 그래서 날짜 → 가로 위치는 '첫날부터 며칠째인가'로 바로 구한다.
  var n = pts.length;
  var step = n > 1 ? (W - L - R) / (n - 1) : 0;
  function dayIndex(d) { return d ? dayGap(String(d).slice(0, 10), pts[0].d) : null; }

  // 프로모션 구간: 그래프 날짜 범위 밖은 잘라내고, 하루짜리도 보이게 반 칸씩 넓힌다.
  // 색 계열이 다른 구간이 겹치는 날은 높이를 나눠 계열마다 제 띠에 따로 칠한다.
  // (반투명 사각형을 그냥 포개면 섞인 색이 어느 견본과도 안 맞고, 선·▼ 색과 헷갈린다)
  var BAND_ORDER = ["price", "content", "free"];
  var cover = [];                            // 날짜 칸 → {계열: [제목…]}
  (opt.bands || []).forEach(function (bd) {
    var ia = dayIndex(bd.a), ib = dayIndex(bd.b || bd.a);
    if (ia === null || ib === null || ib < 0 || ia > n - 1 || ib < ia) return;
    ia = Math.max(0, ia); ib = Math.min(n - 1, ib);
    var cls = bd.cls || "";
    for (var i = ia; i <= ib; i++) {
      var c = cover[i] || (cover[i] = {});
      var ts = c[cls] || (c[cls] = []);
      if (bd.title && ts.indexOf(bd.title) < 0) ts.push(bd.title);
    }
  });
  function famsAt(i) {
    var c = cover[i];
    if (!c) return [];
    var ks = Object.keys(c);
    return BAND_ORDER.filter(function (f) { return f in c; })
      .concat(ks.filter(function (f) { return BAND_ORDER.indexOf(f) < 0; }));
  }
  function coverKey(i) {
    return famsAt(i).map(function (f) { return f + ":" + cover[i][f].join("\n"); }).join("|");
  }
  function drawBandRun(ia, ib) {
    var fams = famsAt(ia);
    var x0 = Math.max(L, X(ia) - step / 2), x1 = Math.min(W - R, X(ib) + step / 2);
    if (x1 <= x0 || !fams.length) return;
    var lane = (H - T - B) / fams.length;
    fams.forEach(function (f, j) {
      var r = mk("rect", { x: x0, y: T + j * lane, width: x1 - x0, height: lane,
        class: "bd " + f, "shape-rendering": "crispEdges" });
      var ts = cover[ia][f];
      if (ts.length) r.appendChild(mk("title", {}, ts.join("\n")));
      svg.appendChild(r);
    });
  }
  // 덮인 계열·제목이 똑같은 날들을 한 덩어리로 묶어 그린다
  var run = null;
  for (var bi = 0; bi <= n; bi++) {
    var key = bi < n ? coverKey(bi) : "";
    if (run && key === run.k) { run.ib = bi; continue; }
    if (run && run.k) drawBandRun(run.ia, run.ib);
    run = { k: key, ia: bi, ib: bi };
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

  // 순위대가 바뀐 날: 옅은 세로선 + 아래쪽 여백에 ▲/▼
  var seenMark = {};
  (opt.marks || []).forEach(function (m) {
    var i = dayIndex(m.d);
    if (i === null || i < 0 || i > n - 1) return;
    var k = m.d + m.dir;
    if (seenMark[k]) return;                 // 같은 날 같은 방향은 한 번만
    seenMark[k] = true;
    var down = m.dir === "down";
    var g = mk("g", { class: "mk " + (down ? "down" : "up") });
    g.appendChild(mk("line", { x1: X(i), y1: T, x2: X(i), y2: H - B, class: "mkline" }));
    g.appendChild(mk("text", { x: X(i), y: H - B + 10, "text-anchor": "middle", class: "mktx" }, down ? "▼" : "▲"));
    if (m.label) g.appendChild(mk("title", {}, m.label));
    svg.appendChild(g);
  });

  svg.appendChild(mk("path", { d: d.trim(), class: "ln" }));

  pts.forEach(function (p, i) {
    if (p.v === null) return;
    var c = mk("circle", { cx: X(i), cy: Y(p.v), r: 2.5, class: "dot" });
    c.appendChild(mk("title", {}, p.d + " · " + (opt.fmt ? opt.fmt(p.v) : p.v)));
    svg.appendChild(c);
  });

  if (pts.length) {
    // 기본은 날짜(MM-DD). 월 단위 그래프처럼 다른 라벨이 필요하면 opt.label 로 바꾼다.
    var lab = opt.label || function (d) { return d.slice(5); };
    svg.appendChild(mk("text", { x: L, y: H - 8 }, lab(pts[0].d)));
    var last = pts[pts.length - 1];
    svg.appendChild(mk("text", { x: W - R, y: H - 8, "text-anchor": "end" }, lab(last.d)));
  }
  return svg;
}

// ── 프로모션 · 순위대 변화 (data/analysis/) ──
// promo.json  = 작품별로 걸렸던 이벤트·가격 할인·기간 한정 기다무 기간
// shifts.json = 업데이트 주기 톱니를 뺀 '평소 순위대' 변화와 그 원인 판정
// 둘 다 Actions가 매일 다시 만든다. 화면은 읽어서 그리기만 한다.

/** 두 분석 파일을 (처음 한 번만) 읽어 D.promo / D.shifts 에 넣는다. 없으면 빈 값. */
function loadAnalysis() {
  return Promise.all([
    D.promo ? Promise.resolve(D.promo)
      : softJSON("data/analysis/promo.json").then(function (j) {
          D.promo = (j && j.works) ? j : { works: {}, platform: [] };
          return D.promo;
        }),
    D.shifts ? Promise.resolve(D.shifts)
      : softJSON("data/analysis/shifts.json").then(function (j) {
          D.shifts = (j && j.items) ? j : { items: [] };
          D.shiftsById = {};
          D.shifts.items.forEach(function (it) {
            (D.shiftsById[it.id] || (D.shiftsById[it.id] = [])).push(it);
          });
          return D.shifts;
        })
  ]);
}

function promosOf(id) { return (D.promo && D.promo.works && D.promo.works[id]) || []; }

/** "2026-09-14 …" → "9/14" */
function mdDay(s) {
  if (!s) return "";
  return Number(String(s).slice(5, 7)) + "/" + Number(String(s).slice(8, 10));
}

/** 순위값(전형 순위·평균) → '22위' / '200위 밖' */
function rankWord(v) {
  if (v === null || v === undefined) return "-";
  if (v >= 200) return "200위 밖";
  return Math.max(1, Math.round(v)) + "위";
}

// 색 계열 3가지: 가격 할인 / 무료·포인트(랜덤티켓·최신화 포함) / 콘텐츠·론칭
// 여러 유형이 섞인 이벤트는 가격 할인 → 콘텐츠·론칭 → 무료·포인트 순으로 하나만 고른다.
// (시즌·완결 이벤트는 대개 포인트도 같이 주지만, 판정에서는 '콘텐츠 이벤트'로 따로 보기 때문)
var PROMO_FAMILY = { price: "가격 할인", free: "무료·포인트", content: "콘텐츠·론칭" };
function promoFamily(k) {
  k = k || [];
  if (k.indexOf("가격할인") >= 0) return "price";
  if (k.indexOf("콘텐츠") >= 0 || k.indexOf("론칭") >= 0) return "content";
  return "free";
}
var PROMO_SRC = { event: "이벤트", price: "가격 변화 관측", wff: "기간 한정 기다무" };

/** 표시용 기간: '9/14 하루' / '8/20~9/2' */
function promoWhen(p) {
  var s = (p.s || "").slice(0, 10), e = (p.e || "").slice(0, 10);
  if (!s) return e ? "~" + mdDay(e) : "";
  if (!e || s === e) return mdDay(s) + " 하루";
  return mdDay(s) + "~" + (e.slice(0, 4) !== s.slice(0, 4) ? e.slice(0, 4) + "/" : "") + mdDay(e);
}

/** 프로모션 제목. 이벤트 주소가 있으면 새 탭 링크로. */
function promoTitleEl(p) {
  var t;
  if (p.u) {
    t = el("a", "plink", p.t || "(제목 없음)");
    t.href = p.u; t.target = "_blank"; t.rel = "noopener";
  } else {
    t = el("span", "", p.t || "(제목 없음)");
  }
  t.title = (p.src === "price" ? "할인이 보인 수집 시각 " : "")
    + (p.s || "") + " ~ " + (p.e || "") + " (한국시간)";
  return t;
}

/** 그래프용 색 구간. 같은 기간·같은 색(예: 이벤트와 그 가격 할인)은 하나로 합친다. */
function promoBands(promos) {
  var seen = {}, out = [];
  promos.forEach(function (p) {
    if (!p.a) return;
    var cls = promoFamily(p.k);
    var key = p.a + "|" + (p.b || p.a) + "|" + cls;
    var line = promoWhen(p) + " · " + p.t;
    if (seen[key]) { seen[key].title += "\n" + line; return; }
    seen[key] = { a: p.a, b: p.b || p.a, cls: cls, title: line };
    out.push(seen[key]);
  });
  return out;
}

var SHIFT_LABEL = {
  // promo_live 는 '아직 진행 중'과 '끝났지만 다음 사이클 자료가 모자람'을 함께 뜻한다.
  // 화면 글자는 shiftLabelOf()가 프로모션 끝난 시각을 보고 둘 중 하나로 고른다.
  promo_live: { t: "프로모션 진행 중", c: "promo",
    tip: "프로모션과 함께 바뀌었고 프로모션이 아직 진행 중이라, 효과인지 판단을 미뤄요." },
  promo_live_ended: { t: "프로모션 끝남 · 판정 대기", c: "promo",
    tip: "프로모션과 함께 바뀌었어요. 끝난 뒤 자료가 아직 모자라 효과인지 판단을 미뤄요." },
  promo_temp: { t: "프로모션 끝나고 복귀", c: "promo",
    tip: "프로모션 동안 바뀌었다가 끝난 뒤 원래 수준으로 돌아갔어요." },
  promo_kept: { t: "프로모션 후에도 유지", c: "promo",
    tip: "프로모션이 끝난 뒤에도 바뀐 순위대가 이어졌어요. 작품 쪽 힘일 수 있어요." },
  promo_end: { t: "프로모션 종료로 하락", c: "end",
    tip: "프로모션 판매가 순위 집계에서 빠지면서 내려갔어요. 오늘의 베스트는 끝난 다음 날, 주간은 8일째, 월간은 한 달쯤 뒤에 빠져요." },
  content: { t: "시즌·완결 이벤트와 겹침", c: "content",
    tip: "시즌 시작·완결·외전 같은 이벤트와 겹쳐서 회차 효과와 나눌 수 없어요." },
  none: { t: "확인된 프로모션 없음", c: "none",
    tip: "같은 시기 이 작품의 이벤트·할인을 찾지 못했어요. 배너·추천 노출은 데이터에 없어요." },
};
var SHIFT_PERSIST = {
  "지속": ["유지됨", "다음 회차(또는 이후 며칠)에도 이어졌어요."],
  "일시": ["일시적", "곧 원래 수준으로 돌아갔어요."],
  "부분": ["일부만 유지", "바뀐 폭의 절반쯤만 이어졌어요."],
  "보류": ["지켜보는 중", "아직 다음 회차·이후 자료가 모자라요."],
};
/** 지금 한국시간 'YYYY-MM-DD HH:mm' (프로모션 e 와 같은 꼴) */
function kstNowStr() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
}
/** 판정 항목의 라벨 정보. promo_live 는 걸린 프로모션이 모두 끝났으면 '끝남 · 판정 대기'로. */
function shiftLabelOf(it) {
  var L = SHIFT_LABEL[it.label] || { t: it.label, c: "", tip: "" };
  if (it.label === "promo_live") {
    var ps = it.promos || [];
    var now = kstNowStr();
    var ended = ps.length > 0 && ps.every(function (p) { return p.e && String(p.e) < now; });
    if (ended) return SHIFT_LABEL.promo_live_ended;
  }
  return L;
}
function shiftLabelChip(it) {
  var L = shiftLabelOf(it);
  var s = el("span", "lb " + L.c, L.t);
  s.title = L.tip;
  return s;
}
/** 지속성 칩. 라벨과 어긋나지 않게 고쳐 쓰거나 뺀다(없으면 null).
 *  · promo_temp(끝나고 복귀) + 지속/부분: 지속성은 급등 뒤 며칠을 본 것이라 프로모션 기간 안의 이야기다.
 *  · promo_live + 보류: 라벨이 이미 '판정 대기'라 겹친다. */
function persistChip(it) {
  var ps = SHIFT_PERSIST[it.persist];
  if (!ps) return null;
  if (it.label === "promo_temp") {
    if (it.persist === "지속") ps = ["프로모션 동안 유지", "프로모션이 이어지는 동안엔 바뀐 순위대가 유지됐고, 끝난 뒤 돌아갔어요."];
    else if (it.persist === "부분") ps = ["프로모션 동안 일부 유지", "프로모션이 이어지는 동안 바뀐 폭의 절반쯤이 유지됐고, 끝난 뒤 돌아갔어요."];
    else if (it.persist === "보류") return null;
  }
  if (it.label === "promo_live" && it.persist === "보류") return null;
  var pc = el("span", "badge", ps[0]);
  pc.title = ps[1];
  return pc;
}
function shiftMarkText(it) {
  return shiftLead(it, true) + (it.dir === "down" ? "▼ " : "▲ ") + shiftNums(it)
    + " · " + shiftLabelOf(it).t;
}

/** 상세 화면: 이 기간 걸린 프로모션 목록 + 순위대 변화 판정 */
function promoCard(promos, shifts) {
  var card = el("div", "card promocard");
  var h = el("h3", "", promos.length ? "이 기간 걸린 프로모션" : "순위대 변화 판정");
  var win = D.promo && D.promo.window;
  if (win && win.length === 2) {
    h.appendChild(el("span", "r", mdDay(win[0]) + "~" + mdDay(win[1])
      + (promos.length ? " · " + promos.length + "건" : "")));
  }
  card.appendChild(h);

  // 파일은 최근 것부터지만, 한 작품 안에서는 일어난 순서대로 읽는 게 자연스럽다.
  // 같은 날이면 오늘의 → 주간 → 월간 순(기간마다 따로 판정한 항목이 각각 있다).
  shifts.slice().sort(function (x, y) {
    return x.d < y.d ? -1 : x.d > y.d ? 1 : PERIOD_ORDER.indexOf(x.per) - PERIOD_ORDER.indexOf(y.per);
  }).forEach(function (it) {
    var v = el("div", "verdict");
    var top = el("div", "vtop");
    top.appendChild(shiftLabelChip(it));
    top.appendChild(el("span", "vwhen " + (it.dir === "down" ? "down" : "up"),
      (it.dir === "down" ? "▼ " : "▲ ") + mdDay(it.d) + " · " + periodLabel(it.per)));
    var pc = persistChip(it);
    if (pc) top.appendChild(pc);
    v.appendChild(top);
    if (it.note) v.appendChild(el("div", "vnote", it.note));
    card.appendChild(v);
  });

  if (promos.length) {
    var list = el("div", "promolist");
    promos.forEach(function (p) {
      var row = el("div", "prow");
      var fam = promoFamily(p.k);
      var sw = el("span", "sw " + fam);
      sw.title = PROMO_FAMILY[fam];
      row.appendChild(sw);
      var bx = el("div", "pbody");
      var tl = el("div", "pt");
      tl.appendChild(promoTitleEl(p));
      bx.appendChild(tl);
      var meta = el("div", "pm");
      meta.appendChild(el("span", "pwhen", promoWhen(p)));
      meta.appendChild(el("span", "", (PROMO_SRC[p.src] || p.src) + (p.role === "mentioned" ? " · 설명에 언급" : "")));
      (p.k || []).forEach(function (k) { meta.appendChild(el("span", "ktag", k)); });
      bx.appendChild(meta);
      row.appendChild(bx);
      list.appendChild(row);
    });
    card.appendChild(list);
  }

  var hasNone = shifts.some(function (it) { return it.label === "none"; });
  card.appendChild(el("p", "hint", "배너·추천 노출은 기록이 없어 판정에 넣지 못했어요."
    + (hasNone ? " '확인된 프로모션 없음'은 이벤트·할인을 찾지 못했다는 뜻이에요." : "")));
  return card;
}

// ── 리뷰 분석 ──
// 분석 엔진은 rabsa.js (사이트와 Actions가 함께 쓴다).
// 리뷰 파일에 analysis(Actions가 구매자 리뷰 '전량'으로 계산)가 있으면 그것을 쓰고,
// 아직 전량 분석 전인 작품은 파일에 든 최근 리뷰로 즉석 계산한다.
// AI 분석이 있으면 '자세한 리뷰' 기준 화면(요소별 반응·공통 의견·과몰입)을 AI 결과로 바꾼다.
// '전체 리뷰' 기준은 규칙 엔진 그대로 (한 줄 리뷰까지 AI로 보면 비용이 너무 커서).
// AI 정확도: 사람 블라인드 채점 94% (규칙 엔진 73%), 2026-10-09 표본 120건.
function mergeAi(reviewData, ai) {
  if (!reviewData || !reviewData.analysis || !ai || !ai.analysis || !(ai.analysis.dTotal > 0)) return reviewData;
  var a = Object.assign({}, reviewData.analysis), x = ai.analysis;
  // 규칙 엔진이 센 자세한 리뷰가 AI가 읽은 것보다 눈에 띄게 많으면(순위 밖으로 나가 AI 분석이 멈춘 작품 등)
  // 낡은 AI 결과 대신 최신 규칙 엔진 결과를 보여준다
  var rd = a.dTotal || 0;
  if (rd > x.dTotal * 1.2 && rd - x.dTotal >= 10) return reviewData;
  a.aspectsD = x.aspectsD || {}; a.examples = x.examples || {}; a.phr = x.phr || {};
  a.dTotal = x.dTotal; a.dUsed = x.dUsed || 0;
  a.over = [(a.over || [0, 0])[0], (x.over || [0, 0])[1]]; a.overEx = x.overEx || [];
  a.ai = { model: ai.model, count: x.dTotal, updated: (ai.updated_at || "").slice(0, 10) };
  return Object.assign({}, reviewData, { analysis: a });
}

function reviewAgg(data) {
  if (!data) return null;
  if (data.analysis) return { agg: data.analysis, full: true };
  if (data.reviews && data.reviews.length) return { agg: RABSA.analyze(data.reviews, { names: data.names || [] }), full: false };
  return null;
}

// ── 공통 의견 ──
// '많이 나온 말' 짝(요소 단어·감성 단어)을 자연스러운 문장으로: '작화·예쁘' → '작화가 예쁘다'
var OPINION_PRED = {
  "좋": "좋다", "최고": "최고다", "예쁘": "예쁘다", "귀엽": "귀엽다", "재밌": "재밌다", "흥미": "흥미롭다",
  "잘생": "잘생겼다", "매력적": "매력적이다", "탄탄": "탄탄하다", "촘촘": "촘촘하다", "깔끔": "깔끔하다",
  "신선": "신선하다", "독특": "독특하다", "참신": "참신하다", "신박": "신박하다", "설레": "설렌다", "설렘": "설렌다",
  "두근": "두근거린다", "달달": "달달하다", "달콤": "달콤하다", "애틋": "애틋하다", "몰입": "몰입된다",
  "흡입력": "흡입력 있다", "흡인력": "흡입력 있다", "술술": "술술 읽힌다", "순삭": "순삭이다", "감동": "감동적이다",
  "여운": "여운이 남는다", "먹먹": "먹먹하다", "울컥": "울컥한다", "웃기": "웃기다", "웃음": "웃음이 난다",
  "유쾌": "유쾌하다", "피식": "피식 웃게 된다", "빵터": "빵 터진다", "사이다": "사이다다", "완벽": "완벽하다",
  "만족": "만족스럽다", "힐링": "힐링된다", "쫄깃": "쫄깃하다", "섹시": "섹시하다", "멋지": "멋지다",
  "아름답": "아름답다", "사랑스럽": "사랑스럽다", "미쳤": "미쳤다(좋은 뜻)", "미친": "미쳤다(좋은 뜻)",
  "대박": "대박이다", "명작": "명작이다", "인생작": "인생작이다", "맛있": "맛있다", "괜찮": "괜찮다",
  "무난": "무난하다", "볼만": "볼만하다", "준수": "준수하다", "짜임새": "짜임새 있다", "입체적": "입체적이다",
  "독보적": "독보적이다", "강추": "강력 추천", "강력추천": "강력 추천", "취저": "취향 저격", "취향저격": "취향 저격",
  "정주행": "정주행하게 된다", "밤새": "밤새 읽게 된다", "재탕": "다시 보게 된다", "재독": "다시 읽게 된다",
  "찰떡": "찰떡이다", "눈호강": "눈호강이다", "유죄": "치명적이다", "꿀잼": "꿀잼이다", "존잼": "존잼이다",
  "아쉽": "아쉽다", "지루": "지루하다", "답답": "답답하다", "별로": "별로다", "실망": "실망스럽다", "루즈": "루즈하다",
  "질질": "질질 끈다", "늘어지": "늘어진다", "고구마": "고구마다", "억지": "억지스럽다", "작위": "작위적이다",
  "유치": "유치하다", "뻔하": "뻔하다", "진부": "진부하다", "전형적": "전형적이다", "양산형": "양산형이다",
  "오글": "오글거린다", "급전개": "급전개다", "급발진": "급발진한다", "급마무리": "급하게 끝난다", "뜬금": "뜬금없다",
  "산만": "산만하다", "어색": "어색하다", "평면적": "평면적이다", "민폐": "민폐다", "찌질": "찌질하다",
  "멍청": "멍청하다", "호구": "호구 같다", "짜증": "짜증 난다", "노잼": "재미없다", "재미없": "재미없다",
  "허무": "허무하다", "허술": "허술하다", "싫": "싫다", "불편": "불편하다", "떨어지": "떨어진다", "애매": "애매하다",
  "허접": "허접하다", "용두사미": "용두사미다", "오타": "오타가 많다", "비싸": "비싸다", "최악": "최악이다",
  "캐붕": "캐릭터가 무너진다", "무매력": "매력이 없다", "매력없": "매력이 없다", "심심": "심심하다", "싱겁": "싱겁다",
  "난해": "난해하다", "비추": "비추천", "하차": "하차했다", "질리": "질린다", "거슬리": "거슬린다",
  "촌스럽": "촌스럽다", "올드": "올드하다", "부자연스럽": "부자연스럽다", "김빠": "김빠진다",
  "지지부진": "지지부진하다", "흐지부지": "흐지부지 끝난다",
  "절절": "절절하다", "순애": "순애다", "몽글몽글": "몽글몽글하다", "믿고보는": "믿고 본다", "훌륭": "훌륭하다",
  "삽질": "삽질한다", "비문": "비문이 많다", "오탈자": "오탈자가 많다", "역하": "역하다", "쓰레기": "쓰레기 같다",
  "불호": "불호다", "바보": "바보 같다", "찐따": "찐따 같다", "안읽히": "안 읽힌다", "간질간질": "간질간질하다",
  "애절": "애절하다", "깜찍": "깜찍하다", "입덕": "입덕하게 된다", "극락": "극락이다", "골때리": "골 때린다",
  // 엔진 v8에서 늘어난 말
  "흐뭇": "흐뭇하다", "풋풋": "풋풋하다", "쏠쏠": "쏠쏠하다", "스며들": "스며든다", "스며듭": "스며든다", "스며든": "스며든다",
  "따뜻": "따뜻하다", "행복": "행복하다", "원픽": "원픽이다", "끝내주": "끝내준다", "이입": "이입된다", "걸작": "걸작이다",
  "웰메이드": "웰메이드다", "기특": "기특하다", "묘미": "묘미가 있다", "강약조절": "강약 조절이 좋다", "완급조절": "완급 조절이 좋다",
  "보배": "보배 같다", "시원하": "시원하다", "벤츠": "벤츠다", "고움": "곱다", "고와": "곱다", "고운": "곱다", "소름": "소름 돋는다",
  "적절": "적절하다", "선물": "선물 같다", "단비": "단비 같다", "꼴리": "꼴린다", "꼴려": "꼴린다", "개꼴": "꼴린다", "존꼴": "꼴린다",
  "섹시": "섹시하다", "맛도리": "맛도리다", "레전드": "레전드다", "갓작": "갓작이다", "대작": "대작이다", "수작": "수작이다",
  "밋밋": "밋밋하다", "미숙": "미숙하다", "불친절": "불친절하다", "무의미": "무의미하다", "반감": "반감된다", "갑갑": "갑갑하다",
  "엉망": "엉망이다", "쓸데없": "쓸데없다", "부족": "부족하다", "섭섭": "섭섭하다", "서운": "서운하다", "지치": "지친다",
  "지쳐": "지친다", "역겹": "역겹다", "구린": "구리다", "구려": "구리다", "구림": "구리다", "망했": "망했다", "망함": "망했다",
  "노꼴": "안 꼴린다", "코웃음": "코웃음만 나온다", "헛웃음": "헛웃음이 나온다", "짜증": "짜증 난다", "피곤": "피곤하다",
  "노잼": "재미없다", "꾸역꾸역": "꾸역꾸역 읽게 된다", "흐린눈": "흐린 눈 하게 된다", "작붕": "작화가 무너진다", "속터지": "속 터진다",
  "조건부 추천": "조건부로 추천한다", "미친": "미쳤다(좋은 뜻)", "쩐다": "쩐다"
};
// 부정어가 '없이/않'으로 뒤집힌 칭찬: '지루 없음' → '지루하지 않다'
var OPINION_NOT = {
  "지루": "지루하지 않다", "답답": "답답하지 않다", "고구마": "고구마가 없다", "뻔하": "뻔하지 않다",
  "불편": "불편하지 않다", "질질": "질질 끌지 않다", "늘어지": "늘어지지 않다", "유치": "유치하지 않다",
  "억지": "억지스럽지 않다", "오글": "오글거리지 않다", "산만": "산만하지 않다", "어색": "어색하지 않다",
  "아쉽": "아쉬움이 없다", "루즈": "루즈하지 않다", "진부": "진부하지 않다", "뜬금": "뜬금없지 않다",
  "부족": "부족함이 없다", "쓸데없": "쓸데없는 부분이 없다", "짜치": "짜치지 않다", "거슬리": "거슬리지 않다",
  "캐붕": "캐붕이 없다", "작붕": "작붕이 없다", "실망": "실망시키지 않는다", "올드": "올드하지 않다", "밋밋": "밋밋하지 않다",
  "질리": "질리지 않다", "허술": "허술하지 않다", "별로": "별로가 아니다", "속터지": "속 터지지 않다"
};
function hasBatchim(word) {
  var c = word.charCodeAt(word.length - 1);
  return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0;
}
function opinionText(key) {
  var i = key.indexOf("·");
  var kw = i < 0 ? "" : key.slice(0, i), w = i < 0 ? key : key.slice(i + 1);
  var m = /^(.*?) (없음|아님)$/.exec(w), pred;
  if (m && m[2] === "없음") pred = OPINION_NOT[m[1]] || (m[1] + " 없음");
  else if (m) pred = OPINION_PRED[m[1]] ? OPINION_PRED[m[1]].replace(/다$/, "지 않다") : m[1] + " 아님";
  else if (OPINION_PRED[w]) pred = OPINION_PRED[w];
  else if (/다$/.test(w)) pred = w;                       // 엔진이 문장으로 만든 말 ('잘 쓴다', '다음이 궁금하다')
  else if (w.indexOf(" ") >= 0) pred = w + "다";          // '매력 있' → '매력 있다', '잘 읽히' → '잘 읽히다'
  else pred = w;
  return kw ? kw + (hasBatchim(kw) ? "이 " : "가 ") + pred : pred;
}

// '독자 반응 요약' 카드 — AI가 리뷰 표본(별점 낮은·공감 많은·최근 리뷰)을 읽고 정리한 것 (scripts/ai/ai_summary.mjs)
//   좋아하는 서사·케미 / 좋아한 점 / 아쉬운 점 / 과몰입 포인트 / 맞는 독자. 인용은 실제 리뷰에서 확인된 것만.
// 독자 반응 — 별점 리뷰에서 반복되는 말 (scripts/cmt/rev_daily.mjs)
//   rx.themes: [{b: like|talk|dislike, l: 묶음 이름, d: 기준, est: (약)개수, share: %, star: 평균 별점, low: 별1~3 %, likes, n: 표시된 리뷰 수,
//                s: [별1..별5 (약)개수], q: [[별점, 공감, 짧은 인용], ...]}]
//   rx.starTot / rx.starUntag: 별점마다 표시된 리뷰 수(환산) / 그중 어느 묶음에도 안 들어간 수 — 별점별 보기의 분모
function reactionCard(rx) {
  // 실제로 표시된 리뷰가 2개 이하인 묶음은 '반복'이라 보기 어려워 숨긴다
  var all = (rx && rx.themes) || [];
  var ts = all.filter(function (t) { return (t.n || 0) >= 3; });
  if (!ts.length) return null;
  var st = rx.stats || {};
  var approx = st.exact === false;
  var hasStar = !!(rx.starTot && rx.starTot.length === 5 && all.some(function (t) { return t.s; }));
  var card = el("div", "card sumcard rxcard");
  var h = el("h3");
  h.innerHTML = "독자 반응 — 별점 리뷰에서 반복되는 말 <span class='r'>리뷰 " + num(st.all || 0) + "개 중 내용 있는 리뷰 " + num(st.meaningful || 0) +
    "개" + (approx ? "(" + num(st.tagged || 0) + "개를 읽고 전체로 환산)" : " 전부") + " · " + String(rx.updated_at || "").slice(0, 10) + "</span>";
  card.appendChild(h);
  var stars = function (k) { var s = ""; for (var i = 0; i < 5; i++) s += i < k ? "★" : "☆"; return s; };
  var EMO = { like: "👍", talk: "💬", dislike: "👎" };
  // 별점 고르기: 전체 / ★1 … ★5 (별점마다 전체 리뷰 수)
  var view = 0;
  var chips = null;
  if (hasStar) {
    chips = el("div", "rxchips");
    [0, 1, 2, 3, 4, 5].forEach(function (k) {
      var c = el("button", "chip" + (k === view ? " on" : ""), k ? "★" + k + " · " + num((st.stars && st.stars[k]) || 0) : "전체");
      c.type = "button";
      c.addEventListener("click", function () { view = k; Array.prototype.forEach.call(chips.children, function (x, i) { x.classList.toggle("on", i === k); }); draw(); });
      chips.appendChild(c);
    });
    card.appendChild(chips);
  }
  var list = el("div", "opn");
  card.appendChild(list);
  var row = function (t, cnt, pct, maxCnt, k) {
    var r = el("div", "oprow sumrow rxrow rx" + t.b);
    var top = el("div", "optop");
    top.appendChild(el("b", "", (k ? EMO[t.b] + " " : "") + (t.l || "")));
    top.appendChild(el("span", "opc", (approx ? "약 " : "") + num(cnt) + "개 · " + pct + "%"));
    r.appendChild(top);
    var bar = el("div", "rxbar"); var bi = el("i"); bi.style.width = Math.max(2, Math.round(100 * cnt / (maxCnt || 1))) + "%"; bar.appendChild(bi);
    r.appendChild(bar);
    if (!k) r.appendChild(el("div", "rxm", "평균 ★" + (t.star != null ? t.star.toFixed(2) : "-") + ((t.low >= 10 || t.b === "dislike") ? " · 별 1~3개 " + (t.low || 0) + "%" : "") + " · 공감 " + num(t.likes || 0)));
    var qs = (t.q || []).filter(function (q) { return !k || q[0] === k; });
    if (!k) qs = qs.slice(0, 5);
    qs.forEach(function (q, i) {
      var qd = el("div", "ope rxq" + (i ? " more hidden" : ""));
      qd.appendChild(el("span", "st", stars(q[0])));
      qd.appendChild(document.createTextNode("“" + q[2] + "”" + (q[1] ? " · 공감 " + num(q[1]) : "")));
      r.appendChild(qd);
    });
    if (qs.length > 1) {
      r.classList.add("hasex");
      r.title = t.d || "";
      r.addEventListener("click", function () {
        Array.prototype.forEach.call(r.querySelectorAll(".more"), function (x) { x.classList.toggle("hidden"); });
        r.classList.toggle("open");
      });
    }
    list.appendChild(r);
  };
  var draw = function () {
    list.innerHTML = "";
    if (!view) {
      var maxEst = Math.max.apply(null, ts.map(function (t) { return t.est || 0; }).concat([1]));
      [["like", "👍 좋다는 말", ""], ["talk", "💬 많이 하는 말", ""], ["dislike", "👎 불호", "뚜렷한 불호 없음 — 작품을 진지하게 비판하는 말이 반복되지 않았어요."]].forEach(function (sec) {
        var arr = ts.filter(function (t) { return t.b === sec[0]; }).sort(function (x, y) { return (y.est || 0) - (x.est || 0); });
        list.appendChild(el("div", "exh", sec[1]));
        if (!arr.length) { if (sec[2]) list.appendChild(el("div", "rxempty", sec[2])); return; }
        arr.forEach(function (t) { row(t, t.est || 0, t.share || 0, maxEst, 0); });
      });
      return;
    }
    // 별점 k: 그 별점 리뷰에서 많이 나온 말 (좋다는 말·많이 하는 말·불호를 섞어 많은 순)
    var tot = rx.starTot[view - 1] || 0, un = rx.starUntag[view - 1] || 0;
    var arr = all.filter(function (t) { return t.s && t.s[view - 1] >= 2; }).sort(function (x, y) { return y.s[view - 1] - x.s[view - 1]; }).slice(0, 12);
    list.appendChild(el("div", "exh", "★" + view + " 리뷰에서 많이 나온 말 — 읽은 ★" + view + " 리뷰 " + (approx ? "약 " : "") + num(tot) + "개 기준" +
      (tot ? " · 어느 묶음에도 안 들어간 리뷰 " + Math.round(100 * un / tot) + "%" : "")));
    if (!arr.length) { list.appendChild(el("div", "rxempty", "이 별점에서 2개 넘게 반복된 말이 없어요.")); return; }
    var maxS = arr[0].s[view - 1];
    arr.forEach(function (t) { row(t, t.s[view - 1], tot ? Math.round(1000 * t.s[view - 1] / tot) / 10 : 0, maxS, view); });
  };
  draw();
  card.appendChild(el("p", "hint", "AI(Claude)가 리뷰를 읽고 반복되는 말을 묶은 뒤 리뷰마다 어느 묶음인지 표시했고, 개수·평균 별점은 프로그램이 셌어요. " +
    (approx ? "리뷰가 많아 일부(별점 낮은 리뷰는 되도록 전부)만 읽고 전체로 환산한 수예요(‘약’). " : "") +
    (hasStar ? "별점 단추를 누르면 그 별점 리뷰에서 많이 나온 말을 볼 수 있어요(👍좋다는 말 💬많이 하는 말 👎불호). " : "") +
    "리뷰 하나가 여러 묶음에 들어갈 수 있고, 리뷰 2개 이하인 묶음은 숨겼어요. 캐릭터에게 화내거나 휴재·완결을 아쉬워하는 말은 불호가 아니라 ‘많이 하는 말’로 셌어요. 줄을 누르면 리뷰가 더 나와요."));
  return card;
}

// 회차별 댓글 수 (scripts/cmt/cmt_counts.mjs) — cc.eps: [[회차 id, 화 번호, 공개 시각, 센 때까지 댓글 수, 센 시각, [[공개 후 시간, 댓글 수], ...]]]
//   같은 시점끼리만 비교한다: 센 때가 공개 30일 뒤인 회차는 '전체 수'끼리, 최근 회차는 7일째(없으면 3일째) 값끼리.
//   기준선 = 직전 5화(같은 잣대가 있는 회차)의 가운데 값. 1.5배↑ 급증, 2배↑ 대박, 0.7배↓가 3화 연속이면 이탈 경고.
//   여러 화를 한꺼번에 공개한 회차는 비교하지 않음.
function cmtCountCard(cc) {
  var HOUR = 3600e3;
  var snapAt = function (snaps, lo, hi) { var s = (snaps || []).filter(function (x) { return x[0] >= lo && x[0] < hi; })[0]; return s ? s[1] : null; };
  var rows = ((cc && cc.eps) || []).filter(function (e) { return e[1] !== null && e[3] !== null; }).map(function (e) {
    var ca = (e[2] && e[4]) ? (Date.parse(e[4]) - Date.parse(e[2])) / HOUR : 1e9;   // 센 때 공개 후 몇 시간이었나
    return { no: e[1], reg: e[2], n: e[3], ca: ca, mature: ca >= 720, c7: snapAt(e[5], 168, 216), c3: snapAt(e[5], 72, 120) };
  });
  if (rows.length < 3) return null;
  var median = function (a) { var b = a.slice().sort(function (x, y) { return x - y; }), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  rows.forEach(function (r, i) {
    r.batch = i > 0 && r.reg && rows[i - 1].reg && Math.abs(Date.parse(r.reg) - Date.parse(rows[i - 1].reg)) <= HOUR;
    r.ratio = null; r.by = "";
    if (r.batch) return;
    var key = r.mature ? "n" : r.c7 != null ? "c7" : r.c3 != null ? "c3" : null;
    if (!key) return;
    var prev = rows.slice(0, i).filter(function (x) { return !x.batch && (key === "n" ? x.mature : x[key] != null); }).slice(-5).map(function (x) { return x[key]; });
    if (prev.length < 2) return;
    var base = median(prev);
    if (base > 0) { r.ratio = r[key] / base; r.by = key === "n" ? "전체 수" : key === "c7" ? "공개 7일째" : "공개 3일째"; }
  });
  rows.forEach(function (r, i) {
    r.flags = [];
    if (r.ratio != null && r.ratio >= 2) r.flags.push("대박"); else if (r.ratio != null && r.ratio >= 1.5) r.flags.push("급증");
    if (i >= 2 && [0, 1, 2].every(function (k) { var x = rows[i - k]; return x.ratio != null && x.ratio <= 0.7; })) r.flags.push("이탈 경고");
  });
  var left = cc.done === false ? (cc.eps || []).filter(function (e) { return e[3] === null; }).length : 0;
  var card = el("div", "card");
  var h = el("h3");
  var top = rows.slice().sort(function (a, b) { return b.n - a.n; })[0];
  h.innerHTML = "회차별 댓글 수 <span class='r'>" + num(rows.length) + "화" + (left ? " (아직 세는 중 · " + num(left) + "회차 남음)" : "") +
    " · 가장 많은 회차 " + top.no + "화(" + num(top.n) + "개) · " + String(cc.at || "").slice(0, 10) + " 기준</span>";
  card.appendChild(h);
  var NS = "http://www.w3.org/2000/svg";
  var mk = function (tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  var bw = Math.max(4, Math.min(22, Math.floor(680 / rows.length) - 2)), H = 150, W = rows.length * (bw + 2) + 20;
  // 눈금: 1화처럼 혼자 튀는 막대(두 번째로 큰 값의 2배↑)가 있으면 그 막대는 위를 잘라 ▲로 표시하고 나머지가 잘 보이게
  var sorted = rows.map(function (r) { return r.n; }).sort(function (a, b) { return b - a; });
  var max = Math.max(1, sorted[0] > sorted[1] * 2 ? sorted[1] * 1.15 : sorted[0]);
  // 짧은 연재는 늘어나지 않게 높이를 고정하고, 긴 연재는 옆으로 밀어 보게(chartwrap 가로 스크롤)
  var svg = mk("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, style: "display:block;min-width:" + Math.min(W, 640) + "px;max-width:" + Math.max(W, 320) + "px" });
  var step = Math.ceil(rows.length / 20);
  rows.forEach(function (r, i) {
    var clipped = r.n > max;
    var bh = Math.max(1, Math.round((Math.min(r.n, max) / max) * (H - 34))), x = 10 + i * (bw + 2), y = H - 16 - bh;
    var cls = "ccbar" + (!r.mature ? " young" : "") + (r.flags.some(function (f) { return f !== "이탈 경고"; }) ? " up" : "") + (r.flags.indexOf("이탈 경고") >= 0 ? " down" : "");
    var g = mk("g", {}, svg);
    var t = mk("title", {}, g);
    t.textContent = r.no + "화 · 댓글 " + num(r.n) + "개" + (r.reg ? " · 공개 " + r.reg.slice(0, 10) : "") +
      (!r.mature ? " · 공개 " + Math.max(0, Math.round(r.ca / 24)) + "일째에 센 수(아직 느는 중)" : "") +
      (r.c7 != null ? " · 7일째 " + num(r.c7) + "개" : r.c3 != null ? " · 3일째 " + num(r.c3) + "개" : "") +
      (r.ratio != null ? " · 직전 회차들(" + r.by + ") 가운데 값의 " + r.ratio.toFixed(2) + "배" : "") +
      (r.batch ? " · 여러 화 동시 공개(비교 안 함)" : "") + (r.flags.length ? " · " + r.flags.join(", ") : "");
    mk("rect", { x: x, y: y, width: bw, height: bh, rx: 1.5, "class": cls }, g);
    var mark = (clipped ? "▲" : "") + r.flags.map(function (f) { return f[0]; }).join("");
    if (mark) { var ft = mk("text", { x: x + bw / 2, y: y - 3, "text-anchor": "middle", "class": "ccflag" }, g); ft.textContent = mark; }
    if (i % step === 0) { var lt = mk("text", { x: x + bw / 2, y: H - 4, "text-anchor": "middle", "class": "cclab" }, g); lt.textContent = r.no; }
  });
  var w = el("div", "chartwrap"); w.appendChild(svg); card.appendChild(w);
  card.appendChild(el("p", "hint", "막대 = 회차별 댓글 수(막대에 마우스를 올리면 자세히). ▲는 너무 커서 위를 자른 막대. 막대 위 글자: 대=대박(직전 회차들 가운데 값의 2배↑), 급=급증(1.5배↑), 이=이탈 경고(0.7배↓ 3화 연속). " +
    "같은 시점끼리 비교해요: 공개 30일 지난 회차는 전체 수끼리, 최근 회차는 공개 7일째(없으면 3일째) 수끼리. 연한 막대는 아직 느는 중이고, 여러 화를 한꺼번에 공개한 회차는 비교하지 않아요. 1화는 새 독자가 계속 들어와 댓글이 많은 게 보통이에요." +
    (left ? " 아직 앞 회차부터 세는 중이라 일부 회차가 빠져 있어요(매일 이어서 셉니다)." : "")));
  return card;
}

// 작품 전체에서 '공통 의견'(가장 많이 반복된 말)을 모은다: [[부호, 문장, 건수, 대표 발췌], ...]
function commonOpinions(agg) {
  var phrAll = RABSA.packPhr(agg.phr || {}, 10), pos = [], neg = [], mid = [];
  // '반복된 말'로 칠 최소 건수: 요소를 뽑은 리뷰의 2% 이상, 최소 2건 (한두 건짜리 오분류가 대표처럼 보이지 않게)
  var minN = Math.max(2, Math.round(((agg.aspectsD ? agg.dUsed : agg.used) || 0) * 0.02));
  Object.keys(phrAll).forEach(function (key) {
    mergePhraseSide(phrAll[key].p).forEach(function (e) { pos.push([1, e[0], e[1], e[2]]); });
    mergePhraseSide(phrAll[key].n).forEach(function (e) { neg.push([-1, e[0], e[1], e[2]]); });
    mergePhraseSide(phrAll[key].m).forEach(function (e) { mid.push([0, e[0], e[1], e[2]]); });   // 무난(그냥 그렇다)
  });
  var top = function (arr, n) {
    var by = {};
    arr.forEach(function (o) {                       // 같은 문장이 된 짝은 합침
      var t = opinionText(o[1]);
      if (!by[t]) by[t] = [o[0], t, 0, o[3], 0];
      by[t][2] += o[2];
      if (o[2] > by[t][4]) { by[t][3] = o[3]; by[t][4] = o[2]; }
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .filter(function (o) { return o[2] >= minN; })
      .sort(function (a, b) { return b[2] - a[2]; }).slice(0, n);
  };
  return { pos: top(pos, 6), mid: top(mid, 3), neg: top(neg, 4) };
}

function opinionCard(data) {
  var a = reviewAgg(data);
  if (!a) return null;
  var agg = a.agg, ops = commonOpinions(agg);
  if (!ops.pos.length && !ops.neg.length && !ops.mid.length) return null;
  var card = el("div", "card");
  var h = el("h3");
  var hasD = !!agg.aspectsD;
  h.innerHTML = "독자들의 공통 의견 <span class='r'>" + (agg.ai
    ? "AI가 자세한 리뷰 " + num(agg.dTotal || 0) + "건을 읽고 모은 말"
    : hasD ? "자세한 리뷰 " + num(agg.dTotal || 0) + "건에서 반복된 말"
    : "리뷰 " + num(agg.total) + "건에서 반복된 말") + "</span>";
  card.appendChild(h);
  var list = el("div", "opn");
  var add = function (o) {
    var row = el("div", "oprow " + (o[0] > 0 ? "exp" : o[0] < 0 ? "exn" : "exm"));
    var top = el("div", "optop");
    top.appendChild(el("b", "", (o[0] > 0 ? "👍 " : o[0] < 0 ? "👎 " : "😐 ") + o[1]));
    top.appendChild(el("span", "opc", num(o[2]) + "건"));
    row.appendChild(top);
    if (o[3]) row.appendChild(el("div", "ope", "“" + o[3] + "”"));
    list.appendChild(row);
  };
  ops.pos.forEach(add);
  if (ops.mid.length) {
    list.appendChild(el("div", "exh", "무난하다는 평 (칭찬이지만 '그냥 그렇다'에 가까운 말)"));
    ops.mid.forEach(add);
  }
  list.appendChild(el("div", "exh", ops.neg.length ? "아쉬운 점으로 반복된 말" : "아쉬운 점: 뚜렷하게 반복된 말 없음"));
  ops.neg.forEach(add);
  // 캐릭터에게 화내는 과몰입 반응 — 작품 불만이 아니라 몰입했다는 신호라 따로 보여준다
  var ov = agg.over ? (hasD ? agg.over[1] : agg.over[0]) : 0;
  if (ov > 0) {
    list.appendChild(el("div", "exh", "캐릭터 과몰입 반응 (불만으로 세지 않음)"));
    var orow = el("div", "oprow");
    var otop = el("div", "optop");
    otop.appendChild(el("b", "", "🔥 캐릭터에게 화내거나 놀리며 몰입한 반응"));
    otop.appendChild(el("span", "opc", num(ov) + "건"));
    orow.appendChild(otop);
    (agg.overEx || []).slice(0, 2).forEach(function (e) { orow.appendChild(el("div", "ope", "“" + e[0] + "”")); });
    list.appendChild(orow);
  }
  card.appendChild(list);
  card.appendChild(el("p", "hint", (hasD
    ? "자세한 리뷰(공백·이모지 빼고 " + RABSA.DETAIL_MIN + "자 이상)에서 같은 말을 한 횟수입니다. 이벤트 날 몰리는 한 줄 리뷰는 뺐어요."
    : "리뷰에서 같은 말을 한 횟수입니다.")
    + " 다른 작품 얘기('다른 소설들은…', '전작은…')는 이 작품 평가에서 뺐어요."
    + (agg.ai ? " 이 작품은 AI(Claude)가 자세한 리뷰를 한 건씩 읽고 분류했어요 (" + agg.ai.updated + " 기준)." : "")));
  return card;
}

function aspectList(agg, detailed) {
  var src = detailed ? (agg.aspectsD || {}) : (agg.aspects || {});
  return RABSA.aspects.map(function (a) {
    var s = src[a.key] || [0, 0];
    return { key: a.key, label: a.label, pos: s[0], neg: s[1], mid: s[2] || 0, strong: s[3] || 0, strongNeg: s[4] || 0 };
  }).filter(function (x) { return x.pos + x.neg + x.mid >= 2; })
    .sort(function (a, b) { return (b.pos + b.neg + b.mid) - (a.pos + a.neg + a.mid); });
}

// 같은 말로 묶이는 '많이 나온 말' 짝은 합친다(건수를 더함, 대표 문장은 건수 많은 쪽 것)
// (이름이 달라도 화면에 같은 문장으로 보이는 것 — '작화·예쁘'와 '작화가 예쁘다' — 도 합친다)
function mergePhraseSide(arr) {
  var by = {}, order = [];
  (arr || []).forEach(function (e) {
    var nk = RABSA.normKey(e[0]), t = opinionText(nk);
    if (!by[t]) { by[t] = [nk, e[1], e[2], e[3], e[4]]; order.push(t); }
    else { by[t][1] += e[1]; if (!by[t][2] && e[2]) { by[t][2] = e[2]; by[t][3] = e[3]; by[t][4] = e[4]; } }
  });
  return order.map(function (t) { return by[t]; }).sort(function (a, b) { return b[1] - a[1]; });
}

// '요소별 반응' 카드 — 어떤 요소(작화·스토리·캐릭터…)가 호평/아쉬움인지.
// 리디는 리뷰 이벤트 날 '재밌어요' 같은 한 줄 리뷰가 하루 수백~수천 건 몰리므로,
// 기본은 '자세한 리뷰'(공백·이모지 빼고 40자 이상) 기준으로 보여주고 '전체'로 바꿔 볼 수 있다.
// 예시(많이 나온 말·공감 많은 문장)는 늘 자세한 리뷰에서 뽑는다.
function aspectCard(data) {
  var a = reviewAgg(data);
  if (!a) return null;
  var agg = a.agg;
  if (!aspectList(agg, false).length) return null;
  var hasD = !!agg.aspectsD;
  var dN = agg.dTotal || 0;
  var basis = (hasD && dN >= 20) ? "d" : "all";     // 자세한 리뷰가 너무 적으면 전체 기준으로 시작

  var card = el("div", "card");
  var h = el("h3");
  card.appendChild(h);
  var seg = null;
  if (hasD) {
    seg = el("div", "seg small aspbasis");
    [["d", "자세한 리뷰 " + num(dN) + "건"], ["all", "전체 리뷰 " + num(agg.total) + "건"]].forEach(function (o) {
      var b = el("button", "", o[1]);
      b.dataset.b = o[0];
      b.addEventListener("click", function () { basis = o[0]; paint(); });
      seg.appendChild(b);
    });
    card.appendChild(seg);
  }
  var body = el("div");
  card.appendChild(body);
  var phrAll = RABSA.packPhr(agg.phr || {}, 10);   // 저장본(배열)·즉석 계산(맵) 모두 같은 형태로

  function paint() {
    if (seg) Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle("on", b.dataset.b === basis); });
    var detailed = basis === "d";
    var used = detailed ? (agg.dUsed || 0) : agg.used;
    var shown = aspectList(agg, detailed);
    var src = a.full ? "구매자 리뷰 " + num(agg.total) + "건" : "최근 리뷰 " + num(agg.total) + "건";
    h.innerHTML = "요소별 반응 <span class='r'>" + (detailed && agg.ai
      ? "AI가 자세한 리뷰 " + num(dN) + "건을 읽고 분석 · " + num(used) + "건에서 뽑음"
      : detailed
      ? src + " 중 자세한 리뷰 " + num(dN) + "건 기준 · " + num(used) + "건에서 뽑음"
      : src + " 전체 · " + num(used) + "건에서 뽑음") + "</span>";
    body.innerHTML = "";
    if (!shown.length) {
      body.appendChild(el("p", "hint", "자세한 리뷰에서 요소를 이야기한 문장이 아직 적어요. '전체 리뷰'를 눌러 보세요."));
      return;
    }

    // 한 줄 요약. 리뷰가 많을수록 기준을 올린다(뽑힌 리뷰의 0.5%, 최소 3건).
    // '아쉬움 많은 요소' = 이 작품의 평균보다 지적 비율이 눈에 띄게 높은 요소
    var minN = Math.max(3, Math.round(used * 0.005));
    var sp = 0, sn = 0;
    shown.forEach(function (x) { sp += x.pos + x.mid; sn += x.neg; });
    var avgNeg = (sp + sn) ? sn / (sp + sn) : 0;
    var negShare = function (x) { return x.neg / (x.pos + x.neg + x.mid); };
    var strongPos = shown.filter(function (x) { return x.pos >= minN && negShare(x) <= Math.max(0.1, avgNeg); })
      .sort(function (x, y) { return y.pos - x.pos; }).slice(0, 3);
    // 평균의 1.5배 이상이거나, 호불호가 큰 작품이라도 지적이 40%를 넘으면 표시
    var strongNeg = shown.filter(function (x) {
      return x.neg >= minN && (negShare(x) >= 0.4 || negShare(x) >= Math.max(0.15, avgNeg * 1.5));
    }).sort(function (x, y) { return negShare(y) - negShare(x); }).slice(0, 3);
    if (strongPos.length || strongNeg.length) {
      var sum = el("p", "covernote");
      var parts = [];
      if (strongPos.length) parts.push("주로 호평: " + strongPos.map(function (x) { return x.label; }).join(" · "));
      if (strongNeg.length) parts.push("아쉬움 많은 요소: " + strongNeg.map(function (x) {
        return x.label + "(" + Math.round(negShare(x) * 100) + "%)";
      }).join(" · "));
      sum.textContent = parts.join("   /   ");
      body.appendChild(sum);
    }

    var wrap = el("div", "asp"), anyEx = false;
    var exFrom = hasD ? "자세한 리뷰에서 " : "";
    shown.slice(0, 12).forEach(function (x) {
      var t = x.pos + x.neg + x.mid;
      var row = el("div", "asprow");
      row.appendChild(el("div", "asplabel", x.label));
      var bar = el("div", "aspbar");
      var p = el("div", "asppos"); p.style.width = (x.pos / t * 100) + "%";
      var md = el("div", "aspmid"); md.style.width = (x.mid / t * 100) + "%";
      var n = el("div", "aspneg"); n.style.width = (x.neg / t * 100) + "%";
      bar.appendChild(p); bar.appendChild(md); bar.appendChild(n);
      row.appendChild(bar);
      row.appendChild(el("div", "aspnum", "👍" + num(x.pos) + (x.mid ? " 😐" + num(x.mid) : "") + " 👎" + num(x.neg)));
      wrap.appendChild(row);

      // 막대를 누르면 ① 많이 나온 말(2번 이상 반복된 요소·감성 짝 + 대표 발췌)
      //            ② 공감 많은 문장(공감 1개 이상, 공감 순) — 둘 다 자세한 리뷰에서
      var ph = phrAll[x.key] || { p: [], n: [] };
      ph = { p: mergePhraseSide(ph.p), m: mergePhraseSide(ph.m), n: mergePhraseSide(ph.n) };
      var reps = ph.p.filter(function (e) { return e[1] >= 2; }).slice(0, 3).map(function (e) { return [1, e]; })
        .concat(ph.m.filter(function (e) { return e[1] >= 2; }).slice(0, 2).map(function (e) { return [0, e]; }))
        .concat(ph.n.filter(function (e) { return e[1] >= 2; }).slice(0, 2).map(function (e) { return [-1, e]; }));
      var ex = (agg.examples || {})[x.key] || {};
      var liked = (ex.p || []).map(function (e) { return [1, e]; }).concat((ex.m || []).map(function (e) { return [0, e]; }))
        .concat((ex.n || []).map(function (e) { return [-1, e]; }))
        .filter(function (r) { return r[1][1] >= 1; })
        .sort(function (r1, r2) { return (r2[1][1] - r1[1][1]) || (r1[1][2] < r2[1][2] ? 1 : -1); })
        .slice(0, 4);
      if (!reps.length && !liked.length) return;
      anyEx = true;
      row.classList.add("hasex");
      var box = el("div", "aspex hidden");
      if (t < 10) box.appendChild(el("div", "exh", "언급이 " + t + "건뿐이라 참고용으로만 보세요"));
      // 뉘앙스 내역: 강한 호평 / 무난 / 강한 불만
      var nu = [];
      if (x.strong) nu.push("🔥 강한 호평 " + num(x.strong));
      if (x.mid) nu.push("😐 무난 " + num(x.mid));
      if (x.strongNeg) nu.push("💢 강한 불만 " + num(x.strongNeg));
      if (nu.length) box.appendChild(el("div", "exh", "뉘앙스: " + nu.join(" · ")));
      if (reps.length) {
        box.appendChild(el("div", "exh", exFrom + "많이 나온 말"));
        reps.forEach(function (r) {
          var e = r[1], d = el("div", r[0] > 0 ? "exp" : r[0] < 0 ? "exn" : "exm");
          d.appendChild(el("b", "", (r[0] > 0 ? "👍 " : r[0] < 0 ? "👎 " : "😐 ") + opinionText(e[0]) + " " + num(e[1]) + "건"));
          if (e[2]) d.appendChild(document.createTextNode(" — “" + e[2] + "”"));
          box.appendChild(d);
        });
      }
      if (liked.length) {
        box.appendChild(el("div", "exh", exFrom + "공감 많은 문장"));
        liked.forEach(function (r) {
          var e = r[1], d = el("div", r[0] > 0 ? "exp" : r[0] < 0 ? "exn" : "exm");
          d.appendChild(el("b", "", (r[0] > 0 ? "👍 " : r[0] < 0 ? "👎 " : "😐 ") + "공감 " + num(e[1])));
          d.appendChild(document.createTextNode(" “" + e[0] + "”"));
          box.appendChild(d);
        });
      }
      row.addEventListener("click", function () { box.classList.toggle("hidden"); });
      wrap.appendChild(box);
    });
    body.appendChild(wrap);

    var note = detailed && agg.ai
      ? "자세한 리뷰를 AI(Claude)가 한 건씩 읽고 요소별 호평·아쉬움을 판정했어요 (사람이 채점한 정확도 94%, " + agg.ai.updated + " 기준). '전체 리뷰'는 자동 규칙으로 센 값이에요. 초록=호평, 회색=무난, 빨강=아쉬움."
      : "별점이 아니라 리뷰 '내용'을 문장 단위로 분석한 대략적 경향입니다. 초록=호평, 회색=무난('나쁘지 않다·그다지 없다'처럼 그냥 그렇다는 말), 빨강=아쉬움 언급 횟수.";
    if (hasD) note += " 자세한 리뷰 = 공백·이모지를 빼고 " + RABSA.DETAIL_MIN + "자 이상 (이벤트 날 몰리는 '재밌어요' 같은 한 줄 리뷰와 구분).";
    if (anyEx) note += " 막대를 누르면 '많이 나온 말'(반복 횟수)과 '공감 많은 문장'이 나와요.";
    if (!a.full) note += " 아직 최근 리뷰만으로 계산했어요 — 구매자 리뷰 전체 분석은 순위 높은 작품부터 차례로 진행 중입니다.";
    if (used < 10) note += " 뽑힌 리뷰가 적어 참고용으로만 보세요.";
    body.appendChild(el("p", "hint", note));
  }
  paint();
  return card;
}

function reviewCard(data) {
  var card = el("div", "card");
  var a = reviewAgg(data);
  var rs = (data && data.reviews) || [];
  if (!a) {
    card.appendChild(el("h3", "", "리뷰"));
    card.appendChild(el("p", "hint", "이 작품의 리뷰는 아직 모으지 않았습니다.\n리뷰는 순위가 높은 작품부터 차례로 모읍니다."));
    return card;
  }
  var agg = a.agg;
  if (a.full && !agg.total) {
    card.appendChild(el("h3", "", "리뷰"));
    card.appendChild(el("p", "hint", "아직 구매자 리뷰가 없습니다. (리뷰 분석은 구매자 리뷰만 봅니다)"));
    return card;
  }

  var h = el("h3");
  h.innerHTML = "리뷰 분석 <span class='r'>" + (a.full
    ? "구매자 리뷰 " + num(agg.total) + "건 기준"
    : "모아둔 " + num(rs.length) + "건 기준") + "</span>";
  card.appendChild(h);

  // 긍정/부정 (별점 기준 — 지어내지 않고 실제 점수로 계산)
  var st = agg.stars || {};
  var pos = (st[4] || 0) + (st[5] || 0), neu = st[3] || 0, neg = (st[1] || 0) + (st[2] || 0);
  var tot = pos + neu + neg;
  if (tot) {
    var bars = el("div", "bars");
    bars.appendChild(barRow("긍정", pos, tot, "pos"));
    bars.appendChild(barRow("보통", neu, tot));
    bars.appendChild(barRow("부정", neg, tot, "neg"));
    card.appendChild(bars);
    card.appendChild(el("p", "hint", "별점 4~5점을 긍정, 3점을 보통, 1~2점을 부정으로 계산했습니다."));
  }

  // 리뷰 수 추이 — 전량 분석 작품은 '작성일 기준 월별 누적'(처음부터의 추이), 아니면 모은 날 기준
  var mo = agg.months || {}, mkeys = Object.keys(mo).sort();
  if (a.full && mkeys.length >= 2) {
    var acc = 0;
    var mpts = mkeys.map(function (m) { acc += mo[m]; return { d: m, v: acc }; });
    var mw = el("div", "chartwrap");
    mw.style.marginTop = "12px";
    mw.appendChild(lineChart(mpts, {
      invert: false, fmt: function (v) { return num(Math.round(v)) + "건"; },
      label: function (d) { return d.slice(2).replace("-", "."); }
    }));
    card.appendChild(el("h3", "", "구매자 리뷰 누적 추이"));
    card.appendChild(mw);
    card.appendChild(el("p", "hint", "리뷰 날짜 기준 월별 누적이에요 (수정한 리뷰는 수정한 날로 잡힙니다)."));
  } else if (data.history && data.history.length >= 2) {
    var pts = data.history.map(function (x) { return { d: x.date, v: x.count }; });
    var w = el("div", "chartwrap");
    w.style.marginTop = "12px";
    w.appendChild(lineChart(pts, { invert: false, fmt: function (v) { return num(Math.round(v)) + "건"; } }));
    card.appendChild(el("h3", "", "모은 리뷰 수 추이"));
    card.appendChild(w);
  }

  // 자주 나오는 말 — 자세한 리뷰가 20건 이상이면 그 기준(이벤트성 '기대됩니다·새해' 같은 말이 빠짐)
  var useD = (agg.dTotal || 0) >= 20 && (agg.kwD || agg.kwfD);
  var kws = useD ? (agg.kwD || RABSA.topWords(agg.kwfD, 24)) : (agg.kw || RABSA.topWords(agg.kwf, 24));
  kws = kws.slice(0, 24);
  if (kws.length) {
    card.appendChild(el("h3", "", useD ? "자세한 리뷰에 자주 나오는 말" : "리뷰에 자주 나오는 말"));
    var tb = el("div", "tags");
    kws.forEach(function (p) {
      var t = el("span", "tag", p[0] + " " + num(p[1]));
      t.style.fontSize = Math.min(1.05, 0.74 + p[1] / (kws[0][1] * 4)) + "rem";
      tb.appendChild(t);
    });
    card.appendChild(tb);
  }

  // 최근 리뷰
  if (rs.length) {
    card.appendChild(el("h3", "", "최근 리뷰"));
    var box = el("div", "reviews");
    rs.slice(0, 12).forEach(function (r) {
      var rv = el("div", "rv");
      var m = el("div", "m");
      m.appendChild(el("span", "", "★".repeat(Math.max(0, r.rating || 0))));
      m.appendChild(el("span", "", r.user || ""));
      m.appendChild(el("span", "", (r.at || "").slice(0, 10)));
      if (r.likes) m.appendChild(el("span", "", "공감 " + r.likes));
      if (r.buyer) m.appendChild(el("span", "", "구매자"));
      rv.appendChild(m);
      rv.appendChild(el("div", "c", r.content || ""));
      box.appendChild(rv);
    });
    card.appendChild(box);
  }
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
