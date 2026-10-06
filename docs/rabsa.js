/* 리뷰 '요소별 반응' 분석 엔진 (RABSA)
 *
 * 브라우저(사이트)와 GitHub Actions(Node, scripts/reviews_full.js)가 이 파일 하나를 함께 쓴다.
 * 사전이나 규칙을 고치면 VERSION 을 올릴 것 — Actions가 버전이 다른 작품을 차례로 다시 계산한다.
 *
 * 왜 이렇게 하나:
 *   리디 리뷰는 별점이 거의 전부 5점이라 별점으로는 '어떤 요소가 긍/부정'인지 알 수 없다.
 *   그래서 리뷰 '본문'을 절(clause) 단위로 쪼개, 각 절에서 요소 키워드 + 감성 표현을 읽는다.
 *     예) "능글 남주 좋음.. 대신 일러가 좀 아쉽네요" → 캐릭터=긍정, 그림=부정
 *   사전은 실제 리뷰 100여 건을 분석해 만들었고, 오탐(선구매·기대평, '없이/않' 접미부정,
 *   '비추천'⊂'추천', '씬' 단독, 반어 등)을 걸러내도록 규칙을 넣었다. 대략적 경향 파악용.
 *
 * 집계(agg) 형태 — 사이트에 저장되는 analysis 와 같다:
 *   { total, used, aspects: {키: [긍정, 부정]}, examples: {키: {p: [[문장, 공감, 날짜]], n: [...]}},
 *     kwf: {단어: 리뷰수}, stars: {"1".."5": 수}, months: {"YYYY-MM": 수} }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RABSA = api;
})(this, function () {
  var VERSION = "1";

  function S(s) { return s.split(/\s+/).filter(Boolean); }

  var aspects = [
    { key: "art",       label: "그림·작화", kw: S("그림체 그림이 그림을 그림은 그림도 작화 작화가 일러 일러스트 삽화 삽화본 표지 화풍 채색 색감 비주얼 화질 연출 눈호강") },
    { key: "story",     label: "스토리·전개", kw: S("스토리 전개 서사 빌드업 떡밥 복선 반전 개연성 짜임새 흐름 템포 호흡 완급조절 급전개 급발진 급마무리 늘어지 루즈 질질 지지부진 흐지부지 산만 중구난방 뜬금 제자리걸음 무한반복 전개속도 고구마 사이다 답답 속터지 속시원 각색 삽질") },
    { key: "character", label: "캐릭터 매력", kw: S("남주 여주 주인공 캐릭터 캐릭 인물 캐붕 매력 매력적 무매력 매력없 입체적 평면적 성격 집착 다정 능글 까칠 민폐 찌질 찐따 호구 멘헤라 금쪽이 싸가지 수동적 멍청 햇살 회피형 공수 미남수 미인수 떡대수 연상수 연하수 연상공 연하공 집착공 집착수 까칠수 다정공 부둥") },
    { key: "chemistry", label: "케미·관계", kw: S("케미 캐미 공수조합 관계성 티키타카 밀당 혐관 쌍방구원 투샷 상호작용 찰떡궁합") },
    { key: "romance",   label: "설렘·로맨스", kw: S("로맨스 설렘 설레 두근 달달 달콤 애틋 간질간질 몽글몽글 순애 절절 애절 러브력 썸 연애 꽁냥") },
    { key: "immersion", label: "몰입·재미", kw: S("몰입 몰입감 흡입력 흡인력 재미 재밌 꿀잼 존잼 핵잼 개잼 노잼 지루 술술 순삭 정주행 밤새 흥미진진 흥미로 흥미 킬링타임 킬타 도파민 잘읽 안읽") },
    { key: "writing",   label: "필력·문장", kw: S("필력 문장 문장력 문체 글솜씨 글맛 묘사 서술 대사 독백 번역 번역투 발번역 오타 오탈자 비문 가독성 띄어쓰기 편집 어휘 글빨") },
    { key: "emotion",   label: "분위기·감성", kw: S("감정선 분위기 감성 여운 먹먹 눈물 울었 울컥 펑펑 감동 신파 잔잔 담백 쓸쓸 외로움 울림") },
    { key: "humor",     label: "유머·개그", kw: S("개그 유머 드립 말장난 병맛 코믹 코미디 웃기 웃음 유쾌 피식 빵터") },
    { key: "setting",   label: "세계관·설정", kw: S("세계관 설정 소재 클리셰 트로프 신선 참신 독특 신박 특이 진부 뻔하 전형적 양산형 회빙환 회귀 빙의 역하렘") },
    { key: "spice",     label: "수위", kw: S("수위 고수위 저수위 19금 꾸금 섹텐 더티토크 야하 야르 꼴리 개꼴 존꼴 노꼴 자극적 적나라 노골적 BDSM 키스씬 베드씬 정사씬 섹슈얼") },
    { key: "ending",    label: "분량·완결·외전", kw: S("결말 완결 외전 엔딩 마무리 용두사미 급마무리 떡밥회수 분량 단편 장편 권수 짧 휴재 존버 뒷심부족") },
    { key: "price",     label: "가격·과금", kw: S("가격 정가 가성비 돈값 비싸 과금 환불 돈아깝 시간아깝 캐시아깝") },
    { key: "author",    label: "작가·전작 신뢰", kw: S("믿고보는 전작 차기작 도장깨기") }
  ];
  var positive = S("재밌 재미있 재미나 잼나 꿀잼 존잼 핵잼 개잼 개존잼 대존잼 존맛 맛도리 맛집 맛있 마시써 꿀맛 최고 명작 수작 인생작 띵작 갓작 갓벽 레전드 대작 대박 완벽 만족 흡입력 흡인력 몰입 술술 순삭 흥미 흥미진진 흥미로 매력적 매력있 설레 설렘 두근 달달 달콤 애틋 간질간질 몽글몽글 절절 순애 여운 감동 먹먹 울컥 귀엽 기엽 졸귀 귀염뽀짝 뽀짝 사랑스럽 예쁘 이쁘 깜찍 탄탄 촘촘 짜임새 깔끔 신선 참신 독특 신박 취저 취향저격 입덕 강추 강력추천 츄라이 정주행 밤새 힐링 섹시 쫄깃 찰떡 명불허전 극락 감탄 입체적 독보적 완독 믿고보는 유쾌 웃기 웃음 피식 빵터 미쳤 미친 골때리 죽이네 찰지 완급조절 사이다 눈호강 유죄 재탕 재독 괜찮 ㄱㅊ 볼만 무난 그럭저럭 준수 좋");
  var posPhrase = ["나쁘지 않", "나쁘진 않", "싫지 않", "다시 읽", "또 읽", "잘 읽히", "술술 읽", "손을 놓을 수 없", "손을 못 놓",
    "매력 있", "매력이 있", "매력도 있", "매력 넘", "재미 있", "흥미 있", "케미 있"];
  var negative = S("아쉽 아쉬 지루 루즈 질질 늘어지 고구마 용두사미 뒷심부족 엔딩조루 억지 작위 유치 오글 오그라들 노잼 재미없 잼없 답답 속터지 비추 하차 구매방지 재구매방지 재대여방지 방지용 작붕 캐붕 발번역 번역투 오타 오탈자 비문 산만 어수선 중구난방 난잡 평면적 돌려막기 자기복제 급전개 급발진 급마무리 급작스럽 뜬금 별로 별루 최악 실망 짜증 불호 난해 역하 현타 양산형 김빠 식었 묵은지 무매력 매력없 멍청 바보 찌질 찐따 민폐 호구 뇌절 밍숭맹숭 밍밍 슴슴 싱겁 허무 허술 노답 똥망 대실패 돈아깝 시간아깝 캐시아깝 짜치 뻔하 진부 전형적 질리 기빨리 꾸역꾸역 얼렁뚱땅 휘리릭 후다닥 지지부진 무한반복 흐지부지 올드 촌스럽 부자연스럽 어색 수준미달 짬뽕 짜집기 거슬리 극혐 쓰레기 저질 저급 지저분 더럽 지뢰 심심 흐린눈 속지마 평점에속 별점에낚 어이없 어처구니 떨어지 애매 어정쩡 허접 힘빠지 맥빠 삽질");
  var negPhrase = ["안 읽히", "안읽히", "안 넘어가", "손이 안 가", "손을 놓았", "읽기 싫",
    "매력 없", "매력이 없", "재미 없", "흥미 없"];

  // 절(clause) 분리: 문장부호 + 역접 연결어 (치고는/치곤만, 동사 '-치고'는 제외)
  var splitRe = /[\n\r.!?…·,、;:~～]+|는데|은데|ㄴ데|지만|하지만|그런데|근데|대신|다만|그래도|빼면|빼곤|빼고|면서도|반면|그럼에도|치고는|치곤/g;
  // 추측·선구매(기대평)성 절은 '경험 평가'가 아니므로 극성에서 제외
  var conjectureRe = /것\s?같|듯|겠|예정|았으면|었으면|면\s?좋겠|길\s?바|기대(돼|된|됩|되|하|함)|읽어\s?볼|볼게|잘\s?읽겠|읽을/;
  var preReadRe = /선리뷰|선구매|선결제|미보후|미리보기\s?후|구매합니다|지릅니다|지름신|믿고\s?삼|믿고\s?산다|믿고\s?구매|잘\s?읽겠|읽고\s?수정|읽어볼게|읽어볼께|읽을\s?예정|기대평/;
  var readRe = /봤|읽었|완독|하차|보는\s?중|보고\s?있|읽는\s?중|읽고\s?있|재밌었|재미있었|잘\s?봤|다\s?봄|정주행/;

  // '자주 나오는 말'에서 뺄 흔한 말
  var STOPSET = {};
  S("그리고 그래서 하지만 그런데 그러나 정말 진짜 너무 아주 완전 조금 약간 다시 계속 " +
    "이거 저거 그거 여기 저기 거기 이건 그건 저건 하나 진행 작품 소설 웹툰 내용 이야기 스토리 " +
    "생각 느낌 부분 정도 때문 그냥 역시 이제 아직 지금 나중 처음 마지막 다음 이번 저희 우리 " +
    "제가 저는 나는 근데 인데 라고 라는 하는 되는 있는 없는 같은 많은 좋은 보고 읽고 " +
    "합니다 했어요 해요 이런 저런 어떤 무슨 진심 완전히 굉장히 엄청 그램 편이 작가 작가님 " +
    "감사 감사합니다 기대 다음화 리디 소장 대여 결제 무료 최고 존잼 잘봤 잘보 재밌 재미 " +
    "이렇게 그렇게 저렇게 어떻게 않고 않은 않아 않네 읽었 봤어 봤네 좋아 좋네 제일 시작 " +
    "정주행 다음편 담편 계속 얼른 빨리 이건 그건 진짜로 완전 그저 여기 아마 혹시 " +
    "작가님 님의 작품이 소설이 웹툰이 이번화 회차 연재 결말 초반 후반 중반"
  ).forEach(function (w) { STOPSET[w] = 1; });

  function mask(str, idx, len, ch) {
    return str.substring(0, idx) + new Array(len + 1).join(ch) + str.substring(idx + len);
  }

  // 한 절의 극성: +1 긍정 / -1 부정 / 0 판단 불가
  function polarity(cl) {
    var m = cl.replace(/좋아하|좋아해|좋아할|좋아함/g, "▦▦▦");   // '좋아하는'(취향)은 평가 아님
    var pos = 0, neg = 0, i, after, before;

    // 1) 부정어 (뒤에 '없이/않/덜' 등이 붙으면 칭찬으로 반전: '고구마 없이', '지루하지 않')
    negative.forEach(function (ww) {
      i = m.indexOf(ww);
      while (i >= 0) {
        after = m.substr(i + ww.length, 4);
        before = m.substr(Math.max(0, i - 2), 2);
        if (/없이|없고|없는|없음|없어|없네|없었|않|덜/.test(after) || /덜/.test(before)) pos++; else neg++;
        m = mask(m, i, ww.length, "▦");
        i = m.indexOf(ww);
      }
    });
    negPhrase.forEach(function (ph) { while (m.indexOf(ph) >= 0) { neg++; m = m.replace(ph, "▦"); } });

    // 2) 긍정어 (뒤에 '않/없' 또는 앞에 홀로 선 '안/못' → 부정으로 반전: '좋지 않', '안 좋')
    positive.forEach(function (ww) {
      i = m.indexOf(ww);
      while (i >= 0) {
        after = m.substr(i + ww.length, 4);
        before = m.substring(0, i);
        var negated = /^(지|진|지도|긴)?\s*(않|안|없)/.test(after) || /(^|\s)(안|못)\s*$/.test(before.slice(-4));
        if (negated) neg++; else pos++;
        m = mask(m, i, ww.length, "♦");
        i = m.indexOf(ww);
      }
    });
    posPhrase.forEach(function (ph) { while (m.indexOf(ph) >= 0) { pos++; m = m.replace(ph, "♦"); } });

    if (pos > neg) return 1;
    if (neg > pos) return -1;
    return 0;
  }

  // 리뷰 한 건 → [[요소키, 극성, 절], ...]. 선구매·기대평이면 null.
  function analyzeReview(text) {
    text = (text || "").trim();
    if (text.length < 4) return [];
    if (preReadRe.test(text) && !readRe.test(text)) return null;
    var out = [];
    text.split(splitRe).forEach(function (cl) {
      if (!cl || cl.replace(/\s/g, "").length < 2) return;
      if (conjectureRe.test(cl)) return;                       // 추측성 절 제외
      var pol = polarity(cl);
      if (!pol) return;
      aspects.forEach(function (a) {
        for (var k = 0; k < a.kw.length; k++) {
          if (cl.indexOf(a.kw[k]) >= 0) { out.push([a.key, pol, cl]); break; }
        }
      });
    });
    return out;
  }

  // 리뷰 한 건에서 '자주 나오는 말' 후보 (한 리뷰에서 같은 단어는 한 번만)
  function tokens(text) {
    var seen = {}, out = [];
    (text || "").split(/[^가-힣A-Za-z0-9]+/).forEach(function (raw) {
      var w = raw.trim();
      if (w.length < 2 || w.length > 8) return;
      // 조사·어미를 대충 떼어낸다 (완벽하진 않지만 경향 파악에는 충분)
      w = w.replace(/(이었|였|하는|해서|하고|한테|에게|에서|으로|까지|부터|이라|라서|네요|어요|아요|습니다|입니다|는데|지만|면서|다가|이다|하다)$/, "");
      w = w.replace(/(은|는|이|가|을|를|의|에|도|만|과|와|랑|께|요)$/, "");
      if (w.length < 2 || STOPSET[w]) return;
      if (/^\d/.test(w)) return;                       // "200회" 같은 숫자 표현 제외
      if (/(작가님|작가)$/.test(w) && w.length > 3) return;
      if (seen[w]) return;
      seen[w] = 1;
      out.push(w);
    });
    return out;
  }

  function newAgg() {
    return { total: 0, used: 0, aspects: {}, examples: {}, kwf: {}, stars: {}, months: {} };
  }

  // 예시 문장 후보: 공감 많은 것 > 최신 것. 요소·극성별 2개까지.
  function better(a, b) { return (a[1] - b[1]) || (a[2] > b[2] ? 1 : a[2] < b[2] ? -1 : 0); }
  function keepExample(agg, key, pol, cl, likes, date) {
    var c = cl.replace(/\s+/g, " ").trim();
    if (c.length < 6) return;
    if (c.length > 90) c = c.slice(0, 88) + "…";
    var slot = agg.examples[key] || (agg.examples[key] = { p: [], n: [] });
    var arr = pol > 0 ? slot.p : slot.n;
    for (var i = 0; i < arr.length; i++) if (arr[i][0] === c) return;
    arr.push([c, likes || 0, date || ""]);
    arr.sort(function (x, y) { return better(y, x); });
    if (arr.length > 2) arr.length = 2;
  }

  // 리뷰 한 건을 집계에 더한다 (Actions의 이어받기 계산도 같은 함수를 쓴다)
  function addReview(agg, r) {
    var text = (r && r.content) || "";
    agg.total++;
    if (r && r.rating) agg.stars[r.rating] = (agg.stars[r.rating] || 0) + 1;
    var at = (r && r.at) || "";
    if (at) { var mo = at.slice(0, 7); agg.months[mo] = (agg.months[mo] || 0) + 1; }
    tokens(text).forEach(function (w) { agg.kwf[w] = (agg.kwf[w] || 0) + 1; });
    var pairs = analyzeReview(text);
    if (!pairs || !pairs.length) return;
    agg.used++;
    pairs.forEach(function (p) {
      var s = agg.aspects[p[0]] || (agg.aspects[p[0]] = [0, 0]);
      if (p[1] > 0) s[0]++; else s[1]++;
      keepExample(agg, p[0], p[1], p[2], r.likes, at.slice(0, 10));
    });
  }

  function analyze(reviews) {
    var agg = newAgg();
    (reviews || []).forEach(function (r) { addReview(agg, r); });
    return agg;
  }

  // 자주 나오는 말 상위 n개 ([[단어, 리뷰수], ...]) — 2번 이상 나온 것만
  function topWords(kwf, n) {
    return Object.keys(kwf || {}).map(function (w) { return [w, kwf[w]]; })
      .filter(function (p) { return p[1] >= 2; })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
      .slice(0, n || 24);
  }

  return {
    VERSION: VERSION, aspects: aspects, polarity: polarity, analyzeReview: analyzeReview,
    tokens: tokens, newAgg: newAgg, addReview: addReview, analyze: analyze, topWords: topWords
  };
});
