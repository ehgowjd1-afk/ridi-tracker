/* 회차 댓글 분석 — 시범 실행 (작품 1~3개, 최근 N화) · 2판 '반복되는 반응을 있는 그대로 세기'
 *
 * ① 수집: 작품의 전 회차 댓글을 받아 회차별 댓글 수(공개 후 24시간·72시간·7일)를 센다. 아이디·회원번호는 버린다.
 * ② 고르기: 최근 N화마다 '좋아요 상위 30 + 나머지 무작위 70'(설정값)을 분석 대상으로.
 * ③ 1단계 AI(Sonnet, 일괄): 작품마다 '반복되는 반응' 묶음(좋다는 말 / 많이 하는 말 / 불호)을 정한다.
 * ④ 2단계 AI(Haiku, 일괄): 댓글마다 해당 묶음 + 속뜻 + 직접 드러난 니즈를 표시한다. 개수·좋아요·회차는 프로그램이 센다.
 * ⑤ 숫자 판정: [터짐][대박][논쟁][댓글 급증][이탈 경고] + 외부 요인(휴재 복귀·동시 공개·이벤트).
 * ⑥ 3단계 AI(Sonnet, 일괄): 참고용 니즈 맵.
 * ⑦ 결과 파일: 숫자·표시·묶음만(댓글 원문 없음 — 근거는 댓글 번호). 이 달 AI 사용액은 state/ai_state.json 에 더한다.
 *
 *   node scripts/cmt/cmt_pilot.mjs --ids 5163001179,5103000637 --eps 10 --out cmt_pilot_out.json
 *        [--limit-usd 30] [--cap-usd 2] [--wait-min 100] [--collect-only] [--summary FILE]
 *   이어받기는 없다: 다시 돌리면 댓글을 새로 모아 표본이 바뀌므로, 지난 AI 결과를 붙이면 엉뚱한 댓글에 붙는다.
 *   돈: AI 일괄을 보내는 즉시 예상 비용을 이 달 사용액에 먼저 더하고, 결과를 받으면 실제 금액으로 맞춘다
 *       (중간에 끊겨도 보낸 일괄은 예상치로 남아 한도 계산에서 빠지지 않음).
 *   CMT_MOCK=1 이면 AI 대신 가짜 답으로 끝까지 돌려 본다 (돈 안 듦, 시험용).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { fetchSeries, fetchComments, RidiBlocked, cut } from "./ridi_comments.mjs";
import * as R from "./ridi_comments.mjs";
import { CFG } from "./cmt_config.mjs";
import * as AI from "./cmt_ai.mjs";
import { judge } from "./cmt_judge.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const STATE = "state/ai_state.json";
const HAIKU = { model: "claude-haiku-5-5", effort: "medium" };
const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_PER_COMMENT = 0.0001;   // 2단계: 댓글 1개당 예상(일괄, 여유 있게)
const EST_THEME_WORK = 0.15;      // 1단계: 작품 1개당 예상(Sonnet 일괄)
const EST_NEEDS_WORK = 0.15;      // 3단계: 작품 1개당 예상(Sonnet 일괄)
const MOCK = !!process.env.CMT_MOCK;

// ---- 명령줄 ----
const args = { ids: [], eps: 10, limitUsd: 30, capUsd: 2, waitMin: 100, out: "cmt_pilot_out.json", collectOnly: false, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--ids") args.ids = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--eps") args.eps = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--collect-only") args.collectOnly = true;
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["eps", "limitUsd", "capUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (!args.ids.length || args.ids.length > 3 || args.ids.some((x) => !/^\d{5,12}$/.test(x))) throw new Error("--ids 에 작품 번호 1~3개를 쉼표로 넣어 주세요");
const T_START = Date.now();   // 기다림 상한(--wait-min)은 실행 시작부터 잰다 — 단계 시간 제한보다 먼저 정상적으로 끝나게

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

// ---------------- 일괄 처리: batch.mjs ----------------
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));

// 시험용 가짜 답 (CMT_MOCK=1): 요청 내용에서 번호를 읽어 그럴듯한 JSON을 만든다
function mockAnswer(customId, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  if (customId.startsWith("t-")) return { themes: [
    { bucket: "like", label: "작화가 화보 같다", def: "작화·그림 칭찬", refs: ns.slice(0, 3) },
    { bucket: "talk", label: "다음 화 기다림·휴재 아쉬움", def: "기다림·휴재", refs: ns.slice(3, 5) },
    { bucket: "talk", label: "남주에게 화내기", def: "인물 타박", refs: ns.slice(5, 7) },
    { bucket: "dislike", label: "그림체가 달라 보인다", def: "작화 일관성 진지한 지적", refs: ns.slice(7, 9) }] };
  if (customId.startsWith("h-")) return { comments: ns.map((n, i) => ({ n, th: [["T1"], ["T2"], ["T3"], ["T4"], [], ["T1", "T9"]][i % 6],
    tn: ["praise", "miss", "char", "critic", "other", "tease"][i % 6], nd: i % 3 ? [] : ["rom_progress"], st: i % 3 ? "none" : "met", nn: i % 7 ? "" : "수위·씬",
    ac: ["none", "stay", "churn", "pay"][i % 4], cf: ["hi", "mid", "lo"][i % 3] })) };
  return { needs: [{ axis: "romance", need: "관계 진전", state: "met", evidence: "가짜", size: "중", why: "가짜", refs: ns.slice(0, 3).concat([999999]) }] };
}
const clip = (t, n) => cut(t.trim().replace(/\s+/g, " "), n);

// ---------------- ③ 1단계: 반복되는 반응 찾기 ----------------
// 표본: 회차마다 좋아요 상위 themeTop개 + 나머지에서 고르게 themeRest개
function themeText(w, perTop = CFG.themeTop, perRest = CFG.themeRest) {
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.bl ? " / BL" : ""}`, `[작품 소개] ${w.desc || "-"}`, "",
    `[댓글 표본] 최근 ${w.episodes.filter((e) => e.analyzed).length}화, 회차마다 좋아요 많은 댓글 ${perTop}개 + 그 밖의 댓글 ${perRest}개. 번호 [좋아요] 본문`];
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    const cs = w.sample.filter((c) => c.ep === e.id);
    const top = cs.filter((c) => c.pick === "top").slice(0, perTop);
    const rest = cs.filter((c) => c.pick !== "top");
    const step = Math.max(1, Math.floor(rest.length / Math.max(1, perRest)));
    const more = rest.filter((_, i) => i % step === 0).slice(0, perRest);
    lines.push(`== ${e.no}화 (${String(e.reg).slice(0, 10)}) ==`);
    for (const c of [...top, ...more]) lines.push(`#${c.n} [${c.like}] ${clip(c.text, CFG.themeTextMax)}`);
  }
  return lines.join("\n");
}
function themeRequests(works) {
  return works.map((w, wi) => {
    let top = CFG.themeTop, rest = CFG.themeRest, t = themeText(w, top, rest);
    while (t.length > CFG.synthMaxChars && top + rest > 12) { top = Math.ceil(top * 0.8); rest = Math.floor(rest * 0.8); t = themeText(w, top, rest); }
    log(`  1단계 자료: ${w.title} ${t.length.toLocaleString()}자`);
    return { custom_id: `t-${wi}`, params: AI.buildThemeParams(SONNET, t) };
  });
}
function applyThemes(works, out) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`1단계 실패: ${w ? w.title : cid} (${res.type})`); continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.map((c) => c.n));
      w.themes = (AI.parseJson(res.message).themes || []).slice(0, CFG.themeMax).map((t, i) => ({
        id: "T" + (i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
        seed: [...new Set((t.refs || []).filter((n) => valid.has(n)))].slice(0, 5)
      }));
    } catch (e) { report.notes.push(`1단계 해석 실패: ${w.title} ${e.message}`); }
  }
  return usd;
}

// ---------------- ④ 2단계: 댓글마다 표시 ----------------
function classifyRequests(works) {
  const reqs = [];
  works.forEach((w, wi) => {
    if (!w.themes || !w.themes.length) return;
    for (const e of w.episodes.filter((x) => x.analyzed)) {
      const cs = w.sample.filter((c) => c.ep === e.id);
      for (let k = 0; k < cs.length; k += CFG.chunk) {
        reqs.push({ custom_id: `h-${wi}-${e.id}-${k / CFG.chunk}`, params: AI.buildClassifyParams(HAIKU, w, e, cs.slice(k, k + CFG.chunk), CFG.textMax, w.themes) });
      }
    }
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
    try { parsed = AI.parseJson(res.message); } catch (e) { failed++; continue; }
    const byN = new Map(w.sample.map((c) => [c.n, c]));
    const themeOf = new Map((w.themes || []).map((t) => [t.id, t]));
    for (const it of parsed.comments || []) {
      const c = byN.get(it.n);
      if (!c) continue;
      const b = { th: [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 2),
        tn: it.tn, nd: [...new Set(it.nd || [])].slice(0, 3), st: it.st, nn: cut(it.nn, 20), ac: it.ac, cf: it.cf };
      // 속뜻과 맞추기: 과몰입·애정 투정·연재 아쉬움엔 이탈 신호 없음, 연재 아쉬움엔 서사 니즈 없음
      if (["char", "tease", "miss", "nudge"].includes(b.tn) && b.ac === "churn") b.ac = "none";
      if (b.tn === "miss") b.nd = [];
      if (!b.nd.length && !b.nn) b.st = "none";
      // '불호' 묶음엔 확신 있는 진짜 작품 불만(critic)만 — 겉말 불평(과몰입·투정·아쉬움·애정 섞인 지적)이 불호로 세지지 않게
      const before = b.th.length;
      b.th = b.th.filter((id) => themeOf.get(id).bucket !== "dislike" || (b.tn === "critic" && b.cf !== "lo"));
      if (b.th.length < before) report.dropped++;
      c.lab = b;
    }
  }
  return { usd, failed };
}

// 묶음별 개수·좋아요·회차 (분석한 댓글 안에서 센다)
function themeStats(w) {
  const an = w.episodes.filter((e) => e.analyzed);
  for (const t of w.themes || []) {
    const cs = w.sample.filter((c) => c.lab && c.lab.th.includes(t.id));
    t.count = cs.length;
    t.likes = cs.reduce((s, c) => s + c.like, 0);
    t.eps = {};
    for (const c of cs) t.eps[c.no] = (t.eps[c.no] || 0) + 1;
    t.refs = [...cs].sort((a, b) => b.like - a.like).slice(0, CFG.themeRefs).map((c) => c.n);
    t.tones = cs.reduce((o, c) => ((o[c.lab.tn] = (o[c.lab.tn] || 0) + 1), o), {});
  }
  for (const e of an) {
    e.topThemes = (w.themes || []).map((t) => ({ id: t.id, n: t.eps[e.no] || 0 })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
  }
  w.untagged = w.sample.filter((c) => c.lab && !c.lab.th.length).length;
}

// ---------------- ⑥ 3단계: 참고용 니즈 맵 ----------------
const L = (o, k) => o[k] || k;
function needsText(w, perEp = CFG.needsPerEp) {
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.bl ? " / BL" : ""}`, `[작품 소개] ${w.desc || "-"}`, "",
    `[회차별 댓글 수] (공개 후 ${CFG.windowH}시간 기준, 기준선 = 직전 ${CFG.baseEps}화 ${CFG.baseStat === "mean" ? "평균" : "중앙값"})`];
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    lines.push(`${e.no}화: ${CFG.windowH}h ${e.c72 ?? "-"} / 기준선 대비 ${e.ratio ?? "-"}배` + (e.flags.length ? ` / ${e.flags.join(",")}` : "") +
      (e.ai ? ` / 속뜻 ${Object.entries(e.ai.tn || {}).map(([k, v]) => `${L(AI.TONES, k)} ${v}`).join(", ")} / 결제 ${e.ai.pay}` : ""));
  }
  lines.push("", "[반복되는 반응]");
  for (const t of w.themes || []) lines.push(`${t.id} (${AI.BUCKETS[t.bucket]}) ${t.label}: ${t.count}개, 좋아요 ${t.likes}`);
  lines.push("", "[니즈 통계] (충족/결핍/요구/갈림 · 관련 댓글 좋아요 합 · 나온 회차 · 결제 신호)");
  for (const [d, s] of Object.entries(w.needStats || {}).sort((a, b) => (b[1].met + b[1].lack + b[1].ask) - (a[1].met + a[1].lack + a[1].ask))) {
    lines.push(`${AI.NEEDS[d]}(${AI.AXES[AI.NEED_AXIS(d)]}): ${s.met}/${s.lack}/${s.ask}/${s.split} · 좋아요 ${s.likes} · ${s.eps.join(",")}화 · 결제 ${s.pay}`);
  }
  const nn = Object.entries(w.newNeeds || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  if (nn.length) lines.push("", "[목록에 없는 바람] " + nn.map(([k, v]) => `${k} ${v.count}개(좋아요 ${v.likes}, ${v.eps.join(",")}화)`).join(" / "));
  lines.push("", "[니즈가 표시된 댓글] 번호 [좋아요] 속뜻/상태/니즈/신규 | 본문");
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    const cs = w.sample.filter((c) => c.ep === e.id && c.lab && (c.lab.nd.length || c.lab.nn)).sort((a, b) => b.like - a.like).slice(0, perEp).sort((a, b) => a.n - b.n);
    if (!cs.length) continue;
    lines.push(`== ${e.no}화 ==`);
    for (const c of cs) {
      const b = c.lab;
      lines.push(`#${c.n} [${c.like}] ${L(AI.TONES, b.tn)}/${L(AI.STATES, b.st)}/${b.nd.map((d) => AI.NEEDS[d]).join(",") || "-"}${b.nn ? "/신규:" + b.nn : ""} | ${clip(c.text, 120)}`);
    }
  }
  return lines.join("\n");
}
function needsRequests(works) {
  return works.map((w, wi) => {
    if (!w.sample.some((c) => c.lab)) return null;
    let per = CFG.needsPerEp, t = needsText(w, per);
    while (t.length > CFG.synthMaxChars && per > 8) { per = Math.floor(per * 0.8); t = needsText(w, per); }
    log(`  3단계 자료: ${w.title} ${t.length.toLocaleString()}자`);
    return { custom_id: `s-${wi}`, params: AI.buildNeedsParams(SONNET, t) };
  }).filter(Boolean);
}
function applyNeeds(works, out) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`3단계 실패: ${w ? w.title : cid} (${res.type})`); continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.filter((c) => c.lab).map((c) => c.n));
      w.needsMap = (AI.parseJson(res.message).needs || [])
        .map((x) => ({ ...x, refs: [...new Set((x.refs || []).filter((n) => valid.has(n)))].slice(0, 8) })).filter((x) => x.refs.length);
    } catch (e) { report.notes.push(`3단계 해석 실패: ${w.title} ${e.message}`); }
  }
  return usd;
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { version: 2, generated_at: new Date().toISOString(), cfg: CFG, models: { haiku: HAIKU, sonnet: SONNET },
  cost: { theme: 0, haiku: 0, needs: 0 }, batches: {}, notes: [], dropped: 0, scrubbed: 0 };
let works = [];
// 공개되는 결과에 댓글 원문이 그대로 실리지 않게: AI가 쓴 글(묶음 이름·기준·니즈 근거)이 어떤 댓글과 공백 빼고 12자 넘게 겹치면 가린다
const GRAM = 12;
function scrubber(w) {
  const norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const c of w.sample || []) { const t = norm(c.text); for (let i = 0; i + GRAM <= t.length; i++) grams.add(t.slice(i, i + GRAM)); }
  return (s) => {
    const t = norm(s);
    for (let i = 0; i + GRAM <= t.length; i++) if (grams.has(t.slice(i, i + GRAM))) { report.scrubbed++; return "(댓글 원문과 겹쳐 가림)"; }
    return s;
  };
}
function save() {
  report.requests = R.requests;
  report.scrubbed = 0;
  report.works = works.map((w) => {
    const sc = scrubber(w);
    return {
    id: w.id, title: w.title, webtoon: w.webtoon, bl: w.bl,
    episodes: w.episodes.map(({ _c, ...e }) => e),
    themes: (w.themes || []).map((t) => ({ ...t, label: sc(t.label), def: sc(t.def) })), untagged: w.untagged ?? null,
    // 원문(text)은 넣지 않는다 — 번호·시각·좋아요·표시만
    comments: (w.sample || []).map(({ text, hidden, ...c }) => c),
    needStats: w.needStats || {}, newNeeds: Object.fromEntries(Object.entries(w.newNeeds || {}).map(([k, v]) => [sc(k), v])),
    needsMap: w.needsMap ? w.needsMap.map((x) => ({ ...x, need: sc(x.need), evidence: sc(x.evidence), why: sc(x.why) })) : null
    };
  });
  writeFileSync(args.out, JSON.stringify(report));
}
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

try {
  const events = loadEvents();
  for (const id of args.ids) works.push(await collect(id, events));
  for (const w of works) pickSample(w);
  log(`수집 끝: 요청 ${R.requests}번, 분석 대상 ${works.reduce((t, w) => t + w.sample.length, 0)}개`);
  if (args.collectOnly) { for (const w of works) judge(w); save(); log("수집만 하고 끝냅니다 (--collect-only)"); process.exit(0); }

  // 돈 확인
  const nC = works.reduce((t, w) => t + w.sample.length, 0);
  const est = nC * EST_PER_COMMENT + works.length * (EST_THEME_WORK + EST_NEEDS_WORK);
  const { inFlightUsd } = await import("../ai/review_ai.mjs");
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);
  log(`예상 비용 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용·처리 중 $${spent.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 시범 상한을 넘어 보내지 않습니다");
  if (spent + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");

  // ③ 1단계: 반복되는 반응 찾기
  await stage("1단계(Sonnet) 반복 반응 찾기", themeRequests(works), works.length * EST_THEME_WORK, "theme", (out) => applyThemes(works, out));
  save();
  if (!works.some((w) => w.themes && w.themes.length)) throw new Error("반복 반응 묶음을 하나도 받지 못했습니다");

  // ④ 2단계: 댓글마다 표시
  await stage("2단계(Haiku) 댓글 표시", classifyRequests(works), nC * EST_PER_COMMENT, "haiku", (out) => {
    const a = applyLabels(works, out);
    if (a.failed) report.notes.push(`2단계 실패한 묶음 ${a.failed}개`);
    return a.usd;
  });
  for (const w of works) { judge(w); themeStats(w); }
  save();

  // ⑥ 3단계: 참고용 니즈 맵
  await stage("3단계(Sonnet) 참고용 니즈 맵", needsRequests(works), works.length * EST_NEEDS_WORK, "needs", (out) => applyNeeds(works, out));
} catch (e) {
  report.error = e instanceof RidiBlocked ? "리디가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  save();
  const usd = report.cost.theme + report.cost.haiku + report.cost.needs;
  const lines = [`## 회차 댓글 분석 시범 (2판: 반복 반응)`, `- 작품: ${works.map((w) => w.title).join(", ")}`, `- 리디 요청 ${R.requests}번`,
    `- 표시한 댓글 ${works.reduce((t, w) => t + (w.sample || []).filter((c) => c.lab).length, 0)}개, 반복 반응 묶음 ${works.map((w) => (w.themes || []).length).join("·")}개`,
    `- '불호' 묶음에서 뺀 겉말 불평 ${report.dropped}개, 원문과 겹쳐 가린 글 ${report.scrubbed || 0}개`,
    `- AI 비용 $${usd.toFixed(3)} (묶음 찾기 $${report.cost.theme.toFixed(3)} + 표시 $${report.cost.haiku.toFixed(3)} + 니즈 맵 $${report.cost.needs.toFixed(3)}) / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
