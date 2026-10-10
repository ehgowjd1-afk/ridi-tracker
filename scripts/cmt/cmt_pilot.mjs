/* 회차 댓글 분석 — 시범 실행 (작품 1~2개, 최근 10화)
 *
 * ① 수집: 작품의 전 회차 댓글을 받아 회차별 댓글 수(공개 후 24시간·72시간·7일)를 센다. 아이디·회원번호는 버린다.
 * ② 고르기: 최근 N화마다 '좋아요 상위 30 + 나머지 무작위 70'(설정값)을 분류 대상으로.
 * ③ 1단계 AI(Haiku, 일괄): 댓글마다 분류 칸을 붙인다.
 * ④ 숫자 판정: [터짐][대박][논쟁][이탈 경고][니즈 누적][니즈 폭발] + 외부 요인(휴재 복귀·동시 공개·이벤트).
 * ⑤ 2단계 AI(Sonnet, 일괄): 작품마다 화별 반응 요약과 니즈 맵.
 * ⑥ 결과 파일: 숫자·분류·요약만(댓글 원문 없음 — 근거는 댓글 번호). 이 달 AI 사용액은 state/ai_state.json 에 더한다.
 *
 *   node scripts/cmt/cmt_pilot.mjs --ids 5163001179,5103000637 --eps 10 --out cmt_pilot_out.json
 *        [--limit-usd 30] [--cap-usd 2] [--wait-min 45] [--collect-only] [--resume-haiku ID] [--resume-sonnet ID] [--summary FILE]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { fetchSeries, fetchComments, RidiBlocked } from "./ridi_comments.mjs";
import * as R from "./ridi_comments.mjs";
import { CFG } from "./cmt_config.mjs";
import * as AI from "./cmt_ai.mjs";
import { judge } from "./cmt_judge.mjs";

const STATE = "state/ai_state.json";
const HAIKU = { model: "claude-haiku-5-5", effort: "medium" };
const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_PER_COMMENT = 0.00012;   // 1단계: 댓글 1개당 예상(일괄, 여유 있게)
const EST_PER_WORK = 0.3;          // 2단계: 작품 1개당 예상(Sonnet 일괄, 여유 있게)

// ---- 명령줄 ----
const args = { ids: [], eps: 10, limitUsd: 30, capUsd: 2, waitMin: 45, out: "cmt_pilot_out.json", collectOnly: false, resumeHaiku: null, resumeSonnet: null, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--ids") args.ids = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--eps") args.eps = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--collect-only") args.collectOnly = true;
  else if (k === "--resume-haiku") args.resumeHaiku = v() || null;
  else if (k === "--resume-sonnet") args.resumeSonnet = v() || null;
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["eps", "limitUsd", "capUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (!args.ids.length || args.ids.length > 3 || args.ids.some((x) => !/^\d{5,12}$/.test(x))) throw new Error("--ids 에 작품 번호 1~3개를 쉼표로 넣어 주세요");
for (const k of ["resumeHaiku", "resumeSonnet"]) if (args[k] && !/^msgbatch_[A-Za-z0-9]+$/.test(args[k])) throw new Error(k + " 형식이 이상합니다");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;
const MONTH = new Date(Date.now() + 9 * HOUR).toISOString().slice(0, 7);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const log = (...a) => console.log(...a);

// ---- 작품 정보(제목·웹툰·BL)는 트래커가 모은 순위 파일에서 ----
function workInfo(id) {
  let latest = {};
  try { latest = JSON.parse(readFileSync("docs/data/latest.json", "utf8")); } catch (e) {}
  const rk = latest.rankings || {};
  const inCat = (codes) => Object.entries(rk).some(([k, v]) => codes.includes(k.split("-")[0]) && (v.ids || []).includes(id));
  const b = (latest.books || {})[id] || {};
  return { title: b.title || b.t || id, webtoon: inCat(["1600", "4250"]), bl: inCat(["4250", "4150"]) };
}

// 순위 파일의 이벤트 중 이 작품 이름이 들어간 것 (트래커가 2026-08-22부터 모음)
function loadEvents() {
  const dir = "docs/data/events", seen = new Map();
  if (!existsSync(dir)) return [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try { for (const e of JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).events || []) seen.set(e.id, e); } catch (e) {}
  }
  return [...seen.values()];
}
const coreTitle = (t) => String(t).replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();

// 같은 씨앗이면 늘 같은 순서로 섞기 (다시 돌려도 같은 표본)
function shuffle(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------- ① 수집 + 회차 숫자 ----------------
async function collect(id, events) {
  const info = workInfo(id);
  const s = await fetchSeries(id);
  log(`■ ${info.title} (${id}) — 회차 ${s.episodes.length}개`);
  const now = Date.now();
  for (const e of s.episodes) {
    const { comments, complete } = await fetchComments(e.id);
    const reg = Date.parse(e.reg);
    const within = (h) => (complete ? comments.filter((c) => Date.parse(c.at) - reg <= h * HOUR).length : null);
    Object.assign(e, {
      n: comments.length, complete, age_h: Math.round((now - reg) / HOUR),
      c24: within(CFG.shortH), c72: within(CFG.windowH), c7d: within(168),
      likes: comments.reduce((t, c) => t + c.like, 0)
    });
    e._c = comments;
  }
  // 기준선: 직전 baseEps화의 같은 시점 댓글 수 (72시간이 안 지났으면 24시간끼리)
  //  - 평균 대신 중앙값(CFG.baseStat): 대박 회차 하나가 기준을 부풀려 바로 뒤 회차가 '이탈'로 찍히는 일을 막는다
  //  - 앞 회차와 함께 한꺼번에 공개된 회차는 1화 쏠림 때문에 비교하지 않는다 ('여러 화 동시 공개'로만 표시)
  const num = s.episodes.filter((e) => e.no != null);
  const mid = (a) => { const b = [...a].sort((x, y) => x - y), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; };
  num.forEach((e, i) => {
    e.batch = i > 0 && Date.parse(e.reg) - Date.parse(num[i - 1].reg) <= HOUR;
    const key = e.age_h >= CFG.windowH ? "c72" : e.age_h >= CFG.shortH ? "c24" : null;
    e.win = key ? (key === "c72" ? CFG.windowH : CFG.shortH) : null;
    e.base = e.ratio = null;
    if (!key || e.batch || e[key] == null) return;
    const prev = num.slice(Math.max(0, i - CFG.baseEps), i).map((p) => p[key]).filter((v) => v != null);
    if (prev.length < 2) return;
    e.base = Math.round((CFG.baseStat === "mean" ? avg(prev) : mid(prev)) * 10) / 10;
    e.ratio = e.base > 0 ? Math.round((e[key] / e.base) * 100) / 100 : null;
  });
  // 외부 요인 (지금 무료 여부는 오늘 기준이라 과거 회차 판정엔 쓰지 않음 — freeNow 로만 남김)
  const gaps = num.slice(1).map((e, i) => Date.parse(e.reg) - Date.parse(num[i].reg)).filter((g) => g > HOUR);
  const medGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  const core = coreTitle(info.title);
  num.forEach((e, i) => {
    e.ext = [];
    if (e.batch) e.ext.push("여러 화 동시 공개");
    else if (i > 0 && medGap) {
      const g = Date.parse(e.reg) - Date.parse(num[i - 1].reg);
      if (g >= CFG.hiatusX * medGap) e.ext.push(`휴재 후 복귀(${Math.round(g / 86400e3)}일 만)`);
    }
    const t0 = Date.parse(e.reg), t1 = t0 + CFG.windowH * HOUR;
    const evs = events.filter((ev) => core && (String(ev.title) + " " + String(ev.description || "")).includes(core) &&
      Date.parse(ev.start_date) <= t1 && Date.parse(ev.end_date) >= t0).map((ev) => ev.title);
    for (const t of [...new Set(evs)].slice(0, 2)) e.ext.push("이벤트: " + t);
  });
  return { id, ...info, desc: s.desc, episodes: s.episodes };
}

// ---------------- ② 분류 대상 고르기 ----------------
function pickSample(work) {
  const num = work.episodes.filter((e) => e.no != null);
  const targets = num.slice(-args.eps);
  let n = 0;
  work.sample = [];
  for (const e of targets) {
    e.analyzed = true;
    const vis = e._c.filter((c) => !c.hidden && c.text.trim());
    const byLike = [...vis].sort((a, b) => b.like - a.like || a.cid - b.cid);
    const top = byLike.slice(0, CFG.topLiked).map((c) => ({ ...c, pick: "top" }));
    const rnd = shuffle(byLike.slice(CFG.topLiked), Number(e.id)).slice(0, CFG.randomRest).map((c) => ({ ...c, pick: "rand" }));
    for (const c of [...top, ...rnd]) work.sample.push({ ...c, n: ++n, ep: e.id, no: e.no });
  }
}

// ---------------- 일괄 처리 도우미 ----------------
let client = null;
async function sdk() {
  if (!client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
  return client;
}
class Waiting extends Error { constructor(id) { super("일괄 처리가 아직 끝나지 않음: " + id); this.batchId = id; } }

async function runBatch(label, requests, resumeId) {
  const c = await sdk();
  let b;
  if (resumeId) b = await c.messages.batches.retrieve(resumeId);
  else {
    try { b = await c.messages.batches.create({ requests }, { maxRetries: 0 }); }
    catch (e) { throw new Error(`${label} 일괄을 만들지 못했습니다: ${e.message} — 콘솔(Batches)에서 생겼는지 확인 필요`); }
  }
  log(`  ${label} 일괄 ${b.id} (${requests ? requests.length : "?"}건)`);
  const t0 = Date.now();
  while (b.processing_status !== "ended") {
    if (Date.now() - t0 > args.waitMin * 60e3) throw new Waiting(b.id);
    await sleep(30000);
    b = await c.messages.batches.retrieve(b.id);
    log(`  … 처리 중 ${b.request_counts.processing} / 완료 ${b.request_counts.succeeded}`);
  }
  const out = new Map();
  for await (const r of await c.messages.batches.results(b.id)) out.set(r.custom_id, r.result);
  return { id: b.id, out };
}

const PRICE = { "claude-haiku-5-5": { in: 0.10, out: 0.50 }, "claude-sonnet-5-5": { in: 2, out: 10 } };
function costOf(model, u) {   // 일괄이라 반값
  const p = PRICE[model];
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.in * 0.1 +
    (u.cache_creation_input_tokens || 0) * p.in * 1.25) / 1e6 / 2;
}

// ---------------- ③ 1단계: 댓글 분류 ----------------
function classifyRequests(works) {
  const reqs = [];
  works.forEach((w, wi) => {
    for (const e of w.episodes.filter((x) => x.analyzed)) {
      const cs = w.sample.filter((c) => c.ep === e.id);
      for (let k = 0; k < cs.length; k += CFG.chunk) {
        reqs.push({ custom_id: `h-${wi}-${e.id}-${k / CFG.chunk}`, params: AI.buildClassifyParams(HAIKU, w, e, cs.slice(k, k + CFG.chunk), CFG.textMax) });
      }
    }
  });
  return reqs;
}

function applyLabels(works, out) {
  let usd = 0, failed = 0;
  for (const [cid, res] of out) {
    const [, wi] = cid.split("-");
    const w = works[Number(wi)];
    if (!w || res.type !== "succeeded") { failed++; continue; }
    usd += costOf(HAIKU.model, res.message.usage || {});
    let parsed;
    try { parsed = AI.parseJson(res.message); } catch (e) { failed++; continue; }
    const byN = new Map(w.sample.map((c) => [c.n, c]));
    for (const it of parsed.comments || []) {
      const c = byN.get(it.n);
      if (!c) continue;
      c.lab = { ty: it.ty, ax: it.ax, nd: [...new Set(it.nd || [])].slice(0, 3), st: it.st, ev: it.ev, tg: it.tg, ac: it.ac, rd: it.rd,
        sg: Number(it.sg), ch: (it.ch || []).slice(0, 5).map((s) => String(s).slice(0, 20)), sc: String(it.sc || "").slice(0, 40),
        nn: String(it.nn || "").slice(0, 20), cf: it.cf };
    }
  }
  return { usd, failed };
}

// ---------------- ④ 숫자 판정: cmt_judge.mjs ----------------

// ---------------- ⑤ 2단계: 작품 종합 ----------------
const L = (o, k) => o[k] || k;
function workText(w, perEp = CFG.synthPerEp) {
  const num = w.episodes.filter((e) => e.no != null);
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.bl ? " / BL" : ""}`, `[작품 소개] ${w.desc || "-"}`, "",
    `[회차별 댓글 수] (같은 시점 비교: 공개 후 ${CFG.windowH}시간, 기준선 = 직전 ${CFG.baseEps}화 ${CFG.baseStat === "mean" ? "평균" : "중앙값"})`];
  for (const e of num) {
    lines.push(`${e.no}화 ${String(e.reg).slice(0, 10)}: ${CFG.windowH}h ${e.c72 ?? "-"} / 24h ${e.c24 ?? "-"} / 전체 ${e.n}` +
      (e.ratio != null ? ` / 기준선 대비 ${e.ratio}배(${e.win}h)` : "") + (e.flags.length ? ` / 표시: ${e.flags.join(",")}` : "") +
      (e.ext.length ? ` / 외부 요인: ${e.ext.join(",")}` : ""));
  }
  lines.push("", "[분석한 회차]");
  for (const e of num.filter((x) => x.analyzed && x.ai)) {
    const fmt = (o, lab) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${L(lab, k)} ${v}`).join(", ");
    lines.push(`${e.no}화: 분류 ${e.ai.n}개 · 유형 ${fmt(e.ai.ty, AI.TYPES)} · 축 ${fmt(e.ai.ax, AI.AXES)} · 이탈 ${e.ai.churn} 결제 ${e.ai.pay} 기다림 ${e.ai.stay} 추천 ${e.ai.share} · 장기독자 ${e.ai.long}` +
      (e.needRun ? ` · 누적 니즈 ${e.needRun.map((d) => AI.NEEDS[d]).join(",")}` : "") + (e.needBurst ? ` · 폭발 니즈 ${e.needBurst.map((d) => AI.NEEDS[d]).join(",")}` : ""));
  }
  lines.push("", "[니즈 통계] (충족/결핍/요구/갈림 · 관련 댓글 좋아요 합 · 나온 회차 · 결제 신호 · 첫 폭발 전 쌓인 요구·결핍 · 폭발 회차의 댓글 배수)");
  for (const [d, s] of Object.entries(w.needStats).sort((a, b) => (b[1].met + b[1].lack + b[1].ask) - (a[1].met + a[1].lack + a[1].ask))) {
    lines.push(`${AI.NEEDS[d]}(${AI.AXES[AI.NEED_AXIS(d)]}): ${s.met}/${s.lack}/${s.ask}/${s.split} · 좋아요 ${s.likes} · ${s.eps.join(",")}화 · 결제 ${s.pay} · 쌓인 요구 ${s.askBeforeBurst} · 배수 ${s.burstRatios.join(",") || "-"}`);
  }
  const nn = Object.entries(w.newNeeds).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  if (nn.length) lines.push("", "[신규 니즈 후보] " + nn.map(([k, v]) => `${k} ${v.count}개(좋아요 ${v.likes}, ${v.eps.join(",")}화)`).join(" / "));
  lines.push("", `[댓글] 회차마다 대표 댓글(좋아요 상위 ${CFG.synthTop} + 니즈·행동 신호가 있는 댓글, 최대 ${CFG.synthPerEp}개). 단순반응·작품 외 이슈는 생략.`,
    "번호 [좋아요] 유형/축/상태/니즈/평가/대상/행동/독자 | 장면 메모 | 본문");
  for (const e of num.filter((x) => x.analyzed)) {
    lines.push(`== ${e.no}화 ==`);
    const rich = w.sample.filter((x) => x.ep === e.id && x.lab && !["simple", "offtopic"].includes(x.lab.ty)).sort((a, b) => b.like - a.like);
    const top = rich.slice(0, Math.min(CFG.synthTop, perEp));
    const sig = rich.slice(CFG.synthTop).filter((c) => c.lab.nd.length || c.lab.nn || ["pay", "churn", "share"].includes(c.lab.ac));
    const chosen = [...top, ...sig].slice(0, perEp).sort((a, b) => a.n - b.n);
    for (const c of chosen) {
      const b = c.lab;
      lines.push(`#${c.n} [${c.like}] ${L(AI.TYPES, b.ty)}/${L(AI.AXES, b.ax)}/${L(AI.STATES, b.st)}/${b.nd.map((d) => AI.NEEDS[d]).join(",") || "-"}/${L(AI.EVALS, b.ev)}/${L(AI.TARGETS, b.tg)}/${L(AI.ACTIONS, b.ac)}/${L(AI.READERS, b.rd)}` +
        (b.nn ? `/신규:${b.nn}` : "") + ` | ${b.sc || "-"} | ${c.text.trim().replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

function cleanSynth(w, s) {
  const valid = new Set(w.sample.filter((c) => c.lab).map((c) => c.n));
  const refs = (r) => [...new Set((r || []).filter((n) => valid.has(n)))].slice(0, 12);
  const keep = (arr) => (arr || []).map((x) => ({ ...x, refs: refs(x.refs) })).filter((x) => x.refs.length);
  return {
    headline: s.headline,
    episodes: (s.episodes || []).map((e) => ({ ...e, scenes: keep(e.scenes) })),
    needs: keep(s.needs), likes: keep(s.likes).slice(0, 5), dislikes: keep(s.dislikes).slice(0, 5),
    unfilled: keep(s.unfilled), newNeeds: keep(s.newNeeds), sayDo: s.sayDo || ""
  };
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { generated_at: new Date().toISOString(), cfg: CFG, models: { haiku: HAIKU, sonnet: SONNET }, cost: { haiku: 0, sonnet: 0 }, batches: {}, notes: [] };
let works = [];
function save() {
  report.requests = R.requests;
  report.works = works.map((w) => ({
    id: w.id, title: w.title, webtoon: w.webtoon, bl: w.bl,
    episodes: w.episodes.map(({ _c, ...e }) => e),
    // 원문(text)은 넣지 않는다 — 번호·시각·좋아요·분류만
    comments: (w.sample || []).map(({ text, hidden, ...c }) => c),
    needStats: w.needStats || {}, newNeeds: w.newNeeds || {}, synth: w.synth || null
  }));
  writeFileSync(args.out, JSON.stringify(report));
}
function charge(usd, label) {
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}

try {
  const events = loadEvents();
  for (const id of args.ids) works.push(await collect(id, events));
  for (const w of works) pickSample(w);
  log(`수집 끝: 요청 ${R.requests}번, 분류 대상 ${works.reduce((t, w) => t + w.sample.length, 0)}개`);
  if (args.collectOnly) { for (const w of works) judge(w); save(); log("수집만 하고 끝냅니다 (--collect-only)"); process.exit(0); }

  // 돈 확인
  const nC = works.reduce((t, w) => t + w.sample.length, 0);
  const est = nC * EST_PER_COMMENT + works.length * EST_PER_WORK;
  const { inFlightUsd } = await import("../ai/review_ai.mjs");
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);
  log(`예상 비용 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용·처리 중 $${spent.toFixed(2)} (한도 $${args.limitUsd})`);
  if (!args.resumeHaiku && est > args.capUsd) throw new Error("예상 비용이 시범 상한을 넘어 보내지 않습니다");
  if (!args.resumeHaiku && spent + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");

  // ③ 1단계
  let h;
  try { h = await runBatch("1단계(Haiku) 분류", args.resumeHaiku ? null : classifyRequests(works), args.resumeHaiku); }
  catch (e) {
    if (e instanceof Waiting) { charge(nC * EST_PER_COMMENT, "1단계 미완료(예상치로 미리 셈)"); report.batches.haiku = e.batchId; report.notes.push(e.message); }
    throw e;
  }
  report.batches.haiku = h.id;
  const a = applyLabels(works, h.out);
  report.cost.haiku = a.usd;
  charge(a.usd, "1단계");
  if (a.failed) report.notes.push(`1단계 실패한 묶음 ${a.failed}개`);
  for (const w of works) judge(w);
  save();

  // ⑤ 2단계
  let s;
  // 자료가 너무 길면(글자 수 상한) 회차당 대표 댓글 수를 줄여 다시 만든다 — 긴 요청은 단가가 올라감
  const fitText = (w) => { let per = CFG.synthPerEp, t = workText(w, per); while (t.length > CFG.synthMaxChars && per > 10) { per = Math.floor(per * 0.8); t = workText(w, per); } return t; };
  const sreq = works.map((w, wi) => ({ custom_id: `s-${wi}`, params: AI.buildWorkParams(SONNET, fitText(w)) }));
  sreq.forEach((r, i) => log(`  2단계 자료: ${works[i].title} ${r.params.messages[0].content.length.toLocaleString()}자`));
  try { s = await runBatch("2단계(Sonnet) 종합", args.resumeSonnet ? null : sreq, args.resumeSonnet); }
  catch (e) {
    if (e instanceof Waiting) { charge(works.length * EST_PER_WORK, "2단계 미완료(예상치로 미리 셈)"); report.batches.sonnet = e.batchId; report.notes.push(e.message); }
    throw e;
  }
  report.batches.sonnet = s.id;
  let su = 0;
  for (const [cid, res] of s.out) {
    const w = works[Number(cid.split("-")[1])];
    if (res.type !== "succeeded") { report.notes.push(`2단계 실패: ${w.title} (${res.type})`); continue; }
    su += costOf(SONNET.model, res.message.usage || {});
    try { w.synth = cleanSynth(w, AI.parseJson(res.message)); } catch (e) { report.notes.push(`2단계 해석 실패: ${w.title} ${e.message}`); }
  }
  report.cost.sonnet = su;
  charge(su, "2단계");
} catch (e) {
  report.error = e instanceof RidiBlocked ? "리디가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  save();
  const usd = report.cost.haiku + report.cost.sonnet;
  const lines = [`## 회차 댓글 분석 시범`, `- 작품: ${works.map((w) => w.title).join(", ")}`, `- 리디 요청 ${R.requests}번`,
    `- 분류한 댓글 ${works.reduce((t, w) => t + (w.sample || []).filter((c) => c.lab).length, 0)}개`,
    `- AI 비용 $${usd.toFixed(3)} (분류 $${report.cost.haiku.toFixed(3)} + 종합 $${report.cost.sonnet.toFixed(3)}) / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
