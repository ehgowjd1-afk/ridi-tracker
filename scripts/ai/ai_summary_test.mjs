/* '독자 반응 요약' 시험: 작품 몇 개를 Haiku·Sonnet으로 요약해 비교용 결과를 남긴다.
 * 결과 파일에는 원문 대신 표본 리뷰 번호(ratingId)와 요약만 남긴다 (공개 저장소).
 *   node scripts/ai/ai_summary_test.mjs out.json [id,id,...]
 */
import fs from "fs";
import { createRequire } from "module";
import { makeClient, costOf } from "./review_ai.mjs";
import { sampleReviews, buildSummaryParams, verifySummary } from "./summary_ai.mjs";

const require = createRequire(import.meta.url);
const RABSA = require("../../docs/rabsa.js");
const RO = require("../review_opts.js");
const OUT = process.argv[2] || "ai_summary_out.json";
const IDS = (process.argv[3] || "4869004885,6360000001,4688000606,6210000001,3049004830").split(",");
const CONFIGS = [
  { name: "haiku-5-5 (effort medium)", model: "claude-haiku-5-5", effort: "medium" },
  { name: "sonnet-5-5 (effort medium)", model: "claude-sonnet-5-5", effort: "medium" }
];
const DATA = "docs/data/";
const cat = JSON.parse(fs.readFileSync(DATA + "books.json", "utf8"));
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const Q = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) { riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { reviews { rating ratingId likeVoteCnt status timestamp content } pagination { ... on PageLimitOutput { hasMore } } } } } } } }";
async function fetchAll(id) {
  const byId = new Map();
  for (let p = 1; p <= 300; p++) {
    const body = { query: Q, variables: { id: "1d4076f7-fc4e-4094-99c7-03b6348feeb5", context: { bookId: String(id), buyerOnly: true, order: "RECENT", pageLimitInput: { limit: 1000, page: p } } } };
    const r = await fetch("https://api.ridibooks.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" }, body: JSON.stringify(body) });
    const c = (await r.json()).data.riGrid.cells.bookDetailHome.reviewCell.cell;
    for (const x of c.reviews || []) if (x.status === "VISIBLE" && !byId.has(x.ratingId)) byId.set(x.ratingId, { id: x.ratingId, content: (x.content || "").trim(), rating: x.rating, likes: x.likeVoteCnt || 0, at: x.timestamp || "" });
    await sleep(2500);
    if (!c.pagination || !c.pagination.hasMore || !(c.reviews || []).length) break;
  }
  return [...byId.values()];
}

const client = makeClient();
const result = { at: new Date().toISOString(), works: [] };
for (const id of IDS) {
  const all = await fetchAll(id);
  const det = all.filter((r) => RABSA.isDetailed(r.content));
  const { sample, counts } = sampleReviews(det);
  let detail = null; try { detail = JSON.parse(fs.readFileSync(DATA + "books/" + id + ".json", "utf8")); } catch (e) {}
  const o = detail ? RO.reviewOpts(detail, cat[id], {}, null) : {};
  const work = { title: (cat[id] && cat[id].t) || "", webtoon: !!o.webtoon, bl: !!o.bl, orig: !!o.orig, authors: o.authors || [] };
  let ai = null; try { ai = JSON.parse(fs.readFileSync(DATA + "reviews_ai/" + id + ".json", "utf8")); } catch (e) {}
  let rules = null; try { rules = JSON.parse(fs.readFileSync(DATA + "reviews/" + id + ".json", "utf8")); } catch (e) {}
  const aspectsD = (ai && ai.analysis && ai.analysis.aspectsD) || (rules && rules.analysis && rules.analysis.aspectsD) || {};
  const dTotal = (ai && ai.analysis && ai.analysis.dTotal) || (rules && rules.analysis && rules.analysis.dTotal) || det.length;
  const entry = { id, title: work.title, detailed: det.length, counts, rids: sample.map((r) => r.id), runs: [] };
  for (const cfg of CONFIGS) {
    try {
      const msg = await client.messages.stream(buildSummaryParams(cfg, work, aspectsD, dTotal, sample)).finalMessage();
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const raw = JSON.parse(text);
      const v = verifySummary(raw, sample);
      entry.runs.push({ name: cfg.name, usage: msg.usage, usd: costOf(cfg.model, msg.usage, false), raw, verified: v.summary, stat: v.stat });
      console.log(`[${work.title}] ${cfg.name}: 입력 ${msg.usage.input_tokens} 출력 ${msg.usage.output_tokens} $${costOf(cfg.model, msg.usage, false).toFixed(4)} / 항목 ${v.stat.kept}/${v.stat.items}, 인용 확인 ${v.stat.quotesOk}/${v.stat.quotes}`);
    } catch (e) {
      entry.runs.push({ name: cfg.name, error: e.message });
      console.log(`[${work.title}] ${cfg.name} 실패: ${e.message}`);
    }
  }
  result.works.push(entry);
}
fs.writeFileSync(OUT, JSON.stringify(result));
console.log("저장:", OUT);
