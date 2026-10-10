/* 별점 리뷰 — 반복되는 반응 세기 시범 (작품 1~3개)
 *
 * ① 수집: 작품의 보이는 구매자 리뷰 전부(별점·공감·시각·내용, 아이디 없음). 별점 분포를 센다.
 * ② 고르기: '내용 있는 리뷰'(ㅋㅋ·이모지만 있는 것 제외 — 웹툰은 짧은 리뷰가 대부분이고 짧아도 '작화 황홀' 같은 말이 많음) 중 표시할 리뷰를 고른다.
 *    전부가 --max 이하면 전부. 넘으면 별점 낮은(★1~3) 리뷰는 되도록 전부 + 나머지는 무작위로 채우고,
 *    개수는 '약 N개'로 환산한다: 1단계 표본(공감 많은·최근·낮은 별점 등, 무작위가 아님)은 자기 자신만 세고,
 *    무작위로 고른 리뷰가 층(낮은 별점/높은 별점)마다 '(층 전체 − 1단계 표본) ÷ 무작위로 고른 수'만큼을 대표한다.
 * ③ 1단계 AI(Sonnet, 일괄): 리뷰 표본(자세한 리뷰의 낮은 별점·공감 많은·최근 + 짧은 리뷰 무작위)을 읽고 반복되는 반응 묶음을 정한다.
 * ④ 2단계 AI(Haiku, 일괄): 고른 리뷰마다 묶음 번호 + 속뜻만 표시. 개수·평균 별점은 프로그램이 센다.
 * ⑤ 결과 파일: 숫자·표시·묶음만(리뷰 원문 없음 — 근거는 리뷰 번호). 이 달 AI 사용액은 state/ai_state.json 에 더한다.
 *
 *   node scripts/cmt/rev_pilot.mjs --ids 5163001179,5103000637 --out rev_pilot_out.json
 *        [--max 1200] [--limit-usd 30] [--cap-usd 2] [--wait-min 100] [--summary FILE]
 *   CMT_MOCK=1 이면 AI 대신 가짜 답으로 끝까지 돌려 본다 (돈 안 듦, 시험용).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fetchSeries, RidiBlocked, cut } from "./ridi_comments.mjs";
import * as RR from "./ridi_reviews.mjs";
import * as AI from "./rev_ai.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");
const STATE = "state/ai_state.json";
const HAIKU = { model: "claude-haiku-5-5", effort: "medium" };
const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_PER_REVIEW = 0.00015;   // 2단계: 리뷰 1개당 예상(일괄, 여유 있게)
const EST_THEME_WORK = 0.2;       // 1단계: 작품 1개당 예상(Sonnet 일괄)
const CHUNK = 20, TEXT_MAX = 600, THEME_TEXT = 300, THEME_MAX = 24, REFS = 8, MAX_CHARS = 70000;
const MOCK = !!process.env.CMT_MOCK;
const T_START = Date.now();

const args = { ids: [], max: 1200, limitUsd: 30, capUsd: 2, waitMin: 100, out: "rev_pilot_out.json", summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--ids") args.ids = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--max") args.max = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["max", "limitUsd", "capUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (!args.ids.length || args.ids.length > 3 || args.ids.some((x) => !/^\d{5,12}$/.test(x))) throw new Error("--ids 에 작품 번호 1~3개를 쉼표로 넣어 주세요");

const HOUR = 3600e3;
const MONTH = new Date(Date.now() + 9 * HOUR).toISOString().slice(0, 7);
const log = (...a) => console.log(...a);
const clip = (t, n) => cut(String(t).replace(/\s+/g, " ").trim(), n);
const low = (r) => r.rating > 0 && r.rating <= 3;
// 내용 있는 리뷰: 공백·ㅋㅎㅠㅜ·문장부호·하트·이모지를 빼고 4글자 이상
const core = (t) => String(t).replace(/[\s\p{P}\p{S}ㅋㅎㅠㅜ]+/gu, "");
const meaningful = (r) => Array.from(core(r.content)).length >= 4;

function workInfo(id) {
  let latest = {};
  try { latest = JSON.parse(readFileSync("docs/data/latest.json", "utf8")); } catch (e) {}
  const rk = latest.rankings || {};
  const inCat = (codes) => Object.entries(rk).some(([k, v]) => codes.includes(k.split("-")[0]) && (v.ids || []).includes(id));
  const b = (latest.books || {})[id] || {};
  return { title: b.title || b.t || id, webtoon: inCat(["1600", "4250"]), bl: inCat(["4250", "4150"]) };
}
function shuffle(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const starDist = (rs) => rs.reduce((o, r) => ((o[r.rating] = (o[r.rating] || 0) + 1), o), {});

// ---------------- ① 수집 + ② 고르기 ----------------
async function collect(id) {
  const info = workInfo(id);
  let desc = "";
  try { desc = (await fetchSeries(id)).desc; } catch (e) { log("  작품 소개를 못 받음:", e.message); }
  const all = await RR.fetchReviews(id);
  const pool = all.filter(meaningful);
  const det = pool.filter((r) => RABSA.isDetailed(r.content));
  const short = pool.filter((r) => !RABSA.isDetailed(r.content));
  log(`■ ${info.title} (${id}) — 리뷰 ${all.length}개, 내용 있는 리뷰 ${pool.length}개(자세한 ${det.length}·짧은 ${short.length})`);
  // 1단계 표본: 자세한 리뷰의 낮은 별점(공감순) + 공감 많은 + 최근, 그리고 짧은 리뷰 무작위를 번갈아, 글자 수 상한까지
  const lists = [det.filter(low).sort((a, b) => b.likes - a.likes).slice(0, 80), [...det].sort((a, b) => b.likes - a.likes).slice(0, 120),
    [...det].sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0)).slice(0, 120), shuffle(short, Number(id) + 7).slice(0, 120)];
  const themeSet = [], seen = new Set();
  let chars = 0;
  for (let round = 0, progressed = true; progressed; round++) {
    progressed = false;
    for (const L of lists) {
      const r = L[round];
      if (!r) continue;
      progressed = true;   // 이 목록에 아직 남은 게 있으면 다음 차례로 (겹쳐서 못 넣은 차례에서 멈추지 않게)
      if (seen.has(r.id)) continue;
      const len = Math.min(Array.from(r.content).length, THEME_TEXT) + 20;
      if (chars + len > MAX_CHARS - 2000) continue;
      seen.add(r.id); themeSet.push(r); chars += len; progressed = true;
    }
  }
  // 2단계 표시 대상: 1단계 표본 + (전부 또는 층별 채우기)
  let tagSet;
  if (pool.length <= args.max) tagSet = pool;
  else {
    const lows = pool.filter(low), highs = pool.filter((r) => !low(r));
    const lowCap = Math.min(lows.length, Math.floor(args.max / 3));
    const pick = new Map(themeSet.map((r) => [r.id, r]));
    for (const r of shuffle(lows, Number(id))) { if ([...pick.values()].filter(low).length >= lowCap) break; pick.set(r.id, r); }
    for (const r of shuffle(highs, Number(id) + 1)) { if (pick.size >= args.max) break; pick.set(r.id, r); }
    tagSet = [...pick.values()];
  }
  // 층별 무게: 1단계 표본은 무작위가 아니므로 자기 자신만 대표(무게 1), 무작위 표본이 (층 전체 − 1단계 표본)을 대표
  //   전부 표시한 경우엔 모두 1. 무작위 표본이 하나도 없으면(작은 --max) 층 전체를 고른 수로 나눈다.
  const cert = new Set(themeSet.map((r) => r.id));
  const wOf = (isLow) => {
    const pop = pool.filter((r) => low(r) === isLow).length;
    const ins = tagSet.filter((r) => low(r) === isLow);
    const c = ins.filter((r) => cert.has(r.id)).length, rnd = ins.length - c;
    return rnd ? { cert: 1, rand: (pop - c) / rnd } : { cert: ins.length ? pop / ins.length : 0, rand: 0 };
  };
  const wl = wOf(true), wh = wOf(false);
  let n = 0;
  const tagged = tagSet.map((r) => { const s = low(r) ? wl : wh; return { ...r, n: ++n, w: cert.has(r.id) ? s.cert : s.rand }; });
  const nOf = new Map(tagged.map((r) => [r.id, r.n]));
  return { id, ...info, desc, stats: { all: all.length, meaningful: pool.length, detailed: det.length, stars: starDist(all), starsMeaningful: starDist(pool), tagged: tagged.length,
    exact: pool.length <= args.max, wLow: Math.round(wl.rand * 100) / 100, wHigh: Math.round(wh.rand * 100) / 100, themeSample: themeSet.length },
    sample: tagged, themeSample: themeSet.map((r) => nOf.get(r.id)) };
}

// ---------------- 일괄 처리 ----------------
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));
function mockAnswer(customId, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  if (customId.startsWith("t-")) return { themes: [
    { bucket: "like", label: "공 캐릭터가 매력적이다", def: "공 칭찬", refs: ns.slice(0, 3) },
    { bucket: "talk", label: "완결이 아쉽고 외전을 바란다", def: "완결·외전", refs: ns.slice(3, 5) },
    { bucket: "dislike", label: "후반 전개가 늘어진다", def: "전개 비판", refs: ns.slice(5, 7) }] };
  return { reviews: ns.map((n, i) => ({ n, th: [["T1"], ["T2"], ["T3"], [], ["T1", "T2", "T9"]][i % 5], tn: ["praise", "miss", "critic", "other", "nudge"][i % 5], cf: ["hi", "mid", "lo"][i % 3] })) };
}

// ---------------- ③ 1단계 ----------------
function themeRequests(works) {
  return works.flatMap((w, wi) => {
    if (!w.themeSample.length) return [];
    const byN = new Map(w.sample.map((r) => [r.n, r]));
    const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.bl ? " / BL" : ""}`, `[작품 소개] ${w.desc || "-"}`,
      `[별점 분포(전체 리뷰 ${w.stats.all}개)] ${[5, 4, 3, 2, 1].map((s) => `★${s} ${w.stats.stars[s] || 0}`).join(" · ")}`, "",
      `[리뷰 표본] 별점 낮은 리뷰 + 공감 많은 리뷰 + 최근 리뷰 + 짧은 리뷰 무작위(이 작품 리뷰의 대부분은 짧은 리뷰). 번호 [별점 · 공감] 본문`];
    for (const n of w.themeSample) { const r = byN.get(n); lines.push(`#${n} [★${r.rating} · 공감 ${r.likes}] ${clip(r.content, THEME_TEXT)}`); }
    const t = lines.join("\n");
    log(`  1단계 자료: ${w.title} 리뷰 ${w.themeSample.length}개, ${t.length.toLocaleString()}자`);
    return [{ custom_id: `t-${wi}`, params: AI.buildRevThemeParams(SONNET, t) }];
  });
}
function applyThemes(works, out) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`1단계 실패: ${w ? w.title : cid} (${res.type})`); continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.map((r) => r.n));
      w.themes = (JSON.parse(res.message.content.filter((b) => b.type === "text").map((b) => b.text).join("")).themes || []).slice(0, THEME_MAX).map((t, i) => ({
        id: "T" + (i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
        seed: [...new Set((t.refs || []).filter((n) => valid.has(n)))].slice(0, 5) }));
    } catch (e) { report.notes.push(`1단계 해석 실패: ${w.title} ${e.message}`); }
  }
  return usd;
}

// ---------------- ④ 2단계 ----------------
function classifyRequests(works) {
  const reqs = [];
  works.forEach((w, wi) => {
    if (!w.themes || !w.themes.length) return;
    for (let k = 0; k < w.sample.length; k += CHUNK)
      reqs.push({ custom_id: `h-${wi}-${k / CHUNK}`, params: AI.buildRevClassifyParams(HAIKU, w, w.sample.slice(k, k + CHUNK), TEXT_MAX, w.themes) });
  });
  return reqs;
}
function applyLabels(works, out) {
  let usd = 0, failed = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { failed++; continue; }
    usd += costOf(HAIKU.model, res.message.usage || {});
    let parsed;
    try { parsed = JSON.parse(res.message.content.filter((b) => b.type === "text").map((b) => b.text).join("")); } catch (e) { failed++; continue; }
    const byN = new Map(w.sample.map((r) => [r.n, r]));
    const themeOf = new Map(w.themes.map((t) => [t.id, t]));
    for (const it of parsed.reviews || []) {
      const r = byN.get(it.n);
      if (!r) continue;
      const lab = { th: [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 3), tn: it.tn, cf: it.cf };
      // '불호' 묶음엔 확신 있는 진짜 작품 불만만
      const before = lab.th.length;
      lab.th = lab.th.filter((id) => themeOf.get(id).bucket !== "dislike" || (lab.tn === "critic" && lab.cf !== "lo"));
      if (lab.th.length < before) report.dropped++;
      r.lab = lab;
    }
  }
  if (failed) report.notes.push(`2단계 실패한 묶음 ${failed}개`);
  return usd;
}

// 묶음별 개수(그대로·환산)·평균 별점·낮은 별점 비율·공감 합
function themeStats(w) {
  const lab = w.sample.filter((r) => r.lab);
  // 표시 못 받은 리뷰(2단계 실패·답에서 빠짐)만큼 같은 층 무게를 늘려 층 합(=층 전체 수)을 유지
  const fac = (isLow) => {
    const tot = w.sample.filter((r) => low(r) === isLow).reduce((s, r) => s + r.w, 0);
    const got = lab.filter((r) => low(r) === isLow).reduce((s, r) => s + r.w, 0);
    return got ? tot / got : 0;
  };
  const fL = fac(true), fH = fac(false), wt = (r) => r.w * (low(r) ? fL : fH);
  w.unlabeled = w.sample.length - lab.length;
  if (w.unlabeled) report.notes.push(`${w.title}: 표시 못 받은 리뷰 ${w.unlabeled}개 — 환산은 같은 층 리뷰로 보정(정확한 수 아님)`);
  const wsum = lab.reduce((s, r) => s + wt(r), 0) || 1;
  for (const t of w.themes || []) {
    const rs = lab.filter((r) => r.lab.th.includes(t.id));
    const W = rs.reduce((s, r) => s + wt(r), 0);
    t.count = rs.length;
    t.est = Math.round(W);
    t.share = Math.round((W / wsum) * 1000) / 10;
    t.avgStar = W ? Math.round((rs.reduce((s, r) => s + r.rating * wt(r), 0) / W) * 100) / 100 : null;
    t.lowShare = W ? Math.round((rs.filter(low).reduce((s, r) => s + wt(r), 0) / W) * 100) : null;
    t.likes = rs.reduce((s, r) => s + r.likes, 0);
    t.refs = [...rs].sort((a, b) => b.likes - a.likes).slice(0, REFS).map((r) => r.n);
    t.tones = rs.reduce((o, r) => ((o[r.lab.tn] = (o[r.lab.tn] || 0) + 1), o), {});
  }
  w.untagged = lab.filter((r) => !r.lab.th.length).length;
  w.tones = lab.reduce((o, r) => ((o[r.lab.tn] = (o[r.lab.tn] || 0) + 1), o), {});
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { kind: "reviews", generated_at: new Date().toISOString(), models: { haiku: HAIKU, sonnet: SONNET }, cost: { theme: 0, haiku: 0 }, batches: {}, notes: [], dropped: 0, scrubbed: 0 };
let works = [];
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
// 공개되는 결과에 리뷰 원문이 실리지 않게: AI가 쓴 묶음 이름·기준이 어떤 리뷰와 공백 빼고 12자 넘게 겹치면 가린다
function scrubber(w) {
  const G = 12, norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const r of w.sample || []) { const t = norm(r.content); for (let i = 0; i + G <= t.length; i++) grams.add(t.slice(i, i + G)); }
  return (s) => { const t = norm(s); for (let i = 0; i + G <= t.length; i++) if (grams.has(t.slice(i, i + G))) { report.scrubbed++; return "(리뷰 원문과 겹쳐 가림)"; } return s; };
}
function save() {
  report.reviewRequests = RR.reviewRequests;
  report.scrubbed = 0;
  report.works = works.map((w) => {
    const sc = scrubber(w);
    return { id: w.id, title: w.title, webtoon: w.webtoon, bl: w.bl, stats: w.stats, untagged: w.untagged ?? null, unlabeled: w.unlabeled ?? null, tones: w.tones || {},
      themes: (w.themes || []).map((t) => ({ ...t, label: sc(t.label), def: sc(t.def) })),
      // 원문(content)은 넣지 않는다 — 번호·별점·공감·시각·무게·표시만
      reviews: (w.sample || []).map(({ content, ...r }) => r), themeSample: w.themeSample };
  });
  writeFileSync(args.out, JSON.stringify(report));
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

try {
  for (const id of args.ids) works.push(await collect(id));
  const nR = works.reduce((t, w) => t + w.sample.length, 0);
  log(`수집 끝: 리디 요청 ${RR.reviewRequests}번, 표시할 리뷰 ${nR}개`);
  const sendN = works.filter((w) => w.themeSample.length).length;
  for (const w of works) if (!w.themeSample.length) report.notes.push(`내용 있는 리뷰가 없어 AI에 보내지 않음: ${w.title} (${w.id})`);
  if (!sendN) throw new Error("내용 있는 리뷰가 있는 작품이 없어 AI를 부르지 않습니다(작품 번호·리디 응답 확인)");
  const est = nR * EST_PER_REVIEW + sendN * EST_THEME_WORK;
  const { inFlightUsd } = await import("../ai/review_ai.mjs");
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);
  log(`예상 비용 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용·처리 중 $${spent.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 시범 상한을 넘어 보내지 않습니다");
  if (spent + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");

  await stage("1단계(Sonnet) 반복 반응 찾기", themeRequests(works), sendN * EST_THEME_WORK, "theme", (out) => applyThemes(works, out));
  save();
  if (!works.some((w) => w.themes && w.themes.length)) throw new Error("반복 반응 묶음을 하나도 받지 못했습니다");
  await stage("2단계(Haiku) 리뷰 표시", classifyRequests(works), nR * EST_PER_REVIEW, "haiku", (out) => applyLabels(works, out));
  for (const w of works) themeStats(w);
} catch (e) {
  report.error = e instanceof RidiBlocked ? "리디가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  save();
  const usd = report.cost.theme + report.cost.haiku;
  const lines = [`## 별점 리뷰 반복 반응 시범`, `- 작품: ${works.map((w) => `${w.title}(리뷰 ${w.stats.all}·내용 있는 ${w.stats.meaningful}·표시 ${w.stats.tagged})`).join(", ")}`,
    `- 리디 요청 ${RR.reviewRequests}번, 묶음 ${works.map((w) => (w.themes || []).length).join("·")}개, '불호'에서 뺀 지적(애정 섞인 지적·확신 낮음) ${report.dropped}개, 원문과 겹쳐 가린 글 ${report.scrubbed}개`,
    `- AI 비용 $${usd.toFixed(3)} (묶음 찾기 $${report.cost.theme.toFixed(3)} + 표시 $${report.cost.haiku.toFixed(3)}) / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
