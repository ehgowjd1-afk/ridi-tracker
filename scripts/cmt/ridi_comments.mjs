/* 리디 회차 댓글 수집 (로그인 없이)
 *
 * 회차 목록: 작품 상세페이지 HTML 안의 seriesBookListJson (성인 작품도 들어 있음)
 * 댓글:     ridibooks.com/apps/reading-data/serial-comment/{회차 id}?offset&limit&sort=RECENT_FIRST|MOST_LIKED
 * 개인정보: 응답에 딸려 오는 user_id(가려진 아이디)·user_idx(회원 번호)는 받자마자 버린다 — 내용·시각·좋아요만 남김.
 * 사이트 부담: 요청 사이 최소 2초, 429(너무 많음)가 3번 나오면 멈춘다.
 */
const BASE = "https://ridibooks.com";
const H = { "User-Agent": "Mozilla/5.0", Referer: "https://ridibooks.com/" };
export const GAP_MS = 2000;
const PAGE = 200;   // 한 번에 받는 댓글 수 (사이트가 허용하는 최대로 확인한 값)

export class RidiBlocked extends Error {}
// 글자 수로 자르기 — 이모지(두 칸짜리 글자)를 반쪽으로 자르면 AI 요청이 '올바르지 않은 JSON'으로 거절된다
export const cut = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0, n429 = 0;
export let requests = 0;

async function get(url, asText) {
  for (let tries = 0; ; tries++) {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    requests++;
    let r;
    try { r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (tries < 2) { await sleep(5000); continue; } throw e; }
    if (r.status === 429 || r.status === 503) {
      if (++n429 >= 3) throw new RidiBlocked("리디가 요청을 막았습니다 (" + r.status + ")");
      await sleep(30000 * (tries + 1));
      continue;
    }
    if (!r.ok) {
      if (r.status >= 500 && tries < 2) { await sleep(5000); continue; }
      throw new Error(`HTTP ${r.status} ${url}`);
    }
    return asText ? r.text() : r.json();
  }
}

// "2026-10-09 22:00:01"(한국시간) 또는 "20261009220000" → ISO(+09:00)
function kstIso(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, "");
  if (d.length < 12) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14) || "00"}+09:00`;
}

// 회차 제목 → 화 번호 ("… 37화" → 37, "프롤로그" → 0, 인사말·공지·후기 → null)
export function epNo(title) {
  const t = String(title || "");
  if (/외전|번외|특별편|후기|공지|인사말/.test(t)) return null;
  const m = t.match(/(\d+)\s*화(?!.*\d+\s*화)/);
  if (m) return Number(m[1]);
  if (/프롤로그/.test(t)) return 0;
  return null;
}

// 작품 정보 + 회차 목록 (공개 순서)
export async function fetchSeries(id) {
  const html = await get(`${BASE}/books/${id}`, true);
  const m = html.match(/var seriesBookListJson = (\[[\s\S]*?\]);\n/);
  if (!m) throw new Error("회차 목록을 찾지 못했습니다: " + id);
  const list = JSON.parse(m[1]);
  const meta = (p) => { const x = html.match(new RegExp(`<meta property="og:${p}" content="([^"]*)"`)); return x ? x[1] : ""; };
  const desc = cut(meta("description").replace(/^.*?작품소개:\s*/, ""), 400);
  const episodes = list.map((b) => {
    const p = b.price_info || {};
    return {
      id: String(b.id),
      title: b.title || "",
      no: epNo(b.title),
      reg: kstIso((b.property_info && b.property_info.ridi_open_date) || b.open_date || b.reg_date),
      // 지금 가격 기준(과거 무료 여부는 알 수 없음). 무료 대여 = 기다무·이벤트 무료일 수 있음
      freeNow: Number(p.current_price) === 0 || p.rental_price === "0"
    };
  });
  return { id: String(id), desc, episodes };
}

const keep = (c) => ({
  cid: c.comment_id,
  text: c.content || "",
  at: c.created,
  like: c.like_count | 0,
  best: !!c.is_best,
  sp: !!c.is_spoiler,
  rc: c.reply_count | 0,
  hidden: !!(c.blind_type || c.is_screened)
});

// 한 회차의 댓글 전부(최신순). max개에서 멈춤. 받는 도중 새 댓글이 붙어 밀린 것은 번호로 걸러낸다.
export async function fetchComments(epId, max = 6000) {
  const out = [], seen = new Set();
  for (let off = 0; off < max; off += PAGE) {
    const j = await get(`${BASE}/apps/reading-data/serial-comment/${epId}?offset=${off}&limit=${PAGE}&sort=RECENT_FIRST`);
    const cs = (j.serial_comment && j.serial_comment.comments) || [];
    for (const c of cs) if (!seen.has(c.comment_id)) { seen.add(c.comment_id); out.push(keep(c)); }
    if (cs.length < PAGE) return { comments: out, complete: true };
  }
  return { comments: out, complete: false };
}
