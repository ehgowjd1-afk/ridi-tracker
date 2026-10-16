/* 별점 리뷰 반복 반응(docs/data/reviews_rx)의 묶음 이름을 구체적인 요소로 다시 짓기.
 *
 * 사용자 요청(2026-10-17): '첫 실패'처럼 "남주 태혁이 다정하고 직진해서 좋다"같이 어떤 서사·캐릭터성이 좋은지
 * 구체적으로 적어 달라. 묶음(리뷰 분류)은 그대로 두고 이름(l)·기준(d)만 Sonnet이 대표 리뷰를 읽고 다시 쓴다.
 * 리뷰를 다시 분류하지 않으므로 작품당 $0.03쯤(일괄 반값). 새 분석(rev_daily)은 지시문이 바뀌어 처음부터 이렇게 짓는다.
 *
 *   node scripts/cmt/rev_relabel.mjs [--only id,id] [--max-works N] [--run-usd 5] [--limit-usd 30] [--wait-min 100] [--dry] [--summary FILE]
 *   CMT_MOCK=1 이면 AI 대신 가짜 답(비용 0).
 * 결과: 같은 파일에 l·d 교체 + relabel: 2 표시. state/ai_state.json 의 spend 에 비용 기록.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import * as C from "./rev_core.mjs";
import * as AI from "./rev_ai.mjs";
import { createBatcher, costOf as rawCost, Waiting } from "./batch.mjs";

const DIR = "docs/data/reviews_rx", STATE = "state/ai_state.json";
const RELABEL_VER = 2;               // 이 번호가 붙은 파일은 건너뛴다
const EST_WORK = 0.05;               // 작품당 예상(예상은 넉넉히, 실제는 보통 그 절반)
const QUOTE_PER_THEME = 6, QUOTE_LEN = 240;
const MOCK = !!process.env.CMT_MOCK;
const T_START = Date.now();
const args = { only: null, maxWorks: 200, runUsd: 5, limitUsd: 30, waitMin: 100, dry: false, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--only") args.only = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--max-works") args.maxWorks = Number(v());
  else if (k === "--run-usd") args.runUsd = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--dry") args.dry = true;
  else if (k === "--summary") args.summary = v();
}
for (const k of ["maxWorks", "runUsd", "limitUsd", "waitMin"]) if (!Number.isFinite(args[k])) { console.error("숫자가 아닌 옵션:", k); process.exit(2); }

const log = (...a) => console.log(...a);
const MONTH = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return d; } };
const clip = (t, n) => { const a = Array.from(String(t).replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : a.join(""); };
const textOf = (msg) => (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));

const RELABEL_SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 리디(RIDI)의 구매자 별점 리뷰 분석 결과를 다듬는 분석가입니다.
이미 리뷰를 읽고 '반복되는 반응' 묶음을 만들어 두었습니다. 묶음 자체(어떤 리뷰가 들어가는지)는 바꾸지 않고, **묶음의 이름(label)과 기준(def)만** 아래 규칙대로 구체적으로 다시 씁니다. 결과는 공개되므로 리뷰 문장을 그대로 옮기지 않습니다.

## 이름 짓기 규칙 (가장 중요)
기획자는 "어떤 서사가, 어떤 캐릭터성이 먹히는가"를 보려 합니다. 이름은 반응의 종류가 아니라 **반응의 대상이 된 구체적 요소**를 적습니다.
- 인물은 리뷰에서 부르는 이름·호칭으로 콕 집고(남주 태혁, 여주 재인, 공 신루, 서브남 라이문트), 그 인물의 어떤 성격·행동·관계가 좋은지(싫은지)까지 적는다.
  · 나쁜 예 → 좋은 예: '캐릭터가 매력적이다' → '남주 태혁이 다정하고 직진해서 좋다' / '두 주인공 케미가 좋다' → '까칠한 태혁이 재인에게만 무너지는 반전이 설렌다' / '설레고 달달하다' → '재회 후 태혁이 먼저 다가오는 직진 로맨스가 설렌다'
- 서사도 마찬가지: '스토리가 탄탄하다'가 아니라 무슨 설정·전개·장면이 좋은지. '떡밥 회수가 좋다' → '초반 신수 떡밥이 100화 뒤 회수되는 치밀함', '눈물 난다' → '이모와 할머니가 재인을 품어 주는 장면에서 운다'.
- 불호·아쉬움도 대상을 적는다: '전개가 느리다' → '중반 회상·설명이 반복돼 전개가 늘어진다', '캐릭터가 싫다' → '여주가 계속 끌려다니기만 해서 답답하다'.
- 구체적인 내용은 **대표 리뷰에 실제로 있는 것**만 쓴다. 대표 리뷰가 '재밌다'만 말하고 무엇이 좋은지 없으면 지어내지 말고 지금 이름을 다듬는 정도로 둔다. 이름은 25~35자, 독자 말투에 가깝게.
- def(60자 안팎)에는 그 요소를 말하는 리뷰를 알아보는 기준(어떤 인물·장면·설정)과 이웃 묶음과의 구분을 적는다.
- 묶음의 bucket(좋다는 말/많이 하는 말/불호)과 번호는 그대로. 모든 묶음을 빠짐없이 돌려준다.`;

const RELABEL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["themes"],
  properties: { themes: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "label", "def"],
    properties: { id: { type: "string" }, label: { type: "string" }, def: { type: "string" } } } } }
};

function requestFor(rx, wi) {
  const det = readJSON(`docs/data/books/${rx.id}.json`, {}) || {};
  const lines = [`[작품] ${rx.title} / ${rx.webtoon ? "웹툰" : "웹소설"}`, `[작품 소개] ${clip(det.description || "-", 700)}`, "",
    `[지금 묶음 목록] 번호 (bucket) 지금 이름 — 지금 기준 — 리뷰 수. 그 아래 대표 리뷰 [별점 · 공감] 본문`];
  for (const t of rx.themes || []) {
    lines.push(`${t.id} (${AI.BUCKETS[t.b] || t.b}) ${t.l} — ${t.d || "-"} — 약 ${t.est || t.n || 0}개`);
    for (const q of (t.q || []).slice(0, QUOTE_PER_THEME)) lines.push(`  · [★${q[0]} · 공감 ${q[1]}] ${clip(q[2], QUOTE_LEN)}`);
  }
  const text = lines.join("\n");
  const req = {
    model: C.SONNET.model, max_tokens: 8000, system: RELABEL_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 묶음들의 이름과 기준을 규칙대로 구체적으로 다시 써서 JSON으로 주세요." }],
    output_config: { format: { type: "json_schema", schema: RELABEL_SCHEMA } }
  };
  if (C.SONNET.effort) req.output_config.effort = C.SONNET.effort;
  return { custom_id: `r-${wi}`, params: req, chars: text.length };
}

function mockAnswer(customId, body) {
  const ids = [...body.matchAll(/^(T\d+) \(/gm)].map((m) => m[1]);
  return { themes: ids.map((id) => ({ id, label: `${id} 새 이름(가짜)`, def: "가짜 기준" })) };
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? readJSON(STATE, {}) : {};
state.spend ||= {};
const report = { cost: { relabel: 0 }, batches: {}, notes: [], scrubbed: 0 };
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

let works = [], saved = 0;
try {
  const { inFlightUsd } = await import("../ai/review_ai.mjs");
  const spent = (state.spend[MONTH] || 0) + inFlightUsd(state);
  const room = Math.min(args.runUsd, args.limitUsd - spent);
  const ids = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => !args.only || args.only.includes(id));
  const due = ids.map((id) => readJSON(`${DIR}/${id}.json`, null)).filter((rx) => rx && rx.themes && rx.themes.length && !((rx.relabel || 0) >= RELABEL_VER));
  log(`[반복 반응 이름 다시 짓기] 대상 ${ids.length}작 중 할 일 ${due.length}작 · 이 달 사용·처리 중 $${spent.toFixed(2)} / 한도 $${args.limitUsd} · 이번 상한 $${room.toFixed(2)}`);
  if (room <= 0.05) { report.notes.push("이 달 한도에 닿아 이번엔 보내지 않음"); throw new Error("한도"); }
  works = due.slice(0, Math.min(args.maxWorks, Math.floor(room / EST_WORK)));
  log(`이번에 할 작품 ${works.length}개 (예상 $${(works.length * EST_WORK).toFixed(2)})`);
  if (args.dry || !works.length) throw new Error(args.dry ? "dry" : "할 일 없음");

  const reqs = works.map((rx, wi) => requestFor(rx, wi));
  log(`  요청 ${reqs.length}건, 글자 수 합 ${reqs.reduce((s, r) => s + r.chars, 0).toLocaleString()}`);
  await stage("묶음 이름 다시 짓기(Sonnet)", reqs.map(({ custom_id, params }) => ({ custom_id, params })), works.length * EST_WORK, "relabel", (out) => {
    let usd = 0;
    for (const [cid, res] of out) {
      const rx = works[Number(cid.split("-")[1])];
      if (!rx || res.type !== "succeeded") { report.notes.push(`실패: ${rx ? rx.title : cid} (${res.type})`); continue; }
      usd += costOf(C.SONNET.model, res.message.usage || {});
      let themes;
      try { themes = JSON.parse(textOf(res.message)).themes || []; } catch (e) { report.notes.push(`해석 실패: ${rx.title} ${e.message}`); continue; }
      // 리뷰 원문과 12자 넘게 겹치는 이름은 가린다(공개 파일) — 대표 리뷰를 표본으로 씀
      const sc = C.scrubber({ sample: (rx.themes || []).flatMap((t) => (t.q || []).map((q) => ({ content: q[2] }))) }, report);
      const byId = new Map(themes.map((t) => [t.id, t]));
      let changed = 0;
      for (const t of rx.themes) {
        const n = byId.get(t.id);
        if (!n) continue;
        const label = sc(String(n.label || "").trim()), def = sc(String(n.def || "").trim());
        if (label && label !== t.l) { t.l = Array.from(label).slice(0, 60).join(""); changed++; }
        if (def) t.d = Array.from(def).slice(0, 160).join("");
      }
      rx.relabel = RELABEL_VER;
      rx.relabel_at = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/\.\d+Z$/, "+09:00");
      writeFileSync(`${DIR}/${rx.id}.json`, JSON.stringify(rx));
      saved++;
      log(`  ${rx.title}: 묶음 ${rx.themes.length}개 중 ${changed}개 이름 바뀜`);
    }
    return usd;
  });
} catch (e) {
  if (!["한도", "dry", "할 일 없음"].includes(e.message)) {
    report.error = e instanceof Waiting ? e.message : e.message;
    console.error("오류:", e.message);
    process.exitCode = 1;
  }
} finally {
  const lines = [`## 반복 반응 묶음 이름 다시 짓기`, `- 손본 작품 ${saved}개 / 시도 ${works.length}개`,
    `- AI 비용 $${report.cost.relabel.toFixed(3)} / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)} (한도 $${args.limitUsd})`,
    `- 원문과 겹쳐 가린 이름 ${report.scrubbed}개`, ...report.notes.slice(0, 30).map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
