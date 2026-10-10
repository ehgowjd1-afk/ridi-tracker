/* 리디 구매자 별점 리뷰 수집 (로그인 없이) — ai_reviews.mjs·ai_summary.mjs 와 같은 GraphQL 요청
 *
 * 받는 것: 리뷰 번호(ratingId)·별점·공감 수·작성 시각·내용. 작성자 아이디는 요청하지 않는다.
 * 사이트 부담: 요청 사이 최소 2.5초, 429(너무 많음)가 3번 나오면 멈춘다.
 */
import { RidiBlocked } from "./ridi_comments.mjs";

const GQL_URL = "https://api.ridibooks.com/graphql";
const HEADERS = {
  "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://ridibooks.com", "Referer": "https://ridibooks.com/",
  "Accept-Language": "ko-KR,ko;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};
const QUERY = "query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) " +
  "{ riGrid { cells { bookDetailHome { reviewCell(id: $id, context: $context) { cell { " +
  "reviews { rating ratingId likeVoteCnt status timestamp content } pagination { ... on PageLimitOutput { hasMore } } } } } } } }";
const CELL = "1d4076f7-fc4e-4094-99c7-03b6348feeb5";   // 아무 값이나 받아 줌(확인됨)
const GAP_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0, n429 = 0;
export let reviewRequests = 0;

async function page(bookId, pageNo) {
  const body = JSON.stringify({ query: QUERY, variables: { id: CELL, context: { bookId: String(bookId), buyerOnly: true, order: "RECENT", pageLimitInput: { limit: 1000, page: pageNo } } } });
  for (let attempt = 1; ; attempt++) {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now(); reviewRequests++;
    let res;
    try { res = await fetch(GQL_URL, { method: "POST", headers: HEADERS, body, signal: AbortSignal.timeout(60000) }); }
    catch (e) { if (attempt < 3) { await sleep(5000 * attempt); continue; } throw e; }
    if (res.status === 429) { if (++n429 >= 3) throw new RidiBlocked("리디가 요청을 막았습니다 (429)"); await sleep(30000); continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 160));
    const c = (((((j.data || {}).riGrid || {}).cells || {}).bookDetailHome || {}).reviewCell || {}).cell || {};
    return { reviews: c.reviews || [], hasMore: !!((c.pagination || {}).hasMore) };
  }
}

// 작품의 보이는 리뷰 전부: [{id, content, rating, likes, at}]
export async function fetchReviews(bookId, maxPages = 60) {
  const byId = new Map();
  for (let p = 1; p <= maxPages; p++) {
    const r = await page(bookId, p);
    for (const x of r.reviews) {
      if (x.status !== "VISIBLE" || byId.has(x.ratingId)) continue;
      byId.set(x.ratingId, { id: x.ratingId, content: (x.content || "").trim(), rating: x.rating || 0, likes: x.likeVoteCnt || 0, at: x.timestamp || "" });
    }
    if (!r.hasMore || !r.reviews.length) break;
  }
  return [...byId.values()];
}
