/* 별점 리뷰 '반복되는 반응' — 시범(rev_pilot.mjs)과 매일 작업(rev_daily.mjs)이 같이 쓰는 핵심
 *
 * ① collect: 작품의 보이는 구매자 리뷰 전부(별점·공감·시각·내용, 아이디 없음) → '내용 있는 리뷰'(공백·기호·ㅋㅎㅠㅜ 빼고 4글자 이상)
 *    → 1단계 표본(자세한 리뷰의 낮은 별점·공감 많은·최근 + 짧은 리뷰 무작위) + 2단계 표시 대상(전부가 max 이하면 전부,
 *    넘으면 낮은 별점 우선 + 무작위). 개수는 '약 N개'로 환산: 1단계 표본은 자기 자신만(무게 1), 무작위 표본이
 *    층(낮은 별점/높은 별점)마다 '(층 전체 − 1단계 표본) ÷ 무작위로 고른 수'만큼을 대표.
 * ② 1단계(Sonnet): 반복되는 반응 묶음 → ③ 2단계(Haiku): 리뷰마다 묶음 번호 + 속뜻 → ④ themeStats: 프로그램이 셈.
 * '불호' 묶음엔 확신 있는 진짜 작품 불만(critic, 확신 낮음 아님)만 — 코드로 강제.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fetchSeries, cut } from "./ridi_comments.mjs";
import * as RR from "./ridi_reviews.mjs";
import * as AI from "./rev_ai.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");

export const REV_VER = "1";   // 지시문·방식을 바꾸면 올린다(올리면 전부 다시 분석 = 비용 듦)
export const HAIKU = { model: "claude-haiku-5-5", effort: "medium" };
export const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
export const CHUNK = 20, TEXT_MAX = 600, THEME_TEXT = 300, THEME_MAX = 24, REFS = 8, MAX_CHARS = 70000;

export const low = (r) => r.rating > 0 && r.rating <= 3;
const core = (t) => String(t).replace(/[\s\p{P}\p{S}ㅋㅎㅠㅜ]+/gu, "");
export const meaningful = (r) => Array.from(core(r.content)).length >= 4;
const clip = (t, n) => cut(String(t).replace(/\s+/g, " ").trim(), n);
const starDist = (rs) => rs.reduce((o, r) => ((o[r.rating] = (o[r.rating] || 0) + 1), o), {});
const textOf = (msg) => (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

let latestCache = null;
export function workInfo(id) {
  if (!latestCache) { try { latestCache = JSON.parse(readFileSync("docs/data/latest.json", "utf8")); } catch (e) { latestCache = {}; } }
  const rk = latestCache.rankings || {};
  const inSection = (sec) => Object.values(rk).some((v) => v.section === sec && (v.ids || []).includes(id));
  const inCat = (codes) => Object.entries(rk).some(([k, v]) => codes.includes(k.split("-")[0]) && (v.ids || []).includes(id));
  const b = (latestCache.books || {})[id] || {};
  return { title: b.title || b.t || id, webtoon: inSection("webtoon"), bl: inCat(["4250", "4150"]) };
}
export function shuffle(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------- ① 수집 + 고르기 ----------------
export async function collect(id, max, log) {
  const info = workInfo(id);
  let desc = "";
  try { desc = (await fetchSeries(id)).desc; } catch (e) { log(`  작품 소개를 못 받음(${id}): ${e.message}`); }
  const all = await RR.fetchReviews(id);
  const pool = all.filter(meaningful);
  const det = pool.filter((r) => RABSA.isDetailed(r.content));
  const short = pool.filter((r) => !RABSA.isDetailed(r.content));
  log(`■ ${info.title} (${id}) — 리뷰 ${all.length}개, 내용 있는 리뷰 ${pool.length}개(자세한 ${det.length}·짧은 ${short.length})`);
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
      seen.add(r.id); themeSet.push(r); chars += len;
    }
  }
  let tagSet;
  if (pool.length <= max) tagSet = pool;
  else {
    const lows = pool.filter(low), highs = pool.filter((r) => !low(r));
    const lowCap = Math.min(lows.length, Math.floor(max / 3));
    const pick = new Map(themeSet.map((r) => [r.id, r]));
    let lowIn = themeSet.filter(low).length;
    for (const r of shuffle(lows, Number(id))) { if (lowIn >= lowCap) break; if (!pick.has(r.id)) { pick.set(r.id, r); lowIn++; } }
    for (const r of shuffle(highs, Number(id) + 1)) { if (pick.size >= max) break; pick.set(r.id, r); }
    tagSet = [...pick.values()];
  }
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
    exact: pool.length <= max, wLow: Math.round(wl.rand * 100) / 100, wHigh: Math.round(wh.rand * 100) / 100, themeSample: themeSet.length },
    sample: tagged, themeSample: themeSet.map((r) => nOf.get(r.id)) };
}

// 시험용 가짜 답 (CMT_MOCK=1)
export function mockAnswer(customId, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  if (customId.startsWith("t-")) return { themes: [
    { bucket: "like", label: "공 캐릭터가 매력적이다", def: "공 칭찬", refs: ns.slice(0, 3) },
    { bucket: "talk", label: "완결이 아쉽고 외전을 바란다", def: "완결·외전", refs: ns.slice(3, 5) },
    { bucket: "dislike", label: "후반 전개가 늘어진다", def: "전개 비판", refs: ns.slice(5, 7) }] };
  return { reviews: ns.map((n, i) => ({ n, th: [["T1"], ["T2"], ["T3"], [], ["T1", "T2", "T9"]][i % 5], tn: ["praise", "miss", "critic", "other", "nudge"][i % 5], cf: ["hi", "mid", "lo"][i % 3] })) };
}

// ---------------- ② 1단계: 반복되는 반응 찾기 ----------------
export function themeRequests(works, log) {
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
export function applyThemes(works, out, report, costOf) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`1단계 실패: ${w ? w.title : cid} (${res.type})`); if (w) w.failed = "1단계 " + res.type; continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.map((r) => r.n));
      w.themes = (JSON.parse(textOf(res.message)).themes || []).slice(0, THEME_MAX).map((t, i) => ({
        id: "T" + (i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
        seed: [...new Set((t.refs || []).filter((n) => valid.has(n)))].slice(0, 5) }));
    } catch (e) { report.notes.push(`1단계 해석 실패: ${w.title} ${e.message}`); w.failed = "1단계 해석"; }
  }
  return usd;
}

// ---------------- ③ 2단계: 리뷰마다 표시 ----------------
export function classifyRequests(works) {
  const reqs = [];
  works.forEach((w, wi) => {
    if (!w.themes || !w.themes.length) return;
    for (let k = 0; k < w.sample.length; k += CHUNK)
      reqs.push({ custom_id: `h-${wi}-${k / CHUNK}`, params: AI.buildRevClassifyParams(HAIKU, w, w.sample.slice(k, k + CHUNK), TEXT_MAX, w.themes) });
  });
  return reqs;
}
export function applyLabels(works, out, report, costOf) {
  let usd = 0, failed = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { failed++; continue; }
    usd += costOf(HAIKU.model, res.message.usage || {});
    let parsed;
    try { parsed = JSON.parse(textOf(res.message)); } catch (e) { failed++; continue; }
    const byN = new Map(w.sample.map((r) => [r.n, r]));
    const themeOf = new Map(w.themes.map((t) => [t.id, t]));
    for (const it of parsed.reviews || []) {
      const r = byN.get(it.n);
      if (!r) continue;
      const lab = { th: [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 3), tn: it.tn, cf: it.cf };
      const before = lab.th.length;
      lab.th = lab.th.filter((id) => themeOf.get(id).bucket !== "dislike" || (lab.tn === "critic" && lab.cf !== "lo"));
      if (lab.th.length < before) report.dropped++;
      r.lab = lab;
    }
  }
  if (failed) report.notes.push(`2단계 실패한 묶음 ${failed}개`);
  return usd;
}

// ---------------- ④ 셈: 개수(그대로·환산)·평균 별점·낮은 별점 비율·공감 합 ----------------
export function themeStats(w, report) {
  const lab = w.sample.filter((r) => r.lab);
  const fac = (isLow) => {
    const tot = w.sample.filter((r) => low(r) === isLow).reduce((s, r) => s + r.w, 0);
    const got = lab.filter((r) => low(r) === isLow).reduce((s, r) => s + r.w, 0);
    return got ? tot / got : 0;
  };
  const fL = fac(true), fH = fac(false), wt = (r) => r.w * (low(r) ? fL : fH);
  w.unlabeled = w.sample.length - lab.length;
  if (w.unlabeled) report.notes.push(`${w.title}: 표시 못 받은 리뷰 ${w.unlabeled}개 — 환산은 같은 층 리뷰로 보정(정확한 수 아님)`);
  const wsum = lab.reduce((s, r) => s + wt(r), 0) || 1;
  // 별점별: 별점(1~5)마다 표시된 리뷰 합(묶음 비율의 분모)과 어느 묶음에도 안 들어간 리뷰
  const star = (r) => (r.rating >= 1 && r.rating <= 5 ? r.rating - 1 : -1);
  w.starTot = [0, 0, 0, 0, 0]; w.starUntag = [0, 0, 0, 0, 0];
  for (const r of lab) { const k = star(r); if (k < 0) continue; w.starTot[k] += wt(r); if (!r.lab.th.length) w.starUntag[k] += wt(r); }
  for (const t of w.themes || []) {
    const rs = lab.filter((r) => r.lab.th.includes(t.id));
    const W = rs.reduce((s, r) => s + wt(r), 0);
    t.byStar = [0, 0, 0, 0, 0];
    for (const r of rs) { const k = star(r); if (k >= 0) t.byStar[k] += wt(r); }
    // 별점마다 공감 많은 리뷰 몇 개(그 별점으로 볼 때 대표 리뷰)
    t.refsByStar = [1, 2, 3, 4, 5].map((s) => rs.filter((r) => r.rating === s).sort((a, b) => b.likes - a.likes).slice(0, 4).map((r) => r.n));
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

// AI가 쓴 묶음 이름·기준이 어떤 리뷰와 공백 빼고 12자 넘게 겹치면 가린다 (리뷰 원문이 그대로 실리지 않게)
export function scrubber(w, report) {
  const G = 12, norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const r of w.sample || []) { const t = norm(r.content); for (let i = 0; i + G <= t.length; i++) grams.add(t.slice(i, i + G)); }
  return (s) => { const t = norm(s); for (let i = 0; i + G <= t.length; i++) if (grams.has(t.slice(i, i + G))) { report.scrubbed++; return null; } return s; };
}
