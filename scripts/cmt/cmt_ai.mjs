/* 회차 댓글 분석 — Claude API 부분
 *
 * 1단계(Haiku): 댓글 하나마다 분류 칸(유형·서사 축·니즈·니즈 상태·실제 평가·감정 대상·행동 신호·독자 유형·몰입 단계·캐릭터·장면·확신도)을 붙인다.
 * 2단계(Sonnet): 작품 하나의 분류 결과·회차 숫자를 모아 화별 반응 요약과 '니즈 맵'을 쓴다.
 * 원문 인용 대신 댓글 번호(refs)로 근거를 단다 — 결과 파일에 댓글 원문이 들어가지 않게.
 */

export const TYPES = { cheer: "환호형", complain: "불만형", demand: "요구형", theory: "망상·예측형", simple: "단순반응", offtopic: "작품 외 이슈" };
export const AXES = { hero: "주인공", romance: "로맨스", fantasy: "판타지", relation: "관계·조연", craft: "작화·연출(웹소설은 문장·필력)", ops: "연재 운영", orig: "원작 비교", etc: "기타" };
export const NEEDS = {
  hero_revenge: "응징·사이다", hero_status: "인정·위상 역전", hero_growth: "성장·노력의 보상", hero_agency: "주체성", hero_heal: "상처와 치유", hero_tension: "긴장감·대가",
  rom_progress: "관계 진전", rom_mutual: "쌍방 확인", rom_power: "관계의 힘 구도", rom_jealous: "질투·독점", rom_conflict: "갈등의 종류", rom_salvation: "구원", rom_sub: "서브 캐릭터",
  fan_reveal: "세계관·비밀 공개", fan_system: "능력 체계의 일관성", fan_action: "전투·액션 쾌감", fan_strategy: "두뇌전·전략", fan_regress: "회귀·빙의 정보 우위", fan_scale: "스케일 확장",
  rel_family: "가족 서사", rel_friend: "동료·우정", rel_villain: "악역 서사"
};
export const NEED_AXIS = (code) => ({ hero: "hero", rom: "romance", fan: "fantasy", rel: "relation" })[code.split("_")[0]];
export const STATES = { met: "충족", lack: "결핍", ask: "요구", split: "호불호 갈림", none: "해당 없음" };
export const EVALS = { pos: "긍정", neg: "부정", neu: "중립" };
export const TARGETS = { char: "캐릭터", plot: "전개·작가", art: "작화", ops: "운영", etc: "기타" };
export const ACTIONS = { pay: "결제·전환", stay: "기다림·유지", share: "추천·전파", churn: "이탈 경고", none: "없음" };
export const READERS = { long: "장기 독자", new: "신규 정주행", orig: "원작 독자", unk: "알 수 없음" };
export const STAGES = { 1: "출석형", 2: "감상형", 3: "해석형", 4: "확장형" };
export const CONFS = { hi: "높음", mid: "중간", lo: "낮음" };

const E = (o) => Object.keys(o);
export const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["comments"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["n", "ty", "ax", "nd", "st", "ev", "tg", "ac", "rd", "sg", "ch", "sc", "nn", "cf"],
        properties: {
          n: { type: "integer" },
          ty: { type: "string", enum: E(TYPES) },
          ax: { type: "string", enum: E(AXES) },
          nd: { type: "array", items: { type: "string", enum: E(NEEDS) } },
          st: { type: "string", enum: E(STATES) },
          ev: { type: "string", enum: E(EVALS) },
          tg: { type: "string", enum: E(TARGETS) },
          ac: { type: "string", enum: E(ACTIONS) },
          rd: { type: "string", enum: E(READERS) },
          sg: { type: "string", enum: ["1", "2", "3", "4"] },
          ch: { type: "array", items: { type: "string" } },
          sc: { type: "string" },
          nn: { type: "string" },
          cf: { type: "string", enum: E(CONFS) }
        }
      }
    }
  }
};

const list = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ");

export const CLASSIFY_SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 리디(RIDI)의 '회차 댓글'을 읽고 분류하는 분석가입니다. 목표는 댓글을 모아 독자가 진짜 원하는 서사(니즈)를 거꾸로 알아내는 것입니다. 댓글은 "리뷰(충족된 니즈) + 클레임(배신·지연된 니즈) + 주문서(아직 안 채워진 니즈)"가 섞인 것입니다.

댓글마다 아래 칸을 채웁니다. 값은 반드시 아래 코드로 씁니다.

- ty 댓글 유형: ${list(TYPES)}
  · simple: 출석·1등·'ㅋㅋ'·'왔다'·'작가님 사랑해요'처럼 내용 없는 반응
  · theory: 떡밥 추리, 앞으로의 전개 예측, '~면 좋겠다'는 상상(망상)
  · demand: 작가·작품에 무언가를 해 달라는 요구(분량, 특정 전개, 외전 등)
  · offtopic: 작품과 상관없는 이야기(다른 작품, 플랫폼, 이벤트, 댓글끼리 싸움)
- ax 서사 축(가장 중심 하나): ${list(AXES)}
  · BL·로맨스의 커플 관계는 romance. 수위·씬도 romance.
  · 휴재·업로드 시간·분량·가격·기다무 이야기는 ops — 작품 평가와 섞지 않는다.
- nd 니즈 코드(0~3개): ${list(NEEDS)}
- st 니즈 상태: ${list(STATES)}
  · met: 이 화에서 채워져서 좋아함 / lack: 채워지지 않아 불만·아쉬움 / ask: 앞으로 이렇게 되길 바람(요구·망상·예측) / split: 이 요소를 두고 독자끼리 호불호가 갈림이 드러남 / none: 니즈와 상관없음
- ev 실제 평가(겉 감정이 아니라 작품에 대한 실제 평가): ${list(EVALS)}
- tg 감정의 대상: ${list(TARGETS)}
- ac 행동 신호: ${list(ACTIONS)}
  · pay: 결제·소장·대여했다, 기다무 못 참고 결제, 전권 질렀다 / stay: 다음 화 기다림, 일주일 어떻게 기다려 / share: 추천·영업·주변에 퍼뜨림 / churn: 하차, 그만 볼까, 결제가 아깝다, 여기까지
- rd 독자 유형 단서: ${list(READERS)}
  · long: '1화부터 봤는데', '연재 때부터', '몇 년째' / new: '정주행 중', '오늘 처음 봤는데' / orig: 원작 소설을 읽은 티가 남
- sg 몰입 단계: "1"=출석형, "2"=감상형(좋다·싫다 감상), "3"=해석형(떡밥 추리·예측·복선 해석), "4"=확장형(재독·밈·2차 창작·영상화·굿즈 요청)
- ch 언급 캐릭터: 댓글에 나온 인물 이름(작품 소개 참고). 별명도 그대로. 없으면 []
- sc 장면 메모: 어떤 장면·사건에 대한 반응인지 한 줄(25자 이내, 댓글 문장을 그대로 베끼지 말고 요약). 모르면 ""
- nn 신규 니즈 후보: 위 니즈 목록에 없는 바람이 분명하면 짧은 이름(예: '수위·씬', '티키타카', '작화 퀄리티'). 없으면 ""
- cf 분류 확신도: ${list(CONFS)}

## 분류 규칙 (가장 중요)
1. 겉 감정과 실제 평가는 다르다. "작가님 미쳤어요", "미친 전개", "숨 막혀" = 극찬(pos). "아 진짜 짜증나 다음화 내놔" = 몰입(pos, stay).
2. 캐릭터에게 화내거나 욕하는 것(악역·남주·공·수에게 '개새', '패고 싶다')은 몰입 성공 = ev pos(또는 neu), tg char. 작품 불만이 아니다.
3. 전개·작가에게 화내는 것('작가님 왜 이렇게 써요', '전개 산으로 감', '개연성 없음')은 경고 신호 = ev neg, tg plot.
4. 운영 불만('또 휴재?', '분량 너무 짧다', '가격 비싸')은 ax ops, tg ops. 작품 내용 평가와 섞지 않는다.
5. 불만 댓글은 뒤집어서 숨은 니즈로 번역해 nd에 넣고 st=lack:
   · "주인공 답답해" → hero_agency(주체성), hero_revenge(사이다 타이밍)
   · "오해 또?" → rom_mutual(쌍방 확인)
   · "서브남이 낫다" → rom_sub(서브 캐릭터) — 남주 매력 결핍이면 sc에 적는다
   · "너무 쉽게 이김" → hero_tension(긴장감·대가)
   · "설정 설명 지루해" → fan_reveal(설정을 사건으로 보여주길 원함)
   · "질질 끈다" → 보상이 너무 늦음: 늦어지는 그 니즈 코드(rom_progress 등)
   · "캐붕" → 캐릭터 일관성: nn에 '캐릭터 일관성'
   · "원작이랑 달라" → ax orig, nn에 '원작 명장면 재현'
6. 망상·예측형 댓글은 '아직 안 채워진 니즈'가 가장 순수하게 드러나는 곳이다. 무엇이 일어나길 바라는지 nd와 st=ask로 빠짐없이 잡는다.
7. 반어·드립·밈은 문맥으로 판단하고, 애매하면 cf=lo.
8. 댓글 하나에 니즈가 여러 개일 수 있다(최대 3개).
9. 니즈와 상관없는 단순반응은 nd=[], st=none, sg="1".
10. 지어내지 않는다. 확실하지 않은 칸은 가장 무난한 값(none, unk, etc, "")으로 둔다.

## 출력
입력의 댓글 번호(#n)마다 하나씩, 빠짐없이 JSON으로 답한다.`;

function workBlock(work, ep) {
  return `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.bl ? " / BL" : ""}\n[작품 소개] ${work.desc || "-"}\n[회차] ${ep.no}화 (공개 ${String(ep.reg || "").slice(0, 10)})`;
}

// 댓글 묶음 하나의 요청. comments: [{n, text, like, sp, best}]
export function buildClassifyParams(cfg, work, ep, comments, textMax) {
  const body = workBlock(work, ep) + "\n\n[댓글]\n" +
    comments.map((c) => `#${c.n} [좋아요 ${c.like}${c.best ? "·베스트" : ""}${c.sp ? "·스포" : ""}] ${c.text.trim().replace(/\s+/g, " ").slice(0, textMax)}`).join("\n") +
    "\n\n위 댓글을 규칙대로 분류해 JSON으로 답하세요.";
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

// ---------------- 2단계: 작품 종합 (Sonnet) ----------------
const REFS = { type: "array", items: { type: "integer" } };
export const WORK_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "episodes", "needs", "likes", "dislikes", "unfilled", "newNeeds", "sayDo"],
  properties: {
    headline: { type: "string" },
    episodes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["no", "line", "scenes", "combo"],
        properties: {
          no: { type: "integer" },
          line: { type: "string" },
          scenes: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["scene", "mood", "refs"],
              properties: { scene: { type: "string" }, mood: { type: "string", enum: ["열광", "불만", "논쟁", "추리", "슬픔"] }, refs: REFS }
            }
          },
          combo: { type: "array", items: { type: "string" } }
        }
      }
    },
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
    },
    likes: { type: "array", items: { type: "object", additionalProperties: false, required: ["point", "refs"], properties: { point: { type: "string" }, refs: REFS } } },
    dislikes: { type: "array", items: { type: "object", additionalProperties: false, required: ["point", "refs"], properties: { point: { type: "string" }, refs: REFS } } },
    unfilled: { type: "array", items: { type: "object", additionalProperties: false, required: ["need", "point", "refs"], properties: { need: { type: "string" }, point: { type: "string" }, refs: REFS } } },
    newNeeds: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "point", "refs"], properties: { label: { type: "string" }, point: { type: "string" }, refs: REFS } } },
    sayDo: { type: "string" }
  }
};

export const WORK_SYSTEM = `당신은 웹소설·웹툰 기획자를 돕는 독자 반응 분석가입니다. 한 작품의 최근 회차 댓글(이미 1차 분류됨)과 회차별 댓글 수를 받아, 독자가 진짜 원하는 서사(니즈)를 정리합니다.

## 쓸 것
- headline: 이 작품 독자 반응의 핵심 한 문장.
- episodes: 분석한 회차마다
  · line: 이 화 반응 한 줄(무엇에 반응했는지 구체적으로. '반응이 좋았다' 같은 말 금지)
  · scenes: 독자가 반응한 장면·사건 1~3개. mood는 열광/불만/논쟁/추리/슬픔. refs는 근거 댓글 번호.
  · combo: [터짐]·[대박] 표시가 있는 회차면 '한 장면에서 동시에 충족된 니즈 조합'(니즈 이름들). 아니면 [].
- needs: 니즈 맵. 한 줄 = (서사 축, 니즈, 상태, 근거 회차·장면, 크기, 크기 판단 이유).
  · need는 니즈 이름(목록 이름 그대로) 또는 신규 후보 이름.
  · 크기(상/중/하)는 제공된 니즈 통계로 판단: 충족 회차의 댓글 증가 정도, 충족 전에 쌓인 요구 댓글 양, 관련 댓글 좋아요 합, 여러 회차 반복 여부, 결제·전환 신호 동반(돈이 움직인 니즈가 진짜 니즈).
  · 근거가 댓글 2개 이하인 니즈는 넣지 않는다.
- likes / dislikes: 독자가 좋아하는 것·싫어하는 것 TOP 5(많은 순). 연재 운영(휴재·분량·가격)은 dislikes에 넣지 말고, 넣어야 하면 point 앞에 '[운영]'을 붙인다.
- unfilled: 아직 안 채워진 니즈(요구형·망상형에서 반복되는 바람).
- newNeeds: 니즈 목록에 없는데 반복해서 나온 바람(신규 후보 nn 통계 참고). 없으면 [].
- sayDo: '말과 행동이 다름' — 불만 댓글은 많은데 댓글 수나 결제·기다림 신호는 오히려 늘어난 회차가 있으면 그 회차와 해석('불만이지만 소비 중', 고구마가 사이다의 재료로 작동 중일 수 있음). 없으면 "".

## 규칙
- 캐릭터에게 화내는 건 몰입(좋은 신호), 전개·작가에게 화내는 건 경고 신호로 구분한다.
- 장기 독자(rd=long)의 불만은 무게를 더 둔다.
- 숫자를 부풀리지 않는다. 근거 없는 말을 지어내지 않는다. refs에는 실제로 그 내용을 말한 댓글 번호만 넣는다.
- 댓글 원문을 길게 옮겨 적지 말고 요약해서 쓴다.
- 모든 문장은 쉬운 한국어로.`;

export function buildWorkParams(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: WORK_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 자료로 이 작품의 회차 반응과 니즈 맵을 JSON으로 정리하세요." }],
    output_config: { format: { type: "json_schema", schema: WORK_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

export function parseJson(msg) {
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch (e) { throw new Error("JSON 해석 실패 (stop_reason=" + msg.stop_reason + ")"); }
}
