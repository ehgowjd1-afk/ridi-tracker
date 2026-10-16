/* AI 분석 파일의 예시 발췌·인용 구절에 리뷰 원문 전체를 붙인다 (한 번 돌리는 보정, AI 안 씀).
 *
 *  - docs/data/reviews_ai/<id>.json : analysis.examples[요소].{p,n,m} 와 overEx 의 [발췌, 공감, 날짜] → 네 번째에 원문(600자)
 *  - docs/data/reviews_sum/<id>.json: summary.{tropes,likes,dislikes,immersion}[].quotes 에 맞춰 qfull(인용이 든 리뷰 원문) 추가
 * 작품마다 리뷰를 다시 받아(파이썬 경유) 발췌/인용이 들어 있는 리뷰를 찾는다. 새 분석부터는 생성할 때 바로 넣는다.
 *
 *   node scripts/ai/quotes_fill.mjs [--only id,id] [--max-works N]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { RidiBlocked } from "../cmt/ridi_comments.mjs";
import * as RR from "../cmt/ridi_reviews.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");
const AI_DIR = "docs/data/reviews_ai", SUM_DIR = "docs/data/reviews_sum";
const args = { only: null, maxWorks: 1000 };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--only") args.only = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--max-works") args.maxWorks = Number(v());
}
const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
const squash = (t) => (t || "").replace(/\s+/g, "");
const clip = (t, n) => { const a = Array.from(t); return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : t; };
const fullOf = (t) => clip(norm(t), 600);

const ids = new Set();
for (const d of [AI_DIR, SUM_DIR]) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
const list = [...ids].filter((id) => !args.only || args.only.includes(id)).slice(0, args.maxWorks);
let works = 0, exFixed = 0, exMissed = 0, qFixed = 0, qMissed = 0, skipped = 0;

for (const id of list) {
  const aiFile = `${AI_DIR}/${id}.json`, sumFile = `${SUM_DIR}/${id}.json`;
  const ai = existsSync(aiFile) ? JSON.parse(readFileSync(aiFile, "utf8")) : null;
  const sum = existsSync(sumFile) ? JSON.parse(readFileSync(sumFile, "utf8")) : null;
  // 손볼 것: 네 번째 칸 없는 예시, qfull 없는 항목
  const exs = [];
  if (ai && ai.analysis) {
    for (const slot of Object.values(ai.analysis.examples || {})) for (const side of ["p", "n", "m"]) for (const e of slot[side] || []) if (!e[3]) exs.push(e);
    for (const e of ai.analysis.overEx || []) if (!e[3]) exs.push(e);
  }
  const items = [];
  if (sum && sum.summary) for (const k of ["tropes", "likes", "dislikes", "immersion"]) for (const it of sum.summary[k] || []) if ((it.quotes || []).length && !(it.qfull && it.qfull.length === it.quotes.length)) items.push(it);
  if (!exs.length && !items.length) { skipped++; continue; }

  let reviews;
  try { reviews = await RR.fetchReviews(id); }
  catch (e) { if (e instanceof RidiBlocked) { console.log(`중단: ${e.message}`); break; } console.log(`  ✗ ${id}: ${e.message}`); continue; }
  const rs = reviews.map((r) => ({ n: norm(RABSA.normText(r.content || "")), s: squash(r.content), likes: r.likes || 0, raw: r.content || "" }));

  let a = 0, b = 0;
  for (const e of exs) {
    const core = String(e[0] || "").replace(/^…/, "").replace(/…$/, "").trim();
    if (core.length < 4) { exMissed++; continue; }
    const cands = rs.filter((r) => r.n.includes(core));
    const pick = cands.find((r) => r.likes === e[1]) || cands[0];
    if (pick) { e[3] = fullOf(pick.raw); a++; exFixed++; } else exMissed++;
  }
  for (const it of items) {
    it.qfull = it.quotes.map((q) => {
      const sq = squash(q).replace(/…$/, "");
      const hit = sq.length >= 4 ? rs.find((r) => r.s.includes(sq)) : null;
      if (hit) { b++; qFixed++; return fullOf(hit.raw); }
      qMissed++; return "";
    });
  }
  if (ai && a) writeFileSync(aiFile, JSON.stringify(ai));
  if (sum && items.length) writeFileSync(sumFile, JSON.stringify(sum));
  works++;
  console.log(`  ${(ai && ai.title) || (sum && sum.title) || id} — 예시 ${a}/${exs.length}, 인용 ${b}/${items.reduce((s, it) => s + it.quotes.length, 0)} (리뷰 ${reviews.length}건)`);
}
console.log(`\n완료: 작품 ${works}개 손봄, 예시 원문 ${exFixed}개 채움(못 찾음 ${exMissed}), 인용 원문 ${qFixed}개 채움(못 찾음 ${qMissed}), 손볼 것 없음 ${skipped}개, 리디 요청 ${RR.reviewRequests}번`);
