/* 작품별 '독자 반응 요약' — AI가 리뷰 표본을 읽고 좋아한 점·아쉬운 점·바라는 점·과몰입 포인트를 정리한다.
 *
 * 리뷰 원문은 저장하지 않는다. 요약에는 실제 리뷰에 있는지 코드로 확인한 짧은 인용만 남긴다(지어낸 인용 제거).
 */
import { ELEMENTS } from "./review_ai.mjs";

export const SUMMARY_VER = "1";

const ITEM = (extra) => ({
  type: "object", additionalProperties: false,
  required: Object.keys(extra).concat(["point", "n", "refs", "quotes"]),
  properties: Object.assign({}, extra, {
    point: { type: "string" },
    n: { type: "integer" },
    refs: { type: "array", items: { type: "integer" } },
    quotes: { type: "array", items: { type: "string" } }
  })
});
export const SUMMARY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "tropes", "likes", "dislikes", "immersion", "audience"],
  properties: {
    headline: { type: "string" },
    likes: { type: "array", items: ITEM({ element: { type: "string", enum: Object.keys(ELEMENTS) } }) },
    dislikes: { type: "array", items: ITEM({ element: { type: "string", enum: Object.keys(ELEMENTS) } }) },
    tropes: { type: "array", items: ITEM({ tag: { type: "string" } }) },
    immersion: { type: "array", items: ITEM({ target: { type: "string" } }) },
    audience: { type: "string" }
  }
};

export const SUMMARY_SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 리디(RIDI)의 구매자 리뷰를 읽고, 작품 상세 화면 맨 위에 보여 줄 "독자 반응 요약"을 쓰는 분석가입니다. 독자·작가·편집자가 이 요약만 보고도 "독자들이 이 작품의 무엇을 좋아하고, 무엇을 아쉬워하고, 무엇을 바라는지" 알 수 있어야 합니다.

## 입력
- 작품 정보, AI가 자세한 리뷰 전체를 요소별로 센 수치(참고용)
- 리뷰 표본: 공감 많은 리뷰, 최근 리뷰, 별점 낮은 리뷰를 섞은 것. 각 리뷰에 번호(#), 별점(★), 공감 수가 붙어 있다.

## 출력 (JSON)
- headline: 독자 반응 전체를 1~2문장으로. 막연한 칭찬 대신 "무엇 때문에 좋아하고 무엇이 아쉬운지"를 구체적으로.
- tropes: 독자가 좋아하는 서사·케미 2~6개 — 가장 중요한 칸이다. 독자들이 반복해서 "이런 게 너무 좋다"고 말한 장면 흐름·관계 패턴·캐릭터 행동을 하나의 서사로 묶는다.
  · tag: 장르 독자가 쓰는 짧은 이름(2~10자). 예: '여주한정 다정남', '집착공의 순애', '혐관에서 연인으로', '쌍방구원', '능력녀의 사이다', '입덕부정', '계략남의 직진'.
  · point: 이 작품에서 그 서사가 어떻게 나오고 독자가 무엇에 반응하는지 구체적으로. 예: '남주가 다른 사람에겐 냉정하다가 여주 앞에서만 무너지고 질투하는 모습에 설렌다는 말이 반복된다'.
  · "재밌다", "그림이 예쁘다", "필력이 좋다" 같은 일반 칭찬은 여기 넣지 않는다(likes로). 인물 관계·서사 전개·캐릭터 행동 패턴만.
- likes: 그 밖에 독자들이 반복해서 좋아한 점 2~5개 (그림, 필력, 세계관, 전개 속도 등).
- dislikes: 반복된 아쉬움 0~5개. 별점 낮은 리뷰를 반드시 살핀다. 한 명만 말한 것은 넣지 않는다.
- immersion: 과몰입 포인트 0~4개 — 독자들이 특히 감정적으로 크게 반응한 인물·장면·관계(분노, 오열, 설렘 폭발, 응원). target에 인물·장면·관계 이름.
- audience: 이 작품이 특히 맞는 독자와, 안 맞을 수 있는 독자를 1~2문장으로 (리뷰에 근거해서만).

각 항목(tropes·likes·dislikes·immersion)의 칸:
- point: 구체적인 내용. "스토리가 좋다"가 아니라 "무엇이 왜 좋은지/아쉬운지". 예: '남주의 집착이 순애로 바뀌는 과정이 설렌다', '중반부터 서브 인물 이야기가 길어져 전개가 늘어진다', '여주가 위기마다 스스로 해결해 답답하지 않다'.
- element (likes·dislikes만): 가장 가까운 요소 키 — ${Object.entries(ELEMENTS).map(([k, v]) => k + "(" + v + ")").join(", ")}
- n: 표본 안에서 이 점을 말한 리뷰 수(직접 센 수).
- refs: 근거가 된 리뷰 번호 2~5개.
- quotes: 근거 원문 구절 1~2개. 원문을 한 글자도 고치지 말고 그대로, 40자 이내.

## 규칙
- 표본 리뷰에 있는 내용만 쓴다. 지어내지 않는다. 핵심 반전·결말 같은 큰 스포일러는 쓰지 않는다.
- 다른 작품, 같은 작가의 전작, 원작 소설 자체에 대한 말은 이 작품 평가에서 뺀다. 단 원작 대비 웹툰의 각색 평가는 likes/dislikes에 element adapt로 넣는다.
- 캐릭터에게 화내거나 욕하는 반응은 작품 불만이 아니라 몰입이다 → immersion에 넣고 dislikes에 넣지 않는다. 다만 "캐릭터가 답답해서 하차"처럼 실제 불만이면 dislikes.
- '끝나서 아쉽다, 보내기 싫다', '외전 주세요'는 애정이다 → dislikes에 넣지 않는다.
- 읽기 전의 기대·추측('재밌을 것 같아요')은 근거로 쓰지 않는다.
- 많이 말한 것부터 쓴다. 비슷한 내용은 하나로 합친다.
- n은 실제로 그 말을 한 리뷰만 센다. 부풀리지 않는다. refs의 리뷰는 반드시 그 point를 직접 말한 리뷰여야 한다.
- 별점 낮은 리뷰나 불만이 2건 이상 반복되면 dislikes를 비우지 않는다.
- 한 리뷰의 같은 말을 dislikes와 immersion에 동시에 넣지 않는다(캐릭터에게 화내며 즐기면 immersion, 그 때문에 작품이 별로라면 dislikes).
- 연재 주기·휴재·한 회 분량·기다리기 힘들다는 말은 작품 내용 평가가 아니므로 dislikes에도 immersion에도 넣지 않는다.
- immersion은 작품 속 인물·장면·관계에 대한 감정 반응만 넣는다(다음 화를 기다리는 마음, 연재 따라가기 같은 읽는 습관은 넣지 않는다).
- 쉬운 한국어, '~다' 체로 쓴다.`;

// 표본 고르기: 별점 낮은 리뷰(최대 lowMax, 공감순) + 공감 많은 리뷰 + 최근 리뷰를 번갈아 넣고 글자 수 상한까지
//   reviews: [{id, content, rating, likes, at}] (자세한 리뷰만)
export function sampleReviews(reviews, { lowMax = 80, likedMax = 120, recentMax = 120, maxChars = 60000 } = {}) {
  const low = reviews.filter((r) => r.rating && r.rating <= 3).sort((a, b) => (b.likes - a.likes) || (b.id - a.id)).slice(0, lowMax);
  const liked = reviews.slice().sort((a, b) => (b.likes - a.likes) || (b.id - a.id)).slice(0, likedMax);
  const recent = reviews.slice().sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : b.id - a.id)).slice(0, recentMax);
  const seen = new Set(), out = [];
  let chars = 0;
  const lists = [low, liked, recent], idx = [0, 0, 0];
  for (let round = 0; out.length < lowMax + likedMax + recentMax; round++) {
    let progressed = false;
    for (let k = 0; k < 3; k++) {
      while (idx[k] < lists[k].length && seen.has(lists[k][idx[k]].id)) idx[k]++;
      if (idx[k] >= lists[k].length) continue;
      const r = lists[k][idx[k]++];
      if (chars + r.content.length > maxChars) continue;
      seen.add(r.id); out.push(r); chars += r.content.length; progressed = true;
    }
    if (!progressed) break;
  }
  return { sample: out, counts: { low: low.length, liked: liked.length, recent: recent.length, used: out.length, chars } };
}

function statsLine(aspectsD) {
  return Object.entries(aspectsD || {})
    .map(([k, s]) => [k, s[0] || 0, s[1] || 0, s[2] || 0])
    .filter((x) => x[1] + x[2] + x[3] >= 3)
    .sort((a, b) => (b[1] + b[2] + b[3]) - (a[1] + a[2] + a[3]))
    .map(([k, p, n, m]) => `${ELEMENTS[k] || k} 호평${p}${m ? "·무난" + m : ""}·아쉬움${n}`).join(", ");
}

export function buildSummaryParams(cfg, work, aspectsD, dTotal, sample) {
  const yn = (b) => (b ? "예" : "아니오");
  const head = `[작품] 제목: ${work.title || "?"} / 웹툰·만화: ${yn(work.webtoon)} / BL: ${yn(work.bl)} / 원작 소설 있음: ${yn(work.orig)}` +
    (work.authors && work.authors.length ? ` / 작가: ${work.authors.join(", ")}` : "") +
    `\n[요소별 반응 — 자세한 리뷰 ${dTotal || "?"}건 기준, 참고용] ${statsLine(aspectsD) || "없음"}`;
  const body = sample.map((r, i) => `#${i + 1} ★${r.rating || "?"} 공감${r.likes || 0}\n${r.content.trim()}`).join("\n\n");
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: [{ type: "text", text: SUMMARY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: head + `\n\n[리뷰 표본 ${sample.length}건]\n` + body + "\n\n위 표본으로 독자 반응 요약을 JSON으로 쓰세요." }],
    output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// 인용이 실제 리뷰에 있는지 확인(공백 차이는 무시). 근거가 확인되지 않는 항목은 뺀다.
const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
const squash = (t) => (t || "").replace(/\s+/g, "");   // 띄어쓰기 차이는 무시하고 대조
// 긴 인용은 글자(코드 포인트) 단위로 잘라 이모지가 깨지지 않게, 잘렸으면 … 표시
function clip(t, n) { const cp = Array.from(t); return cp.length > n ? cp.slice(0, n - 1).join("").trimEnd() + "…" : t; }
export function verifySummary(sum, sample) {
  const texts = sample.map((r) => squash(r.content));
  const stat = { items: 0, kept: 0, quotes: 0, quotesOk: 0 };
  const fix = (arr) => (arr || []).map((it) => {
    stat.items++;
    const refs = [...new Set((it.refs || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= sample.length))];
    const quotes = [];
    for (const q of it.quotes || []) {
      stat.quotes++;
      const sq = squash(q);
      if (sq.length >= 4 && texts.some((t) => t.includes(sq))) { quotes.push(clip(norm(q), 60)); stat.quotesOk++; }
    }
    if (!quotes.length) return null;   // 실제 리뷰에서 확인된 인용이 하나도 없으면 버림 (지어낸 항목 방지)
    stat.kept++;
    // 공감 수: 근거 리뷰들의 공감 합 (화면에서 '공감 많은 의견' 순서에 씀)
    const likes = refs.reduce((s, n) => s + (sample[n - 1].likes || 0), 0);
    // 건수는 표본 안의 수여야 한다: 표본보다 크거나 숫자가 아니면 근거 리뷰 수로, 근거 수보다 작으면 근거 수로
    const n = Number.isInteger(it.n) && it.n <= sample.length ? Math.max(it.n, refs.length) : refs.length;
    return Object.assign({}, it, { n, refs: refs.length, quotes, likes });
  }).filter(Boolean);
  return {
    summary: { headline: norm(sum.headline), tropes: fix(sum.tropes), likes: fix(sum.likes), dislikes: fix(sum.dislikes),
      immersion: fix(sum.immersion), audience: norm(sum.audience) },
    stat
  };
}
