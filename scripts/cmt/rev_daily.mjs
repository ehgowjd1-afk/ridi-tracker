/* 별점 리뷰 '반복되는 반응' — 매일 작업 (예전 'AI 독자 반응 요약'을 대신함)
 *
 * 대상: 웹소설(전체·로맨스·로판·판타지·BL)·웹툰·BL웹툰의 일간·주간·월간 1~--top위(기본 50) 합집합, 순위 높은 순.
 * 다시 분석: 처음 / 방식(REV_VER)이 바뀜 / 리뷰가 15%·30개 넘게 늘어남 / 60일 지나고 새 리뷰가 있음.
 *   리뷰 수는 트래커가 매일 세는 docs/data/reviews/<id>.json 의 count 로 판단(리디에 따로 묻지 않음).
 * 돈: 하루 상한(--run-usd)과 이 달 한도(--limit-usd, 다른 AI 작업과 같은 state/ai_state.json) 안에서만 보낸다.
 *     일괄은 보내는 즉시 예상 비용을 먼저 기록하고, 결과를 받으면 실제 금액으로 맞춘다(batch.mjs).
 * 결과: docs/data/reviews_rx/<id>.json — 묶음·개수·평균 별점 + 묶음마다 대표 리뷰 몇 개(60자 이내로 자름, 아이디 없음).
 * 같은 작품이 3번 실패하면 14일 동안 쉬게 한다(state/rev_rx.json).
 * 2단계가 시간 초과 등으로 끝나지 못하면, 이미 돈을 낸 1단계 묶음(AI가 쓴 이름·기준만, 리뷰 원문과 겹치는 글은 뺌)을
 * state/rev_rx.json 의 reuse 에 남겨 다음 실행에서 1단계(Sonnet)를 다시 사지 않는다(14일 안).
 *
 *   node scripts/cmt/rev_daily.mjs [--top 50] [--max 1200] [--max-works 40] [--run-usd 6] [--limit-usd 30] [--wait-min 100] [--only id,id] [--dry] [--summary FILE]
 *   CMT_MOCK=1 이면 AI 대신 가짜 답(돈 안 듦), 결과는 --out-dir 로(기본은 공개 폴더라 시험엔 꼭 바꿀 것).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { RidiBlocked, cut } from "./ridi_comments.mjs";
import * as RR from "./ridi_reviews.mjs";
import * as C from "./rev_core.mjs";
import { createBatcher, costOf as rawCost, Waiting } from "./batch.mjs";

const STATE = "state/ai_state.json", RX_STATE = "state/rev_rx.json";
const EST_PER_REVIEW = 0.00008;   // 2단계: 리뷰 1개당 예상(실측 약 $0.00004의 2배)
const EST_THEME_WORK = 0.08;      // 1단계: 작품 1개당 예상(실측 약 $0.044의 2배)
const QUOTES = 5, QUOTE_LEN = 60;
const WEBNOVEL = [999001, 1650, 6050, 1750, 4150], WEBTOON = [1600, 4250];
const MOCK = !!process.env.CMT_MOCK;
const T_START = Date.now();
const DAY = 86400e3;

const args = { top: 50, max: 1200, maxWorks: 40, runUsd: 6, limitUsd: 30, waitMin: 100, only: null, dry: false, outDir: "docs/data/reviews_rx", summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--top") args.top = Number(v());
  else if (k === "--max") args.max = Number(v());
  else if (k === "--max-works") args.maxWorks = Number(v());
  else if (k === "--run-usd") args.runUsd = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--only") args.only = v().split(",").map((s) => s.trim()).filter((s) => /^\d{5,12}$/.test(s));
  else if (k === "--dry") args.dry = true;
  else if (k === "--out-dir") args.outDir = v();
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["top", "max", "maxWorks", "runUsd", "limitUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);

const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const MONTH = kstNow().toISOString().slice(0, 7);
const nowKst = () => kstNow().toISOString().replace(/\.\d+Z$/, "+09:00");
const log = (...a) => console.log(...a);
const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return d; } };
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));
// 대표 리뷰로 쓸 만한 글: 글자(한글·영문 등)가 절반 넘는 것 — 'ㄱㄱㄱ' 같은 기호 그림이나 이모지 줄은 뺀다
const readable = (t) => { const a = Array.from(String(t).replace(/\s+/g, "")); return a.length > 0 && a.filter((c) => /\p{L}/u.test(c) && !/[ㄱ-ㅎㅏ-ㅣ]/.test(c)).length / a.length >= 0.5; };
// 인용은 기호 그림(━┓○ 등)과 글자 없는 덩어리를 빼고 자른다 — 앞부분이 기호 그림인 긴 리뷰도 글자부터 보이게
const cleanQ = (t) => String(t).replace(/[\p{So}\p{Sk}\p{Sm}]+/gu, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).join(" ");
const clipQ = (t) => { const a = Array.from(cleanQ(t)); return a.length > QUOTE_LEN ? a.slice(0, QUOTE_LEN - 1).join("").trimEnd() + "…" : a.join(""); };

// ---- 대상
function targets() {
  const latest = readJSON("docs/data/latest.json", { rankings: {} });
  const best = {};
  for (const [key, t] of Object.entries(latest.rankings || {})) {
    const [codeS, period] = key.split("-");
    const code = Number(codeS);
    if (!/^(DAILY|WEEKLY|MONTHLY)$/.test(period || "") || t.is_sub) continue;
    if (!WEBNOVEL.includes(code) && !WEBTOON.includes(code)) continue;
    (t.ids || []).slice(0, args.top).forEach((id, i) => { if (best[id] == null || i < best[id]) best[id] = i; });
  }
  return Object.keys(best).sort((a, b) => best[a] - best[b]);
}
function why(id, rxs) {
  const rx = readJSON(`${args.outDir}/${id}.json`, null);
  const cnt = (readJSON(`docs/data/reviews/${id}.json`, {}) || {}).count || null;
  const f = rxs.failed[id];
  if (f && f.n >= 3 && Date.now() - Date.parse(f.at) < 14 * DAY) return null;
  if (!rx) return { why: "처음", cnt };
  if (rx.ver !== C.REV_VER) return { why: "방식 바뀜", cnt };
  const base = (rx.stats && rx.stats.all) || 0;
  if (cnt && cnt >= base * 1.15 && cnt - base >= 30) return { why: `리뷰 ${base}→${cnt}`, cnt };
  if (cnt && Date.now() - Date.parse(rx.updated_at) > 60 * DAY && cnt - base >= 10) return { why: "60일 지남", cnt };
  return null;
}
const estWork = (cnt) => EST_THEME_WORK + Math.min(cnt || args.max, args.max) * EST_PER_REVIEW;

// ---- 공개 파일: 원문 통째로 X, 묶음마다 대표 리뷰 몇 개만 짧게
function publicFile(w, report) {
  const sc = C.scrubber(w, report);
  const byN = new Map(w.sample.map((r) => [r.n, r]));
  return {
    id: w.id, title: w.title, ver: C.REV_VER, updated_at: nowKst(), model: { theme: C.SONNET.model, tag: C.HAIKU.model },
    stats: { all: w.stats.all, meaningful: w.stats.meaningful, detailed: w.stats.detailed, stars: w.stats.stars, tagged: w.stats.tagged, exact: w.stats.exact },
    untagged: w.untagged, unlabeled: w.unlabeled,
    themes: (w.themes || []).filter((t) => t.count > 0).map((t) => ({
      id: t.id, b: t.bucket, l: sc(t.label) ?? cut(sc(t.def) ?? "", 40), d: sc(t.def) ?? "",
      est: t.est, share: t.share, star: t.avgStar, low: t.lowShare, likes: t.likes, n: t.count,
      q: t.refs.map((n) => byN.get(n)).filter((r) => r && readable(r.content)).slice(0, QUOTES).map((r) => [r.rating, r.likes, clipQ(r.content)])
    })).filter((t) => t.l)
  };
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const rxs = readJSON(RX_STATE, { failed: {} });
rxs.failed ||= {};
rxs.reuse ||= {};
if (!MOCK && !args.dry && !existsSync(RX_STATE)) writeFileSync(RX_STATE, JSON.stringify(rxs, null, 1) + "\n");
let savedIds = new Set();
const report = { generated_at: new Date().toISOString(), cost: { theme: 0, haiku: 0 }, batches: {}, notes: [], dropped: 0, scrubbed: 0 };
let works = [], saved = 0;
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
function fail(id, why) {
  const f = rxs.failed[id] || { n: 0 };
  rxs.failed[id] = { n: f.n + 1, at: new Date().toISOString(), why };
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer: C.mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

try {
  const { inFlightUsd } = await import("../ai/review_ai.mjs");
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);
  const room = Math.min(args.runUsd, args.limitUsd - spent);
  const all = args.only || targets();
  const due = all.map((id) => ({ id, ...(why(id, rxs) || {}) })).filter((x) => x.why);
  log(`[별점 리뷰 반복 반응] 대상 ${all.length}작 중 할 일 ${due.length}작 · 이 달 사용·처리 중 $${spent.toFixed(2)} / 한도 $${args.limitUsd} · 이번 상한 $${room.toFixed(2)}`);
  if (room <= 0.05) { report.notes.push("이 달 한도에 닿아 이번엔 보내지 않음"); throw new Error("한도"); }
  const pick = [];
  let est = 0;
  for (const x of due) {
    if (pick.length >= args.maxWorks) break;
    const e = estWork(x.cnt);
    if (est + e > room) break;
    pick.push(x); est += e;
  }
  log(`이번에 할 작품 ${pick.length}개 (예상 $${est.toFixed(2)}): ${pick.slice(0, 12).map((x) => `${x.id}(${x.why})`).join(", ")}${pick.length > 12 ? " …" : ""}`);
  if (args.dry || !pick.length) throw new Error(args.dry ? "dry" : "할 일 없음");

  for (const x of pick) {
    try { works.push(await C.collect(x.id, args.max, log)); }
    catch (e) { if (e instanceof RidiBlocked) throw e; report.notes.push(`수집 실패 ${x.id}: ${e.message}`); fail(x.id, "수집 " + e.message); }
  }
  works = works.filter((w) => w.themeSample.length || (report.notes.push(`내용 있는 리뷰 없음: ${w.title}`), false));
  if (!works.length) throw new Error("보낼 작품 없음");
  const nR = works.reduce((t, w) => t + w.sample.length, 0);
  const estReal = nR * EST_PER_REVIEW + works.length * EST_THEME_WORK;
  if (spent + estReal > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");
  log(`수집 끝: 리디 요청 ${RR.reviewRequests}번, 작품 ${works.length}개, 표시할 리뷰 ${nR}개, 예상 $${estReal.toFixed(2)}`);

  // 지난 실행에서 1단계까지 받고 2단계를 못 마친 작품은 그 묶음을 그대로 쓴다(1단계 다시 안 삼)
  for (const w of works) {
    const r = rxs.reuse[w.id];
    if (r && r.ver === C.REV_VER && Date.now() - Date.parse(r.at) < 14 * DAY && r.themes && r.themes.length) {
      w.themes = r.themes.map((t) => ({ ...t, seed: [] }));
      report.notes.push(`지난번 1단계 묶음 다시 씀: ${w.title}`);
    }
  }
  const needTheme = works.filter((w) => !w.themes);
  if (needTheme.length) {
    try { await stage("1단계(Sonnet) 반복 반응 찾기", C.themeRequests(needTheme, log), needTheme.length * EST_THEME_WORK, "theme", (out) => C.applyThemes(needTheme, out, report, costOf)); }
    catch (e) { if (works.some((w) => w.themes)) report.notes.push("1단계 실패 — 지난번 묶음이 있는 작품만 계속: " + e.message); else throw e; }
  }
  const ready = works.filter((w) => w.themes && w.themes.length);
  for (const w of works) if (!ready.includes(w)) fail(w.id, w.failed || "묶음 없음");
  if (ready.length) {
    const nR2 = ready.reduce((t, w) => t + w.sample.length, 0);
    // 2단계가 끝나지 못해도 1단계 묶음은 남겨 둔다(공개 저장소라 AI가 쓴 이름·기준만, 리뷰 원문과 겹치는 글은 뺌)
    for (const w of ready) {
      const sc = C.scrubber(w, report);
      rxs.reuse[w.id] = { ver: C.REV_VER, at: new Date().toISOString(), themes: w.themes.map((t) => ({ id: t.id, bucket: t.bucket, label: sc(t.label) ?? "", def: sc(t.def) ?? "" })).filter((t) => t.label || t.def) };
    }
    await stage("2단계(Haiku) 리뷰 표시", C.classifyRequests(ready), nR2 * EST_PER_REVIEW, "haiku", (out) => C.applyLabels(ready, out, report, costOf));
    mkdirSync(args.outDir, { recursive: true });
    for (const w of ready) {
      C.themeStats(w, report);
      if (w.unlabeled > w.sample.length * 0.2) { fail(w.id, `표시 못 받은 리뷰 ${w.unlabeled}`); continue; }
      writeFileSync(`${args.outDir}/${w.id}.json`, JSON.stringify(publicFile(w, report)));
      delete rxs.failed[w.id];
      delete rxs.reuse[w.id];
      savedIds.add(w.id);
      saved++;
    }
  }
} catch (e) {
  if (!["한도", "dry", "할 일 없음"].includes(e.message)) {
    if (!(e instanceof Waiting) && !(e instanceof RidiBlocked) && e.message !== "보낼 작품 없음") {
      for (const w of works) if (!savedIds.has(w.id)) fail(w.id, e.message);
    }
    report.error = e instanceof RidiBlocked ? "리디가 요청을 막아 멈췄습니다" : e.message;
    console.error("오류:", e.message);
    process.exitCode = 1;
  }
} finally {
  if (!MOCK && !args.dry) writeFileSync(RX_STATE, JSON.stringify(rxs, null, 1) + "\n");
  const usd = report.cost.theme + report.cost.haiku;
  const lines = [`## 별점 리뷰 반복 반응 (매일)`, `- 새로 저장한 작품 ${saved}개 / 시도 ${works.length}개 · 리디 요청 ${RR.reviewRequests}번`,
    `- AI 비용 $${usd.toFixed(3)} (묶음 찾기 $${report.cost.theme.toFixed(3)} + 표시 $${report.cost.haiku.toFixed(3)}) / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)} (한도 $${args.limitUsd})`,
    `- '불호'에서 뺀 지적 ${report.dropped}개, 원문과 겹쳐 가린 글 ${report.scrubbed}개`,
    ...report.notes.slice(0, 30).map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
