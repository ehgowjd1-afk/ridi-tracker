#!/usr/bin/env python3
"""웹툰(1600)·BL웹툰(4250) 순위대 변화를 찾고, 그게 프로모션 때문인지 가려 붙인다.

작품 그래프는 대부분 '업데이트 주기 톱니' 모양이다. 그러다 어떤 회차부터 순위대가
갑자기 오르거나 내려가면, 그게 회차 재미(작품 쪽 힘)인지 리디 이벤트·할인 때문인지
확인하려고 만든 분석기다. 2026-10-04에 검증한 판별 규칙을 그대로 옮겼다.
(참조 구현 analyze_ref.js 와 같은 알고리즘. 숫자는 부동소수 오차 범위에서 일치한다.
 함수 이름과 장 번호를 맞춰 뒀다)

  읽기(수정하지 않음): docs/data/daily/*.json, events/*.json(+ended.json),
                       books.json, books/{id}.json
  쓰기: docs/data/analysis/promo.json   작품별 프로모션 기간 (그래프 음영용)
        docs/data/analysis/shifts.json  순위대 변화 목록 + 프로모션 귀속(label)

판별 순서
  1. 변화 시작일 ±1일에 그 작품 이벤트·회당가 하락(가격지문)·기간한정 기다무가
     있으면 '프로모션 동반'
  2. 끝난 뒤 프로모션 없는 다음 사이클이 원래 수준이면 promo_temp(끝나고 복귀),
     유지되면 promo_kept(작품 쪽 힘 후보), 아직 진행 중이면 promo_live(판정 대기)
  3. 확인된 프로모션이 없으면 none
  4. 하락이 프로모션 종료 다음날(DAILY)·8일째(WEEKLY)와 맞으면 promo_end
  시즌·완결·외전 이벤트는 content(회차 효과와 나눌 수 없음)

포팅 주의 (참조 구현과 숫자를 최대한 같게 맞추려고)
  - 바이트 단위 일치는 보장하지 않는다: math.log·math.exp(러너의 glibc)와 V8 의
    Math.log·Math.exp(fdlibm 포팅)는 마지막 비트가 다를 수 있어, 값이 기준선
    (|z|=2.5, 유지율 0.5·0.33, rhu 반올림 경계)에 딱 걸린 드문 경우만 결과가 갈릴 수 있다.
    JS 출력과 비교할 때는 이런 경계값 차이 몇 개는 허용한다.
  - 반올림은 rhu()(round half up)만 쓴다. 파이썬 round()는 은행가 반올림이라 다르다.
  - JSON 출력은 JSON.stringify 와 같게: 정수인 실수는 정수로(250.0 → 250),
    작품ID 키 순서는 JS 객체 규칙(정수 모양 키 먼저 숫자순)으로 맞춘다.
  - 정규식의 \\d·\\s·\\b 는 JS(유니코드 플래그 없음)와 같은 범위로 바꿔 쓴다.

사용법:
  python scripts/analyze_promo.py
  python scripts/analyze_promo.py --data-dir docs/data --out-dir /tmp/analysis
  python scripts/analyze_promo.py --summary "$GITHUB_STEP_SUMMARY"
"""

import argparse
import datetime
import functools
import json
import math
import os
import re
import sys
import time
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_DIR = os.path.join(ROOT, "docs", "data")

# =====================================================================================
# 0. 상수 · 공통 함수
# =====================================================================================
WINDOW_DAYS = 90          # 분석 창: 최근 90일(데이터가 짧으면 전체)
LN250 = math.log(250)     # 200위 밖 대치값
DAY_MS = 86400000
KST_MS = 9 * 3600000
SHIFT_GROUPS = ["1600", "4250"]
PERS = ["DAILY", "WEEKLY"]
Z_MIN = 2.5               # 레벨 변화 크기 기준 |z|
TOP_TARGET = 50           # shifts 대상: 기간 중 한 번이라도 50위 안
MAX_PHASE = 14            # 톱니 템플릿 길이(경과일 0..13)
PRICE_STD = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]  # 표준 회당 정가
SIGMA_MIN_N = 10          # σ 추정에 필요한 최소 차이 개수. 모자라면 아래 기본값(2026-10 데이터 추정치)
SIGMA_DEFAULT = {"cycle": 0.12, "spike": 0.37, "win": 0.2}
SQRT2 = math.sqrt(2)      # Math.SQRT2 와 같은 값

EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
EPOCH_NAIVE = datetime.datetime(1970, 1, 1)
EPOCH_DATE = datetime.date(1970, 1, 1)

# JS 의 \s 범위(WhiteSpace + LineTerminator). 파이썬 \s 와 조금 달라서 직접 적는다.
WS = r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
JS_WS_CHARS = ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
               "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
# JS /i(유니코드 플래그 없음)는 모든 글자의 대소문자를 접지만(/é/i 는 'É' 와 맞음),
# 비ASCII 글자를 ASCII 로 접는 것만은 하지 않는다(ſ U+017F → S, 켈빈 기호 U+212A → K 안 됨).
# 파이썬 re.IGNORECASE(유니코드)는 이 넷(ſ·U+212A·İ·ı)까지 s·k·i 와 맞춰 버리므로 re.ASCII 를 같이 건다.
# 이 둘이 같은 결과를 내는 것은 '패턴 안의 글자가 전부 ASCII'일 때뿐이다(지금 패턴은
# b·br·special discount·free·coming soon·relay·e북 — 모두 해당).
# ⇒ 비ASCII 글자(é 등)를 I_FLAGS 패턴에 넣을 때는 [éÉ]처럼 대소문자를 둘 다 직접 적을 것.
# (\s·\d 는 아래 jsre()가 JS 범위로 바꾸고, \b 는 패턴에 (?![A-Za-z0-9_])로 직접 적었다)
I_FLAGS = re.IGNORECASE | re.ASCII


def jsre(src, flags=0):
    """JS 정규식 원문을 파이썬용으로: \\s → JS 공백 범위, \\d → [0-9] (문자 클래스 안에는 쓰지 말 것)."""
    return re.compile(src.replace(r"\s", WS).replace(r"\d", "[0-9]"), flags)


def js_trim(s):
    """String.prototype.trim()"""
    return s.strip(JS_WS_CHARS)


def js_truthy(v):
    """JS 의 참·거짓 판정(빈 객체·빈 배열도 참)."""
    if v is None or v is False:
        return False
    if isinstance(v, bool):
        return True
    if isinstance(v, (int, float)):
        return v == v and v != 0
    if isinstance(v, str):
        return v != ""
    return True


def num_str(x):
    """JS 의 String(숫자): 정수인 실수는 '250', 그 밖은 최단 표기."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if x != x:
            return "NaN"
        if x in (math.inf, -math.inf):
            return "Infinity" if x > 0 else "-Infinity"
        if x.is_integer() and abs(x) < 1e21:
            return str(int(x))
        return repr(x)
    return str(x)


def js_string(v):
    """JS 의 String(v) (id 처럼 문자열/숫자가 섞일 수 있는 값용)."""
    if isinstance(v, str):
        return v
    if v is None:
        return "null"
    return num_str(v)


def is_one(v):
    """JS 의 v === 1 (True 는 1 로 치지 않는다)."""
    return not isinstance(v, bool) and isinstance(v, (int, float)) and v == 1


def is_pos(v):
    """JS 의 v > 0 (None 은 거짓)."""
    return not isinstance(v, bool) and isinstance(v, (int, float)) and v > 0


def jsign(x):
    """Math.sign"""
    if x > 0:
        return 1
    if x < 0:
        return -1
    return 0 if x == 0 else math.nan


def jdiv(a, b):
    """JS 나눗셈(0으로 나누면 ±Infinity·NaN, 예외 없음)."""
    if b == 0:
        if a == 0 or a != a:
            return math.nan
        same_sign = (a > 0) == (math.copysign(1.0, b) > 0)
        return math.inf if same_sign else -math.inf
    return a / b


def js_exp(v):
    """Math.exp (null 은 0 으로 본다)."""
    return math.exp(0 if v is None else v)


def rhu(x, k=0):
    """반올림(round half up). 파이썬 round()는 은행가 반올림이라 쓰지 않는다."""
    if not isinstance(x, (int, float)) or not math.isfinite(x):
        return x
    f = 10 ** k
    return math.floor(x * f + 0.5) / f


def day_num(d):
    """'YYYY-MM-DD' → epoch day"""
    return (datetime.date.fromisoformat(d) - EPOCH_DATE).days


def day_str(e):
    """epoch day → 'YYYY-MM-DD'"""
    return (EPOCH_DATE + datetime.timedelta(days=e)).isoformat()


def parse_ms(s):
    """Date.parse 대응: ISO 문자열 → epoch ms(정수). 못 읽으면 None(JS 의 NaN)."""
    if not isinstance(s, str) or not s:
        return None
    t = s.strip()
    if t.endswith("Z") or t.endswith("z"):
        t = t[:-1] + "+00:00"        # 3.10 이하 fromisoformat 은 'Z'를 못 읽는다
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:            # 시간대 없는 값은 UTC 로 본다(Actions 러너와 같게)
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    try:
        return (dt - EPOCH) // datetime.timedelta(milliseconds=1)
    except (OverflowError, ValueError):
        return None


def kst_str(ms):
    """epoch ms → KST 'YYYY-MM-DD HH:mm'"""
    try:
        t = EPOCH_NAIVE + datetime.timedelta(milliseconds=ms + KST_MS)
    except (OverflowError, TypeError, ValueError):
        return ""
    return t.strftime("%Y-%m-%d %H:%M")


def kst_iso_now():
    """지금 시각 KST 'YYYY-MM-DDTHH:MM:SS+09:00'"""
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(milliseconds=KST_MS)
    return t.strftime("%Y-%m-%dT%H:%M:%S") + "+09:00"


def nums(a):
    return [x for x in a if x is not None and not isinstance(x, bool) and math.isfinite(x)]


def median(a):
    """중앙값. 짝수 개면 가운데 두 값 평균. 값이 없으면 None."""
    b = sorted(nums(a))
    if not b:
        return None
    m = len(b) >> 1
    return b[m] if len(b) % 2 else (b[m - 1] + b[m]) / 2


def mean(a):
    """평균(앞에서부터 차례로 더함 — JS reduce 와 같은 순서)."""
    b = nums(a)
    if not b:
        return None
    s = 0
    for x in b:
        s += x
    return s / len(b)


def mad(a):
    """MAD = median(|x - median(x)|)"""
    m = median(a)
    if m is None:
        return None
    return median([abs(x - m) for x in nums(a)])


def sigma_of(vals, div, fallback):
    m = mad(vals)
    if len(vals) >= SIGMA_MIN_N and m is not None and m > 0:
        return m * 1.4826 / div
    return fallback


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def md(date_str):
    """'2026-09-14' → '9/14'"""
    return str(int(date_str[5:7])) + "/" + str(int(date_str[8:10]))


# ---------------------------------------------------------------- JSON 출력(JSON.stringify 와 같게)
ARRAY_INDEX_RE = re.compile(r"0|[1-9][0-9]*")
LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def is_array_index(k):
    return ARRAY_INDEX_RE.fullmatch(k) is not None and int(k) <= 4294967294


def js_key_order(keys):
    """JS 객체 키 순서: 정수 모양 키(배열 인덱스)를 숫자순으로 먼저, 나머지는 넣은 순서."""
    idx = sorted((k for k in keys if is_array_index(k)), key=int)
    rest = [k for k in keys if not is_array_index(k)]
    return idx + rest


def js_clean(v):
    """정수인 실수 → 정수(250.0 → 250), NaN·Infinity → null (JSON.stringify 와 같게)."""
    if isinstance(v, dict):
        return {k: js_clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [js_clean(x) for x in v]
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        if v.is_integer():
            return int(v)
    return v


def dump_js(obj):
    """공백 없는 JSON (storage.py 와 같은 ensure_ascii=False, separators=(",",":"))."""
    s = json.dumps(js_clean(obj), ensure_ascii=False, separators=(",", ":"))
    # 짝 없는 서로게이트는 UTF-8 로 못 쓰므로 JSON.stringify 처럼 \udxxx 로 적는다
    return LONE_SURROGATE_RE.sub(lambda m: "\\u%04x" % ord(m.group()), s)


def write_output(path, obj):
    """파일을 쓴다. 'generated'만 다르고 내용이 같으면 그대로 둔다(시각만 바뀐 커밋 방지).
    반환: 새로 썼으면 True."""
    text = dump_js(obj)
    old_text = None
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                old_text = f.read()
        except (OSError, ValueError):
            old_text = None
    if old_text is not None:
        try:
            old = json.loads(old_text)
        except ValueError:
            old = None
        if isinstance(old, dict) and "generated" in old:
            same = dict(obj)
            same["generated"] = old["generated"]
            if dump_js(same) == old_text:
                return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)
    return True


# =====================================================================================
# 1. 수집일 · 분석 창 (도우미)
# =====================================================================================
DATE_FILE_RE = re.compile(r"[0-9]{4}-[0-9][0-9]-[0-9][0-9]\.json")
WEBTOON_SUB_RE = re.compile(r"16[0-9][0-9]")


def is_webtoon_code(code):
    """웹툰 랭킹 코드: 4250(BL웹툰), 1600~1649(웹툰·하위장르). 1650~은 웹소설"""
    if code == "4250":
        return True
    return WEBTOON_SUB_RE.fullmatch(code) is not None and int(code) < 1650


# =====================================================================================
# 3. 이벤트 작품명 추출 · 정규화 · 유형 분류 (도우미)
# =====================================================================================
OPEN = {"<": ">", "〈": "〉", "《": "》"}
CLOSE_CHARS = (">", "〉", "》")


def extract_names(s):
    """<...>, 〈...〉, 《...》 바깥 괄호 안의 작품명(같은 여는 괄호의 중첩 깊이를 센다)."""
    out = []
    if not s:
        return out
    ln = len(s)
    i = 0
    while i < ln:
        c = s[i]
        close = OPEN.get(c)
        if close is None:
            i += 1
            continue
        depth = 0
        j = i
        while j < ln:
            if s[j] == c:
                depth += 1
            elif s[j] == close:
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j >= ln:                  # 닫는 괄호 없음 → 무시
            i += 1
            continue
        inner = js_trim(s[i + 1:j])
        if inner:
            out.append(inner)
        i = j + 1
    return out


STRIP_HTML_RE = jsre(r"</?(b|br)\s*/?>", I_FLAGS)


def strip_html(s):
    """설명의 <b>,</b>,<br>만 지운다(<BJ알렉스> 같은 작품명은 남긴다)."""
    return STRIP_HTML_RE.sub("", s or "")


# 정규화: NFKC → 소문자 → 한글·영숫자·한자·가나만 남김
NORM_RE = re.compile(r"[^0-9a-z\uac00-\ud7a3\u3131-\u314e\u314f-\u3163\u4e00-\u9fff\u3040-\u30ff]")


def norm(s):
    return NORM_RE.sub("", unicodedata.normalize("NFKC", s or "").lower())


VK_LEAD = jsre(r"^\s*\[[^\]]*\]\s*")
VK_TAIL = jsre(r"\s*\[[^\]]*\]\s*\Z")
VK_PAREN = re.compile(r"\([^)]*\)")
VK_BRACKET = re.compile(r"\[[^\]]*\]")
VK_PAREN_IN = re.compile(r"\(([^)]*)\)")
DERIV_PAREN = re.compile(r"\([^)]*(판|세트)[^)]*\)")


def variant_keys(t):
    """변형 키: 앞/뒤 [..](완전판·개정판·세트 등) 제거, (..) 괄호 병기 제거, 둘 다 제거,
    괄호 안 영문 병기(정규화 4자 이상). 반환은 중복 없는 목록(넣은 순서)."""
    forms = [
        t,
        VK_LEAD.sub("", t, count=1),
        VK_TAIL.sub("", t, count=1),
        VK_PAREN.sub("", t),
        VK_PAREN.sub("", VK_BRACKET.sub("", t)),
    ]
    for m in VK_PAREN_IN.finditer(t):
        if len(norm(m.group(1))) >= 4:
            forms.append(m.group(1))
    keys = []
    for f in forms:
        k = norm(f)
        if len(k) >= 2 and k not in keys:
            keys.append(k)
    return keys


def deriv_base(t):
    """파생 상품 키: 제목에서 [..] 전부와 '판'·'세트'가 든 (..)를 지운 정규화 키.
    예) '[시즌 1 세트] <록사나 : …>', '폐하의 밤 [완전판]', '터치 유어 바디 (Touch Your Body) (개정판)'"""
    return norm(DERIV_PAREN.sub("", VK_BRACKET.sub("", t)))


CB_PRICE = jsre(r"소장가|소장\s*[0-9,]+\s*원|%\s*▼|▼\s*\d+\s*%|special\s*discount|할인|반값", I_FLAGS)
CB_FREE = jsre(r"무료|리다무|기다무|매다무|free", I_FLAGS)
CB_POINT = jsre(r"포인트|\d[0-9,]*\s*P(?![A-Za-z0-9_])|추첨")     # JS 의 P\b (ASCII 단어 경계)
CB_TICKET = jsre(r"랜덤\s*티켓|랜티")
CT_CONTENT = jsre(r"시즌\s*\d+\s*(시작|오픈|연재|공개|컴백|돌아|완결)|[2-9]\s*부\s*(시작|오픈|연재|공개)"
                  r"|완결|외전|연참|휴재\s*복귀|연재\s*재개|복귀|컴백|후속화|일괄\s*공개"
                  r"|\d+\s*화\s*(기념|돌파)|시즌\s*([2-9]|\d\d)\s*(론칭|런칭)")
CT_LAUNCH = jsre(r"론칭|런칭|커밍\s*순|coming\s*soon|신작|출간", I_FLAGS)
CT_PAPER = jsre(r"종이책|e북|단행본", I_FLAGS)
CT_LATEST = jsre(r"최신\s*화|다음\s*화|릴레이|relay", I_FLAGS)
K_ORDER = ["가격할인", "무료", "포인트", "랜덤티켓", "최신화", "콘텐츠", "론칭"]


def classify_body(x):
    """본문(설명 조각·제목 공통) 유형"""
    k = set()
    if CB_PRICE.search(x):
        k.add("가격할인")
    if CB_FREE.search(x):
        k.add("무료")
    if CB_POINT.search(x):
        k.add("포인트")
    if CB_TICKET.search(x):
        k.add("랜덤티켓")
    return k


def classify_title(x):
    """제목 유형 = 본문 유형 + 제목 전용 유형(콘텐츠·론칭·최신화)"""
    k = classify_body(x)
    if CT_CONTENT.search(x):
        k.add("콘텐츠")
    if CT_LAUNCH.search(x) and not CT_PAPER.search(x):
        k.add("론칭")
    if CT_LATEST.search(x):
        k.add("최신화")
    return k


def k_list(kset):
    return [x for x in K_ORDER if x in kset]


LINE_SPLIT_RE = re.compile(r"\n+")


def split_clauses(desc):
    """설명을 줄 → '&'(괄호 밖) 조각으로 나눈다. 조각에 작품명이 없으면 같은 줄 앞 조각의 이름을 물려받는다."""
    out = []
    for line in LINE_SPLIT_RE.split(strip_html(desc)):
        parts = []
        depth = 0
        cur = []
        for ch in line:
            if ch in OPEN:
                depth += 1
            elif ch in CLOSE_CHARS:
                depth = max(0, depth - 1)
            if ch == "&" and depth == 0:
                parts.append("".join(cur))
                cur = []
            else:
                cur.append(ch)
        parts.append("".join(cur))
        inherit = []
        for p in parts:
            names = extract_names(p)
            if names:
                inherit = names
            out.append({"text": p, "names": names if names else inherit})
    return out


def clean_url(u):
    """원본 url 이 'https://ridibooks.comhttps://ridibooks.com/books/…'처럼 중복된 경우가 있어 마지막 http부터 쓴다."""
    if not js_truthy(u) or not isinstance(u, str):
        return None
    i = u.rfind("http")
    return u[i:] if i > 0 else u


BOOK_URL_RE = re.compile(r"/books/([0-9]+)")


def book_id_from_url(u):
    m = BOOK_URL_RE.search(u if isinstance(u, str) else "")
    return m.group(1) if m else None


def is_wt_genre(g):
    return g == "webtoon" or g == "bl_webtoon"


# =====================================================================================
# 6. 업데이트 · 주기 (도우미)
# =====================================================================================
def period_of(iv):
    """주기: 간격의 최빈값(±1일 허용, 동률이면 짧은 쪽) 주변 간격들의 중앙값을 반올림."""
    if not iv:
        return None
    cands = sorted(set(iv))
    best = None
    bs = -1
    for c in cands:
        sc = sum(1 for x in iv if abs(x - c) <= 1)
        if sc > bs:
            bs = sc
            best = c
    return math.floor(median([x for x in iv if abs(x - best) <= 1]) + 0.5)


def intervals(ups):
    return [ups[i]["n"] - ups[i - 1]["n"] for i in range(1, len(ups))]


def correct_gap_updates(ups):
    """관측 공백(08-27 수집 누락·랭킹 밖) 뒤에 잡힌 업데이트를, 다른 업데이트와 주기가
    맞는 날로 옮긴다(그런 날이 하나뿐일 때만). 앞에서 옮긴 값이 뒤 판정에 쓰인다(JS 와 같음)."""
    p0 = period_of(intervals(ups))
    if not p0 or p0 < 5 or len(ups) < 3:
        return
    for u in ups:
        if u["prevN"] is None or u["obsN"] - u["prevN"] <= 1:
            continue
        others = [o["n"] for o in ups if o is not u]
        best = -1
        best_x = []
        for x in range(u["prevN"] + 1, u["obsN"] + 1):
            sc = sum(1 for o in others if (x - o) % p0 == 0)
            if sc > best:
                best = sc
                best_x = [x]
            elif sc == best:
                best_x.append(x)
        if best > 0 and len(best_x) == 1:
            u["n"] = best_x[0]


def is_normal_cycle(c):
    return c["phaseKnown"] and not c["binge"] and not c["hiatus"] and not c["afterHiatus"]


# =====================================================================================
# 8. 레벨 변화 후보 (도우미)
# =====================================================================================
def persist_label(ratio):
    """유지율 → 지속(>=0.5) / 일시(<=0.33) / 부분. NaN 은 '부분'(JS 와 같음)."""
    if ratio >= 0.5:
        return "지속"
    if ratio <= 0.33:
        return "일시"
    return "부분"


def prior7(r, n):
    """직전 7일(수집된 날만, 200위 밖=250)"""
    return [r[k] for k in range(n - 7, n) if k >= 0 and r[k] is not None]


def win_stats(zr, cens, lo, hi):
    """[lo, hi] 구간의 평균·관측 수·200위 밖 비중"""
    v = []
    nc = 0
    for k in range(max(0, lo), min(len(zr) - 1, hi) + 1):
        if zr[k] is not None:
            v.append(zr[k])
            if cens[k]:
                nc += 1
    return {"m": mean(v) if v else None, "n": len(v), "cs": nc / len(v) if v else None}


def kind_pri(c):
    """합치기 우선순위: episode > noep 급등 > noep 창"""
    if c["kind"] == "episode":
        return 0
    return 1 if c.get("sub") == "spike" else 2


def cmp_cand(a, b):
    r = kind_pri(a) - kind_pri(b)
    if js_truthy(r):
        return r
    r = abs(b["z"]) - abs(a["z"])
    if js_truthy(r):
        return r
    r = a["d"] - b["d"]
    if js_truthy(r):
        return r
    ai, bi = a["it"]["id"], b["it"]["id"]
    if ai < bi:
        return -1
    if ai > bi:
        return 1
    return -1 if a["per"] < b["per"] else 1


def cmp_link(sg_a):
    """가격지문 ↔ 이벤트 연결: 시작이 가장 가까운 것, 동률이면 eid 작은 것"""
    def cmp(x, y):
        r = abs(x["a"] - sg_a) - abs(y["a"] - sg_a)
        if js_truthy(r):
            return r
        return -1 if x["eid"] < y["eid"] else 1
    return cmp


def cmp_item(a, b):
    """items 정렬: d 내림차순, z 내림차순, id, per"""
    if a["d"] < b["d"]:
        r = 1
    elif a["d"] > b["d"]:
        r = -1
    else:
        r = 0
    if js_truthy(r):
        return r
    r = b["z"] - a["z"]
    if js_truthy(r):
        return r
    if a["id"] < b["id"]:
        return -1
    if a["id"] > b["id"]:
        return 1
    return -1 if a["per"] < b["per"] else 1


# =====================================================================================
# 10. 설명문(note) 도우미: 한국어 한두 문장, 숫자 포함, 해요체
# =====================================================================================
PER_NAME = {"DAILY": "오늘의 베스트", "WEEKLY": "주간 순위"}
PERSIST_TXT = {   # 첫 문장 뒤에 붙는 지속성(연결형)
    "episode": {"지속": "다음 회차에도 유지됐어요.", "일시": "다음 회차엔 원래대로 돌아갔어요.",
                "부분": "다음 회차에 일부 되돌아갔어요.", "보류": "다음 회차는 아직 못 봤어요."},
    "noep": {"지속": "이후에도 이어졌어요.", "일시": "곧 원래대로 돌아갔어요.",
             "부분": "이후 일부 되돌아갔어요.", "보류": "이후 흐름은 아직 몰라요."},
}
WS_RUN_RE = jsre(r"\s+")
PRICE_PREFIX_RE = jsre(r"^회당가\s*")


def rank_txt(v):
    return "200위 밖" if v >= 199.5 else str(math.floor(v + 0.5)) + "위"


def ro(txt):
    """조사: '200위 밖으로' / '24위로'"""
    return "으로" if txt.endswith("밖") else "로"


def short_title(t, ln=34):
    """길이는 코드포인트 기준(JS Array.from 과 같음)"""
    cp = list(js_trim(WS_RUN_RE.sub(" ", t)))
    if len(cp) > ln:
        return "".join(cp[:ln - 1]) + "…"
    return "".join(cp)


def period_txt(p):
    a = p["s"][:10]
    b = p["e"][:10]
    return md(a) + " 하루" if a == b else md(a) + "~" + md(b)


def promo_phrase(promos):
    """프로모션 묶음 설명: 가격지문(숫자)을 먼저, 이벤트 제목은 하나만, 기간한정 기다무는 따로.
    예) '9/14 하루 회당가 할인 579→193원(-67%) · 이벤트 ‘Beyond Special Discount …’'"""
    prs = sorted([p for p in promos if p["src"] == "price"], key=lambda p: p["a"])
    evs = sorted([p for p in promos if p["src"] == "event"],
                 key=lambda p: (0 if p["role"] == "main" else 1, p["a"]))
    wfs = sorted([p for p in promos if p["src"] == "wff"], key=lambda p: p["a"])
    pr = prs[0] if prs else None
    ev = evs[0] if evs else None
    wf = wfs[0] if wfs else None
    first = pr or ev or wf
    parts = []
    if pr:
        parts.append("회당가 할인 " + PRICE_PREFIX_RE.sub("", pr["t"], count=1))
    if ev:
        parts.append("이벤트 ‘" + short_title(ev["t"]) + "’" + ("(설명에 언급)" if ev["role"] == "mentioned" else ""))
    if wf:
        parts.append(wf["t"])
    return period_txt(first) + " " + " · ".join(parts)


LABEL_KO = {
    "promo_live": "프로모션 진행 중(판정 대기)",
    "promo_temp": "프로모션 끝나고 복귀",
    "promo_kept": "프로모션 후에도 유지",
    "promo_end": "프로모션 끝나며 하락",
    "content": "시즌·완결·외전(분리 불가)",
    "none": "확인된 프로모션 없음",
}


# =====================================================================================
# 분석기 본체 (참조 구현의 전역 상태 = 이 객체의 속성)
# =====================================================================================
class Analyzer:
    def __init__(self, data_dir):
        self.data = data_dir
        self.t_start = time.time()
        self.WORK_PROMOS = {}        # id -> [promo]
        self.PLATFORM = []
        self.ev_stat = {"webtoon_events_in_window": 0, "work_events": 0, "platform_events": 0,
                        "platform_skipped_long": 0, "unmatched_named": 0,
                        "empty_k_work": 0, "empty_k_platform": 0}
        self.price_stat = {"segments": 0, "works": 0}
        self.wff_stat = 0
        self.CANDS = []
        self.EXCL = {}               # 제외 사유별 개수
        self.EXCL_LIST = []

    def run(self):
        self.load_rankings()         # 1. 1차 패스: 랭킹
        self.load_snapshots()        # 1. 2차 패스: 스냅샷
        self.catalog = read_json(os.path.join(self.data, "books.json"))
        self.build_match_index()     # 3d
        self.build_event_promos()    # 3f
        self.build_price_promos()    # 4
        self.build_wff_promos()      # 5
        self.sort_promos()
        self.build_items()           # 6
        self.fit_templates()         # 7
        self.estimate_sigma()        # 7b
        self.find_episode_shifts()   # 8a
        self.find_spikes()           # 8b
        self.find_window_shifts()    # 8c
        self.merge_candidates()      # 8d
        return self.build_outputs()  # 9~11

    # ---------------------------------------------------------------------------------
    # 1. 수집일 · 분석 창
    #    DATES[n] = 창 시작일 + n일 (달력일). VALID[n] = 그날 웹툰 랭킹이 수집됐는가.
    #    COLL[n] = 그날 collected_at(ms). 08-27처럼 웹툰 랭킹이 없는 날은 VALID=False.
    # ---------------------------------------------------------------------------------
    def load_rankings(self):
        daily_dir = os.path.join(self.data, "daily")
        files = sorted(f for f in os.listdir(daily_dir) if DATE_FILE_RE.fullmatch(f))
        if not files:
            raise SystemExit("daily 파일이 없습니다: " + daily_dir)
        self.daily_files = files
        self.LAST_DATE = files[-1][:10]
        first_all = files[0][:10]
        if day_num(first_all) > day_num(self.LAST_DATE) - (WINDOW_DAYS - 1):
            self.WIN_START = first_all
        else:
            self.WIN_START = day_str(day_num(self.LAST_DATE) - (WINDOW_DAYS - 1))
        N = day_num(self.LAST_DATE) - day_num(self.WIN_START) + 1
        self.N = N
        self.DATES = [day_str(day_num(self.WIN_START) + n) for n in range(N)]
        self.IDX = {d: n for n, d in enumerate(self.DATES)}
        self.VALID = [False] * N
        self.COLL = [None] * N
        self.SHIFT_KEYS = [g + "-" + p for g in SHIFT_GROUPS for p in PERS]
        self.RANK = {k: [None] * N for k in self.SHIFT_KEYS}   # RANK[key][n] = {id: 순위} | None
        self.promo_target_set = set()   # 웹툰 랭킹(1600~1649·4250) 200위 안에 든 작품
        self.best50 = {}                # best50[g][id] = 기간 중 g-DAILY/WEEKLY 최고 순위

        for f in files:
            d = f[:10]
            if d not in self.IDX:
                continue
            n = self.IDX[d]
            j = read_json(os.path.join(daily_dir, f))
            rk = (j.get("rankings") if isinstance(j, dict) else None) or {}
            has_webtoon = False
            for key in list(rk.keys()):
                code = key.split("-")[0]
                if not is_webtoon_code(code):
                    continue
                has_webtoon = True
                t = rk[key]
                ids = t.get("ids") if isinstance(t, dict) else None
                if not ids:
                    ids = []
                for bid in ids:
                    self.promo_target_set.add(js_string(bid))
                if key in self.RANK:
                    m = {}
                    for i, bid in enumerate(ids):
                        m[js_string(bid)] = i + 1
                    self.RANK[key][n] = m
                    b50 = self.best50.setdefault(code, {})
                    for i, bid in enumerate(ids):
                        s = js_string(bid)
                        if s not in b50 or i + 1 < b50[s]:
                            b50[s] = i + 1
            if has_webtoon and js_truthy(rk.get("1600-DAILY")):
                self.VALID[n] = True
                self.COLL[n] = parse_ms(j.get("collected_at"))
        self.VALID_IDX = [n for n in range(N) if self.VALID[n]]
        if not self.VALID_IDX:
            raise SystemExit("웹툰 랭킹이 수집된 날이 없습니다.")
        self.LAST_N = self.VALID_IDX[-1]

    def load_snapshots(self):
        """대상작 스냅샷(ep 총회차, p 총가격, rc 별점참여, c 완결). SNAP[id][n] = dict | None"""
        daily_dir = os.path.join(self.data, "daily")
        self.SNAP = {bid: [None] * self.N for bid in self.promo_target_set}
        for f in self.daily_files:
            d = f[:10]
            if d not in self.IDX:
                continue
            n = self.IDX[d]
            if not self.VALID[n]:
                continue
            j = read_json(os.path.join(daily_dir, f))
            sn = (j.get("snapshots") if isinstance(j, dict) else None) or {}
            for bid in self.promo_target_set:
                s = sn.get(bid)
                if isinstance(s, dict):
                    self.SNAP[bid][n] = {"ep": s.get("ep"), "p": s.get("p"), "rc": s.get("rc"), "c": s.get("c")}

    def title_of(self, bid):
        c = self.catalog.get(bid) if isinstance(self.catalog, dict) else None
        t = c.get("t") if isinstance(c, dict) else None
        return t if isinstance(t, str) and t else ""

    def adult_of(self, bid):
        c = self.catalog.get(bid) if isinstance(self.catalog, dict) else None
        return 1 if isinstance(c, dict) and js_truthy(c.get("ad")) else 0

    # ---------------------------------------------------------------------------------
    # 2. 프로모션 반영 수집일 a/b
    #    a = 수집시각 >= 시작 이고 (수집시각 - 24h) <= 종료 인 첫 수집일
    #        (시작이 그날 수집시각 이후면 다음날부터 반영)
    #    b = 같은 조건의 마지막 수집일 (오늘의베스트는 직전 24시간 판매라 종료 다음날
    #        아침 스냅샷까지 반영). 반영된 수집일이 없으면 None.
    # ---------------------------------------------------------------------------------
    def reflect_range(self, start_ms, end_ms):
        a = None
        b = None
        for n in self.VALID_IDX:
            cn = self.COLL[n]
            if cn is None:
                continue
            if cn >= start_ms and cn - DAY_MS <= end_ms:
                if a is None:
                    a = n
                b = n
        return None if a is None else (a, b)

    # ---------------------------------------------------------------------------------
    # 3. 이벤트 수집 · 매칭
    # ---------------------------------------------------------------------------------
    def load_events(self):
        """ended.json 먼저, 그다음 날짜 파일 오름차순(뒤 파일이 앞을 덮어씀 = 최신 정보 우선). id 순."""
        ev_dir = os.path.join(self.data, "events")
        files = []
        if os.path.exists(os.path.join(ev_dir, "ended.json")):
            files.append("ended.json")
        if os.path.isdir(ev_dir):
            files.extend(sorted(f for f in os.listdir(ev_dir) if DATE_FILE_RE.fullmatch(f)))
        ev = {}
        for f in files:
            j = read_json(os.path.join(ev_dir, f))
            for e in ((j.get("events") if isinstance(j, dict) else None) or []):
                if isinstance(e, dict):
                    ev[js_string(e.get("id"))] = e
        return [ev[k] for k in sorted(ev)]

    def build_match_index(self):
        """3d. 매칭 인덱스(대상작 = 웹툰 랭킹 등장작만): 정확 키 / 변형 키 / 파생 상품 키 → id 목록(오름차순)"""
        self.promo_targets = sorted(self.promo_target_set)
        self.EXACT = {}
        self.VARI = {}
        self.DERIV = {}
        for bid in self.promo_targets:
            t = self.title_of(bid)
            if not t:
                continue
            ek = norm(t)
            if ek:
                self.EXACT.setdefault(ek, []).append(bid)
            for k in variant_keys(t):
                self.VARI.setdefault(k, []).append(bid)
        for bid in self.promo_targets:
            t = self.title_of(bid)
            if not t:
                continue
            bk = deriv_base(t)
            if bk and bk != norm(t):
                self.DERIV.setdefault(bk, []).append(bid)

    def match_name(self, name):
        """정확 일치 우선(+그 작품의 파생 상품), 없으면 변형 키 교집합"""
        nk = norm(name)
        if not nk:
            return []
        if nk in self.EXACT:
            return sorted(set(self.EXACT[nk]) | set(self.DERIV.get(nk, [])))
        s = set()
        for k in variant_keys(name):
            for bid in self.VARI.get(k, []):
                s.add(bid)
        return sorted(s)

    def add_promo(self, bid, p):
        self.WORK_PROMOS.setdefault(bid, []).append(p)

    def build_event_promos(self):
        """3f. 이벤트 → 작품별 항목 / 플랫폼 항목"""
        st = self.ev_stat
        for e in self.load_events():
            genres = [g for g in (e.get("genres") or []) if is_wt_genre(g)]
            if not genres:
                continue                                       # 웹툰·BL웹툰 이벤트만
            s_ms = parse_ms(e.get("start_date"))
            e_ms = parse_ms(e.get("end_date"))
            if s_ms is None or e_ms is None:
                continue
            rr = self.reflect_range(s_ms, e_ms)
            if rr is None:
                continue                                       # 창 안에 반영된 수집일 없음
            st["webtoon_events_in_window"] += 1
            title = e.get("title") or ""
            if not isinstance(title, str):
                title = js_string(title)
            title_names = extract_names(title)
            desc = e.get("description") or ""
            clauses = split_clauses(desc if isinstance(desc, str) else js_string(desc))
            # 메인 작품: 제목 <작품명> 매칭 + URL 의 /books/{id}
            main = set()
            for nm in title_names:
                for bid in self.match_name(nm):
                    main.add(bid)
            uid = book_id_from_url(e.get("url"))
            if uid and uid in self.promo_target_set:
                main.add(uid)
            # 언급 작품: 설명 조각의 <작품명> 매칭(메인 제외)
            clause_ids = []
            for c in clauses:
                s = set()
                for nm in c["names"]:
                    for bid in self.match_name(nm):
                        s.add(bid)
                clause_ids.append(s)
            mentioned = set()
            for s in clause_ids:
                for bid in s:
                    if bid not in main:
                        mentioned.add(bid)
            base = {"a": rr[0], "b": rr[1], "s": kst_str(s_ms), "e": kst_str(e_ms), "sMs": s_ms, "eMs": e_ms,
                    "eid": js_string(e.get("id")), "u": clean_url(e.get("url"))}
            if main or mentioned:
                st["work_events"] += 1
                title_k = classify_title(title)
                for bid in sorted(main | mentioned):
                    is_main = bid in main
                    k = set(title_k) if is_main else set()
                    for i, c in enumerate(clauses):
                        applies = (bid in clause_ids[i]) if c["names"] else is_main   # 이름 없는 조각은 메인 작품에만
                        if applies:
                            k |= classify_body(c["text"])
                    if not k:
                        st["empty_k_work"] += 1                   # 판매 유형이 하나도 없는 안내·굿즈 이벤트는 제외
                        continue
                    p = {"src": "event", "t": title, "k": k_list(k), "role": "main" if is_main else "mentioned"}
                    p.update(base)
                    self.add_promo(bid, p)
            elif title_names or uid:
                st["unmatched_named"] += 1                        # 작품명(또는 작품 url)은 있으나 대상작이 아님
            else:
                if (e_ms - s_ms) / DAY_MS > 60:
                    st["platform_skipped_long"] += 1              # 상시(60일 초과) 제외
                    continue
                k = classify_title(title)
                for c in clauses:
                    k |= classify_body(c["text"])
                if not k:
                    st["empty_k_platform"] += 1
                    continue
                st["platform_events"] += 1
                p = {"t": title, "k": k_list(k), "genres": genres}
                p.update(base)
                self.PLATFORM.append(p)

    # ---------------------------------------------------------------------------------
    # 4. 가격지문(소장가 할인): 회당 정가 L, 무료환산 f = ep - p/L, 기준 f0 = min f
    #    할인일: drop = 1 - p/(L*(ep-f0)) >= 0.10 이고 할인액 >= 0.95*L
    #    연속 할인일(4일 넘게 비거나 f가 2 이상 바뀌면 끊음)을 한 구간으로.
    #    a = 첫 할인 수집일, b = 마지막 할인일 다음 달력일이 수집일이면 그날(아니면 마지막 할인일)
    # ---------------------------------------------------------------------------------
    def price_segments(self, bid):
        snaps = self.SNAP[bid]
        obs = []
        for n in self.VALID_IDX:
            s = snaps[n]
            if s is not None and is_pos(s["ep"]) and is_pos(s["p"]):
                obs.append({"n": n, "ep": s["ep"], "p": s["p"]})
        if len(obs) < 2:
            return []
        # 정가 L: 회차가 늘며 가격도 늘어난 증분(원/화)의 최빈값(100~1000원, 동률이면 작은 값)
        cnt = {}
        for i in range(1, len(obs)):
            x = obs[i - 1]
            y = obs[i]
            if y["ep"] > x["ep"] and y["p"] > x["p"]:
                k = math.floor((y["p"] - x["p"]) / (y["ep"] - x["ep"]) + 0.5)
                if 100 <= k <= 1000:
                    cnt[k] = cnt.get(k, 0) + 1
        L = None
        bc = 0
        for k in sorted(cnt):
            if cnt[k] > bc:
                bc = cnt[k]
                L = k
        maxu = max(o["p"] / o["ep"] for o in obs)
        if L is None or maxu > L + 0.5:
            L = next((x for x in PRICE_STD if x >= maxu - 0.5), None)
            if L is None:
                L = math.floor(maxu + 0.5)
        for o in obs:
            o["f"] = o["ep"] - o["p"] / L
        f0 = min(o["f"] for o in obs)
        for o in obs:
            o["exp"] = L * (o["ep"] - f0)
            o["drop"] = 1 - o["p"] / o["exp"] if o["exp"] > 0 else 0
            o["promo"] = o["drop"] >= 0.10 and (o["exp"] - o["p"]) >= 0.95 * L
        segs = []
        cur = None
        for o in obs:
            if not o["promo"]:
                if cur is not None:
                    segs.append(cur)
                    cur = None
                continue
            if cur is not None and (o["n"] - cur["last"]["n"] > 4 or abs(o["f"] - cur["last"]["f"]) >= 2):
                segs.append(cur)
                cur = None
            if cur is None:
                cur = {"first": o, "last": o, "pts": [o]}
            else:
                cur["last"] = o
                cur["pts"].append(o)
        if cur is not None:
            segs.append(cur)
        out = []
        for sg in segs:
            fst = sg["first"]
            lst = sg["last"]
            ub = fst["exp"] / fst["ep"]
            up = fst["p"] / fst["ep"]
            pct = math.floor((1 - up / ub) * 100 + 0.5)
            next_n = lst["n"] + 1
            b = next_n if (next_n <= self.LAST_N and self.VALID[next_n]) else lst["n"]
            out.append({
                "src": "price", "a": fst["n"], "b": b,
                "s": kst_str(self.COLL[fst["n"]]), "e": kst_str(self.COLL[lst["n"]]),
                "sMs": self.COLL[fst["n"]], "eMs": self.COLL[lst["n"]], "ended": lst["n"] < self.LAST_N,
                "t": "회당가 " + str(math.floor(ub + 0.5)) + "→" + str(math.floor(up + 0.5)) + "원(-" + str(pct) + "%)",
                "k": ["가격할인"], "eid": None, "u": None, "role": None,
            })
        return out

    def build_price_promos(self):
        for bid in self.promo_targets:
            segs = self.price_segments(bid)
            if segs:
                self.price_stat["works"] += 1
            for sg in segs:
                self.price_stat["segments"] += 1
                # 같은 작품의 가격할인 이벤트와 겹치면 그 이벤트 id/url 을 붙인다(가장 시작이 가까운 것, 동률이면 eid 작은 것)
                evs = [p for p in self.WORK_PROMOS.get(bid, [])
                       if p["src"] == "event" and "가격할인" in p["k"] and p["a"] <= sg["b"] and p["b"] >= sg["a"]]
                link = None
                if evs:
                    link = sorted(evs, key=functools.cmp_to_key(cmp_link(sg["a"])))[0]
                else:   # 작품명 없는 플랫폼 할인 이벤트와 시작일(±1일)이 맞으면 그 이벤트로 연결
                    pl = [p for p in self.PLATFORM if "가격할인" in p["k"] and abs(p["a"] - sg["a"]) <= 1]
                    if pl:
                        link = sorted(pl, key=functools.cmp_to_key(cmp_link(sg["a"])))[0]
                if link is not None:
                    sg["eid"] = link["eid"]
                    sg["u"] = link["u"]
                self.add_promo(bid, sg)

    # ---------------------------------------------------------------------------------
    # 5. books/{id}.json 기간한정 기다무(wait_for_free): closing_date 가 2099가 아니고 기간 <= 45일
    # ---------------------------------------------------------------------------------
    def build_wff_promos(self):
        for bid in self.promo_targets:
            f = os.path.join(self.data, "books", bid + ".json")
            if not os.path.exists(f):
                continue
            try:
                b = read_json(f)
            except (OSError, ValueError):
                continue
            w = b.get("wait_for_free") if isinstance(b, dict) else None
            if not isinstance(w, dict) or not js_truthy(w.get("opening_date")) or not js_truthy(w.get("closing_date")) \
                    or js_string(w.get("closing_date")).startswith("2099"):
                continue
            s_ms = parse_ms(w.get("opening_date"))
            e_ms = parse_ms(w.get("closing_date"))
            if s_ms is None or e_ms is None or (e_ms - s_ms) / DAY_MS > 45:
                continue
            rr = self.reflect_range(s_ms, e_ms)
            if rr is None:
                continue
            self.wff_stat += 1
            ih = w.get("interval_hours")
            t = (num_str(ih) + "시간마다 " if js_truthy(ih) else "") + "기다리면 무료(기간 한정)"
            self.add_promo(bid, {"src": "wff", "a": rr[0], "b": rr[1], "s": kst_str(s_ms), "e": kst_str(e_ms),
                                 "sMs": s_ms, "eMs": e_ms, "t": t, "k": ["무료"], "eid": None, "u": None, "role": None})

    def sort_promos(self):
        """작품별 정렬: a 오름차순, 동률이면 src(event<price<wff), s, eid. ended(마지막 수집 전에 끝났나) 채움."""
        src_ord = {"event": 0, "price": 1, "wff": 2}
        last_coll = self.COLL[self.LAST_N]
        for bid in self.WORK_PROMOS:
            lst = self.WORK_PROMOS[bid]
            lst.sort(key=lambda p: (p["a"], src_ord[p["src"]], p["s"], p["eid"] or ""))
            for p in lst:
                if "ended" not in p:
                    p["ended"] = last_coll is not None and p["eMs"] < last_coll
        self.PLATFORM.sort(key=lambda p: (p["a"], p["eid"]))

    # ---------------------------------------------------------------------------------
    # 6. shifts: 시계열 · 업데이트 · 주기 · 사이클
    # ---------------------------------------------------------------------------------
    def rank_series(self, bid, key):
        """y = ln(순위) | LN250(200위 밖) | None(그날 그 랭킹 수집 없음), cens = 200위 밖"""
        N = self.N
        y = [None] * N
        cens = [False] * N
        r = [None] * N
        for n in range(N):
            m = self.RANK[key][n]
            if m is None or not self.VALID[n]:
                continue
            v = m.get(bid)
            if v:
                y[n] = math.log(v)
                r[n] = v
            else:
                y[n] = LN250
                cens[n] = True
                r[n] = 250
        return {"y": y, "cens": cens, "r": r}

    def detect_updates(self, bid):
        """업데이트 = ep 증가 AND p 변화 (직전 관측일과 비교).
          - p 증가: 보통의 유료 회차 추가
          - p 감소: 회차 추가와 소장가 할인이 같은 날 시작 → 업데이트로 본다
          - p 그대로: 공지성 무료 회차(notice, 업데이트 아님 = 휴재 신호)
        증가 회차 gain = ep - max(직전 ep, 지금까지 최대 ep), 최소 1"""
        snaps = self.SNAP[bid]
        ups = []
        notices = []
        prev = None
        prev_n = None
        max_ep = -math.inf
        for n in range(self.N):
            s = snaps[n]
            if s is None or s["ep"] is None:
                continue
            if prev is not None and s["ep"] > prev["ep"]:
                if s["p"] != prev["p"]:
                    ups.append({"n": n, "obsN": n, "prevN": prev_n,
                                "gain": max(1, s["ep"] - max(prev["ep"], max_ep)), "ep": s["ep"]})
                else:
                    notices.append({"n": n, "ep": s["ep"]})
            if s["ep"] > max_ep:
                max_ep = s["ep"]
            prev = s
            prev_n = n
        return ups, notices

    def build_items(self):
        """6a. 대상 항목(작품×그룹): g-DAILY 또는 g-WEEKLY 에서 한 번이라도 50위 안"""
        N = self.N
        self.ITEMS = []
        for g in SHIFT_GROUPS:
            b50 = self.best50.get(g, {})
            for bid in sorted(b50):
                if b50[bid] > TOP_TARGET:
                    continue
                self.ITEMS.append({"id": bid, "g": g, "t": self.title_of(bid), "ad": self.adult_of(bid)})
        for it in self.ITEMS:
            ups, notices = self.detect_updates(it["id"])
            correct_gap_updates(ups)
            ups.sort(key=lambda u: u["n"])
            it["ups"] = ups
            it["notices"] = notices
            it["P"] = period_of(intervals(ups))
            if not ups:
                it["kind"] = "none"
            elif len(ups) == 1:
                it["kind"] = "single"
            elif 5 <= it["P"] <= 13:
                it["kind"] = "periodic"
            elif it["P"] >= 14:
                it["kind"] = "long"
            else:
                it["kind"] = "fast"
            it["firstSnap"] = None
            it["epFirst"] = None
            snaps = self.SNAP[it["id"]]
            for n in range(N):
                if snaps[n] is not None:
                    it["firstSnap"] = n
                    it["epFirst"] = snaps[n]["ep"]
                    break
            upd = set()
            for u in ups:
                upd.add(u["n"])
                upd.add(u["obsN"])
            it["updDays"] = upd
            it["series"] = {per: self.rank_series(it["id"], it["g"] + "-" + per) for per in PERS}
            it["cycles"] = None
        for it in self.ITEMS:
            if it["kind"] == "periodic":
                it["cycles"] = self.build_cycles(it)
                for c in it["cycles"]:
                    c["phaseKnown"] = not (c["type"] == "data_start" and c["hiatus"])

    def build_cycles(self, it):
        """6e. 사이클(주기작): 업데이트일부터 다음 업데이트 전날까지. 레벨은 첫 P일(경과일 0..P-1)로 계산.
        data_start = 첫 업데이트 전 부분 사이클(위상 = 첫 업데이트 - P 기준). 첫 관측~첫 업데이트가 P+2일 이상이면 휴재.
        hiatus = 길이 >= 1.5P, binge = 증가 회차 >= 2(몰아공개), afterHiatus = 직전 사이클이 휴재"""
        P = it["P"]
        u = it["ups"]
        cyc = []
        if u[0]["n"] > 0:
            obs_len = u[0]["n"] - (0 if it["firstSnap"] is None else it["firstSnap"])
            st = max(0, u[0]["n"] - P)
            cyc.append({"type": "data_start", "start": st, "end": u[0]["n"] - 1, "phase0": u[0]["n"] - P,
                        "gain": 0, "ep": None, "hiatus": obs_len >= P + 2, "binge": False, "closed": True})
        for i in range(len(u)):
            end = u[i + 1]["n"] - 1 if i + 1 < len(u) else self.N - 1
            length = end - u[i]["n"] + 1
            cyc.append({"type": "update", "start": u[i]["n"], "end": end, "phase0": u[i]["n"],
                        "gain": u[i]["gain"], "ep": u[i]["ep"], "hiatus": length >= 1.5 * P,
                        "binge": u[i]["gain"] >= 2, "closed": i + 1 < len(u)})
        for k, c in enumerate(cyc):
            c["idx"] = k
            c["afterHiatus"] = k > 0 and cyc[k - 1]["hiatus"]
            c["levelEnd"] = min(c["end"], c["phase0"] + P - 1)
            c["lv"] = {per: None for per in PERS}       # JS 의 c['lv_' + per]
            c["nobs"] = {per: 0 for per in PERS}
            c["cens"] = {per: None for per in PERS}
        return cyc

    # ---------------------------------------------------------------------------------
    # 7. 톱니 템플릿 T[key][경과일] · 시장요인 m[key][n] · 사이클 레벨 (번갈아 4회 추정)
    #    레벨 = mean_{n in 첫 P일, y 있음}( y[n] - T[n-phase0] - m[n] )   (200위 밖은 LN250)
    #    T[φ] = median( y - m - 레벨 ) over 주기작의 정상 사이클·200위 안 관측, 평균(φ=0..6) 0으로 맞춤
    #    m[n] = median(그날 대상작 잔차) (주기작: y-T-레벨, 비주기작: y - 작품 중앙레벨), 10개 미만이면 0, 평균 0
    # ---------------------------------------------------------------------------------
    def cycle_level(self, it, c, per, T, m):
        ser = it["series"][per]
        y = ser["y"]
        cens = ser["cens"]
        v = []
        nc = 0
        for n in range(max(0, c["start"]), c["levelEnd"] + 1):
            ph = n - c["phase0"]
            if ph < 0 or y[n] is None:
                continue
            v.append(y[n] - T[ph] - m[n])
            if cens[n]:
                nc += 1
        return (mean(v) if v else None), len(v), (nc / len(v) if v else None)

    def set_levels(self, its, per, T, m):
        for it in its:
            if it["cycles"] is None:
                continue
            for c in it["cycles"]:
                if not c["phaseKnown"]:
                    continue
                lv, nobs, cs = self.cycle_level(it, c, per, T, m)
                c["lv"][per] = lv
                c["nobs"][per] = nobs
                c["cens"][per] = cs

    def fit_templates(self):
        N = self.N
        self.TPL = {}
        self.MKT = {}
        for g in SHIFT_GROUPS:
            for per in PERS:
                key = g + "-" + per
                its = [it for it in self.ITEMS if it["g"] == g]
                T = [0] * MAX_PHASE
                m = [0] * N
                for _iteration in range(4):
                    self.set_levels(its, per, T, m)
                    # 템플릿
                    by_ph = [[] for _ph in range(MAX_PHASE)]
                    for it in its:
                        if it["cycles"] is None:
                            continue
                        y = it["series"][per]["y"]
                        cens = it["series"][per]["cens"]
                        for c in it["cycles"]:
                            if not is_normal_cycle(c) or c["lv"][per] is None:
                                continue
                            for n in range(max(0, c["start"]), c["levelEnd"] + 1):
                                ph = n - c["phase0"]
                                if ph >= 0 and y[n] is not None and not cens[n]:
                                    by_ph[ph].append(y[n] - m[n] - c["lv"][per])
                    T2 = [0] * MAX_PHASE
                    for ph in range(MAX_PHASE):
                        v = median(by_ph[ph])
                        if v is None:
                            T2[ph] = T2[ph - 1] if ph > 0 else 0
                        else:
                            T2[ph] = v
                    c0 = mean(T2[0:7])
                    T = [x - c0 for x in T2]
                    self.set_levels(its, per, T, m)
                    # 시장요인
                    vals = [[] for _n in range(N)]
                    for it in its:
                        y = it["series"][per]["y"]
                        cens = it["series"][per]["cens"]
                        if it["cycles"] is not None:
                            for c in it["cycles"]:
                                if not is_normal_cycle(c) or c["lv"][per] is None:
                                    continue
                                for n in range(max(0, c["start"]), c["levelEnd"] + 1):
                                    ph = n - c["phase0"]
                                    if ph >= 0 and y[n] is not None and not cens[n]:
                                        vals[n].append(y[n] - T[ph] - c["lv"][per])
                        else:
                            lvl = median([None if (v is None or cens[n]) else v - m[n] for n, v in enumerate(y)])
                            if lvl is None:
                                continue
                            for n in range(N):
                                if y[n] is not None and not cens[n]:
                                    vals[n].append(y[n] - lvl)
                    m2 = [median(v) if len(v) >= 10 else 0 for v in vals]
                    used = [m2[n] for n in range(N) if self.VALID[n] and len(vals[n]) >= 10]
                    mc = mean(used) if used else 0
                    m = [(x - mc) if (self.VALID[n] and len(vals[n]) >= 10) else 0 for n, x in enumerate(m2)]
                self.set_levels(its, per, T, m)
                self.TPL[key] = T
                self.MKT[key] = m

    def estimate_sigma(self):
        """7b. 노이즈 σ (랭킹·기간별): 인접한 두 사이클이 모두 정상·완전(관측 >= P-1)·200위 밖 비중 < 0.5일 때
        레벨 차의 MAD × 1.4826 / √2"""
        self.SIGMA = {}
        for key in self.SHIFT_KEYS:
            g, per = key.split("-")
            diffs = []
            for it in self.ITEMS:
                if it["g"] != g or it["cycles"] is None:
                    continue
                cyc = it["cycles"]
                for k in range(1, len(cyc)):
                    a = cyc[k - 1]
                    b = cyc[k]
                    if not is_normal_cycle(a) or not is_normal_cycle(b):
                        continue
                    if a["lv"][per] is None or b["lv"][per] is None:
                        continue
                    if a["nobs"][per] < it["P"] - 1 or b["nobs"][per] < it["P"] - 1:
                        continue
                    if a["cens"][per] >= 0.5 or b["cens"][per] >= 0.5:
                        continue
                    diffs.append(b["lv"][per] - a["lv"][per])
            self.SIGMA[key] = {"sigma": sigma_of(diffs, SQRT2, SIGMA_DEFAULT["cycle"]), "n": len(diffs)}

    # ---------------------------------------------------------------------------------
    # 8. 레벨 변화 후보
    # ---------------------------------------------------------------------------------
    def note_excl(self, r, it, kind, per, d):
        self.EXCL[r] = self.EXCL.get(r, 0) + 1
        if it is not None:
            self.EXCL_LIST.append({"r": r, "t": it["t"], "g": it["g"], "kind": kind, "per": per, "d": self.DATES[d],
                                   "firstSnap": None if it["firstSnap"] is None else self.DATES[it["firstSnap"]],
                                   "epFirst": it["epFirst"]})

    def launch_phase(self, it, d):
        """신작 런칭 국면: 창 시작 뒤 처음 관측됐고 첫 관측 회차 <= 12, 변화일이 첫 관측 14일 이내
        또는 론칭 이벤트(콘텐츠 아님)가 변화일 14일 전~1일 뒤에 시작"""
        fs_n = it["firstSnap"]
        ep0 = it["epFirst"]
        if fs_n is not None and fs_n > 0 and d - fs_n <= 14 and ep0 is not None and ep0 <= 12:
            return True
        for p in self.WORK_PROMOS.get(it["id"], []):
            if p["src"] == "event" and "론칭" in p["k"] and "콘텐츠" not in p["k"] and d - 14 <= p["a"] <= d + 1:
                return True
        return False

    def find_episode_shifts(self):
        """8a. episode(주기작 사이클): 직전 정상 사이클 최대 3개 레벨의 중앙값 B, z = (L-B)/(σ√(1+1/n))
        변화가 이어지는 다음 사이클(같은 방향, 변화폭의 50% 이상)은 같은 변화의 연장이라 새로 잡지 않는다."""
        for it in self.ITEMS:
            if it["kind"] != "periodic":
                continue
            P = it["P"]
            cycles = it["cycles"]
            for per in PERS:
                key = it["g"] + "-" + per
                sig = self.SIGMA[key]["sigma"]
                t_bar = mean(self.TPL[key][0:P])
                active = None
                for c in cycles:
                    L = c["lv"][per]
                    if not c["phaseKnown"] or L is None or c["nobs"][per] < 3:
                        continue
                    if active is not None and jsign(L - active["B"]) == jsign(active["diff"]) \
                            and abs(L - active["B"]) >= 0.5 * abs(active["diff"]):
                        continue                                  # 연장
                    active = None
                    base = [b for b in cycles[0:c["idx"]]
                            if is_normal_cycle(b) and b["lv"][per] is not None and b["nobs"][per] >= 3][-3:]
                    if not base:
                        continue
                    B = median([b["lv"][per] for b in base])
                    z = (L - B) / (sig * math.sqrt(1 + 1 / len(base)))
                    if abs(z) < Z_MIN:
                        continue
                    active = {"B": B, "diff": L - B}              # 제외되더라도 연장 억제에는 쓴다
                    excl = None
                    if c["type"] == "data_start":
                        excl = "관측 시작 부분사이클"
                    elif c["binge"]:
                        excl = "몰아공개"
                    elif c["afterHiatus"]:
                        excl = "휴재 복귀"
                    elif all(b["type"] == "data_start" for b in base):
                        excl = "기준이 관측 시작 부분사이클뿐"
                    elif self.launch_phase(it, c["start"]):
                        excl = "신작 런칭 국면"
                    if excl:
                        self.note_excl(excl, it, "episode", per, c["start"])
                        continue
                    # 지속성: 다음 사이클(몰아공개·휴재복귀 아님, 관측 3일 이상)
                    nx = next((q for q in cycles[c["idx"] + 1:]
                               if q["phaseKnown"] and not q["binge"] and not q["afterHiatus"]
                               and q["lv"][per] is not None and q["nobs"][per] >= 3), None)
                    persist = persist_label(jdiv(nx["lv"][per] - B, L - B)) if nx is not None else "보류"
                    self.CANDS.append({
                        "it": it, "kind": "episode", "per": per, "d": c["start"], "dir": "up" if L < B else "down",
                        "z": z, "B": B, "L": L, "persist": persist, "ep": c["ep"], "cyc": c,
                        "before": min(250, math.exp(B + t_bar)), "after": min(250, math.exp(L + t_bar)),
                        "nextLv": nx["lv"][per] if nx is not None else None,
                        "nextStart": nx["start"] if nx is not None else None,
                    })

    def upd_near(self, it, n):
        """회차 변화 확인 구간: n-3 ~ n+1 (±1일만 보면 주기작의 업데이트 2~3일 뒤가 직전 7일 중앙값
        (이전 사이클 꼬리) 대비 3배로 잡히는 톱니 착시가 생김. 예: 악인담 9/16·알파 트라우마 9/10)"""
        upd = it["updDays"]
        for k in range(n - 3, n + 2):
            if k in upd:
                return True
        return False

    def find_spikes(self):
        """8b. noep 급등(DAILY): 업데이트가 직전 3일~다음 1일에 없고, 순위 <= 60위이며 직전 7일(수집일,
        200위 밖=250) 중앙값 대비 3배 이상 좋아진 첫날.
        변화일 d = 그날, 단 바로 앞 수집일(최대 2개)이 이미 기준 대비 2배 이상 좋았으면 그날로 앞당김.
        peak = min(그날, 다음날) 순위. z = (ln peak - ln 기준) / σ_spike.
        σ_spike = 업데이트 구간(n-3~n+1)이 아닌 모든 날의 (ln순위 - ln 직전7일중앙값) MAD×1.4826
                  (그날·기준 모두 200위 밖인 날 제외)
        지속성: 3일 안에 상승폭이 절반 이하(로그 중간점 이상 순위)로 돌아가면 일시,
                아니면 4~10일 뒤 중앙값의 유지율로 지속(>=0.5)/부분/일시(<=0.33), 관측 2일 미만이면 보류"""
        N = self.N
        self.SIG_SPIKE = {}
        for g in SHIFT_GROUPS:
            dev = []
            for it in self.ITEMS:
                if it["g"] != g:
                    continue
                r = it["series"]["DAILY"]["r"]
                for n in range(N):
                    if r[n] is None or self.upd_near(it, n):
                        continue
                    pv = prior7(r, n)
                    if len(pv) < 4:
                        continue
                    base = median(pv)
                    if r[n] >= 250 and base >= 250:
                        continue
                    dev.append(math.log(r[n]) - math.log(base))
            self.SIG_SPIKE[g + "-DAILY"] = {"sigma": sigma_of(dev, 1, SIGMA_DEFAULT["spike"]), "n": len(dev)}

        for it in self.ITEMS:
            r = it["series"]["DAILY"]["r"]
            y = it["series"]["DAILY"]["y"]
            sig = self.SIG_SPIKE[it["g"] + "-DAILY"]["sigma"]
            snaps = self.SNAP[it["id"]]
            last_spike = -999
            for n in range(N):
                if r[n] is None or r[n] > 60 or self.upd_near(it, n) or n - last_spike <= 7:
                    continue
                pv = prior7(r, n)
                if len(pv) < 4:
                    continue
                base = median(pv)
                if base / r[n] < 3:
                    continue
                last_spike = n
                # 변화 시작일 d0: 직전 수집일(최대 2개)이 이미 기준의 절반 이하 순위이고 업데이트 구간이 아니면 앞당긴다
                d0 = n
                step = 0
                for k in range(n - 1, -1, -1):
                    if step >= 2:
                        break
                    if r[k] is None:
                        continue
                    step += 1
                    if r[k] <= base / 2 and not self.upd_near(it, k):
                        d0 = k
                    else:
                        break
                if n + 1 < N and r[n + 1] is not None and r[n + 1] < r[n]:
                    peak = r[n + 1]
                else:
                    peak = r[n]
                B = math.log(base)
                L = math.log(peak)
                z = (L - B) / sig
                if abs(z) < Z_MIN:
                    continue
                if self.launch_phase(it, d0):
                    self.note_excl("신작 런칭 국면", it, "spike", "DAILY", d0)
                    continue
                mid = (B + L) / 2
                persist = "보류"
                near = [y[k] for k in range(n + 1, n + 4) if k < N and y[k] is not None]
                if any(v >= mid for v in near):
                    persist = "일시"
                else:
                    later = [y[k] for k in range(n + 4, n + 11) if k < N and y[k] is not None]
                    if len(later) >= 2:
                        persist = persist_label(jdiv(B - median(later), B - L))
                # 회차 불변 확인 가능 여부: 직전 7일 안에 스냅샷(=ep 관측)이 있거나 그날 완결작. 아니면 설명에 '확인 못 함'
                ep_known = snaps[d0] is not None and is_one(snaps[d0]["c"])
                for k in range(d0 - 7, d0):
                    if k >= 0 and snaps[k] is not None:
                        ep_known = True
                self.CANDS.append({"it": it, "kind": "noep", "sub": "spike", "per": "DAILY", "d": d0, "peakDay": n,
                                   "dir": "up", "z": z, "B": B, "L": L, "persist": persist, "ep": None,
                                   "before": base, "after": peak, "epKnown": ep_known})

    def adj_series(self, it, per):
        """시장요인을 뺀 ln 순위"""
        y = it["series"][per]["y"]
        m = self.MKT[it["g"] + "-" + per]
        return [None if v is None else v - m[n] for n, v in enumerate(y)]

    def find_window_shifts(self):
        """8c. noep 창(회차 변화가 기간 내내 없는 작품, DAILY·WEEKLY): 직전 7일 vs 이후 7일
        (직전 창 수집 4일 이상, 이후 창 3일 이상) 시장요인 뺀 ln순위 평균 차, z = diff/(σ_win√2).
        둘 다 70% 이상 200위 밖이면 건너뜀.
        σ_win = 회차 변화 없는 작품의 끝에서부터 자른 7일 블록 평균(수집 4일 이상·200위 밖 50% 미만)의
                인접 차 MAD×1.4826/√2
        후보: |z|>=2.5 중 |z| 큰 순(동률이면 이른 날)으로 ±6일 안에 이미 뽑힌 게 없으면 채택.
        지속성: 다음 7일(t+7..t+13, 수집 3일 이상) 평균의 유지율."""
        N = self.N
        self.SIG_WIN = {}
        for key in self.SHIFT_KEYS:
            g, per = key.split("-")
            diffs = []
            for it in self.ITEMS:
                if it["g"] != g or it["kind"] != "none":
                    continue
                zr = self.adj_series(it, per)
                cens = it["series"][per]["cens"]
                blocks = []
                e = N - 1
                while e - 6 >= 0:
                    s = win_stats(zr, cens, e - 6, e)
                    blocks.insert(0, s["m"] if (s["n"] >= 4 and s["cs"] < 0.5) else None)
                    e -= 7
                for i in range(1, len(blocks)):
                    if blocks[i] is not None and blocks[i - 1] is not None:
                        diffs.append(blocks[i] - blocks[i - 1])
            self.SIG_WIN[key] = {"sigma": sigma_of(diffs, SQRT2, SIGMA_DEFAULT["win"]), "n": len(diffs)}

        for it in self.ITEMS:
            if it["kind"] != "none":
                continue
            for per in PERS:
                key = it["g"] + "-" + per
                sig = self.SIG_WIN[key]["sigma"]
                zr = self.adj_series(it, per)
                cens = it["series"][per]["cens"]
                y = it["series"][per]["y"]
                scan = []
                for t in self.VALID_IDX:
                    bw = win_stats(zr, cens, t - 7, t - 1)
                    aw = win_stats(zr, cens, t, t + 6)
                    if bw["n"] < 4 or aw["n"] < 3:
                        continue                                  # 기준 4일·이후 3일 이상
                    if bw["cs"] >= 0.7 and aw["cs"] >= 0.7:
                        continue
                    z = (aw["m"] - bw["m"]) / (sig * SQRT2)
                    if abs(z) >= Z_MIN:
                        scan.append({"t": t, "z": z, "Bw": bw, "Aw": aw})
                scan.sort(key=lambda s: (-abs(s["z"]), s["t"]))
                picked = []
                for s in scan:
                    if not any(abs(p["t"] - s["t"]) <= 6 for p in picked):
                        picked.append(s)
                for s in picked:
                    t = s["t"]
                    if self.launch_phase(it, t):
                        self.note_excl("신작 런칭 국면", it, "window", per, t)
                        continue
                    nx = win_stats(zr, cens, t + 7, t + 13)
                    if nx["n"] >= 3:
                        persist = persist_label(jdiv(nx["m"] - s["Bw"]["m"], s["Aw"]["m"] - s["Bw"]["m"]))
                    else:
                        persist = "보류"
                    raw_b = mean(y[max(0, t - 7):t])
                    raw_a = mean(y[t:min(N, t + 7)])
                    self.CANDS.append({"it": it, "kind": "noep", "sub": "window", "per": per, "d": t,
                                       "dir": "up" if s["z"] < 0 else "down", "z": s["z"],
                                       "B": s["Bw"]["m"], "L": s["Aw"]["m"], "persist": persist, "ep": None,
                                       "before": min(250, js_exp(raw_b)), "after": min(250, js_exp(raw_a))})

    def merge_candidates(self):
        """주기 >= 14일(격주·휴재 반복) 작품은 레벨 변화 목록에서 뺀다(가짜가 많았음) — 급등도 포함.
        8d. 같은 작품·같은 방향·변화일 3일 이내 → 하나로. 우선순위 episode > noep 급등 > noep 창,
        같은 종류끼리는 |z| 큰 쪽(DAILY·WEEKLY 중 더 큰 쪽이 per)"""
        for c in reversed(self.CANDS):
            if c["it"]["kind"] == "long":
                self.note_excl("추정 주기 14일 이상", c["it"], c["kind"], c["per"], c["d"])
        self.CANDS = [c for c in self.CANDS if c["it"]["kind"] != "long"]
        self.CANDS.sort(key=functools.cmp_to_key(cmp_cand))
        self.MERGED = []
        for c in self.CANDS:
            dup = any(m["it"]["id"] == c["it"]["id"] and m["it"]["g"] == c["it"]["g"] and m["dir"] == c["dir"]
                      and abs(m["d"] - c["d"]) <= 3 for m in self.MERGED)
            if not dup:
                self.MERGED.append(c)

    # ---------------------------------------------------------------------------------
    # 9. 귀속(label)
    #   상승: 변화일 ±1일에 시작한(a in [d-1, d+1]) 작품 프로모션(이벤트·가격지문·기간한정 기다무)이 있으면 '동반'.
    #     - 그중 콘텐츠 이벤트(시즌·완결·외전·연참·복귀)가 있으면 content(분리 불가)
    #     - 진행 중이 하나라도 있거나, 끝난 뒤 '프로모션 없는' 비교 구간이 없으면 promo_live
    #     - 비교 구간 값 post 의 유지율 (post-B)/(L-B) >= 0.5 → promo_kept, 아니면 promo_temp
    #       비교 구간: episode = 그 뒤 첫 정상 사이클(작품 프로모션과 안 겹침),
    #                  noep = b(+6)+1 ~ +7일 중 프로모션 없는 수집일(2일 이상)
    #     - 동반 프로모션 없음 → none
    #   하락: 변화 전에 시작해(a < d-1) 끝난(ended) 프로모션에 대해 d in [b-1, b+2](DAILY) / [b-1, b+7](WEEKLY)
    #         이면 promo_end, 아니면 14일 안에 시작한 콘텐츠 이벤트가 있으면 content, 아니면 none
    #   플랫폼 이벤트와 books event_ids 는 귀속에 쓰지 않는다.
    # ---------------------------------------------------------------------------------
    def promo_active(self, bid, n):
        return any(p["a"] <= n and p["b"] >= n for p in self.WORK_PROMOS.get(bid, []))

    def post_value(self, c, end_b):
        it = c["it"]
        lag = 6 if c["per"] == "WEEKLY" else 0
        eff = end_b + lag
        if eff >= self.LAST_N:
            return None
        promos = self.WORK_PROMOS.get(it["id"], [])
        per = c["per"]
        if c["kind"] == "episode":
            nx = None
            for q in it["cycles"]:
                if q["start"] > eff and q["phaseKnown"] and not q["binge"] and not q["afterHiatus"] \
                        and q["lv"][per] is not None and q["nobs"][per] >= 3 \
                        and not any(p["a"] <= q["levelEnd"] and p["b"] + lag >= q["start"] for p in promos):
                    nx = q
                    break
            if nx is None:
                return None
            return {"v": nx["lv"][per], "from": nx["start"], "to": nx["levelEnd"]}
        src = it["series"]["DAILY"]["y"] if c.get("sub") == "spike" else self.adj_series(it, per)
        v = []
        lo = None
        hi = None
        for k in range(eff + 1, min(self.N - 1, eff + 7) + 1):
            if src[k] is None or self.promo_active(it["id"], k):
                continue
            v.append(src[k])
            if lo is None:
                lo = k
            hi = k
        if len(v) >= 2:
            return {"v": mean(v), "from": lo, "to": hi}
        return None

    def attribute(self, c):
        bid = c["it"]["id"]
        promos = self.WORK_PROMOS.get(bid, [])
        d = c["d"]
        if c["dir"] == "up":
            acc = [p for p in promos if d - 1 <= p["a"] <= d + 1]
            if not acc:
                return {"label": "none", "promos": []}
            if any(p["src"] == "event" and "콘텐츠" in p["k"] for p in acc):
                return {"label": "content", "promos": acc}
            end_b = max(p["b"] for p in acc)
            if any(not p["ended"] for p in acc):
                return {"label": "promo_live", "promos": acc, "endB": end_b}
            post = self.post_value(c, end_b)
            if post is None:
                return {"label": "promo_live", "promos": acc, "endB": end_b}
            ratio = jdiv(post["v"] - c["B"], c["L"] - c["B"])
            return {"label": "promo_kept" if ratio >= 0.5 else "promo_temp", "promos": acc, "endB": end_b,
                    "post": post, "ratio": ratio}
        lag_max = 7 if c["per"] == "WEEKLY" else 2
        ended = [p for p in promos if p["ended"] and p["a"] < d - 1 and p["b"] - 1 <= d <= p["b"] + lag_max]
        if ended:
            return {"label": "promo_end", "promos": ended, "endB": max(p["b"] for p in ended)}
        cont = [p for p in promos if p["src"] == "event" and "콘텐츠" in p["k"] and d - 14 <= p["a"] <= d - 1]
        if cont:
            return {"label": "content", "promos": cont}     # 시즌·완결·외전 직후 하락(회차 효과 소멸과 못 나눔)
        return {"label": "none", "promos": []}

    # ---------------------------------------------------------------------------------
    # 10. 설명문(note)
    # ---------------------------------------------------------------------------------
    def rank_trail(self, c):
        """급등 전후 순위 흐름: 직전 수집일, 변화일, +1, +2"""
        r = c["it"]["series"]["DAILY"]["r"]
        pv = None
        for k in range(c["d"] - 1, -1, -1):
            if r[k] is not None:
                pv = k
                break
        ks = []
        if pv is not None:
            ks.append(pv)
        for k in range(c["d"], min(self.N - 1, c["d"] + 2) + 1):
            if r[k] is not None:
                ks.append(k)
        return [md(self.DATES[k]) + " " + rank_txt(r[k]) for k in ks]

    def make_note(self, c, at):
        dates = self.DATES
        dir_w = "올랐고" if c["dir"] == "up" else "내려갔고"
        if c["kind"] == "episode":
            a = rank_txt(c["after"])
            s1 = (md(dates[c["d"]]) + " " + num_str(c["ep"]) + "화부터 " + PER_NAME[c["per"]] + " 평소 수준이 "
                  + rank_txt(c["before"]) + " → " + a + ro(a) + " " + dir_w + ", " + PERSIST_TXT["episode"][c["persist"]])
        elif c.get("sub") == "spike":
            tr = self.rank_trail(c)
            last = tr[-1]
            if c["epKnown"]:
                s1 = "회차 변화 없이 오늘의 베스트가 " + " → ".join(tr) + ro(last) + " 움직였어요."
            else:
                s1 = ("오늘의 베스트가 " + " → ".join(tr) + ro(last)
                      + " 움직였어요(직전엔 랭킹 밖이라 회차 변화는 확인 못 했어요).")
        else:
            a = rank_txt(c["after"])
            s1 = (md(dates[c["d"]]) + "부터 회차 변화 없이 " + PER_NAME[c["per"]] + " 1주 평균이 "
                  + rank_txt(c["before"]) + " → " + a + ro(a) + " " + dir_w + ", " + PERSIST_TXT["noep"][c["persist"]])
        label = at["label"]
        s2 = ""
        if label == "none":
            if c["dir"] == "up":
                s2 = "같은 시기 이 작품의 이벤트·할인은 확인되지 않았어요."
            else:
                s2 = "직전에 끝난 이 작품의 프로모션은 확인되지 않았어요."
        elif label == "content":
            ce = next(p for p in at["promos"] if p["src"] == "event" and "콘텐츠" in p["k"])
            s2 = ("겹친 이벤트: " + period_txt(ce) + " ‘" + short_title(ce["t"])
                  + "’. 시즌·완결·외전 이벤트라 회차 효과와 나눌 수 없어요.")
        elif label == "promo_live":
            s2 = "겹친 프로모션: " + promo_phrase(at["promos"]) + ". 아직 진행 중이거나 끝난 뒤 자료가 모자라 판단을 미뤄요."
        elif label == "promo_temp":
            s2 = ("겹친 프로모션: " + promo_phrase(at["promos"]) + ". 끝난 뒤 " + md(dates[at["post"]["from"]])
                  + (" 회차" if c["kind"] == "episode" else "") + "부터 원래 수준으로 돌아갔어요.")
        elif label == "promo_kept":
            s2 = "겹친 프로모션: " + promo_phrase(at["promos"]) + ". 끝난 뒤에도 유지돼 작품 쪽 힘일 수 있어요."
        elif label == "promo_end":
            s2 = "직전에 끝난 프로모션: " + promo_phrase(at["promos"]) + ". 끝나면서 내려간 것으로 보여요."
        return js_trim(s1 + " " + s2)

    # ---------------------------------------------------------------------------------
    # 11. 출력 조립 (데이터 계약)
    #  promo.json  { generated:'<KST ISO>', window:[시작,끝],
    #    works:{ id:[ {src:'event'|'price'|'wff', a,b:'YYYY-MM-DD'(그래프 음영 수집일), s,e:'YYYY-MM-DD HH:mm'(표시용 KST),
    #                  t, k:[가격할인|무료|포인트|랜덤티켓|최신화|콘텐츠|론칭], eid, u, role:'main'|'mentioned'|null} ] },
    #    platform:[ {a,b,s,e,t,k,eid,u,genres:['webtoon'|'bl_webtoon']} ] }                       (a 오름차순)
    #  shifts.json { generated, window, sigma:{'1600-DAILY':σ,…}, sigma_noep:{key:{win,spike?}},
    #    items:[ {id,t,g,ad,kind:'episode'|'noep',ep,d,dir:'up'|'down',per:'DAILY'|'WEEKLY',before,after,z(크기),
    #             persist:'지속'|'일시'|'부분'|'보류', label:'promo_live'|'promo_temp'|'promo_kept'|'promo_end'|'content'|'none',
    #             promos:[{src,t,s,e,k,eid,u}], note} ] }                                          (d 내림차순)
    # ---------------------------------------------------------------------------------
    def promo_out(self, p):
        return {"src": p["src"], "a": self.DATES[p["a"]], "b": self.DATES[p["b"]], "s": p["s"], "e": p["e"],
                "t": p["t"], "k": p["k"], "eid": p["eid"], "u": p["u"], "role": p["role"]}

    @staticmethod
    def promo_brief(p):
        return {"src": p["src"], "t": p["t"], "s": p["s"], "e": p["e"], "k": p["k"], "eid": p["eid"], "u": p["u"]}

    def build_outputs(self):
        dates = self.DATES
        window = [self.WIN_START, self.LAST_DATE]
        generated = kst_iso_now()
        platform = [{"a": dates[p["a"]], "b": dates[p["b"]], "s": p["s"], "e": p["e"], "t": p["t"], "k": p["k"],
                     "eid": p["eid"], "u": p["u"], "genres": p["genres"]} for p in self.PLATFORM]
        promo_json = {"generated": generated, "window": list(window), "works": {}, "platform": platform}
        # JS 는 정수 모양 키(작품ID)를 숫자순으로 먼저 내보낸다 → 같은 순서로 넣는다
        for bid in js_key_order(sorted(self.WORK_PROMOS)):
            promo_json["works"][bid] = [self.promo_out(p) for p in self.WORK_PROMOS[bid]]

        items = []
        for c in self.MERGED:
            at = self.attribute(c)
            c["at"] = at
            items.append({
                "id": c["it"]["id"], "t": c["it"]["t"], "g": c["it"]["g"], "ad": c["it"]["ad"],
                "kind": c["kind"], "ep": c["ep"] if c["kind"] == "episode" else None, "d": dates[c["d"]],
                "dir": c["dir"], "per": c["per"],
                "before": rhu(c["before"], 1), "after": rhu(c["after"], 1), "z": rhu(abs(c["z"]), 1),
                "persist": c["persist"], "label": at["label"], "promos": [self.promo_brief(p) for p in at["promos"]],
                "note": self.make_note(c, at),
            })
        items.sort(key=functools.cmp_to_key(cmp_item))
        sigma_out = {k: rhu(self.SIGMA[k]["sigma"], 3) for k in self.SHIFT_KEYS}
        sigma_noep = {k: {"win": rhu(self.SIG_WIN[k]["sigma"], 3)} for k in self.SHIFT_KEYS}
        for g in SHIFT_GROUPS:
            sigma_noep[g + "-DAILY"]["spike"] = rhu(self.SIG_SPIKE[g + "-DAILY"]["sigma"], 3)
        shifts_json = {"generated": generated, "window": list(window), "sigma": sigma_out,
                       "sigma_noep": sigma_noep, "items": items}
        self.items_out = items
        return promo_json, shifts_json

    # ---------------------------------------------------------------------------------
    # 12. 통계
    # ---------------------------------------------------------------------------------
    def build_stats(self, out_dir):
        def cnt_by(arr, f):
            o = {}
            for x in arr:
                k = f(x)
                o[k] = o.get(k, 0) + 1
            return o

        items = self.items_out
        all_promos = [p for bid in js_key_order(list(self.WORK_PROMOS)) for p in self.WORK_PROMOS[bid]]

        def size_kb(name):
            p = os.path.join(out_dir, name)
            return rhu(os.path.getsize(p) / 1024, 1) if os.path.exists(p) else None

        return {
            "window": [self.WIN_START, self.LAST_DATE], "days": self.N, "valid_days": len(self.VALID_IDX),
            "promo_targets": len(self.promo_targets), "promo_works_with_entries": len(self.WORK_PROMOS),
            "promo_entries_by_src": cnt_by(all_promos, lambda p: p["src"]), "platform_events": len(self.PLATFORM),
            "events": self.ev_stat, "price": self.price_stat, "wff": self.wff_stat,
            "shift_items": len(self.ITEMS), "shift_items_by_group": cnt_by(self.ITEMS, lambda x: x["g"]),
            "kinds": cnt_by(self.ITEMS, lambda x: x["g"] + ":" + x["kind"]),
            "periods": cnt_by([x for x in self.ITEMS if x["kind"] == "periodic"],
                              lambda x: x["g"] + ":P" + num_str(x["P"])),
            "sigma": self.SIGMA, "sigma_spike": self.SIG_SPIKE, "sigma_win": self.SIG_WIN,
            "candidates_before_merge": len(self.CANDS), "excluded": self.EXCL,
            "shifts": len(items), "by_label": cnt_by(items, lambda x: x["label"]),
            "by_kind": cnt_by(items, lambda x: x["kind"]), "by_dir": cnt_by(items, lambda x: x["dir"]),
            "by_label_kind_dir": cnt_by(items, lambda x: x["label"] + "|" + x["kind"] + "|" + x["dir"]),
            "by_per": cnt_by(items, lambda x: x["per"]), "by_persist": cnt_by(items, lambda x: x["persist"]),
            "by_group": cnt_by(items, lambda x: x["g"]),
            "sizes_kb": {"promo": size_kb("promo.json"), "shifts": size_kb("shifts.json")},
            "seconds": rhu(time.time() - self.t_start, 1),
        }


def summary_lines(st, wrote):
    """사람이 읽는 요약(마크다운). 콘솔과 GitHub 실행 요약에 같이 쓴다."""
    src = st["promo_entries_by_src"]
    lab = st["by_label"]
    lines = [
        "### 프로모션·순위대 변화 분석",
        "- 분석 창: **%s ~ %s** (수집일 %d일)" % (st["window"][0], st["window"][1], st["valid_days"]),
        "- 프로모션: 작품 %d편 · 항목 %d개 (이벤트 %d / 회당가 할인 %d / 기간한정 기다무 %d), 플랫폼 이벤트 %d개" % (
            st["promo_works_with_entries"], sum(src.values()), src.get("event", 0), src.get("price", 0),
            src.get("wff", 0), st["platform_events"]),
        "- 순위대 변화: **%d건** (대상 %d편, 제외 %d건)" % (st["shifts"], st["shift_items"], sum(st["excluded"].values())),
    ]
    for k in ["promo_live", "promo_temp", "promo_kept", "promo_end", "content", "none"]:
        if lab.get(k):
            lines.append("  - %s: %d" % (LABEL_KO[k], lab[k]))
    sz = st["sizes_kb"]
    lines.append("- 파일: promo.json %s KB%s · shifts.json %s KB%s" % (
        num_str(sz["promo"]), "" if wrote["promo"] else "(내용 같아 그대로 둠)",
        num_str(sz["shifts"]), "" if wrote["shifts"] else "(내용 같아 그대로 둠)"))
    lines.append("- 소요: %s초" % num_str(st["seconds"]))
    return lines


def main():
    ap = argparse.ArgumentParser(description="웹툰·BL웹툰 순위대 변화 × 프로모션 귀속 분석")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="데이터 폴더 (기본 docs/data)")
    ap.add_argument("--out-dir", default=None, help="출력 폴더 (기본 <data-dir>/analysis)")
    ap.add_argument("--summary", default=None, help="요약(마크다운)을 덧붙일 파일 (예: $GITHUB_STEP_SUMMARY)")
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    data_dir = os.path.abspath(args.data_dir)
    out_dir = os.path.abspath(args.out_dir) if args.out_dir else os.path.join(data_dir, "analysis")

    an = Analyzer(data_dir)
    promo_json, shifts_json = an.run()
    os.makedirs(out_dir, exist_ok=True)
    wrote = {
        "promo": write_output(os.path.join(out_dir, "promo.json"), promo_json),
        "shifts": write_output(os.path.join(out_dir, "shifts.json"), shifts_json),
    }
    stats = an.build_stats(out_dir)
    print(json.dumps(js_clean(stats), ensure_ascii=False, indent=1))
    if os.environ.get("DEBUG"):
        with open(os.path.join(out_dir, "debug_excluded.json"), "w", encoding="utf-8") as f:
            json.dump(js_clean(an.EXCL_LIST), f, ensure_ascii=False, indent=1)

    lines = summary_lines(stats, wrote)
    print()
    print("\n".join(lines))
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
