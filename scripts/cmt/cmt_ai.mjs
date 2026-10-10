import { cut } from "./ridi_comments.mjs";

/* 회차 댓글 분석 — Claude API 부분 (2판: '반복되는 반응을 있는 그대로 세기')
 *
 * 1단계(Sonnet): 작품마다 댓글 표본을 읽고 '독자들이 반복해서 하는 말' 묶음(좋다는 말 / 많이 하는 말 / 불호)을 정한다.
 * 2단계(Haiku): 댓글 하나마다 어느 묶음에 해당하는지(th) + 속뜻(tn) + 직접 드러난 니즈(nd)만 붙인다. 개수는 프로그램이 센다.
 * 3단계(Sonnet): 참고용 니즈 맵.
 * 원문 인용 대신 댓글 번호(refs)로 근거를 단다 — 결과 파일에 댓글 원문이 들어가지 않게.
 *
 * 1판(12칸 분류 + 해석형 종합)은 사람 재검토에서 34%가 속뜻과 달랐다(2026-10-10, 612개):
 * '불만형' 105개 중 99개가 실제로는 연재 아쉬움·캐릭터 과몰입·애정 투정이었고, 니즈는 43%만 맞았다.
 * 아래 규칙은 그 재검토에서 나온 것이다.
 */

// 속뜻: 겉말이 불평이어도 속뜻이 애정이면 불만이 아니다 (사용자 지적, 2026-10-10)
export const TONES = { praise: "칭찬·환호", char: "캐릭터 과몰입", tease: "애정 투정·반어", miss: "연재 아쉬움", nudge: "애정 섞인 지적·진도 투정", critic: "진짜 작품 불만", theory: "추리·예측", fan: "독자끼리·작품 외", other: "단순·기타" };
export const BUCKETS = { like: "좋다는 말", talk: "많이 하는 말", dislike: "불호" };
export const AXES = { hero: "주인공", romance: "로맨스", fantasy: "판타지", relation: "관계·조연", craft: "작화·연출", ops: "연재 운영", orig: "원작 비교", etc: "기타" };
export const NEEDS = {
  hero_revenge: "응징·사이다", hero_status: "인정·위상 역전", hero_growth: "성장·노력의 보상", hero_agency: "주체성", hero_heal: "상처와 치유", hero_tension: "긴장감·대가",
  rom_progress: "관계 진전", rom_mutual: "쌍방 확인", rom_power: "관계의 힘 구도", rom_jealous: "질투·독점", rom_conflict: "갈등의 종류", rom_salvation: "구원", rom_sub: "서브 캐릭터",
  fan_reveal: "세계관·비밀 공개", fan_system: "능력 체계의 일관성", fan_action: "전투·액션 쾌감", fan_strategy: "두뇌전·전략", fan_regress: "회귀·빙의 정보 우위", fan_scale: "스케일 확장",
  rel_family: "가족 서사", rel_friend: "동료·우정", rel_villain: "악역 서사"
};
export const NEED_AXIS = (code) => ({ hero: "hero", rom: "romance", fan: "fantasy", rel: "relation" })[code.split("_")[0]] || "etc";
export const STATES = { met: "충족", lack: "결핍", ask: "요구", split: "호불호 갈림", none: "해당 없음" };
export const ACTIONS = { pay: "결제·전환", stay: "기다림·유지", share: "추천·전파", churn: "이탈 경고", none: "없음" };
export const CONFS = { hi: "높음", mid: "중간", lo: "낮음" };

const E = (o) => Object.keys(o);
const list = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ");
const REFS = { type: "array", items: { type: "integer" } };

// ---------------- 1단계: 반복되는 반응 찾기 (Sonnet) ----------------
export const THEME_SCHEMA = {
  type: "object", additionalProperties: false, required: ["themes"],
  properties: {
    themes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["bucket", "label", "def", "refs"],
        properties: { bucket: { type: "string", enum: E(BUCKETS) }, label: { type: "string" }, def: { type: "string" }, refs: REFS }
      }
    }
  }
};

export const THEME_SYSTEM = `당신은 웹툰·웹소설 회차 댓글에서 '독자들이 반복해서 하는 말'을 찾는 분석가입니다. 숨은 뜻을 해석하지 말고, 독자들이 실제로 되풀이하는 말을 있는 그대로 묶되, 결과에는 댓글 원문을 옮겨 적지 않습니다(결과가 공개되므로 근거는 refs 번호로만). 결과는 기획자가 "이런 반응이 반복된다, 이런 말이 많다, 이런 불호가 있다"를 보는 데 쓰입니다.

## 할 일
최근 회차 댓글 표본을 읽고, 여러 댓글에서 되풀이되는 말을 15~22개 묶음으로 정리합니다. 목표는 '무언가 구체적인 말을 하는 댓글'의 대부분이 어느 한 묶음에 들어가게 하는 것입니다.
- 먼저 작품 전체에 걸쳐 여러 회차에 나오는 반응을 찾습니다(예: 작화가 화보 같다, 공의 미모 감탄, 수의 성격 매력, 공의 질투·집착이 웃기고 좋다, 원작 장면 재현 만족, 다음 화·휴재 기다림). 이런 묶음의 label·def에는 회차를 붙이지 않습니다.
- 그다음 특정 회차 장면에 몰린 반응(예: 27화 포토부스 키스 환호)은 정말 그 회차(와 바로 다음 화)에만 몰릴 때만 따로 묶고, label 앞에 회차를 붙입니다('27화: …'). 같은 반응이 다른 회차에도 나오면 회차 없는 작품 전체 묶음으로 만듭니다.
- 이런 반응을 빠뜨리지 않았는지 확인합니다: 인물별 외모 매력, 인물별 성격·관계 매력, 커플 케미, 질투·집착, 수위·씬, 작화·연출, 원작 재현·원작 비교, 명장면 기대(원작 독자가 기다리는 장면), 캐릭터에게 화내기·놀리기(인물별), 악역·방해꾼 미워하기, 연재 기다림·절단 투정, 추리·예측.
- 각 묶음:
  · bucket: like(좋다는 말) / talk(많이 하는 말) / dislike(불호)
  · label: 여러 댓글이 공통으로 하는 말을 25자 안팎으로, 독자 말투에 가깝게 자기 말로 요약. 특정 댓글 문장을 그대로 옮기지 않는다(예: '신루가 미모로 유혹하는 게 좋다', '휴재·시즌 완결이 너무 아쉽다', '헌터에게 마음 인정하라고 다그침')
  · def: 다른 AI가 댓글 하나하나를 이 묶음에 넣을지 판단할 기준. 60자 안팎. 헷갈리는 이웃 묶음과 어떻게 다른지도 짧게. def에도 댓글 문장을 옮기지 않고 특징을 설명한다.
  · refs: 근거 댓글 번호 2~5개

## bucket 기준 (가장 중요)
- like: 작품·장면·인물·작화·연출을 좋다고 하는 말. 인물의 외모·성격·매력 칭찬('렉스 존잘'), 장면 환호('드디어 키스!', '최고의 추석 선물')는 부탁이 섞여도 like다. 반어·밈으로 한 칭찬도 like다:
  'X 얘기 좀 그만해요'라면서 문장 사이사이에 X를 끼워 넣음(= X가 좋다), '외모가 반칙·흉기', '적당히 더 하세요', '몇백 원에 이걸 봐도 되나', '몸 보느라 대사를 못 읽음', '웹툰이에요 화보예요?'
- talk: 좋다·싫다로 가르기 애매하거나 화제인 말:
  · 캐릭터에게 하는 말 — 화내기·욕·놀림·서운함·타박·훈수·명령('예쁘면 다냐', '정작 본인은 멀쩡한데 내가 서운함', '빨리 마음 인정해 바보야', 악역 미워하기)
  · 연재 아쉬움 — 휴재·시즌 완결·분량·기다림('규탄한다 보장하라', '이제 무슨 낙으로 살아', '벌써 끝?'), 절단 투정('왜 여기서 끊어요ㅠ')
  · 추리·예측·상상, 수위·씬 조르기, 원작 비교·원작 회차 질문, 다음 전개 기대
  · 애정 섞인 지적이나 진도 투정('재밌는데 팔이 짧아 보여요, 그것만 부탁', '진도 너무 느려어어', '이 에피소드를 4화나 끈다고? 너무하네')
- dislike: 작품을 만든 방식(전개·개연성·캐붕·작화·연출·과한 수위)이나 작가를 분명하고 진지하게 비판하는 말, 진지한 하차 선언, 결제가 아깝다는 말만.
  · 웃음·ㅠ·애칭·과장이 섞인 투정, 정중한 부탁형 지적, 캐릭터의 행동에 화내는 말, 휴재·완결 아쉬움은 dislike가 아니라 talk다.
  · 상위 작품은 진짜 불호가 매우 드물다(재검토에서 612개 중 5개). 분명한 근거가 여러 개 없으면 dislike 묶음을 만들지 않는다. 0개여도 된다.

## 주의
- 묶음끼리 겹치지 않게. '재밌다'처럼 너무 넓은 묶음은 만들지 않는다 — 무엇이 좋은지, 무슨 말인지 구체적으로.
- 한 묶음 = 한 가지 반응. 같은 회차라는 이유만으로 서로 다른 반응(예: 사진 이야기 + 조연 미움)을 한 묶음에 섞지 않는다.
- '재밌어요', '1등', 'ㅋㅋㅋ'뿐인 댓글은 묶지 않아도 된다(분류에서 '해당 없음'으로 남음).
- 지어내지 않는다. 표본에 실제로 여러 번 나온 말만.`;

export function buildThemeParams(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: THEME_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 댓글 표본에서 반복되는 반응 묶음을 JSON으로 정리하세요." }],
    output_config: { format: { type: "json_schema", schema: THEME_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// ---------------- 2단계: 댓글마다 묶음·속뜻·니즈 표시 (Haiku) ----------------
export const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["comments"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["n", "th", "tn", "nd", "st", "nn", "ac", "cf"],
        properties: {
          n: { type: "integer" },
          th: { type: "array", items: { type: "string" } },
          tn: { type: "string", enum: E(TONES) },
          nd: { type: "array", items: { type: "string", enum: E(NEEDS) } },
          st: { type: "string", enum: E(STATES) },
          nn: { type: "string" },
          ac: { type: "string", enum: E(ACTIONS) },
          cf: { type: "string", enum: E(CONFS) }
        }
      }
    }
  }
};

export const CLASSIFY_SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 리디(RIDI)의 '회차 댓글'을 하나하나 읽고 표시를 붙이는 분석가입니다. 해석보다 '이 댓글이 무슨 말을 하는지'를 정확히 잡는 것이 목표입니다.

댓글마다 아래 칸을 채웁니다. 값은 반드시 정해진 코드로 씁니다.

- th 반복 반응: 입력의 [반복 반응 목록]에서 이 댓글이 해당하는 묶음 번호(T1, T2 …) 0~2개. 댓글마다 목록 전체를 훑어, 댓글의 주된 말이 어떤 묶음의 기준(def) 범위 안에 들면 넣는다 — 묶음 이름과 표현이 똑같지 않아도, 다른 회차의 같은 반응이어도 넣는다. 회차가 붙은 묶음('27화: …')은 그 장면 이야기일 때만. '재밌어요', 'ㅋㅋㅋ'처럼 구체적인 말이 없거나 맞는 묶음이 정말 없을 때만 []. (불호) 묶음은 tn=critic일 때만 고른다 — 애정 섞인 지적·진도 투정·과몰입·연재 아쉬움은 (많이 하는 말) 묶음에서 고른다.
- tn 속뜻(겉말이 아니라 속뜻 기준 하나): ${list(TONES)}
- nd 니즈 코드(0~3개, 댓글 문장에 직접 나온 것만): ${list(NEEDS)}
- st 니즈 상태: ${list(STATES)}
- nn 목록에 없는 바람의 짧은 이름(댓글 문장을 베끼지 말고 니즈 이름으로. 예: '수위·씬', '원작 명장면 재현', '각색·오리지널 씬', '후회 전개(구르기)'). 없으면 ""
- ac 행동 신호: ${list(ACTIONS)}
- cf 확신도: ${list(CONFS)}

## 속뜻(tn) 정하는 순서
1. 감정이 누구를 향하는지 본다: ① 작중 인물 ② 연재 일정(휴재·완결·분량·끊긴 지점·기다림) ③ 작품을 만든 방식(전개·구성·작화·연출·작가) ④ 다른 독자나 작품 밖.
2. 판별 질문: 작가가 작품 내용·그리는 방식을 고쳐야 한다고 '진지하게' 탓하는가(좋다는 말·부탁·ㅠ·늘인 말끝·투정 없이) → critic. 좋아하면서 부탁하거나 진도·속도를 조르는가 → nudge. 작중 인물에게 하는 말인가 → char. 그냥 빨리 더 보고 싶은 것인가(연재 일정·운영 포함) → miss 또는 tease.
3. 겉말이 불평·욕·항의여도 속뜻이 '좋다' 또는 '더 보고 싶다'면 critic이 아니다.

## 값의 뜻
- praise 칭찬·환호: 작품·장면·작화·인물의 매력을 좋다고 하는 말. 짧은 감탄('미쳤다', '와ㅠㅠ', 'Good'), 복귀 환영, 소장 자랑 포함.
- char 캐릭터 과몰입: 작중 인물에게 화·욕·놀림·서운함·걱정·타박·편들기·명령·훈수, 별명 부르기, 악역 미워하기. 예) "잘생기면 다예요? 하는 짓 좀 보라고ㅋㅋ", "당사자는 태연한데 왜 보는 내가 섭섭하지", "사과해", "언제 철들래". 외모를 욕해도 작화 불만이 아니다.
- tease 애정 투정·반어·밈: 불평처럼 보이지만 속은 좋아하는 말.
  · 절단 투정: '여기서 끊어요?', '끊기 있기 없기', '감질나', '작가님 잔인하시다', 인물에게 '마저 해라'
  · 금지어 끼워 넣기: 'X 얘기 그만해'라며 문장 사이사이에 X를 반복 = X가 좋다. 예) "허벅지 얘기 그만해요 허벅지 진짜 허벅지 지겹다니까요 허벅지"
  · '적당히 (더) 하세요', '그만 좀 설레게 해', 외모·스킨십을 '흉기·반칙·폭력'으로 표현
  · '몸이나 얼굴 보느라 내용이 기억 안 남' = 작화 극찬(내용이 약하다는 불만 아님)
  · 가격 죄책감('몇백 원에 이걸 봐도 되나') = 가성비 극찬
  · 장르 바뀜 드립('호러물인 줄', '스릴러 봤다') = 집착·질투 장면 몰입
  · 수위·씬 조르기('왜 성인 등급인지 다음 화에 증명해 주세요'), 하차 농담('이러다 하차각ㅋㅋ')
  · 양보절('답답하긴 한데 귀여우니 봐준다')은 뒤가 본심
- miss 연재 아쉬움: 휴재·시즌 완결·분량·기다림에 대한 비명 = 더 보고 싶다. 시위 구호('결사반대', '보장하라'), 상실 과장('이제 무슨 낙으로 살아'), 부정('완결이 뭐죠?'), 애원('가지 마요'), 분량('벌써 끝?'), '하 이걸 또 일주일을', 연재일 착각, 스포 구걸, 업데이트 요청. 휴재·지각·공지·분량 같은 연재 운영 이야기는 비꼬거나 화를 내도('공지도 없이 또 휴재?', '오늘도 지각이네요') miss다. 예) "휴재 결사반대!! 독자 생존권 보장하라"
- nudge 애정 섞인 지적·진도 투정: 재밌다·좋다는 말이나 부탁과 함께 하는 작화·전개 지적('재밌게 보고 있어요, 근데 손이 좀 어색해요 그것만 부탁드려요'), 투정 말투의 진도·속도 불평('진도 너무 느려어어', '이 에피소드를 4화나 끈다고? 너무하네', '언제 사귀어요 진도 좀'). 작가에게 하는 말이어도 critic이 아니다.
- critic 진짜 작품 불만: 작품을 만든 방식이나 작가를 향한 진지한 비판만.
  · 전개('산으로 간다', '개연성 없다', '캐붕'), 구성(같은 패턴이 반복돼 지루하다·지친다는 진지한 비판. 화수를 세며 투정하는 말은 nudge)
  · 작화('그림체가 바뀐 것 같다', '비율이 어색하다', 좋아진다는 말 없이 '작화가 점점…ㅠ'), 연출('경기 장면 효과가 약하다')
  · 수위 과잉 진지한 비판('또 벗기냐 스토리는 언제'), 작품이 인물의 잘못을 미화한다는 비판(인물의 행동이 아니라 작품의 그리는 방식을 탓할 때)
  · 진지한 하차 선언, '결제 아깝다'(작품 값어치 탓)
  · 웃음이나 ㅠ 없이 건조하게 쓴 짧은 관찰도 critic 후보로 두되 cf=lo
- theory 추리·예측·망상: 아직 일어나지 않은 구체적 사건을 짐작하거나 상상할 때만. '재밌다 어떻게 되려나', '이 장면만 기다렸다'는 praise.
- fan 독자끼리·작품 밖: 다른 독자(스포·댓글 매너)를 향한 말, 플랫폼·다른 작품 이야기.
- other 단순·중립: 정보 질문(원작 몇 권이에요?), 맥락 없는 답글, 방향을 알 수 없는 반응.
여러 감정이 섞이면 주된 감정으로. 좋다는 말·부탁과 지적이 함께 있으면 nudge. 칭찬·부탁·투정 없이 진지한 비판만 있을 때 critic.

## 니즈(nd): 댓글 문장에 직접 나온 서사만 — 과다 부착 금지
- nd는 댓글이 그 서사 요소(고백·키스·질투·사과·위기 등)를 직접 가리킬 때만 붙인다. 회차 분위기나 '이 화에서 일어난 일'로 짐작해 넣지 않는다. 애매하면 [].
- nd=[]: 감탄만 있는 말('미쳤다', '야하다', '설렌다', '울면서 봤다'), 외모·작화 칭찬, 기다림·분량·휴재 반응(miss는 항상 []), 독자 자신의 이야기('내 도파민 돌아옴'), 별명·애칭 욕 하나뿐인 말.
- rom_mutual: 고백·마음 확인·엇갈림이 언급될 때만(키스·스킨십 환호엔 rom_progress만). rom_progress: 고백·키스·사귐·동거·호칭 변화 같은 관계 단계.
- hero_tension: 주인공 승리의 대가·난이도 이야기만(커플 '텐션', 클리프행어, 무서운 연출엔 쓰지 않음). hero_agency: 주인공이 행동하지 않아 사건이 멈출 때만(로맨스 상대가 마음을 인정 못 해 답답한 건 rom_mutual).
- rom_sub: 서브 캐릭터의 매력. rel_family: 실제 작중 가족 서사만(커플을 '엄마아빠'라 부르는 밈은 rom_progress). hero_heal: 작중 인물의 상처 회복(독자가 위로받았다는 말 아님). fan_reveal: 특정 떡밥·비밀이 궁금할 때(수위 조르기에 쓰지 않음).
- 과몰입 댓글에서 독자가 인물에게 시키는 행동 = 독자가 원하는 전개(st=ask): 마음 인정·고백해라→rom_mutual, 이제 사귀어라·책임져라→rom_progress, 사과해라·굴러라→rom_power + nn '후회 전개(구르기)', 악역에게 꺼져→rel_villain met, 질투하는 인물 놀림→rom_jealous met.
- 수위 감탄·조르기 → nd=[] 또는 그대로 두고 nn '수위·씬'. 원작 장면 구현의 기쁨 → nn '원작 명장면 재현'. 각색 칭찬 → nn '각색·오리지널 씬'.

## 상태(st)·행동(ac)
- st: met=이 화에서 채워져 좋아함 / ask=앞으로 이렇게 되길 바람 / lack=진짜 피로감('지친다', '언제까지 끌어', '또 이 패턴')이 있을 때만 / split=독자끼리 갈림이 드러남 / none=니즈 없음. 절단·기다림 반응엔 met 금지, 놀림·관전엔 lack 금지.
- ac: pay=소장·결제·원작 구매 언급 / stay=다음 화 기다림 / share=영업·주변 사람 언급 / churn=독자 자신이 진지하게 그만 보겠다고 할 때만(char·tease·miss·nudge엔 쓰지 않음) / none. '사랑해요·응원해요'만으로는 붙이지 않는다.

## 출력
입력의 댓글 번호(#n)마다 하나씩, 빠짐없이 JSON으로 답한다. 지어내지 않는다.`;

function workBlock(work, ep, themes) {
  return `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.bl ? " / BL" : ""}\n[작품 소개] ${work.desc || "-"}\n[회차] ${ep.no}화 (공개 ${String(ep.reg || "").slice(0, 10)})\n\n` +
    `[반복 반응 목록]\n` + themes.map((t) => `${t.id} (${BUCKETS[t.bucket]}) ${t.label} — 기준: ${t.def}`).join("\n");
}

// 댓글 묶음 하나의 요청. comments: [{n, text, like, sp, best}]
export function buildClassifyParams(cfg, work, ep, comments, textMax, themes) {
  const body = workBlock(work, ep, themes) + "\n\n[댓글]\n" +
    comments.map((c) => `#${c.n} [좋아요 ${c.like}${c.best ? "·베스트" : ""}${c.sp ? "·스포" : ""}] ${cut(c.text.trim().replace(/\s+/g, " "), textMax)}`).join("\n") +
    "\n\n위 댓글에 규칙대로 표시를 붙여 JSON으로 답하세요.";
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: [{ type: "text", text: CLASSIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// ---------------- 3단계: 참고용 니즈 맵 (Sonnet) ----------------
export const NEEDS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["needs"],
  properties: {
    needs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["axis", "need", "state", "evidence", "size", "why", "refs"],
        properties: {
          axis: { type: "string", enum: E(AXES) },
          need: { type: "string" },
          state: { type: "string", enum: ["met", "lack", "ask", "split"] },
          evidence: { type: "string" },
          size: { type: "string", enum: ["상", "중", "하"] },
          why: { type: "string" },
          refs: REFS
        }
      }
    }
  }
};

export const NEEDS_SYSTEM = `당신은 웹소설·웹툰 기획자를 돕는 분석가입니다. 한 작품의 최근 회차 댓글(표시가 붙어 있음)과 니즈 통계를 받아 '니즈 맵'을 씁니다. 이 표는 참고용이며, 숫자와 근거가 분명한 것만 씁니다.

## 니즈 맵 한 줄 = (서사 축, 니즈, 상태, 근거 회차·장면, 크기, 크기 판단 이유, 근거 댓글 번호)
- need는 니즈 이름(목록 이름 그대로) 또는 신규 후보 이름.
- 상태: met(충족)/ask(요구 — 아직 안 채워진 바람)/lack(결핍 — 진짜 피로감·작품 불만이 근거일 때만)/split(호불호 갈림).
- 크기(상/중/하): 관련 댓글 수, 관련 댓글 좋아요 합, 여러 회차 반복 여부, 그 니즈가 채워진 회차의 댓글 증가, 결제 신호 동반(돈이 움직인 니즈가 진짜 니즈)으로 판단하고 why에 숫자로 적는다.
- 근거 댓글이 3개 미만인 니즈는 넣지 않는다. 8~12줄 이내.

## 규칙
- 캐릭터에게 화내기·놀리기·서운함(과몰입)은 불만이 아니다. 독자가 인물에게 시키는 행동(고백해라, 사과해라, 이제 사귀어라)은 ask(주문서)로 옮긴다.
- 휴재·완결·분량 아쉬움, 절단 투정은 니즈 결핍(lack)의 근거가 아니다.
- 감탄만 있는 댓글에 붙은 니즈는 과다 부착일 수 있으니 무게를 낮춘다.
- 숫자를 부풀리지 않는다. refs에는 실제로 그 내용을 말한 댓글 번호만.
- evidence·why에 댓글 문장을 옮겨 적지 않는다(따옴표 인용 포함). 회차·장면은 요약해서 쓰고, 근거는 refs 번호로만.
- 모든 문장은 쉬운 한국어로.`;

export function buildNeedsParams(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: NEEDS_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 자료로 참고용 니즈 맵을 JSON으로 쓰세요." }],
    output_config: { format: { type: "json_schema", schema: NEEDS_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

export function parseJson(msg) {
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch (e) { throw new Error("JSON 해석 실패 (stop_reason=" + msg.stop_reason + ")"); }
}
