/* 별점 리뷰 — 반복되는 반응 세기 시범 (작품 1~3개). 핵심은 rev_core.mjs (매일 작업 rev_daily.mjs 와 같음)
 *
 * 결과 파일: 숫자·표시·묶음만(리뷰 원문 없음 — 근거는 리뷰 번호). 이 달 AI 사용액은 state/ai_state.json 에 더한다.
 *
 *   node scripts/cmt/rev_pilot.mjs --ids 5163001179,5103000637 --out rev_pilot_out.json
 *        [--max 1200] [--limit-usd 30] [--cap-usd 2] [--wait-min 100] [--summary FILE]
 *   CMT_MOCK=1 이면 AI 대신 가짜 답으로 끝까지 돌려 본다 (돈 안 듦, 시험용).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { RidiBlocked } from "./ridi_comments.mjs";
import * as RR from "./ridi_reviews.mjs";
import * as C from "./rev_core.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const STATE = "state/ai_state.json";
const EST_PER_REVIEW = 0.00015;   // 2단계: 리뷰 1개당 예상(일괄, 여유 있게)
const EST_THEME_WORK = 0.2;       // 1단계: 작품 1개당 예상(Sonnet 일괄)
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

const MONTH = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const log = (...a) => console.log(...a);
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { kind: "reviews", generated_at: new Date().toISOString(), models: { haiku: C.HAIKU, sonnet: C.SONNET }, cost: { theme: 0, haiku: 0 }, batches: {}, notes: [], dropped: 0, scrubbed: 0 };
let works = [];
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
function save() {
  report.reviewRequests = RR.reviewRequests;
  report.scrubbed = 0;
  report.works = works.map((w) => {
    const sc = C.scrubber(w, report);
    return { id: w.id, title: w.title, webtoon: w.webtoon, bl: w.bl, stats: w.stats, untagged: w.untagged ?? null, unlabeled: w.unlabeled ?? null, tones: w.tones || {},
      themes: (w.themes || []).map((t) => ({ ...t, label: sc(t.label) ?? "(리뷰 원문과 겹쳐 가림)", def: sc(t.def) ?? "(리뷰 원문과 겹쳐 가림)" })),
      // 원문(content)은 넣지 않는다 — 번호·별점·공감·시각·무게·표시만
      reviews: (w.sample || []).map(({ content, ...r }) => r), themeSample: w.themeSample };
  });
  writeFileSync(args.out, JSON.stringify(report));
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer: C.mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

try {
  for (const id of args.ids) works.push(await C.collect(id, args.max, log));
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

  await stage("1단계(Sonnet) 반복 반응 찾기", C.themeRequests(works, log), sendN * EST_THEME_WORK, "theme", (out) => C.applyThemes(works, out, report, costOf));
  save();
  if (!works.some((w) => w.themes && w.themes.length)) throw new Error("반복 반응 묶음을 하나도 받지 못했습니다");
  await stage("2단계(Haiku) 리뷰 표시", C.classifyRequests(works), nR * EST_PER_REVIEW, "haiku", (out) => C.applyLabels(works, out, report, costOf));
  for (const w of works) C.themeStats(w, report);
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
