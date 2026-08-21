/* 리디 트래커 — 화면 동작
   저장된 JSON을 읽어서 그리기만 합니다. 서버도 빌드도 없습니다. */
"use strict";

// ────────────────────────────────────────── 데이터 보관함
var D = {
  index: null,
  latest: null,
  events: null,
  catalog: null,          // 전체 작품 (검색할 때만 불러옴)
  history: {},            // "2026-08" → 추이 데이터
  detail: {},             // 작품ID → 상세
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
    var g = sec.groups[t.group] || (sec.groups[t.group] = { name: t.group, parent: null, subs: {} });
    if (t.is_sub) {
      var s = g.subs[t.name] || (g.subs[t.name] = { name: t.name, id: t.category_id, periods: [] });
      s.periods.push(t.period);
    } else {
      if (!g.parent) g.parent = { name: t.name, id: t.category_id, periods: [] };
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
  ["move", "event", "search"].forEach(function (v) {
    $("#view-" + v).classList.toggle("hidden", v !== UI.view);
  });
  if (rank) drawRank();
  if (UI.view === "move") drawMove();
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
  $("#groupPick").addEventListener("change", function () {
    UI.group = this.value; UI.sub = "";
    fillSubs(); fillPeriods(); drawRank();
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
  var sel = $("#groupPick");
  sel.innerHTML = "";
  var groups = D.tree[UI.section].groups;
  Object.keys(groups).forEach(function (g) {
    sel.appendChild(new Option(g, g));
  });
  if (!UI.group || !groups[UI.group]) UI.group = Object.keys(groups)[0];
  sel.value = UI.group;
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
  return t ? (t.id + "-" + UI.period) : null;
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
    list.appendChild(bookRow(id, b, i + 1, ch));
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

function bookRow(id, b, rank, ch) {
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

  li.addEventListener("click", function () { openBook(id); });
  li.addEventListener("keydown", function (e) { if (e.key === "Enter") openBook(id); });
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
    list.appendChild(bookRow(r.id, b, r.rank || "–", fake));
    shown++;
  });
  if (!shown) list.appendChild(el("li", "empty", "해당하는 작품이 없습니다."));
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
}

function drawEvents() {
  if (UI.view !== "event") return;
  var box = $("#eventList");
  if (!D.events) {
    box.innerHTML = '<p class="empty">불러오는 중…</p>';
    softJSON("data/events/latest.json").then(function (j) {
      D.events = (j && j.events) || [];
      drawEvents();
    });
    return;
  }

  var q = $("#eventQ").value.trim().toLowerCase();
  var now = Date.now();
  var list = D.events.filter(function (e) {
    return !q || (e.title || "").toLowerCase().indexOf(q) >= 0;
  });
  list.sort(function (a, b) {
    if (UI.eventSort === "end") return new Date(a.end_date || 0) - new Date(b.end_date || 0);
    return new Date(b.start_date || 0) - new Date(a.start_date || 0);
  });

  $("#eventHead").innerHTML = "진행 중 <b>" + num(list.length) + "</b>건";
  box.innerHTML = "";
  list.slice(0, 400).forEach(function (e) {
    var row = el("div", "eventrow");
    var h = el("h3");
    var a = el("a", "", e.title);
    a.href = e.url; a.target = "_blank"; a.rel = "noopener";
    h.appendChild(a);
    row.appendChild(h);

    var when = el("div", "when");
    var days = e.end_date ? Math.ceil((new Date(e.end_date) - now) / 86400000) : null;
    when.textContent = fmtDate(e.start_date) + " ~ " + fmtDate(e.end_date) + "  ";
    if (days !== null && days >= 0 && days < 3650) {
      var dd = el("span", "dday" + (days <= 3 ? " soon" : ""), days === 0 ? "오늘 종료" : "D-" + days);
      when.appendChild(dd);
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
function openBook(id) {
  var sheet = $("#sheet");
  sheet.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  var body = $("#sheetBody");
  body.innerHTML = '<p class="empty">불러오는 중…</p>';

  var months = (D.index.months || []).slice(-12);
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
    drawBook(id, r[0], r[1], r[2].filter(Boolean));
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

function drawBook(id, detail, reviewData, months) {
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
  hi.appendChild(el("h2", "", (detail && detail.title) || b.t || id));
  hi.appendChild(el("div", "au", (b.a || (detail && (detail.authors_full || []).map(function (a) { return a.name; })) || []).join(", ")));
  var stats = el("div", "dstats");
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
  body.appendChild(rankTrendCard(id, months));

  // ── 별점 추이 ──
  var ratingSeries = collectSeries(months, function (h) { return (h.rating || {})[id]; });
  if (ratingSeries.pts.filter(function (p) { return p.v !== null; }).length >= 2) {
    var rc = el("div", "card");
    rc.appendChild(el("h3", "", "별점 추이"));
    var w = el("div", "chartwrap");
    w.appendChild(lineChart(ratingSeries.pts, { invert: false, fmt: function (v) { return v.toFixed(2); } }));
    rc.appendChild(w);
    body.appendChild(rc);
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
function rankTrendCard(id, months) {
  var card = el("div", "card");
  var h = el("h3", "", "순위 추이");
  card.appendChild(h);

  var avail = [];
  PERIOD_ORDER.forEach(function (p) {
    var found = null;
    months.forEach(function (m) {
      var slot = (m.rank || {})[id];
      if (!slot) return;
      Object.keys(slot).forEach(function (k) { if (k.slice(-p.length - 1) === "-" + p) found = k; });
    });
    if (found) avail.push({ period: p, key: found });
  });

  if (!avail.length) {
    card.appendChild(el("p", "hint", "아직 추이 데이터가 없습니다. 며칠 모으면 그래프가 그려집니다."));
    return card;
  }

  var seg = el("div", "seg small");
  seg.style.marginBottom = "10px";
  var wrap = el("div", "chartwrap");
  var note = el("p", "hint");

  function show(item) {
    Array.prototype.forEach.call(seg.children, function (b) {
      b.classList.toggle("on", b.dataset.p === item.period);
    });
    var s = collectSeries(months, function (h) { return ((h.rank || {})[id] || {})[item.key]; });
    wrap.innerHTML = "";
    var pts = s.pts.filter(function (p) { return p.v !== null; });
    if (pts.length < 2) {
      wrap.appendChild(el("p", "hint", "기록이 " + pts.length + "일치뿐이라 아직 선을 그릴 수 없습니다."));
    } else {
      wrap.appendChild(lineChart(s.pts, { invert: true, fmt: function (v) { return v + "위"; } }));
    }
    var vals = pts.map(function (p) { return p.v; });
    note.textContent = vals.length
      ? "최고 " + Math.min.apply(null, vals) + "위 · 최근 " + vals[vals.length - 1] + "위 · " + vals.length + "일 기록"
      : "";
  }

  avail.forEach(function (item) {
    var b = el("button", "", periodLabel(item.period));
    b.dataset.p = item.period;
    b.addEventListener("click", function () { show(item); });
    seg.appendChild(b);
  });
  card.appendChild(seg);
  card.appendChild(wrap);
  card.appendChild(note);
  show(avail[0]);
  return card;
}

/** 월별 파일들에서 하나의 시계열을 뽑아 [{d:날짜, v:값}] 로 만든다. */
function collectSeries(months, pick) {
  var pts = [];
  months.forEach(function (h) {
    if (!h || !h.days) return;
    var arr = pick(h) || [];
    h.days.forEach(function (day, i) {
      var v = (i < arr.length) ? arr[i] : null;
      pts.push({ d: day, v: (v === undefined ? null : v) });
    });
  });
  return { pts: pts };
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

  var d = "", started = false;
  pts.forEach(function (p, i) {
    if (p.v === null) { started = false; return; }
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
