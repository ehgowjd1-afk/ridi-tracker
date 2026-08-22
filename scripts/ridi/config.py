"""수집 대상과 설정값을 모아둔 곳.

여기 숫자만 바꾸면 수집 범위가 바뀝니다.
카테고리 ID는 조사결과.md 참고 (리디 사이트에서 직접 확인한 값).
"""

# ---------------------------------------------------------------- 수집 예의
# 리디 서버에 부담을 주지 않기 위한 설정.
#
# ⚠️ 실측 기록 (2026-08-22): 작품 상세페이지를 2초 간격으로 200건쯤 연속으로 열자
#    리디가 HTTP 429(요청 과다)로 막기 시작했습니다. 상세페이지는 한 장이 900KB라
#    API 호출보다 훨씬 무겁습니다. 그래서 아래처럼 나눠 두었습니다.
#      - API 호출(랭킹·이벤트·리뷰) : 2초 간격
#      - 상세페이지(HTML)          : 4초 간격 + 하루 상한을 낮게
#    이 숫자를 무턱대고 올리면 다시 차단당합니다.
REQUEST_INTERVAL_SEC = 2.0      # API 호출 간격
PAGE_INTERVAL_SEC = 4.0         # 상세페이지(HTML) 간격 — 더 여유 있게
REQUEST_TIMEOUT_SEC = 30
MAX_RETRIES = 3
RETRY_BACKOFF_SEC = 5.0

# 429(요청 과다)를 만났을 때
RATE_LIMIT_WAIT_SEC = 90        # 이만큼 길게 쉬고 한 번만 다시 시도
RATE_LIMIT_ABORT_AFTER = 3      # 연속 3번 막히면 그 단계를 그날은 접는다

# 하루에 새로 열어볼 작품 상세페이지 수 상한 (태그·이벤트 수집용)
# 200건 × 4초 ≈ 13분. 전체 약 11,000종을 두 달쯤에 걸쳐 한 바퀴 돈다.
MAX_DETAIL_FETCHES_PER_RUN = 200
# 하루에 리뷰를 새로 긁어올 작품 수 상한
# 리뷰는 가벼운 API 호출이라 상세페이지보다 여유가 있다.
MAX_REVIEW_FETCHES_PER_RUN = 300
# 작품 하나당 가져올 리뷰 최대 건수 (한 번의 요청으로 받아온다)
REVIEWS_PER_BOOK = 50

# 전체 소요 시간 어림
#   랭킹 183×2초 + 이벤트 22×2초 + 상세 200×4초 + 리뷰 300×2초  ≈  32분

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------- 엔드포인트
API_BASE = "https://api.ridibooks.com"
WEB_BASE = "https://ridibooks.com"
BESTSELLER_URL = f"{API_BASE}/v2/bestsellers"
EVENTS_URL = f"{API_BASE}/v2/events"
GRAPHQL_URL = f"{API_BASE}/graphql"

# ---------------------------------------------------------------- 랭킹 기간
# 리디는 연재물과 단행본에 서로 다른 기준을 씁니다. 리디 화면 그대로 따릅니다.
#
#   연재물(웹소설·웹툰)  : 오늘의 베스트 · 주간 베스트 · 월간 베스트
#   단행본(E북·만화 e북) : 주간 베스트 · 월간 베스트 · 스테디셀러
#
# ⚠️ 'YEARLY(연간)'는 쓰지 않습니다. 리디 화면 어디에도 없고,
#    API에 요청하면 단행본의 경우 주간 순위를 그대로 돌려줍니다(30/30 동일).
#    즉 연간 데이터가 아니라 가짜입니다. 되살리지 마세요.
PERIODS_SERIAL = ["DAILY", "WEEKLY", "MONTHLY"]
PERIODS_BOOK = ["WEEKLY", "MONTHLY", "STEADY"]

# 세부 장르도 전체 랭킹과 똑같이 3종 전부 모읍니다.
# (랭킹은 가벼운 API 호출이라 늘려도 부담이 거의 없습니다. 세부 장르만 2종으로 두면
#  '월간 베스트가 왜 없지?' 하고 헷갈립니다.)
SUB_PERIOD_COUNT = 3

PERIOD_LABELS = {
    "DAILY": "오늘의 베스트",
    "WEEKLY": "주간 베스트",
    "MONTHLY": "월간 베스트",
    "STEADY": "스테디셀러",
}

# ---------------------------------------------------------------- 카테고리
# section: 웹사이트 상단 대분류 (webnovel / ebook / webtoon)
# 각 항목은 (카테고리ID, 이름, [하위 (ID, 이름) ...])

CATEGORY_TREE = {
    # 웹소설 (연재물)
    "webnovel": {
        "label": "웹소설",
        "kind": "serial",
        "groups": [
            (1650, "로맨스 웹소설", [
                (1651, "현대물"),
                (1652, "역사/시대물"),
            ]),
            (6050, "로판 웹소설", [
                (6051, "동양풍 로판"),
                (6052, "서양풍 로판"),
                (6053, "가상 세계 로판"),
            ]),
            (1750, "판타지 웹소설", [
                (1751, "정통 판타지"),
                (1752, "퓨전 판타지"),
                (1753, "현대 판타지"),
                (1754, "무협 소설"),
            ]),
            (4150, "BL 웹소설", [
                (4151, "현대물"),
                (4152, "판타지물"),
                (4153, "역사/시대물"),
            ]),
        ],
    },
    # E북 단행본
    "ebook": {
        "label": "E북 단행본",
        "kind": "book",
        "groups": [
            (1700, "로맨스 e북", [
                (1701, "현대물"),
                (1702, "역사/시대물"),
                (1704, "할리퀸 소설"),
                (1705, "하이틴"),
                (1706, "19+"),
                (1708, "TL 소설"),
                (1709, "섹슈얼 로맨스"),
            ]),
            (6000, "로판 e북", [
                (6001, "동양풍 로판"),
                (6002, "서양풍 로판"),
                (6003, "해외 소설"),
                (6004, "가상 세계 로판"),
            ]),
            (1710, "판타지 e북", [
                (1711, "정통 판타지"),
                (1712, "퓨전 판타지"),
                (1713, "현대 판타지"),
                (1714, "게임 판타지"),
                (1715, "대체 역사물"),
                (1716, "스포츠물"),
                (1721, "신무협"),
                (1722, "전통 무협"),
            ]),
            (4100, "BL 소설 e북", [
                (4101, "현대물"),
                (4102, "판타지물"),
                (4103, "역사/시대물"),
                (4104, "해외 소설"),
            ]),
            (3000, "라이트노벨", [
                (3001, "해외 라노벨"),
                (3002, "TL"),
                (3005, "국내 라노벨"),
                (3006, "성인 라노벨"),
            ]),
        ],
    },
    # 웹툰 (연재물)
    "webtoon": {
        "label": "웹툰",
        "kind": "serial",
        "groups": [
            (1600, "웹툰", [
                (1612, "로판"),
                (1613, "로맨스"),
                (1603, "드라마"),
                (1604, "성인"),
                (1605, "액션/무협"),
                (1606, "판타지/SF"),
                (1607, "스포츠/학원"),
                (1608, "코믹"),
                (1609, "GL"),
                (1610, "공포/추리"),
                (1614, "19+"),
            ]),
            # BL 웹툰은 리디에 하위 장르가 없습니다 (4250 하나뿐).
            # 4251·4252를 넣으면 각각 전체와 똑같은 목록 / 빈 목록이 돌아옵니다.
            (4250, "BL 웹툰", []),
        ],
    },
}


def periods_for(section):
    """그 분류에서 리디가 실제로 제공하는 기준을 돌려준다."""
    kind = CATEGORY_TREE[section].get("kind", "serial")
    return PERIODS_SERIAL if kind == "serial" else PERIODS_BOOK


def iter_ranking_targets():
    """수집할 랭킹 목록을 만든다. 기간은 분류별로 리디 화면과 똑같이 맞춘다."""
    for section, info in CATEGORY_TREE.items():
        periods = periods_for(section)
        for cat_id, cat_name, subs in info["groups"]:
            for period in periods:
                yield {
                    "key": f"{cat_id}-{period}",
                    "section": section,
                    "group": cat_name,
                    "name": cat_name,
                    "category_id": cat_id,
                    "period": period,
                    "is_sub": False,
                }
            for sub_id, sub_name in subs:
                for period in periods[:SUB_PERIOD_COUNT]:
                    yield {
                        "key": f"{sub_id}-{period}",
                        "section": section,
                        "group": cat_name,
                        "name": sub_name,
                        "category_id": sub_id,
                        "period": period,
                        "is_sub": True,
                    }


# ---------------------------------------------------------------- 이벤트 장르
# API가 허용하는 값만 사용 (다른 값을 넣으면 400 에러)
EVENT_GENRES = [
    "romance", "romance_serial",
    "romance_fantasy", "romance_fantasy_serial",
    "fantasy", "fantasy_serial",
    "bl", "bl_novel", "bl_webnovel", "bl_comic", "bl_webtoon",
    "bl_serial_novel", "bl_serial_comic",
    "comic", "comic_serial",
    "webtoon", "lightnovel", "general",
]
