/* 리뷰 분석 엔진(docs/rabsa.js)에 넘길 작품 정보 만들기
 *
 *   webtoon: 웹툰·만화인가 ('연출·표정·묘사'는 그림 얘기, '예쁘다'는 그림 칭찬)
 *   bl:      BL인가 ('수가 귀엽다'의 수·공은 인물)
 *   orig:    원작 소설이 있는가 ('원작은 ~했는데 웹툰은 ~' = 각색 평가)
 *   authors: 작가 이름 ('○○님 작품은 다 좋아요' = 작가 신뢰)
 *   names:   소개글에 나오는 인물 이름 ('파냐 너무 귀여워요' = 캐릭터 칭찬)
 *   others:  같은 작가의 다른 작품 제목 ('만추여관 재밌게 읽었는데' = 다른 작품 얘기)
 */
const fs = require("fs");
const path = require("path");
const RABSA = require("../docs/rabsa.js");

// 소개글에서 '조사 앞 낱말'을 뽑는다 ('류호피는', '카일이가' → 류호피, 카일이·카일)
const STEM_RE = /(?:^|[^가-힣])([가-힣]{2,5})(?:은|는|이|가|의|와|과|에게|을|를|랑|이와|에게서|한테|이는|이가|이의|이를)(?=[^가-힣]|$)/g;
const NOT_NAME_END = /(하|되|스러|로|에서|으로|처럼|까지|부터|에게|하고|했|었|았|겠|들|님|씨|적|게|기|함|음|다|에|라|내|보|며|고|과|와)$/;
function nameStems(desc) {
  const out = new Set();
  let m;
  STEM_RE.lastIndex = 0;
  while ((m = STEM_RE.exec(desc || ""))) {
    const w = m[1];
    out.add(w);
    if (w.length >= 3 && /이$/.test(w)) out.add(w.slice(0, -1));   // '재인이' → 재인
  }
  return out;
}

// 전체 소개글에서 낱말이 몇 작품에 나오는지 — 여러 작품에 흔히 나오면 이름이 아니라 보통 낱말
function buildNameDf(booksDir) {
  const df = {};
  for (const f of fs.readdirSync(booksDir)) {
    if (!f.endsWith(".json")) continue;
    let det;
    try { det = JSON.parse(fs.readFileSync(path.join(booksDir, f), "utf8")); } catch (e) { continue; }
    for (const w of nameStems(det.description)) df[w] = (df[w] || 0) + 1;
  }
  return df;
}

// 제목 정리: '[연재] 상수리나무 아래 (개정판) 3권' → 상수리나무아래
function normTitle(t) {
  return (t || "").replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/(세트|개정판|합본|외전|특별판|완전판|연재|단행본|e북|[0-9]+\s?(권|부|화))/gi, " ")
    .replace(/\s+/g, "").trim();
}

let authorIndex = null;   // 작가 이름 → [작품 id]
function buildAuthorIndex(catalog) {
  authorIndex = {};
  for (const id of Object.keys(catalog)) {
    for (const a of (catalog[id].a || [])) (authorIndex[a] = authorIndex[a] || []).push(id);
  }
}

function reviewOpts(det, catEntry, df, catalog, opts2) {
  if (!det) return {};
  const tags = [].concat(det.keywords || [], det.meta_tags || [], det.tags || []).join("|");
  const roles = det.authors_full || [];
  const authors = Array.from(new Set(roles.map((a) => a.name).concat((catEntry && catEntry.a) || [])))
    .filter((n) => n && n.replace(/\s/g, "").length >= 2);
  const names = Array.from(nameStems(det.description))
    .filter((w) => (df[w] || 0) <= 6 && !NOT_NAME_END.test(w) && !RABSA.isLexicon(w) && !authors.includes(w))
    .slice(0, 15);
  let others = [];
  if (catalog) {
    if (!authorIndex) buildAuthorIndex(catalog);
    const me = normTitle(det.title || (catEntry && catEntry.t));
    const seen = new Set();
    for (const a of authors) {
      for (const oid of (authorIndex[a] || [])) {
        if (oid === det.id) continue;
        const ot = normTitle(catalog[oid].t);
        if (ot.length < 3 || !me || ot.includes(me) || me.includes(ot) || seen.has(ot)) continue;
        seen.add(ot);
        others.push(ot);
      }
    }
    others = others.slice(0, 20);
  }
  const hasOrig = roles.some((a) => a.role === "original_author");
  return {
    // 원작 작가가 따로 있으면 웹툰(코믹스)이다 — 태그가 비어 있는 작품도 있어서
    webtoon: /웹툰|만화/.test(tags) || hasOrig || !!(opts2 && opts2.webtoonIds && opts2.webtoonIds.has(det.id)),
    bl: /BL|비엘/i.test(tags),
    orig: hasOrig || /원작소설有/.test(tags),
    authors, names, others
  };
}

// 소개글에서 뽑은 이름 후보 중 실제 리뷰에 자주 나오는 것만 남긴다 (리뷰 3건 이상 또는 0.2% 이상)
function confirmNames(names, texts) {
  const min = Math.max(3, Math.round(texts.length * 0.002));
  return names.filter((n) => {
    let c = 0;
    for (const t of texts) { if (t && t.indexOf(n) >= 0 && ++c >= min) return true; }
    return false;
  });
}

module.exports = { reviewOpts, buildNameDf, nameStems, normTitle, confirmNames };
