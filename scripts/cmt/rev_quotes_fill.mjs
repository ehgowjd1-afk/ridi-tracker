/* 별점 리뷰 반복 반응(docs/data/reviews_rx)의 대표 리뷰를 원문 전체로 채운다 (한 번 돌리는 보정).
 *
 * 2026-10-16 전까지는 대표 리뷰를 60자에서 잘라 "…"를 붙여 저장했다. 이 스크립트는 작품마다
 * 리뷰를 다시 받아, 잘린 인용의 앞부분과 같은 리뷰를 찾아 전체 글(600자까지)로 바꿔 넣는다.
 * AI는 쓰지 않는다(비용 0). 리디 요청만 작품당 몇 번.
 *
 *   node scripts/cmt/rev_quotes_fill.mjs [--only id,id] [--max-works N]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { RidiBlocked } from "./ridi_comments.mjs";
import * as RR from "./ridi_reviews.mjs";

const DIR = "docs/data/reviews_rx", QUOTE_LEN = 600;
const args = { only: null, maxWorks: 1000 };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--only") args.only = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--max-works") args.maxWorks = Number(v());
}

// rev_daily.mjs 와 같은 정리 규칙 (기호 그림 제거 → 공백 하나로)
const cleanQ = (t) => String(t).replace(/[\p{So}\p{Sk}\p{Sm}]+/gu, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).join(" ");
const clipQ = (t) => { const a = Array.from(cleanQ(t)); return a.length > QUOTE_LEN ? a.slice(0, QUOTE_LEN - 1).join("").trimEnd() + "…" : a.join(""); };
const truncated = (q) => typeof q === "string" && q.endsWith("…") && Array.from(q).length <= 60;

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
  .filter((id) => !args.only || args.only.includes(id)).slice(0, args.maxWorks);
let works = 0, fixed = 0, missed = 0, skipped = 0;
for (const id of files) {
  const file = `${DIR}/${id}.json`;
  const rx = JSON.parse(readFileSync(file, "utf8"));
  const todo = [];
  for (const t of rx.themes || []) for (const q of t.q || []) if (truncated(q[2])) todo.push(q);
  if (!todo.length) { skipped++; continue; }
  let reviews;
  try { reviews = await RR.fetchReviews(id); }
  catch (e) { if (e instanceof RidiBlocked) { console.log(`중단: ${e.message}`); break; } console.log(`  ✗ ${id} ${rx.title}: ${e.message}`); continue; }
  // 정리한 원문 목록. 같은 앞부분을 가진 리뷰가 여럿이면 공감 수가 같은 것을 고른다.
  const full = reviews.map((r) => ({ c: cleanQ(r.content), rating: r.rating, likes: r.likes }));
  let n = 0;
  for (const q of todo) {
    const head = Array.from(q[2]).slice(0, -1).join("");          // "…" 뗀 앞부분
    const cands = full.filter((r) => r.c.startsWith(head));
    const pick = cands.find((r) => r.rating === q[0] && r.likes === q[1]) || cands.find((r) => r.rating === q[0]) || cands[0];
    if (pick) { q[2] = clipQ(pick.c); n++; fixed++; } else missed++;
  }
  works++;
  writeFileSync(file, JSON.stringify(rx));
  console.log(`  ${rx.title} — 인용 ${todo.length}개 중 ${n}개 채움 (리뷰 ${reviews.length}건)`);
}
console.log(`\n완료: 작품 ${works}개 손봄, 인용 ${fixed}개 채움, 못 찾음 ${missed}개, 손볼 것 없음 ${skipped}개, 리디 요청 ${RR.reviewRequests}번`);
