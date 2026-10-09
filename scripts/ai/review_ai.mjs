/* 리뷰 요소별 분석 — Claude API 버전
 *
 * 규칙 엔진(docs/rabsa.js)과 같은 요소·뉘앙스 체계로 '자세한 리뷰'를 AI가 읽고 판정한다.
 * 한 번에 여러 리뷰(같은 작품)를 묶어 보내고, 결과는 JSON(구조화 출력)으로 받는다.
 *   요소 e: rabsa.js 의 요소 키와 같다 (art, story, … overall, adapt)
 *   뉘앙스 lv: strong(강한 호평) pos(호평) mild(무난) mildneg(약한 아쉬움) neg(아쉬움) strongneg(강한 불만)
 *   q: 근거 구절(원문 그대로, 짧게) / over: 캐릭터 과몰입 구절
 * API 키는 환경 변수 ANTHROPIC_API_KEY (GitHub Actions 시크릿)에서 SDK가 읽는다.
 */
import Anthropic from "@anthropic-ai/sdk";

export const ELEMENTS = {
  art: "그림·작화", story: "스토리·전개", character: "캐릭터 매력", chemistry: "케미·관계", romance: "설렘·로맨스",
  immersion: "몰입·재미", writing: "필력·문장", emotion: "분위기·감성", humor: "유머·개그", setting: "세계관·설정",
  spice: "수위", ending: "분량·완결·외전", price: "가격·과금", author: "작가·전작 신뢰", overall: "작품 전체", adapt: "원작 각색"
};
export const LEVELS = ["strong", "pos", "mild", "mildneg", "neg", "strongneg"];

export const SCHEMA = {
  type: "object", additionalProperties: false, required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["n", "items", "over"],
        properties: {
          n: { type: "integer" },
          items: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["e", "lv", "q"],
              properties: {
                e: { type: "string", enum: Object.keys(ELEMENTS) },
                lv: { type: "string", enum: LEVELS },
                q: { type: "string" }
              }
            }
          },
          over: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

export const SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 리디(RIDI)의 구매자 리뷰를 읽고, 리뷰어가 "이 작품"의 어떤 요소를 어떻게 평가했는지 뽑는 분석가입니다. 결과는 작품 상세 화면의 '요소별 반응'과 '독자들의 공통 의견'에 쓰입니다.

## 요소 (e)
- art 그림·작화: 웹툰·만화의 그림, 작화, 채색, 연출, 표지·일러스트
- story 스토리·전개: 줄거리, 전개 속도, 개연성, 복선, 구성, 결말 직전까지의 흐름
- character 캐릭터 매력: 특정 인물(남주·여주·공·수·조연, 이름)이나 인물 설정에 대한 평가
- chemistry 케미·관계: 두 인물의 관계성, 티키타카, 커플 조합
- romance 설렘·로맨스: 설렘, 달달함, 로맨스 감정선
- immersion 몰입·재미: 재미, 몰입, 술술 읽힘, 다음 화가 궁금함, 정주행·밤샘
- writing 필력·문장: 문장, 문체, 묘사(웹소설), 대사, 오탈자·비문, 번역
- emotion 분위기·감성: 분위기, 여운, 감동, 눈물, 잔잔함
- humor 유머·개그
- setting 세계관·설정: 세계관, 소재, 설정의 신선함·진부함, 클리셰
- spice 수위: 수위, 씬(성적 장면), 잔인함 정도
- ending 분량·완결·외전: 결말·완결·외전·분량. '끝나서 아쉽다, 보내기 싫다, 더 보고 싶다'는 애정이므로 pos
- price 가격·과금: 가격, 돈값, 돈이 아깝다/아깝지 않다
- author 작가·전작 신뢰: 작가에 대한 신뢰·칭찬('믿고 보는 작가', '작가님 글은 다 좋다')
- overall 작품 전체: 특정 요소를 짚지 않고 작품 전체를 평가할 때만('인생작', '최고예요', '하차합니다', '그냥 그래요')
- adapt 원작 각색: [원작 소설 있음]인 웹툰에서만. 원작 대비 웹툰의 각색·재현·생략·변경에 대한 평가('원작을 잘 살렸다', '원작 대사를 다 빼먹었다')

## 뉘앙스 (lv)
- strong 강한 호평: 인생작, 미쳤다(좋은 뜻), 최고, 지루할 틈이 없다, 정신 못 차리게 재밌다, 강조('너무너무', '!!!')
- pos 호평: 재밌어요, 좋아요, 예뻐요
- mild 무난: 칭찬이지만 '그냥 그렇다'에 가까운 말 — 괜찮다, 볼만하다, 나쁘지 않다, 무난하다, '○○ 같은 건 그다지 없다'
- mildneg 약한 아쉬움: 살짝/조금 아쉽다, 그냥 그래요, 양보하며 한 지적('물론 비문도 있지만…', '느낄 순 있지만')
- neg 아쉬움: 아쉽다, 별로, 지루하다, 답답하다
- strongneg 강한 불만: 최악, 하차, 돈 아깝다, 포기했다

## 이 작품 평가가 아닌 것 (items에 넣지 않음)
- 다른 작품, 같은 작가의 전작·다른 작품, 원작 소설 자체에 대한 말. 단 비교('다른 소설보다 재밌다', '원작보다 웹툰이 낫다')는 이 작품 평가로 센다.
- 남의 의견 옮기기('다들 재밌다길래', '평이 좋아서 샀는데', '불호 리뷰가 많던데').
- 읽기 전의 기대·추측과 바람('재밌을 것 같아요', '기대돼요', '~했으면 좋겠어요', '외전 주세요'). 읽고 나서 조심스럽게 한 평가('재밌는 것 같아요')는 센다.
- 줄거리 소개, 인물이 느끼는 감정, 작품 속 대사·제목에 든 단어.
- 평소 취향·습관 이야기('원래 이런 장르 안 좋아하는데', '보통은 초반에 하차하는데').
- 연재 주기, 플랫폼, 이벤트에 대한 말(가격이 아니면).

## 캐릭터 과몰입 (over)
작품을 즐기고 있는 리뷰에서 캐릭터에게 화내거나 욕하거나 애정으로 놀리는 말('남주 쓰레기 ㅠㅠ 패고 싶다', '류호피 개바보야 제 최애')은 작품 불만이 아니라 몰입 반응입니다. 그 구절을 over에 넣고 items에는 넣지 마세요. 반대로 불만이 중심인 리뷰(하차, 별로, 답답해서 못 읽겠다)에서의 캐릭터 비판은 character의 neg/strongneg로 넣습니다.

## 시간에 따라 바뀐 평가
'초반엔 지루했는데 갈수록 재밌다' → 지금 평가(재밌다)를 센다. 초반 지루함은 mildneg로 넣어도 된다. '초반엔 재밌었는데 갈수록 별로' → 지금 평가(별로)만 센다. '취향 아닌 줄 알았는데 재밌다'의 앞부분은 넣지 않는다.

## 출력 규칙
- 리뷰마다 n(리뷰 번호), items, over를 낸다. 평가가 없으면 items는 빈 배열.
- 한 리뷰에서 같은 요소는 한 번만, 가장 대표적인 판정으로. 서로 다른 요소는 여러 개 가능.
- 하나의 말이 두 요소에 걸치면(예: '복선들이 재미있다' → story, immersion) 둘 다 넣어도 된다.
- q에는 판정의 근거가 된 원문 구절을 고치지 말고 그대로 짧게(40자 이내) 적는다.
- 확실하지 않으면 넣지 않는다. 지어내지 않는다.`;

function workBlock(work) {
  const yn = (b) => (b ? "예" : "아니오");
  return `[작품] 제목: ${work.title || "?"} / 웹툰·만화: ${yn(work.webtoon)} / BL: ${yn(work.bl)} / 원작 소설 있음: ${yn(work.orig)}` +
    (work.authors && work.authors.length ? ` / 작가: ${work.authors.join(", ")}` : "");
}

export function makeClient() { return new Anthropic(); }

// 같은 작품의 리뷰 묶음 하나를 분석한다. reviews: [{n, text}]
// cfg: {model, effort, thinking: "disabled" | undefined}
export async function analyzeBatch(client, cfg, work, reviews) {
  const body = workBlock(work) + "\n\n[리뷰]\n" + reviews.map((r) => `#${r.n}\n${r.text.trim()}`).join("\n\n") +
    "\n\n위 리뷰를 규칙대로 분석해 JSON으로 답하세요.";
  const req = {
    model: cfg.model,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  if (cfg.thinking === "disabled") req.thinking = { type: "disabled" };
  const msg = await client.messages.stream(req).finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error("JSON 해석 실패 (stop_reason=" + msg.stop_reason + ")"); }
  return { reviews: parsed.reviews || [], usage: msg.usage, stop: msg.stop_reason };
}
