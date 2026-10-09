/* AI 분석 시험: 사람이 검토해 둔 리뷰 120건(scripts/ai/sample_keys.json)을 모델별로 분석해 결과를 파일로 남긴다.
 *
 * 공개 저장소라 리뷰 원문은 저장소에 두지 않는다. 표본은 (작품 id, 리뷰 해시)만 있고,
 * 여기서 리디에서 리뷰를 다시 받아 해시로 맞춰 쓴다. 결과 파일에는 원문 대신 번호와 판정만 남긴다.
 *   node scripts/ai/ai_test.mjs out.json
 */
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { makeClient, analyzeBatch } from "./review_ai.mjs";

const require = createRequire(import.meta.url);
const RO = require("../review_opts.js");
const OUT = process.argv[2] || "ai_test_out.json";
const DATA = "docs/data/";
const cat = JSON.parse(fs.readFileSync(DATA + "books.json", "utf8"));
const keys = JSON.parse(fs.readFileSync("scripts/ai/sample_keys.json", "utf8"));

const CONFIGS = [
  { name: "haiku-5-5 생각없이(effort low)", model: "claude-haiku-5-5", effort: "low", thinking: "disabled" },
  { name: "haiku-5-5 기본(effort medium)", model: "claude-haiku-5-5", effort: "medium" },
  { name: "sonnet-5-5 (effort medium)", model: "claude-sonnet-5-5", effort: "medium" },
  { name: "haiku-5-5 짧게 생각(effort low)", model: "claude-haiku-5-5", effort: "low" }
].filter((c) => !process.env.AI_CONFIGS || process.env.AI_CONFIGS.split(",").some((k) => c.name.includes(k)));
const PER_REQUEST = 15;

const sha = (t) => crypto.createHash("sha1").update((t || "").trim()).digest("hex").slice(0, 16);
const FALLBACK_CELL = "1d4076f7-fc4e-4094-99c7-03b6348feeb5";
const Q = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) { riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { reviews { ratingId content } pagination { ... on PageLimitOutput { hasMore } } } } } } } }";
async function page(id, p) {
  const body = { query: Q, variables: { id: FALLBACK_CELL, context: { bookId: String(id), buyerOnly: true, order: "RECENT", pageLimitInput: { limit: 1000, page: p } } } };
  const r = await fetch("https://api.ridibooks.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" }, body: JSON.stringify(body) });
  const c = (await r.json()).data.riGrid.cells.bookDetailHome.reviewCell.cell;
  return { reviews: c.reviews || [], more: c.pagination && c.pagination.hasMore };
}
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

// 1) 리뷰 원문 다시 받기
const byBook = {};
for (const k of keys) (byBook[k.id] = byBook[k.id] || []).push(k);
const texts = {};
for (const id of Object.keys(byBook)) {
  const want = new Map(byBook[id].map((k) => [k.h, k.n]));
  for (let p = 1; p <= 4 && want.size; p++) {
    const r = await page(id, p);
    for (const x of r.reviews) { const n = want.get(sha(x.content)); if (n) { texts[n] = x.content; want.delete(sha(x.content)); } }
    await sleep(1500);
    if (!r.more) break;
  }
  if (want.size) console.log(`  ${id}: ${want.size}건을 찾지 못함(수정·삭제된 리뷰)`);
}
console.log(`리뷰 ${Object.keys(texts).length}/${keys.length}건 확보`);

// 2) 작품 정보
function workOf(id) {
  let det = null;
  try { det = JSON.parse(fs.readFileSync(DATA + "books/" + id + ".json", "utf8")); } catch (e) {}
  const o = det ? RO.reviewOpts(det, cat[id], {}, null) : {};
  return { title: (cat[id] && cat[id].t) || "", webtoon: !!o.webtoon, bl: !!o.bl, orig: !!o.orig, authors: o.authors || [] };
}

// 3) 모델별 분석
const client = makeClient();
const result = { at: new Date().toISOString(), found: Object.keys(texts).length, configs: [] };
for (const cfg of CONFIGS) {
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }, out = {}, errors = [];
  const t0 = Date.now();
  for (const id of Object.keys(byBook)) {
    const work = workOf(id);
    const rs = byBook[id].filter((k) => texts[k.n]).map((k) => ({ n: k.n, text: texts[k.n] }));
    for (let i = 0; i < rs.length; i += PER_REQUEST) {
      const chunk = rs.slice(i, i + PER_REQUEST);
      try {
        const r = await analyzeBatch(client, cfg, work, chunk);
        usage.input += r.usage.input_tokens || 0; usage.output += r.usage.output_tokens || 0;
        usage.cache_read += r.usage.cache_read_input_tokens || 0; usage.cache_write += r.usage.cache_creation_input_tokens || 0;
        for (const rv of r.reviews) out[rv.n] = { items: rv.items, over: rv.over };
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
        console.log(`  [${cfg.name}] ${id} 실패: ${e.message}`);
      }
    }
  }
  // 리뷰 원문 글자 수(비용 추정용)
  const chars = Object.values(texts).reduce((s, t) => s + t.length, 0);
  result.configs.push({ name: cfg.name, model: cfg.model, effort: cfg.effort, thinking: cfg.thinking || "adaptive",
    seconds: Math.round((Date.now() - t0) / 1000), usage, chars, errors, results: out });
  console.log(`[${cfg.name}] 입력 ${usage.input} / 출력 ${usage.output} / 캐시읽기 ${usage.cache_read} / 캐시쓰기 ${usage.cache_write} 토큰, 오류 ${errors.length}`);
}
fs.writeFileSync(OUT, JSON.stringify(result));
console.log("저장:", OUT);
