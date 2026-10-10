/* 작품별 '독자 반응 요약'을 만든다 — 웹소설·웹툰 장르별 순위 상위 작품 (ai_reviews.mjs 와 같은 대상).
 *
 * 작품마다 리뷰 표본(별점 낮은 리뷰 + 공감 많은 리뷰 + 최근 리뷰, 최대 약 300건)을 리디에서 받아 AI(Sonnet)가 읽고
 * 좋아하는 서사·케미, 좋아한 점, 아쉬운 점, 과몰입 포인트를 정리한다. 인용은 실제 리뷰에 있는지 확인한 것만 남긴다.
 * 결과는 docs/data/reviews_sum/<id>.json (원문 저장 안 함).
 * 모델: 블라인드 비교(2026-10-10, 5작품)에서 Sonnet 10전 10승(충실도 8.0 vs Haiku 5.5) → Sonnet, Batches(반값).
 * 다시 만드는 때: 요약이 없을 때, 자세한 리뷰가 지난 요약 때보다 15%·20건 이상 늘었을 때, 30일 지났고 5건 이상 늘었을 때.
 * 돈: state/ai_state.json 의 이 달 사용액(리뷰 분석과 같이 셈) + 처리 중 예상분이 --limit-usd 를 넘을 것 같으면 멈춘다.
 *
 *   node scripts/ai/ai_summary.mjs --budget-min 60 --limit-usd 30 [--top 30] [--scope genre|sub] [--max-works 300] [--only id,id]
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { makeClient, costOf, inFlightUsd, EST_PER_SUM_WORK } from "./review_ai.mjs";
import { sampleReviews, buildSummaryParams, verifySummary, SUMMARY_VER } from "./summary_ai.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");
const RO = require("../review_opts.js");

const SUM_MODEL = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_PER_WORK = EST_PER_SUM_WORK;   // 예상 비용(달러/작품, 일괄·여유 있게) — 시험 실측 Sonnet 일반 0.05~0.15 → 일괄 반값
const DATA = "docs/data";
const OUT_DIR = path.join(DATA, "reviews_sum");
const STATE_FILE = "state/ai_state.json";
const INTERVAL_MS = 2500;
const WEBNOVEL = [999001, 1650, 6050, 1750, 4150];
const WEBTOON = [1600, 4250];
const SUB_RANGES = [[1651, 1654], [6051, 6053], [1751, 1754], [4151, 4153], [1603, 1614], [4251, 4260]];
const isWebtoonCode = (c) => c === 1600 || (c >= 1603 && c <= 1614) || (c >= 4250 && c <= 4260);
const isBlCode = (c) => (c >= 4150 && c <= 4153) || (c >= 4250 && c <= 4260);

const args = { budgetMin: 60, limitUsd: 30, top: 30, scope: "genre", maxWorks: 300, only: null, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === "--budget-min") args.budgetMin = Number(process.argv[++i]);
  else if (k === "--limit-usd") args.limitUsd = Number(process.argv[++i]);
  else if (k === "--top") args.top = Number(process.argv[++i]);
  else if (k === "--scope") args.scope = process.argv[++i];
  else if (k === "--max-works") args.maxWorks = Number(process.argv[++i]);
  else if (k === "--only") args.only = process.argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--summary") args.summary = process.argv[++i];
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["budgetMin", "limitUsd", "top", "maxWorks"]) {
  if (!Number.isFinite(args[k]) || args[k] < 0) throw new Error(`숫자 옵션이 잘못됐습니다: ${k} — 숫자만 적어 주세요`);
}
if (!/^(genre|sub)$/.test(args.scope)) throw new Error("scope 는 genre 또는 sub 만 됩니다");

const T0 = Date.now();
const leftMs = () => args.budgetMin * 60000 - (Date.now() - T0);
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const kstNow = () => new Date(Date.now() + 9 * 3600000);
const TODAY = kstNow().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const nowKst = () => kstNow().toISOString().replace(/\.\d+Z$/, "+09:00");
const daysSince = (d) => (d ? (Date.parse(TODAY) - Date.parse(d.slice(0, 10))) / 86400000 : 9999);

// ── 리디 리뷰 (별점 포함) — ai_reviews.mjs 와 같은 요청·간격·429 처리
const GQL_URL = "https://api.ridibooks.com/graphql";
const HEADERS = {
  "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/",
  "Accept-Language": "ko-KR,ko;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};
const REVIEW_QUERY = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) " +
  "{ riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { " +
  "reviews { rating ratingId likeVoteCnt status timestamp content } pagination { ... on PageLimitOutput { hasMore } } } } } } } }";
class RidiBlocked extends Error {}
let lastReq = 0, requests = 0, n429 = 0, ridiBlocked = false;
async function reviewPage(bookId, page) {
  if (ridiBlocked) throw new RidiBlocked("리디 요청 과다(429)");
  const body = JSON.stringify({ query: REVIEW_QUERY, variables: { id: "1d4076f7-fc4e-4094-99c7-03b6348feeb5", context: { bookId: String(bookId), buyerOnly: true, order: "RECENT", pageLimitInput: { limit: 1000, page } } } });
  for (let attempt = 1; ; attempt++) {
    const wait = INTERVAL_MS - (Date.now() - lastReq);
    if (wait > 0) await sleep(wait);
    lastReq = Date.now(); requests++;
    let res;
    try { res = await fetch(GQL_URL, { method: "POST", headers: HEADERS, body }); }
    catch (e) { if (attempt < 3) { await sleep(5000 * attempt); continue; } throw e; }
    if (res.status === 429) { if (++n429 >= 3) { ridiBlocked = true; throw new RidiBlocked("리디 요청 과다(429)"); } await sleep(30000); continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    n429 = 0;
    const j = await res.json();
    if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 160));
    const c = (((((j.data || {}).riGrid || {}).cells || {}).bookDetailHome || {}).reviewCell || {}).cell || {};
    return { reviews: c.reviews || [], hasMore: !!((c.pagination || {}).hasMore) };
  }
}
async function fetchAll(bookId) {
  const byId = new Map();
  for (let page = 1; page <= 300; page++) {
    const p = await reviewPage(bookId, page);
    for (const r of p.reviews) {
      if (r.status !== "VISIBLE" || byId.has(r.ratingId)) continue;
      byId.set(r.ratingId, { id: r.ratingId, content: (r.content || "").trim(), rating: r.rating, likes: r.likeVoteCnt || 0, at: r.timestamp || "" });
    }
    if (!p.hasMore || !p.reviews.length) break;
  }
  return [...byId.values()];
}

// ── 대상
const catalog = readJSON(path.join(DATA, "books.json"), {});
const latest = readJSON(path.join(DATA, "latest.json"), { rankings: {}, books: {} });
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
  return { title: (catalog[id] && catalog[id].t) || "", webtoon: !!o.webtoon, bl: !!o.bl, orig: !!o.orig, authors: o.authors || [] };
}
function elementStats(id) {
  const aiFile = readJSON(path.join(DATA, "reviews_ai", id + ".json"), null);
  const rules = readJSON(path.join(DATA, "reviews", id + ".json"), null);
  return (aiFile && aiFile.analysis && aiFile.analysis.aspectsD) || (rules && rules.analysis && rules.analysis.aspectsD) || {};
}
// 규칙 엔진이 센 자세한 리뷰 수 — 요약을 다시 만들지 정할 때 리디에 묻지 않고 쓰는 값
function detailedNow(id) {
  const r = readJSON(path.join(DATA, "reviews", id + ".json"), null);
  return (r && r.analysis && r.analysis.dTotal) || 0;
}
function needsRefresh(id) {
  const f = state.sum.failed && state.sum.failed[id];
  if (f && f.ver === SUMMARY_VER) {
    const grew = detailedNow(id) - (f.detailed || 0);
    const again = (grew >= 20 && grew >= (f.detailed || 0) * 0.15) || daysSince(f.at) >= 30;
    if (!again || f.n >= 3) return false;
  }
  const old = readJSON(path.join(OUT_DIR, id + ".json"), null);
  if (!old || old.ver !== SUMMARY_VER) return detailedNow(id) >= 10;
  const now = detailedNow(id), was = (old.basis && old.basis.detailed) || 0;
  const grew = now - was;
  if (grew >= 20 && grew >= was * 0.15) return true;
  return daysSince(old.updated_at) >= 30 && grew >= 5;
}

const state = readJSON(STATE_FILE, null) || { works: {}, pending: [], spend: {} };
state.spend = state.spend || {}; state.sum = state.sum || {}; state.sum.pending = state.sum.pending || [];
const saveState = () => writeJSON(STATE_FILE, state);
const report = { made: 0, skipped: 0, failed: 0, usd: 0, pendingLeft: 0 };
const client = makeClient();

// 결과 하나 → 확인해서 저장. sample: 보낸 순서 그대로의 리뷰(지워진 것은 빈 칸)
function markFailed(w, why) {
  state.sum.failed = state.sum.failed || {};
  const f = state.sum.failed[w.id];
  const n = f && f.ver === SUMMARY_VER ? f.n + 1 : 1;
  state.sum.failed[w.id] = { at: TODAY, detailed: w.detailed, n, why, ver: SUMMARY_VER };
  console.log(`  ${w.id}: 쓸 수 없는 응답(${why}) — ${n}번째. 리뷰가 꽤 늘거나 30일 지나기 전엔 다시 보내지 않음`);
  return false;
}
function saveSummary(w, msg, sample) {
  if (!msg) return false;   // 오류·만료(요금 없음) — 다음에 다시
  if (msg.stop_reason === "refusal") return markFailed(w, "refusal");
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return markFailed(w, msg.stop_reason || "json"); }
  const v = verifySummary(raw, sample);
  if (!v.stat.kept) return markFailed(w, "no-verified-items");
  if (state.sum.failed) delete state.sum.failed[w.id];
  const work = workInfo(w.id);
  writeJSON(path.join(OUT_DIR, w.id + ".json"), {
    id: w.id, title: work.title, model: SUM_MODEL.model, ver: SUMMARY_VER, updated_at: nowKst(),
    basis: { detailed: w.detailed, sample: w.rids.length, low: w.low }, check: v.stat, summary: v.summary
  });
  report.made++;
  console.log(`  ${work.title.slice(0, 24)}: 항목 ${v.stat.kept}/${v.stat.items}, 인용 확인 ${v.stat.quotesOk}/${v.stat.quotes}`);
  return true;
}

async function collect(batchId) {
  const out = {};
  let usd = 0;
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type === "succeeded") { usd += costOf(SUM_MODEL.model, r.result.message.usage || {}, true); out[r.custom_id] = r.result.message; }
    else out[r.custom_id] = null;
  }
  return { out, usd };
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
// 일괄 만들기 — 자동 재시도는 끄고, 오류면 방금 만들어진 같은 크기의 일괄을 찾아 쓴다(중복 결제 방지)
async function findBatch(t0, n) {
  const known = new Set([...state.sum.pending, ...(state.pending || [])].map((p) => p.batch_id));
  for await (const b of client.messages.batches.list({ limit: 50 })) {
    if (Date.parse(b.created_at) < t0 - 60000) break;
    const rc = b.request_counts;
    if (!known.has(b.id) && rc.processing + rc.succeeded + rc.errored + rc.canceled + rc.expired === n) return b;
  }
  return null;
}
async function createBatch(requests, works) {
  const t0 = Date.now();
  try { return await client.messages.batches.create({ requests }, { maxRetries: 0 }); }
  catch (e) {
    console.log(`  일괄 만들기 오류: ${e.message}`);
    if (e && e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 409) return null;
    for (const wait of [20000, 30000, 40000, 60000, 60000, 90000]) {
      await sleep(wait);
      try { const b = await findBatch(t0, requests.length); if (b) return b; }
      catch (e2) { console.log(`  일괄 목록 확인 실패: ${e2.message}`); }
    }
    state.sum.unsure = { t0: new Date(t0).toISOString(), n: requests.length, prompt: SUMMARY_VER, works };
    saveState();
    return null;
  }
}
async function resolveUnsure() {
  const u = state.sum.unsure;
  if (!u) return;
  try {
    const b = await findBatch(Date.parse(u.t0), u.n);
    if (b) { state.sum.pending.push({ batch_id: b.id, prompt: u.prompt, created: b.created_at, works: u.works }); delete state.sum.unsure; }
    else if (Date.now() - Date.parse(u.t0) > 86400000) delete state.sum.unsure;
    saveState();
  } catch (e) { console.log(`  지난 요약 일괄 확인 실패: ${e.message}`); }
}

async function main() {
  await resolveUnsure();
  // ① 지난 실행에서 기다리다 만 요약 일괄
  for (const p of state.sum.pending.slice()) {
    let out;
    try {
      const b = await client.messages.batches.retrieve(p.batch_id);
      if (b.processing_status !== "ended") { console.log(`  지난 요약 일괄(${p.batch_id})은 아직 처리 중`); continue; }
      const r = await collect(p.batch_id);
      out = r.out;
      if (!p.charged) { state.spend[MONTH] = (state.spend[MONTH] || 0) + r.usd; report.usd += r.usd; p.charged = true; saveState(); }
    } catch (e) {
      const gone = (e && e.status === 404) || Date.now() - Date.parse(p.created) > 28 * 86400000;
      console.log(`  지난 요약 일괄 받기 실패${gone ? " — 버립니다" : " — 다음에 다시"}: ${e.message}`);
      if (gone) { state.sum.pending = state.sum.pending.filter((x) => x.batch_id !== p.batch_id); saveState(); }
      continue;
    }
    const keep = [];
    if ((p.prompt || "1") === SUMMARY_VER) {
      for (const w of p.works) {
        if (!out[w.id]) { report.failed++; continue; }
        if (ridiBlocked) { keep.push(w); continue; }
        try {
          // 인용 확인용으로 표본 리뷰를 다시 받는다 (원문은 저장하지 않으므로)
          const byId = new Map((await fetchAll(w.id)).map((r) => [r.id, r]));
          const miss = w.rids.filter((id) => !byId.has(id)).length;
          if (miss > Math.max(3, Math.ceil(w.rids.length * 0.05)) && Date.now() - Date.parse(p.created) < 25 * 86400000) {
            console.log(`  ${w.id} 표본 리뷰 ${miss}/${w.rids.length}건을 다시 못 받아 다음 실행에서 다시`);
            keep.push(w); continue;
          }
          const sample = w.rids.map((id) => byId.get(id) || { id, content: "", likes: 0 });
          if (!saveSummary(w, out[w.id], sample)) report.failed++;
        } catch (e) { console.log(`  ${w.id} 다시 받기 실패: ${e.message}`); keep.push(w); }
      }
    }
    if (keep.length) p.works = keep; else state.sum.pending = state.sum.pending.filter((x) => x.batch_id !== p.batch_id);
    saveState();
  }

  // ② 다시 만들 작품 고르기 → 표본 모으기 (시간의 절반·돈 한도까지)
  const busy = new Set(state.sum.pending.flatMap((p) => p.works.map((w) => w.id)).concat(((state.sum.unsure && state.sum.unsure.works) || []).map((w) => w.id)));
  const ids = (args.only || targets()).filter((id) => !busy.has(id) && (args.only || needsRefresh(id)));
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);   // 리뷰 분석·요약의 처리 중 예상분까지
  const room = Math.max(0, args.limitUsd - spent);
  const cap = Math.min(args.maxWorks, Math.floor(room / EST_PER_WORK));
  console.log(`[독자 반응 요약] ${TODAY} / ${SUM_MODEL.model} / 새로 만들 작품 ${ids.length}개 중 이번에 최대 ${cap}개 / 이 달 사용 $${(state.spend[MONTH] || 0).toFixed(2)} (한도 $${args.limitUsd})`);
  const jobs = [];
  for (const id of ids) {
    if (jobs.length >= cap || ridiBlocked) break;
    if (leftMs() < args.budgetMin * 60000 * 0.5) { console.log("  수집 시간을 다 써서 여기까지"); break; }
    try {
      const det = (await fetchAll(id)).filter((r) => RABSA.isDetailed(r.content));
      if (det.length < 10) { report.skipped++; continue; }
      const { sample, counts } = sampleReviews(det);
      const work = workInfo(id);
      jobs.push({ w: { id, rids: sample.map((r) => r.id), detailed: det.length, low: counts.low }, sample,
        params: buildSummaryParams(SUM_MODEL, work, elementStats(id), det.length, sample) });
    } catch (e) {
      console.log(`  ${id} 리뷰 받기 실패: ${e.message}`);
      if (e instanceof RidiBlocked) break;
    }
  }
  if (!jobs.length) { console.log("  새로 만들 요약이 없습니다."); return; }

  // ③ 일괄로 보내기
  const batch = await createBatch(jobs.map((j) => ({ custom_id: j.w.id, params: j.params })), jobs.map((j) => j.w));
  if (!batch) { console.log("  일괄을 만들지 못해 이번엔 보내지 않습니다"); report.failed++; return; }
  console.log(`  요약 일괄 ${batch.id}: ${jobs.length}작품`);
  state.sum.pending.push({ batch_id: batch.id, prompt: SUMMARY_VER, created: new Date().toISOString(), works: jobs.map((j) => j.w) });
  saveState();

  // ④ 끝나길 기다렸다 반영 (표본은 아직 메모리에 있음)
  if (!(await waitFor(batch.id))) { console.log("  시간 안에 끝나지 않아 다음 실행에서 받습니다."); report.pendingLeft = 1; return; }
  const { out, usd } = await collect(batch.id);
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd; report.usd += usd;
  const entry = state.sum.pending.find((x) => x.batch_id === batch.id);
  if (entry) entry.charged = true;
  saveState();
  for (const j of jobs) if (!saveSummary(j.w, out[j.w.id], j.sample)) report.failed++;
  state.sum.pending = state.sum.pending.filter((x) => x.batch_id !== batch.id);
  saveState();
}

try {
  await main();
} finally {
  saveState();
  report.usd = Math.round(report.usd * 1000) / 1000;
  report.monthUsd = Math.round((state.spend[MONTH] || 0) * 100) / 100;
  report.requests = requests;
  console.log("요약: " + JSON.stringify(report));
  if (args.summary) {
    fs.appendFileSync(args.summary, ["## 독자 반응 요약", "",
      `- 새로 만든 요약 ${report.made}개, 실패 ${report.failed}, 리뷰가 적어 건너뜀 ${report.skipped}`,
      `- 이번에 쓴 돈 $${report.usd} / 이 달 합계 $${report.monthUsd} (한도 $${args.limitUsd})`,
      report.pendingLeft ? "- 일괄 처리가 시간 안에 끝나지 않아 다음 실행에서 받습니다." : "", ""].join("\n"));
  }
}
