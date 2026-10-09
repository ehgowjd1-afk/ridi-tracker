/* AI 리뷰 분석 — 웹소설·웹툰 장르별 순위 상위 작품의 '자세한 리뷰'를 Claude가 읽고 요소별로 판정한다.
 *
 * 왜: 규칙 엔진(docs/rabsa.js)은 사람 검토 정확도 73%, AI(Claude Haiku 5.5)는 94% (2026-10-09, 같은 표본 120건 블라인드 채점).
 *     비용 때문에 대상은 순위 상위 작품, 리뷰는 '자세한 리뷰'(40자↑)만. 한 줄 리뷰와 나머지 작품은 규칙 엔진 그대로.
 *
 * 대상: 웹소설(전체·로맨스·로판·판타지·BL)·웹툰(웹툰·BL웹툰)의 일간·주간·월간 1~TOP위 (--scope sub 이면 세부 장르까지)
 *       + 예전에 AI로 분석한 작품의 새 리뷰(시간·돈이 남으면, 화면의 AI 결과가 낡지 않게)
 * 흐름: ① 지난 실행에서 못 받은 일괄 결과가 있으면 먼저 받아 반영
 *       ② 대상 작품마다 리디에서 리뷰를 받음 (처음엔 전부, 그 뒤엔 새 리뷰만) → 자세한 리뷰만 고름
 *       ③ Claude Batches API(반값)로 한꺼번에 보내고, 끝날 때까지 기다렸다가 결과를 집계
 *       ④ 결과만 docs/data/reviews_ai/<id>.json 에 저장 (원문은 저장하지 않음 — 공개 저장소)
 * 돈 안전장치:
 *   - 이 달 쓴 돈 + 아직 결과를 못 받은 일괄의 예상 비용이 --limit-usd 를 넘을 것 같으면 보내지 않는다.
 *   - 15건 묶음 하나가 실패해도 나머지 결과는 반영한다(같은 리뷰를 다시 보내 돈을 두 번 쓰지 않게).
 *   - 일괄 만들기가 오류 나면 다시 보내기 전에 이미 만들어졌는지 찾아본다(중복 결제 방지).
 *
 *   node scripts/ai/ai_reviews.mjs --budget-min 90 --limit-usd 30 [--top 30] [--scope genre|sub] [--max-reviews 20000] [--only id,id] [--dry]
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { makeClient, buildParams, parseMessage, costOf, PROD, PROMPT_VER } from "./review_ai.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");
const RO = require("../review_opts.js");

const DATA = "docs/data";
const OUT_DIR = path.join(DATA, "reviews_ai");
const STATE_FILE = "state/ai_state.json";
const PER_REQUEST = 15;          // 한 요청에 묶는 리뷰 수 (시험과 같게)
const EST_PER_REVIEW = 0.0002;   // 예상 비용(달러/리뷰, 일괄 기준·여유 있게) — 시험 실측 ≈ 0.00015
const INTERVAL_MS = 2500;        // 리디 요청 간격 (reviews_full.js 와 같게)
const PHR_KEEP = 60;             // '많이 나온 말'을 이어서 세려고 남기는 개수 (화면엔 위 10개, 대표 문장도 위 10개만)
// 순위 분류 코드: 웹소설 장르 / 웹툰 / BL (세부 장르 포함)
const WEBNOVEL = [999001, 1650, 6050, 1750, 4150];
const WEBTOON = [1600, 4250];
const SUB_RANGES = [[1651, 1654], [6051, 6053], [1751, 1754], [4151, 4153], [1603, 1614], [4251, 4260]];
const isWebtoonCode = (c) => c === 1600 || (c >= 1603 && c <= 1614) || (c >= 4250 && c <= 4260);
const isBlCode = (c) => (c >= 4150 && c <= 4153) || (c >= 4250 && c <= 4260);

// ───────────────────────────── 옵션
const args = { budgetMin: 90, limitUsd: 30, top: 30, scope: "genre", maxReviews: 20000, only: null, dry: false, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === "--budget-min") args.budgetMin = Number(process.argv[++i]);
  else if (k === "--limit-usd") args.limitUsd = Number(process.argv[++i]);
  else if (k === "--top") args.top = Number(process.argv[++i]);
  else if (k === "--scope") args.scope = process.argv[++i];
  else if (k === "--max-reviews") args.maxReviews = Number(process.argv[++i]);
  else if (k === "--only") args.only = process.argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--summary") args.summary = process.argv[++i];
  else if (k === "--dry") args.dry = true;
  else throw new Error("모르는 옵션: " + k);
}
// 숫자 칸에 '$30', '2만' 같은 게 들어오면 한도가 꺼지므로 아예 멈춘다
for (const k of ["budgetMin", "limitUsd", "top", "maxReviews"]) {
  if (!Number.isFinite(args[k]) || args[k] < 0) throw new Error(`숫자 옵션이 잘못됐습니다: ${k} — 숫자만 적어 주세요 (예: 30, 20000)`);
}
if (!/^(genre|sub)$/.test(args.scope)) throw new Error("scope 는 genre 또는 sub 만 됩니다");

const T0 = Date.now();
const leftMs = () => args.budgetMin * 60000 - (Date.now() - T0);
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
function kstNow() { return new Date(Date.now() + 9 * 3600000); }
const TODAY = kstNow().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const nowKst = () => kstNow().toISOString().replace(/\.\d+Z$/, "+09:00");

// ───────────────────────────── 리디 리뷰 받기
const GQL_URL = "https://api.ridibooks.com/graphql";
const FALLBACK_CELL = "1d4076f7-fc4e-4094-99c7-03b6348feeb5";
const HEADERS = {
  "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/",
  "Accept-Language": "ko-KR,ko;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};
const REVIEW_QUERY = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) " +
  "{ riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { " +
  "reviews { rating ratingId likeVoteCnt status timestamp content } " +
  "pagination { ... on PageLimitOutput { hasMore } } } } } } } }";
class RidiBlocked extends Error {}
let lastReq = 0, requests = 0, n429 = 0, ridiBlocked = false;
async function reviewPage(bookId, page, limit) {
  if (ridiBlocked) throw new RidiBlocked("리디 요청 과다(429) — 이번 실행은 리디에 더 묻지 않음");
  const body = JSON.stringify({ query: REVIEW_QUERY, variables: { id: FALLBACK_CELL, context: { bookId: String(bookId), buyerOnly: true, order: "RECENT", pageLimitInput: { limit, page } } } });
  for (let attempt = 1; ; attempt++) {
    const wait = INTERVAL_MS - (Date.now() - lastReq);
    if (wait > 0) await sleep(wait);
    lastReq = Date.now(); requests++;
    let res;
    try { res = await fetch(GQL_URL, { method: "POST", headers: HEADERS, body }); }
    catch (e) { if (attempt < 3) { await sleep(5000 * attempt); continue; } throw e; }
    if (res.status === 429) {
      if (++n429 >= 3) { ridiBlocked = true; throw new RidiBlocked("리디 요청 과다(429)"); }
      await sleep(30000); continue;
    }
    if (res.status >= 500 && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    n429 = 0;
    const j = await res.json();
    if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 160));
    const c = (((((j.data || {}).riGrid || {}).cells || {}).bookDetailHome || {}).reviewCell || {}).cell || {};
    const out = [];
    for (const r of c.reviews || []) {
      if (r.status !== "VISIBLE") continue;
      out.push({ id: r.ratingId, content: (r.content || "").trim(), at: r.timestamp || "", likes: r.likeVoteCnt || 0 });
    }
    return { reviews: out, raw: (c.reviews || []).length, hasMore: !!((c.pagination || {}).hasMore) };
  }
}
// 페이지를 넘기는 사이 새 리뷰가 올라오면 같은 리뷰가 두 페이지에 걸쳐 나올 수 있어 id로 한 번만 남긴다
async function fetchAll(bookId) {
  const byId = new Map();
  for (let page = 1; page <= 300; page++) {
    const p = await reviewPage(bookId, page, 1000);
    p.reviews.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, r); });
    if (!p.hasMore || !p.raw) break;
  }
  return [...byId.values()];
}
// 지난번 이후 새로 달린 리뷰만 (reviews_full.js 의 fetchNew 와 같은 규칙: id로 새 리뷰를 판정, 수정 리뷰는 건너뜀)
async function fetchNew(bookId, lastId, lastAt) {
  const byId = new Map();
  for (let page = 1; page <= 100; page++) {
    const p = await reviewPage(bookId, page, 200);
    let reachedOld = false;
    for (const r of p.reviews) {
      if (r.id > lastId) { if (!byId.has(r.id)) byId.set(r.id, r); }
      else if (r.at <= lastAt) { reachedOld = true; break; }
    }
    if (reachedOld || !p.hasMore || !p.raw) break;
  }
  return [...byId.values()];
}

// ───────────────────────────── 집계 저장 형식
// '많이 나온 말'은 위 PHR_KEEP개를 남겨 다음 실행에서 이어 센다. 같은 건수면 최근 것을 앞에 두어
// 새로 떠오르는 의견이 옛 1건짜리들에 막히지 않게 하고, 10위 밖은 대표 문장을 비워 파일을 작게 둔다.
function packPhrDeep(phr) {
  const out = {};
  for (const key of Object.keys(phr || {})) {
    const o = {};
    for (const side of ["p", "n", "m"]) {
      const b = (phr[key] || {})[side] || {};
      o[side] = Object.keys(b).map((k) => [k, b[k][0], b[k][1], b[k][2] < 0 ? 0 : b[k][2], b[k][3]])
        .sort((x, y) => (y[1] - x[1]) || ((y[4] || "") > (x[4] || "") ? 1 : (y[4] || "") < (x[4] || "") ? -1 : 0) || (y[3] - x[3]))
        .slice(0, PHR_KEEP)
        .map((e, i) => (i < 10 ? e : [e[0], e[1], "", 0, e[4]]));
    }
    out[key] = o;
  }
  return out;
}
function packAgg(agg) {
  return { dTotal: agg.dTotal || 0, dUsed: agg.dUsed || 0, aspectsD: agg.aspectsD || {}, examples: agg.examples || {},
    phr: packPhrDeep(agg.phr || {}), over: agg.over || [0, 0], overEx: agg.overEx || [] };
}
function unpackAgg(a) {
  const agg = RABSA.newAgg();
  if (!a) return agg;
  agg.dTotal = a.dTotal || 0; agg.dUsed = a.dUsed || 0; agg.aspectsD = a.aspectsD || {}; agg.examples = a.examples || {};
  agg.phr = RABSA.unpackPhr(a.phr || {}); agg.over = a.over || [0, 0]; agg.overEx = a.overEx || [];
  return agg;
}

// ───────────────────────────── 읽기
const catalog = readJSON(path.join(DATA, "books.json"), {});
const latest = readJSON(path.join(DATA, "latest.json"), { rankings: {}, books: {} });
const state = readJSON(STATE_FILE, null) || { works: {}, pending: [], spend: {} };
state.works = state.works || {}; state.pending = state.pending || []; state.spend = state.spend || {};
const report = { started: nowKst(), collected: 0, analyzedWorks: 0, analyzedReviews: 0, missing: 0, skipped: 0, failed: 0, usd: 0, pendingLeft: 0 };
const saveState = () => writeJSON(STATE_FILE, state);
const client = args.dry ? null : makeClient();

// 웹툰·BL 여부는 상세 태그가 빈 작품도 있어 순위 분류로도 정한다
const webtoonIds = new Set(), blIds = new Set();
for (const key of Object.keys(latest.rankings || {})) {
  const c = Number(key.split("-")[0]), ids = latest.rankings[key].ids || [];
  if (isWebtoonCode(c)) ids.forEach((i) => webtoonIds.add(i));
  if (isBlCode(c)) ids.forEach((i) => blIds.add(i));
}

function targets() {
  const best = {};
  const isSub = (code) => SUB_RANGES.some(([a, b]) => code >= a && code <= b);
  for (const key of Object.keys(latest.rankings || {})) {
    const t = latest.rankings[key];
    const [codeS, period] = key.split("-");
    const code = Number(codeS);
    if (!/^(DAILY|WEEKLY|MONTHLY)$/.test(period || "")) continue;
    const main = !t.is_sub && (WEBNOVEL.includes(code) || WEBTOON.includes(code));
    const sub = args.scope === "sub" && t.is_sub && isSub(code);
    if (!main && !sub) continue;
    (t.ids || []).slice(0, args.top).forEach((id, i) => { if (!best[id] || i + 1 < best[id]) best[id] = i + 1; });
  }
  return Object.keys(best).sort((a, b) => best[a] - best[b]);
}

function workInfo(id) {
  const det = readJSON(path.join(DATA, "books", id + ".json"), null);
  const o = det ? RO.reviewOpts(det, catalog[id], {}, null, { webtoonIds }) : {};
  if (webtoonIds.has(id)) o.webtoon = true;
  if (blIds.has(id)) o.bl = true;
  const old = readJSON(path.join(DATA, "reviews", id + ".json"), null);
  return {
    work: { title: (catalog[id] && catalog[id].t) || (old && old.title) || "", webtoon: !!o.webtoon, bl: !!o.bl, orig: !!o.orig, authors: o.authors || [] },
    // 규칙 엔진에 넘길 정보(근거 구절로 '많이 나온 말' 이름을 정할 때) — 인물 이름은 리뷰 수집 때 확정된 것
    opts: Object.assign({}, o, { names: (old && old.names) || [] })
  };
}

// 결과 → 작품별 집계. job = {id, mode, reviews:[{id, content, at, likes} | null], lastId, lastAt, rc}
// byN: 리뷰 순서(0..) → {items, over}. 결과가 없는 리뷰는 세지 않고 건너뛴다(다시 보내지도 않음).
function applyJob(job, byN) {
  const file = path.join(OUT_DIR, job.id + ".json");
  const old = readJSON(file, null);
  const oldOk = !!(old && old.prompt === PROMPT_VER && old.analysis);
  // 새 리뷰만 더하는데 기존 분석이 없거나 다른 버전이면, 몇 건짜리로 덮어쓰지 않고 다음에 처음부터 다시 한다
  if (job.mode === "new" && !oldOk) { report.failed++; console.log(`  ${job.id}: 이전 분석이 없거나 다른 버전 — 다음에 처음부터 다시`); return false; }
  const { work, opts } = workInfo(job.id);
  const agg = job.mode === "new" ? unpackAgg(old.analysis) : unpackAgg(null);
  let n = 0;
  job.reviews.forEach((r, i) => {
    const res = byN[i];
    if (!r) return;
    if (!res) { report.missing++; return; }
    RABSA.addAiReview(agg, r, res, opts);
    n++;
  });
  writeJSON(file, {
    id: job.id, title: work.title, model: PROD.model, prompt: PROMPT_VER, updated_at: nowKst(),
    first_at: (oldOk && old.first_at) || TODAY,
    count: agg.dTotal, last_id: job.lastId, last_at: job.lastAt, analysis: packAgg(agg)
  });
  state.works[job.id] = { last_id: job.lastId, last_at: job.lastAt, rc: job.rc, prompt: PROMPT_VER, at: TODAY };
  report.analyzedWorks++; report.analyzedReviews += n;
  return true;
}

// 일괄 결과 받기 → {custom_id: [{n, items, over}] | [] | null}, 비용
//   배열: 정상 / []: 받았지만 쓸 수 없음(거절·잘림·JSON 오류 — 요금은 나감, 다시 보내도 같을 가능성이 커 버림)
//   null: 오류·만료·취소(요금 없음)
async function collect(batchId) {
  const out = {};
  let usd = 0, unusable = 0;
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type === "succeeded") {
      usd += costOf(PROD.model, r.result.message.usage || {}, true);
      try { out[r.custom_id] = parseMessage(r.result.message); } catch (e) { out[r.custom_id] = []; unusable++; }
    } else out[r.custom_id] = null;
  }
  if (unusable) console.log(`  쓸 수 없는 응답 ${unusable}개(거절·잘림) — 그 리뷰는 빼고 반영`);
  return { out, usd };
}

// 요청 묶음별 결과를 작품의 리뷰 순서에 맞춘다. 번호(n)가 묶음 크기 안이고 한 번만 나온 것만 받는다.
// 정상 묶음이 하나도 없으면 null (일괄 전체 오류 같은 경우 — 다음에 다시 보냄)
function resultsFor(job, res) {
  const byN = {};
  let ok = 0;
  for (let c = 0; c * PER_REQUEST < job.reviews.length; c++) {
    const got = res[job.id + "__" + c];
    if (!got || !got.length) continue;
    ok++;
    const size = Math.min(PER_REQUEST, job.reviews.length - c * PER_REQUEST);
    const cnt = {};
    got.forEach((rv) => { cnt[rv.n] = (cnt[rv.n] || 0) + 1; });
    got.forEach((rv) => { if (Number.isInteger(rv.n) && rv.n >= 1 && rv.n <= size && cnt[rv.n] === 1) byN[c * PER_REQUEST + rv.n - 1] = rv; });
  }
  return ok ? byN : null;
}

async function waitFor(batchId) {
  while (leftMs() > 90000) {
    const b = await client.messages.batches.retrieve(batchId);
    if (b.processing_status === "ended") return true;
    console.log(`  일괄 처리 중… 남은 요청 ${b.request_counts.processing}`);
    await sleep(60000);
  }
  return false;
}

// 일괄 만들기: SDK 자동 재시도는 끄고(서버엔 만들어졌는데 응답만 끊기면 두 번 결제될 수 있음),
// 오류가 나면 방금 만들어진 같은 크기의 일괄이 있는지 찾아 그걸 쓴다. 없으면 이번엔 보내지 않는다.
async function createBatch(requests) {
  const t0 = Date.now();
  try {
    return await client.messages.batches.create({ requests }, { maxRetries: 0 });
  } catch (e) {
    console.log(`  일괄 만들기 오류: ${e.message}`);
    if (e && e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 409) return null;   // 요청 자체가 거절됨
    const known = new Set(state.pending.map((p) => p.batch_id));
    for (let k = 0; k < 3; k++) {
      await sleep(20000);
      try {
        for await (const b of client.messages.batches.list({ limit: 20 })) {
          if (Date.parse(b.created_at) < t0 - 60000) break;
          const rc = b.request_counts;
          const total = rc.processing + rc.succeeded + rc.errored + rc.canceled + rc.expired;
          if (!known.has(b.id) && total === requests.length) { console.log(`  이미 만들어진 일괄 ${b.id}을 이어서 씁니다`); return b; }
        }
      } catch (e2) { console.log(`  일괄 목록 확인 실패: ${e2.message}`); }
    }
    return null;
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[AI 리뷰 분석] ${TODAY} / 모델 ${PROD.model} (${PROD.effort}) / 이 달 사용 $${(state.spend[MONTH] || 0).toFixed(2)} / 한도 $${args.limitUsd}`);

  // ① 지난 실행에서 기다리다 만 일괄 결과
  for (const p of state.pending.slice()) {
    if (args.dry) break;
    let out;
    try {
      const b = await client.messages.batches.retrieve(p.batch_id);
      if (b.processing_status !== "ended") { console.log(`  지난 일괄(${p.batch_id})은 아직 처리 중`); continue; }
      const r = await collect(p.batch_id);
      out = r.out;
      if (!p.charged) {    // 결과를 여러 실행에 걸쳐 받더라도 돈은 한 번만 센다
        state.spend[MONTH] = (state.spend[MONTH] || 0) + r.usd; report.usd += r.usd; p.charged = true; saveState();
      }
    } catch (e) {
      const gone = (e && e.status === 404) || Date.now() - Date.parse(p.created) > 28 * 86400000;
      console.log(`  지난 일괄(${p.batch_id}) 받기 실패${gone ? " — 더 받을 수 없어 버립니다" : " — 다음 실행에서 다시"}: ${e.message}`);
      if (gone) { state.pending = state.pending.filter((x) => x.batch_id !== p.batch_id); saveState(); }
      continue;
    }
    // 프롬프트 버전이 바뀐 뒤 받은 옛 결과는 반영하지 않는다(그 작품들은 아래에서 처음부터 다시)
    if ((p.prompt || "1") !== PROMPT_VER) {
      console.log(`  지난 일괄(${p.batch_id})은 이전 프롬프트 결과라 반영하지 않습니다`);
      state.pending = state.pending.filter((x) => x.batch_id !== p.batch_id); saveState();
      continue;
    }
    // 원문은 저장하지 않았으므로 리디에서 같은 범위의 리뷰를 다시 받아 리뷰 번호로 맞춘다
    const keep = [];
    for (const w of p.works) {
      if (ridiBlocked) { keep.push(w); continue; }
      try {
        const got = w.mode === "full" ? await fetchAll(w.id) : await fetchNew(w.id, w.from_id, w.from_at);
        const byId = new Map(got.filter((r) => r.id <= w.to_id && RABSA.isDetailed(r.content)).map((r) => [r.id, r]));
        const reviews = w.rids.map((id) => byId.get(id) || null);   // 그사이 지워졌거나 고쳐진 리뷰는 null → 건너뜀
        const miss = reviews.filter((r) => !r).length;
        if (miss > Math.max(3, Math.ceil(w.rids.length * 0.02))) { keep.push(w); continue; }   // 다시 받은 게 너무 모자람 — 다음에
        const job = { id: w.id, mode: w.mode, reviews, lastId: w.to_id, lastAt: w.to_at, rc: w.rc };
        const byN = resultsFor(job, out);
        if (byN) applyJob(job, byN); else report.failed++;
      } catch (e) {
        console.log(`  ${w.id} 다시 받기 실패: ${e.message}`);
        keep.push(w);    // 리디 쪽 문제 — 결과는 29일간 남아 있으니 다음 실행에서 다시
      }
    }
    if (keep.length) { p.works = keep; console.log(`  지난 일괄의 ${keep.length}작품은 다음 실행에서 마저 반영`); }
    else state.pending = state.pending.filter((x) => x.batch_id !== p.batch_id);
    report.collected++;
    saveState();
  }

  // ② 대상 작품의 새 리뷰 모으기 (시간의 절반·리뷰 수·돈 한도까지)
  const top = args.only || targets();
  // 예전에 AI로 분석했지만 지금은 순위 밖인 작품도 새 리뷰만 이어서 (뒤로 — 시간·돈이 남을 때)
  const extra = args.only ? [] : Object.keys(state.works).filter((id) => !top.includes(id));
  const ids = top.concat(extra);
  const busy = new Set(state.pending.flatMap((p) => p.works.map((w) => w.id)));
  console.log(`  대상 ${top.length}작품 (상위 ${args.top}위, ${args.scope === "sub" ? "세부 장르 포함" : "장르별"}) + 예전 분석 이어가기 ${extra.length}작품`);
  // 이미 보내 놓고 아직 결과를 못 받은 일괄의 예상 비용도 이 달 사용액으로 친다
  const inFlight = state.pending.filter((p) => !p.charged)
    .reduce((s, p) => s + p.works.reduce((t, w) => t + (w.rids || []).length, 0), 0) * EST_PER_REVIEW;
  const spent = (state.spend[MONTH] || 0) + inFlight;
  const roomCap = Math.floor(Math.max(0, args.limitUsd - spent) / EST_PER_REVIEW);   // 돈 한도 (넘지 않음)
  const cap = Math.min(args.maxReviews, roomCap);                                     // 이번 실행 크기 한도
  if (roomCap <= 0) console.log(`  이 달 한도($${args.limitUsd})에 닿아 새로 보내지 않습니다 (쓴 돈 $${(state.spend[MONTH] || 0).toFixed(2)} + 처리 중 $${inFlight.toFixed(2)})`);
  const jobs = [];
  let total = 0;
  for (const id of ids) {
    if (!(roomCap > 0) || !(total < cap)) break;
    if (ridiBlocked) break;
    if (leftMs() < args.budgetMin * 60000 * 0.5) { console.log("  수집 시간을 다 써서 여기까지"); break; }
    if (busy.has(id)) continue;
    const isExtra = !top.includes(id);
    const info = state.works[id];
    const old = readJSON(path.join(OUT_DIR, id + ".json"), null);
    const valid = !!(old && old.prompt === PROMPT_VER && info && info.prompt === PROMPT_VER);
    if (isExtra && !valid) continue;   // 순위 밖 작품은 이어가기만 (처음부터 다시는 하지 않음)
    const rcNow = latest.books && latest.books[id] ? latest.books[id].rc : null;
    if (valid && rcNow != null && info.rc === rcNow) { report.skipped++; continue; }   // 별점 수가 그대로면 새 리뷰도 없음
    try {
      const mode = valid ? "new" : "full";
      const got = mode === "full" ? await fetchAll(id) : await fetchNew(id, info.last_id, info.last_at);
      const lastId = got.reduce((m, r) => Math.max(m, r.id || 0), valid ? info.last_id : 0);
      const lastAt = got.reduce((m, r) => (r.at > m ? r.at : m), valid ? info.last_at : "");
      const reviews = got.filter((r) => RABSA.isDetailed(r.content)).sort((a, b) => a.id - b.id);
      if (!reviews.length) {    // 자세한 리뷰가 새로 없으면 위치만 기록
        if (valid) state.works[id] = Object.assign({}, info, { last_id: lastId, last_at: lastAt, rc: rcNow, at: TODAY });
        else applyJob({ id, mode, reviews: [], lastId, lastAt, rc: rcNow }, {});
        continue;
      }
      if (total + reviews.length > roomCap) { if (jobs.length) break; continue; }   // 돈 한도는 절대 넘지 않음
      if (total + reviews.length > cap && jobs.length) break;                       // 크기 한도 — 큰 작품 하나는 혼자 갈 수 있음
      jobs.push({ id, mode, reviews, lastId, lastAt, rc: rcNow, fromId: valid ? info.last_id : 0, fromAt: valid ? info.last_at : "" });
      total += reviews.length;
      console.log(`  ${(catalog[id] && catalog[id].t || id).slice(0, 24)}: ${mode === "full" ? "처음" : "새"} 자세한 리뷰 ${reviews.length}건`);
    } catch (e) {
      console.log(`  ${id} 리뷰 받기 실패: ${e.message}`);
      if (e instanceof RidiBlocked) break;
    }
  }
  saveState();
  if (!jobs.length) { console.log("  새로 분석할 리뷰가 없습니다."); return; }
  console.log(`  보낼 리뷰 ${total}건 (예상 $${(total * EST_PER_REVIEW).toFixed(2)} 이하)`);
  if (args.dry) return;

  // ③ 일괄로 보내기
  const reqs = [];
  for (const job of jobs) {
    const { work } = workInfo(job.id);
    for (let c = 0; c * PER_REQUEST < job.reviews.length; c++) {
      const chunk = job.reviews.slice(c * PER_REQUEST, (c + 1) * PER_REQUEST).map((r, i) => ({ n: i + 1, text: r.content }));
      reqs.push({ custom_id: job.id + "__" + c, params: buildParams(PROD, work, chunk) });
    }
  }
  const batch = await createBatch(reqs);
  if (!batch) { console.log("  일괄을 만들지 못해 이번엔 보내지 않습니다 (다음 실행에서 다시)"); report.failed++; return; }
  console.log(`  일괄 ${batch.id}: 요청 ${reqs.length}개`);
  // 실행이 도중에 끊겨도 다음 실행이 결과를 받을 수 있게 먼저 기록 (원문 대신 리뷰 번호 목록만)
  state.pending.push({ batch_id: batch.id, prompt: PROMPT_VER, created: new Date().toISOString(), works: jobs.map((j) => ({
    id: j.id, mode: j.mode, from_id: j.fromId, from_at: j.fromAt, to_id: j.lastId, to_at: j.lastAt, rc: j.rc, rids: j.reviews.map((r) => r.id) })) });
  saveState();

  // ④ 끝나길 기다렸다 반영
  if (!(await waitFor(batch.id))) { console.log("  시간 안에 끝나지 않아 다음 실행에서 받습니다."); report.pendingLeft = 1; return; }
  const { out, usd } = await collect(batch.id);
  const entry = state.pending.find((x) => x.batch_id === batch.id);
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd; report.usd += usd;
  if (entry) entry.charged = true;
  saveState();
  for (const job of jobs) {
    const byN = resultsFor(job, out);
    if (byN) applyJob(job, byN); else { report.failed++; console.log(`  ${job.id}: 요청이 모두 실패 — 다음에 다시`); }
  }
  state.pending = state.pending.filter((x) => x.batch_id !== batch.id);
  saveState();
}

try {
  await main();
} finally {
  saveState();
  report.minutes = Math.round((Date.now() - T0) / 6000) / 10;
  report.monthUsd = Math.round((state.spend[MONTH] || 0) * 100) / 100;
  report.usd = Math.round(report.usd * 100) / 100;
  report.requests = requests;
  console.log("요약: " + JSON.stringify(report));
  if (args.summary) {
    fs.appendFileSync(args.summary, [
      "## AI 리뷰 분석", "",
      `- 분석한 작품 ${report.analyzedWorks}개, 리뷰 ${report.analyzedReviews}건, 새 리뷰 없어 건너뜀 ${report.skipped}`,
      `- 이번에 쓴 돈 $${report.usd} / 이 달 합계 $${report.monthUsd} (한도 $${args.limitUsd})`,
      report.missing ? `- AI 응답에서 빠진 리뷰 ${report.missing}건 (세지 않음)` : "",
      report.pendingLeft ? "- 일괄 처리가 시간 안에 끝나지 않아 다음 실행에서 받습니다." : "",
      report.failed ? `- 실패 ${report.failed}건 (다음 실행에서 다시)` : "", ""
    ].join("\n"));
  }
}
