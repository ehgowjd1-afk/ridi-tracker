#!/usr/bin/env node
/*
 * 리디 전 작품 별점 + 구매자 리뷰 '전량' 수집·분석 (GitHub Actions: 리뷰·별점 전체 수집)
 *
 * 하는 일
 *  1) 전 작품 별점 수 (하루 1번)
 *     리디 카테고리 목록 API가 작품마다 별점 분포를 200개씩 준다. 세부 카테고리를 전부 훑어
 *     우리 작품 목록(books.json, 한 번이라도 순위에 든 작품)의 별점 수를 매일 남긴다.
 *     → 순위 밖으로 나간 작품도 '별점 개수 추이'가 끊기지 않는다.
 *     저장: docs/data/rc/<YYYY-MM>/<NN>.json  (NN = 작품 ID 끝 두 자리, 추이 파일과 같은 형태)
 *  2) 구매자 리뷰 전량 → 요소별 반응 분석
 *     리뷰 API(구매자만, 최신순, 한 번에 1000건)로 작품의 구매자 리뷰를 전부 받아
 *     docs/rabsa.js(사이트와 같은 엔진)로 분석하고 '결과만' 저장한다(원문은 최근 12건만).
 *     처음엔 전량, 그 뒤로는 새로 달린 리뷰만 받아 집계에 더한다.
 *     순서: 순위 높은 작품 → 나머지(별점 많은 순). 엔진 버전이 바뀌면 차례로 다시 계산.
 *     저장: docs/data/reviews/<작품ID>.json
 *
 * 리디 서버에 부담을 주지 않도록 요청 사이 2.5초를 쉬고, 429(요청 과다)를 연달아
 * 3번 받으면 그날 실행을 멈춘다. 시간 예산(--budget-min)을 넘기면 하던 작품까지만 하고 끝낸다.
 *
 * 사용 예
 *   node scripts/reviews_full.js --budget-min 60
 *   node scripts/reviews_full.js --only 945098943,1922000007 --no-rc      (시험)
 *   node scripts/reviews_full.js --rc-only --rc-cats 1651,4250            (별점 수집 시험)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const RABSA = require("../docs/rabsa.js");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "docs", "data");
const STATE_FILE = path.join(ROOT, "state", "reviews_state.json");

const INTERVAL_MS = 2500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GQL_URL = "https://api.ridibooks.com/graphql";
const CAT_URL = "https://api.ridibooks.com/v2/category/books";
const KEEP_RECENT = 12;           // 화면용으로 남길 최근 리뷰 수 (상세 화면이 12건 보여줌)
const KW_KEEP = 150;              // '자주 나오는 말' 이어받기용으로 남길 단어 수
const FULL_PAGE = 1000;           // 전량 받을 때 한 번에 받을 리뷰 수 (API 상한 확인함)
const NEW_PAGE = 200;             // 새 리뷰만 받을 때

// 세부 카테고리 (scripts/ridi/config.py 의 CATEGORY_TREE 와 같음). 카테고리 목록 API는
// 한 카테고리에서 6000번째까지만 내려가므로 큰 상위 분류 대신 세부 분류를 훑는다.
const RC_CATEGORIES = [
  1651, 1652, 6051, 6052, 6053, 1751, 1752, 1753, 1754, 4151, 4152, 4153,        // 웹소설
  1701, 1702, 1704, 1705, 1706, 1708, 1709, 6001, 6002, 6003, 6004,              // E북
  1711, 1712, 1713, 1714, 1715, 1716, 1720, 1721, 1722, 4101, 4102, 4103, 4104,
  3001, 3002, 3005, 3006,
  1612, 1613, 1603, 1604, 1605, 1606, 1607, 1608, 1609, 1610, 1614, 4250         // 웹툰
];

// ───────────────────────────────────────────── 실행 옵션
function parseArgs(argv) {
  const a = { budgetMin: 60, rc: true, rcOnly: false, only: null, limit: 0, summary: null, rcCats: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--budget-min") a.budgetMin = Number(argv[++i]);
    else if (k === "--no-rc") a.rc = false;
    else if (k === "--rc-only") a.rcOnly = true;
    else if (k === "--only") a.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--summary") a.summary = argv[++i];
    else if (k === "--rc-cats") a.rcCats = argv[++i].split(",").map(Number);
    else throw new Error("모르는 옵션: " + k);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const T0 = Date.now();
const budgetMs = args.budgetMin * 60 * 1000;
const overBudget = () => Date.now() - T0 > budgetMs;

// 한국 날짜 / 시각
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const TODAY = kstNow().toISOString().slice(0, 10);
const nowKst = () => kstNow().toISOString().slice(0, 19) + "+09:00";

// ───────────────────────────────────────────── 파일
function readJSON(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return dflt; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ───────────────────────────────────────────── HTTP (간격·재시도·429)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Stop429 extends Error {}
let lastReq = 0, reqCount = 0, consecutive429 = 0, total429 = 0;

async function http(url, init) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = lastReq + INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    reqCount++;
    let res;
    try {
      res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(45000) }, init));
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(5000 * attempt);
      continue;
    }
    if (res.status === 429) {
      consecutive429++; total429++;
      if (consecutive429 >= 3) throw new Stop429("리디가 요청 과다(429)로 3번 연속 막음 — 오늘은 여기까지");
      console.log("  429(요청 과다) — 90초 쉬고 다시 시도");
      await sleep(90000);
      attempt--;                       // 429는 재시도 횟수에 넣지 않는다 (연속 3번이면 위에서 멈춤)
      continue;
    }
    consecutive429 = 0;
    if (res.status >= 500) {
      if (attempt === 3) throw new Error("HTTP " + res.status);
      await sleep(5000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  throw new Error("요청 실패");
}

const COMMON_HEADERS = {
  "User-Agent": UA, "Accept": "application/json", "Accept-Language": "ko-KR,ko;q=0.9",
  "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/"
};

// ───────────────────────────────────────────── 1) 전 작품 별점 수
function rcShard(id) { const s = String(id); return ("0" + s.slice(-2)).slice(-2); }

async function sweepRatings(catalog, state, report) {
  const cats = args.rcCats || RC_CATEGORIES;
  const found = {};                    // 작품ID → 별점 수
  const capped = [];

  // 한 카테고리를 한 가지 정렬로 훑는다. API는 6000번째까지만 주므로 그만큼 받았으면 '상한'.
  async function sweepCat(cat, order) {
    let n = 0, pages = 0;
    for (let offset = 0; offset < 6000; offset += 200) {
      const url = `${CAT_URL}?category_id=${cat}&tab=books&limit=200&platform=web&offset=${offset}&order_by=${order}`;
      let j;
      try { j = await http(url, { headers: COMMON_HEADERS }); }
      catch (e) { if (e instanceof Stop429) throw e; console.log(`  카테고리 ${cat} (${order}) offset ${offset} 실패: ${e.message}`); break; }
      const items = ((j && j.data) || {}).items || [];
      pages++;
      for (const it of items) {
        const b = it.book || {};
        const id = String(b.bookId || "");
        if (!id) continue;
        const rc = (b.ratings || []).reduce((s, r) => s + (r.count || 0), 0);
        if (!(id in found) || rc > found[id]) found[id] = rc;
        n++;
      }
      if (items.length < 200) break;
    }
    return { n, pages, capped: n >= 6000 };
  }

  for (const cat of cats) {
    const a = await sweepCat(cat, "popular");
    let msg = `  카테고리 ${cat}: ${a.n}작품 (${a.pages}쪽)`;
    // 6000개가 넘는 카테고리는 '리뷰 많은 순'으로 한 번 더 — 순위에서 밀려난 옛 인기작이 여기서 잡힌다
    if (a.capped) {
      capped.push(cat);
      const before = Object.keys(found).length;
      const b = await sweepCat(cat, "review");
      msg += ` + 리뷰순 ${b.pages}쪽 (새로 ${Object.keys(found).length - before}작품)`;
    }
    console.log(msg);
  }

  // 우리 작품 목록에 있는 것만 남긴다
  const ids = Object.keys(found).filter((id) => catalog[id]);
  const month = TODAY.slice(0, 7);
  const shards = {};
  for (const id of ids) (shards[rcShard(id)] = shards[rcShard(id)] || []).push(id);
  for (let k = 0; k < 100; k++) {
    const sh = ("0" + k).slice(-2);
    const file = path.join(DATA, "rc", month, sh + ".json");
    const h = readJSON(file, null) || { month: month, days: [], count: {} };
    let slot = h.days.indexOf(TODAY);
    if (slot < 0) { h.days.push(TODAY); h.days.sort(); slot = h.days.indexOf(TODAY); }
    for (const id of shards[sh] || []) {
      const arr = h.count[id] || (h.count[id] = []);
      while (arr.length < h.days.length) arr.push(null);
      arr[slot] = found[id];
    }
    // 배열 길이를 days 에 맞춘다 (오늘 못 찾은 작품은 null)
    for (const id of Object.keys(h.count)) {
      const arr = h.count[id];
      while (arr.length < h.days.length) arr.push(null);
    }
    writeJSON(file, h);
  }
  if (!args.rcCats) state.rc_last = TODAY;      // 일부 카테고리만 돌린 시험은 '오늘 끝남'으로 치지 않음
  const coverage = Object.keys(catalog).length ? ids.length / Object.keys(catalog).length : 0;
  report.rc = { categories: cats.length, seen: Object.keys(found).length, catalogHit: ids.length,
    coverage: Math.round(coverage * 1000) / 10, capped: capped };
  console.log(`  → 카테고리 전체 ${Object.keys(found).length}작품 중 우리 목록 ${ids.length}작품 (${report.rc.coverage}%)`
    + (capped.length ? ` / 6000개 끝까지 찬 카테고리: ${capped.join(",")}` : ""));
}

// ───────────────────────────────────────────── 2) 구매자 리뷰
const REVIEW_QUERY = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) " +
  "{ riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { " +
  "reviews { userId rating ratingId likeVoteCnt isBuyer status timestamp content } " +
  "pagination { ... on PageLimitOutput { hasMore } } } } } } } }";

async function reviewPage(cell, bookId, page, limit) {
  const body = JSON.stringify({
    query: REVIEW_QUERY,
    variables: { id: cell, context: { bookId: String(bookId), buyerOnly: true, order: "RECENT",
      pageLimitInput: { limit: limit, page: page } } }
  });
  const j = await http(GQL_URL, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, COMMON_HEADERS), body });
  if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 160));
  const c = ((((((j.data || {}).riGrid || {}).cells || {}).bookDetailHome || {}).reviewCell || {}).cell) || {};
  const out = [];
  for (const r of c.reviews || []) {
    if (r.status !== "VISIBLE") continue;
    out.push({
      id: r.ratingId, user: r.userId, rating: r.rating, content: (r.content || "").trim(),
      at: r.timestamp || "", likes: r.likeVoteCnt || 0, buyer: !!r.isBuyer
    });
  }
  return { reviews: out, raw: (c.reviews || []).length, hasMore: !!((c.pagination || {}).hasMore) };
}

// 처음 한 번: 구매자 리뷰 전부
async function fetchAll(cell, bookId) {
  const all = [];
  for (let page = 1; page <= 300; page++) {
    const p = await reviewPage(cell, bookId, page, FULL_PAGE);
    all.push.apply(all, p.reviews);
    if (!p.hasMore || !p.raw) break;
  }
  return all;
}

// 그 뒤: 지난번 이후 새로 달린 리뷰만 (최신순으로 내려가다 이미 본 리뷰를 만나면 멈춤)
async function fetchNew(cell, bookId, lastId, lastAt) {
  const fresh = [];
  for (let page = 1; page <= 100; page++) {
    const p = await reviewPage(cell, bookId, page, NEW_PAGE);
    let reachedOld = false;
    for (const r of p.reviews) {
      if (r.id > lastId) fresh.push(r);
      else if (r.at <= lastAt) { reachedOld = true; break; }
      // id는 옛것인데 시각만 새로운 것(고친 리뷰)은 건너뛰고 계속 내려간다
    }
    if (reachedOld || !p.hasMore || !p.raw) break;
  }
  return fresh;
}

function packAnalysis(agg) {
  return {
    total: agg.total, used: agg.used, aspects: agg.aspects, examples: agg.examples,
    kw: RABSA.topWords(agg.kwf, KW_KEEP), stars: agg.stars, months: agg.months,
    phr: RABSA.packPhr(agg.phr, 10),        // 요소별 많이 나온 말 상위 10개(이어받기용, 화면엔 3개)
    // 자세한 리뷰(40자↑)만 따로: 리뷰 수, 요소별 집계, 자주 나오는 말
    dTotal: agg.dTotal, dUsed: agg.dUsed, aspectsD: agg.aspectsD, kwD: RABSA.topWords(agg.kwfD, 100)
  };
}
function unpackAnalysis(a) {
  const agg = RABSA.newAgg();
  agg.total = a.total || 0; agg.used = a.used || 0;
  agg.aspects = a.aspects || {}; agg.examples = a.examples || {};
  agg.stars = a.stars || {}; agg.months = a.months || {};
  (a.kw || []).forEach((p) => { agg.kwf[p[0]] = p[1]; });
  agg.phr = RABSA.unpackPhr(a.phr || {});
  agg.dTotal = a.dTotal || 0; agg.dUsed = a.dUsed || 0; agg.aspectsD = a.aspectsD || {};
  (a.kwD || []).forEach((p) => { agg.kwfD[p[0]] = p[1]; });
  return agg;
}

// 전량 분석이 '유효'한가: 새 형식 + 같은 엔진 + 전량 계산한 지 60일 이내.
// (새 리뷰만 더하는 방식은 수정·삭제된 리뷰를 반영하지 못하므로 60일마다 전량으로 바로잡는다)
const FULL_EVERY_DAYS = 60;
function daysSince(d) { return d ? (Date.parse(TODAY) - Date.parse(d)) / 86400000 : 9999; }
// 처음 전량을 같은 주에 받은 수천 작품이 60일 뒤 한꺼번에 몰리지 않도록 작품마다 0~14일 늦춘다
function jitter(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 9973; return h % 15; }
function isFull(file, id) {
  return !!(file && file.v === 2 && file.engine === RABSA.VERSION && file.analysis
    && daysSince(file.full_at) < FULL_EVERY_DAYS + jitter(id));
}

// 작품 하나 처리. rcNow: 지금 별점 수, rcAt: 지난번 확인 때 별점 수.
// 리뷰는 별점과 함께 달리므로 별점 수가 그대로면 새 리뷰도 없다 → 요청 없이 건너뛴다.
async function processBook(id, cell, title, old, rcNow, rcAt) {
  let agg, recent, lastId, lastAt, added, mode;
  if (isFull(old, id)) {
    mode = "new";
    if (rcNow != null && rcAt != null && rcNow === rcAt) return { mode, added: 0, changed: false, skipped: true };
    const fresh = await fetchNew(cell, id, old.last_id || 0, old.last_at || "");
    added = fresh.length;
    if (!added) return { mode, added: 0, changed: false };
    agg = unpackAnalysis(old.analysis);
    fresh.slice().reverse().forEach((r) => RABSA.addReview(agg, r));     // 오래된 것부터 더함
    recent = fresh.concat(old.reviews || []).slice(0, KEEP_RECENT);
    lastId = fresh.reduce((m, r) => Math.max(m, r.id || 0), old.last_id || 0);
    lastAt = fresh.reduce((m, r) => (r.at > m ? r.at : m), old.last_at || "");
  } else {
    mode = "full";
    const all = await fetchAll(cell, id);
    added = all.length;
    agg = RABSA.analyze(all);
    recent = all.slice(0, KEEP_RECENT);
    lastId = all.reduce((m, r) => Math.max(m, r.id || 0), 0);
    lastAt = all.reduce((m, r) => (r.at > m ? r.at : m), "");
  }

  // 리뷰 수 추이: 옛 형식(일부만 모은 것)에서 처음 넘어온 작품은 이전 기록을 버리고 새로 시작
  let history = ((old && old.v === 2) ? old.history : null) || [];
  if (!history.length || history[history.length - 1].count !== agg.total) {
    if (history.length && history[history.length - 1].date === TODAY) history[history.length - 1].count = agg.total;
    else history = history.concat([{ date: TODAY, count: agg.total }]);
  }

  writeJSON(path.join(DATA, "reviews", id + ".json"), {
    id: id, title: title, v: 2, engine: RABSA.VERSION, buyer_only: true,
    updated_at: nowKst(), count: agg.total, history: history,
    full_at: mode === "full" ? TODAY : (old && old.full_at),
    last_id: lastId, last_at: lastAt,
    analysis: packAnalysis(agg), reviews: recent
  });
  return { mode, added, changed: true };
}

// 상태 저장: 디스크의 최신 상태와 합친다. 이번 실행에서 다룬 작품만 덮어쓰고 나머지는 디스크 것을 둔다.
// (동시에 돈 다른 실행이 그사이 남긴 기록을 지우지 않기 위함)
const touched = new Set();
function saveState(state) {
  const disk = readJSON(STATE_FILE, {}) || {};
  const out = { rc_last: [disk.rc_last, state.rc_last].filter(Boolean).sort().pop() || null };
  for (const k of ["checked", "rcAt", "failed"]) {
    const m = Object.assign({}, disk[k] || {});
    for (const id of touched) {
      if (state[k] && Object.prototype.hasOwnProperty.call(state[k], id)) m[id] = state[k][id];
      else delete m[id];
    }
    out[k] = m;
  }
  writeJSON(STATE_FILE, out);
}

// 상세페이지 셀 ID가 없는 작품에 쓰는 공용 셀. 리뷰 API는 실제로 bookId만 본다(셀 값 무관 — 확인함).
const FALLBACK_CELL = "1d4076f7-fc4e-4094-99c7-03b6348feeb5";

// 전 작품 별점 파일에서 작품별 가장 최근 별점 수 (지난달 → 이번 달 순으로 읽어 최신 값이 남게)
function loadLatestRc() {
  const out = {};
  const k = kstNow();
  const prev = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  for (const m of [prev, TODAY.slice(0, 7)]) {
    for (let n = 0; n < 100; n++) {
      const h = readJSON(path.join(DATA, "rc", m, ("0" + n).slice(-2) + ".json"), null);
      if (!h) continue;
      for (const id of Object.keys(h.count || {})) {
        const arr = h.count[id];
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) { out[id] = arr[i]; break; }
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────── 메인
async function main() {
  const catalog = readJSON(path.join(DATA, "books.json"), {});
  const latest = readJSON(path.join(DATA, "latest.json"), { rankings: {}, books: {} });
  const state = readJSON(STATE_FILE, {}) || {};
  state.checked = state.checked || {};
  const report = { started: nowKst(), reviews: { full: 0, newOnly: 0, unchanged: 0, skipped: 0, failed: 0, added: 0 } };
  let stopped = null;

  console.log(`[리뷰·별점 전체 수집] ${TODAY} / 작품 목록 ${Object.keys(catalog).length}종 / 시간 예산 ${args.budgetMin}분`);

  try {
    // 1) 전 작품 별점 수 — 하루 한 번
    if ((args.rc || args.rcOnly) && (state.rc_last !== TODAY || args.rcCats) && !args.only) {
      console.log("\n[1/2] 전 작품 별점 수 (카테고리 목록)");
      await sweepRatings(catalog, state, report);
      saveState(state);
    } else {
      console.log("\n[1/2] 전 작품 별점 수 — 오늘 것은 이미 모음(또는 끔)");
    }
    if (args.rcOnly) return finish(report, state, stopped);

    // 2) 구매자 리뷰
    console.log("\n[2/2] 구매자 리뷰 전량 수집·분석");
    const best = {}, bestMain = {};                    // 작품 → 오늘 가장 높은 순위 (모든 랭킹 / 대분류 랭킹만)
    for (const key of Object.keys(latest.rankings || {})) {
      const t = latest.rankings[key];
      (t.ids || []).forEach((id, i) => {
        if (!best[id] || i + 1 < best[id]) best[id] = i + 1;
        if (!t.is_sub && (!bestMain[id] || i + 1 < bestMain[id])) bestMain[id] = i + 1;
      });
    }
    // 지금 별점 수: 전 작품 별점 파일의 가장 최근 값, 오늘 순위권이면 랭킹 값과 비교해 큰 쪽
    const rcNow = loadLatestRc();
    for (const id of Object.keys(latest.books || {})) {
      const v = latest.books[id].rc;
      if (v != null && (rcNow[id] == null || v > rcNow[id])) rcNow[id] = v;
    }
    state.rcAt = state.rcAt || {};
    state.failed = state.failed || {};

    const ids = args.only || Object.keys(catalog);
    const todo = { hot: [], full: [], refresh: [] };
    let backoff = 0;
    for (const id of ids) {
      // 리뷰 API는 셀 ID와 상관없이 bookId로 작품을 고른다(2026-10-06 확인: 남의 셀·엉터리 셀로도
      // 그 작품 리뷰가 그대로 옴). 상세페이지에서 얻은 셀이 있으면 그걸, 없으면 공용 셀을 쓴다.
      const det = readJSON(path.join(DATA, "books", id + ".json"), null);
      const cell = (det && det.review_cell_id) || FALLBACK_CELL;
      const old = readJSON(path.join(DATA, "reviews", id + ".json"), null);
      const job = { id, cell, old, rank: best[id] || 99999, main: bestMain[id] || 99999,
        rc: (catalog[id] && catalog[id].rc) || 0,
        title: (catalog[id] && catalog[id].t) || (old && old.title) || "",
        stale: (old && old.v === 2) ? 1 : 0 };       // 한 번도 전량 분석 안 한 작품(0)이 먼저
      const age = daysSince(state.checked[id]);
      job.age = age;
      if (args.only) { todo.full.push(job); continue; }
      const f = state.failed[id];
      if (f && daysSince(f.at) < Math.min(Math.pow(2, f.n - 1), 30)) { backoff++; continue; }  // 실패하면 그날은 쉬고, 연달아 실패하면 며칠 쉼
      if (!isFull(old, id)) todo.full.push(job);     // 처음이거나 엔진 버전이 바뀐 작품은 같은 날이라도 다시 계산
      else if (age < 1) continue;                     // 분석이 최신이고 오늘 이미 확인한 작품은 다시 안 함
      else if (job.main <= 30) todo.hot.push(job);
      else if ((job.rank <= 200 && age >= 3) || age >= 14) todo.refresh.push(job);
    }
    const byPriority = (a, b) => (a.rank - b.rank) || (b.rc - a.rc);
    todo.hot.sort((a, b) => (a.main - b.main) || byPriority(a, b));
    // 순위권 작품은 (처음이든 엔진 버전이 바뀐 재계산이든) 순위 순서대로 먼저, 그다음 순위 밖(처음 → 재계산, 별점 많은 순)
    todo.full.sort((a, b) => (a.rank - b.rank) || (a.stale - b.stale) || (b.rc - a.rc));
    todo.refresh.sort((a, b) => (b.age - a.age) || byPriority(a, b));   // 오래 안 본 것부터
    console.log(`  오늘 할 일: 상위권 새 리뷰 ${todo.hot.length}, 전량 ${todo.full.length}, 새 리뷰 확인 ${todo.refresh.length}`
      + (backoff ? ` / 실패가 잦아 쉬는 작품 ${backoff}` : ""));
    report.queue = { hot: todo.hot.length, full: todo.full.length, refresh: todo.refresh.length, backoff: backoff };

    const queue = todo.hot.concat(todo.full, todo.refresh);
    let done = 0, failRun = 0;
    for (const job of queue) {
      if (overBudget()) { console.log("  시간 예산을 다 써서 여기까지"); break; }
      if (args.limit && done >= args.limit) break;
      done++;
      touched.add(job.id);
      try {
        const r = await processBook(job.id, job.cell, job.title, job.old, rcNow[job.id], state.rcAt[job.id]);
        state.checked[job.id] = TODAY;
        if (rcNow[job.id] != null) state.rcAt[job.id] = rcNow[job.id];
        delete state.failed[job.id];
        failRun = 0;
        if (r.mode === "full") report.reviews.full++;
        else if (r.skipped) report.reviews.skipped++;
        else if (r.changed) report.reviews.newOnly++;
        else report.reviews.unchanged++;
        report.reviews.added += r.added;
        if (r.changed) console.log(`  [${done}] ${(job.title || job.id).slice(0, 22)} ${r.mode === "full" ? "전량" : "새 리뷰"} ${r.added}건`);
      } catch (e) {
        if (e instanceof Stop429) throw e;
        report.reviews.failed++;
        state.checked[job.id] = TODAY;                  // 같은 날 다시 시도하지 않음
        const prev = state.failed[job.id];
        state.failed[job.id] = { n: (prev ? prev.n : 0) + 1, at: TODAY };
        console.log(`  [${done}] ${job.id} 실패: ${e.message}`);
        // 리디 쪽이 통째로 이상하면 예산을 실패로 다 쓰지 않도록 멈춘다
        if (++failRun >= 20) { stopped = "작품 20개가 연달아 실패 — 리디 쪽 문제로 보고 이번 실행은 중단"; console.log("  " + stopped); break; }
      }
      if (done % 50 === 0) saveState(state);
    }
  } catch (e) {
    if (e instanceof Stop429) { stopped = e.message; console.log("  " + e.message); }
    else throw e;
  }
  return finish(report, state, stopped);
}

function finish(report, state, stopped) {
  saveState(state);
  report.requests = reqCount;
  report.minutes = Math.round((Date.now() - T0) / 6000) / 10;
  report.http429 = total429;
  if (stopped) report.stopped = stopped;
  console.log("\n요약:", JSON.stringify(report));
  if (args.summary) {
    const R = report.reviews, Q = report.queue || {};
    const lines = ["### 리뷰·별점 전체 수집", `- 기준일 **${TODAY}**, 요청 ${reqCount}회, ${report.minutes}분`];
    if (report.rc) lines.push(`- 전 작품 별점: 우리 목록 ${report.rc.catalogHit}작품 (${report.rc.coverage}%)` +
      (report.rc.capped.length ? `, 6000개 끝까지 찬 카테고리 ${report.rc.capped.join(",")}` : ""));
    lines.push(`- 리뷰: 전량 ${R.full}작품, 새 리뷰 반영 ${R.newOnly}작품, 별점 그대로라 건너뜀 ${R.skipped}, 변화 없음 ${R.unchanged}, 실패 ${R.failed}, 더한 리뷰 ${R.added}건`);
    if (Q.full !== undefined) lines.push(`- 남은 전량 대기 ${Math.max(0, Q.full - R.full)}작품` + (Q.backoff ? ` / 실패가 잦아 쉬는 작품 ${Q.backoff}` : ""));
    if (stopped) lines.push(`- ⚠️ ${stopped}`);
    fs.appendFileSync(args.summary, lines.join("\n") + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
