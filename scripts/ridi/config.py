"""수집 대상과 설정값을 모아둔 곳.

여기 숫자만 바꾸면 수집 범위가 바뀝니다.
카테고리 ID는 조사결과.md 참고 (리디 사이트에서 직접 확인한 값).
"""

# ---------------------------------------------------------------- 수집 예의
# 리디 서버에 부담을 주지 않기 위한 설정. 개인 리서치용이므로 넉넉하게 둡니다.
REQUEST_INTERVAL_SEC = 2.0      # 요청과 요청 사이 쉬는 시간
REQUEST_TIMEOUT_SEC = 30
MAX_RETRIES = 3
RETRY_BACKOFF_SEC = 5.0

# 하루에 새로 열어볼 작품 상세페이지 수 상한 (태그·이벤트 수집용)
# 600건이면 전체 약 11,000종을 3주 안에 한 바퀴 돈다.
MAX_DETAIL_FETCHES_PER_RUN = 600
# 하루에 리뷰를 새로 긁어올 작품 수 상한
# 리뷰 대상은 '일간 전체 랭킹에 든 작품'(약 2,200종)이라 350이면 일주일에 한 바퀴.
MAX_REVIEW_FETCHES_PER_RUN = 350
# 작품 하나당 가져올 리뷰 최대 건수 (한 번의 요청으로 받아온다)
REVIEWS_PER_BOOK = 50

# 전체 소요 시간 어림 (요청 간격 2초 기준)
#   랭킹 159 + 이벤트 22 + 상세 600 + 리뷰 350~700  ≈  1,150~1,500회  ≈  40~50분

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
# 리디가 제공하는 5종. 전체 랭킹은 5종 전부, 세부 장르는 일간·주간만 모읍니다.
PERIODS_MAIN = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "STEADY"]
PERIODS_SUB = ["DAILY", "WEEKLY"]

PERIOD_LABELS = {
    "DAILY": "일간",
    "WEEKLY": "주간",
    "MONTHLY": "월간",
    "YEARLY": "연간",
    "STEADY": "스테디셀러",
}

# ---------------------------------------------------------------- 카테고리
# section: 웹사이트 상단 대분류 (webnovel / ebook / webtoon)
# 각 항목은 (카테고리ID, 이름, [하위 (ID, 이름) ...])

CATEGORY_TREE = {
    # 웹소설 (연재)
    "webnovel": {
        "label": "웹소설",
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
    # 웹툰
    "webtoon": {
        "label": "웹툰",
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
            (4250, "BL 웹툰", [
                (4251, "BL 웹툰 국내"),
                (4252, "BL 웹툰 해외"),
            ]),
        ],
    },
}


def iter_ranking_targets():
    """수집할 (랭킹키, 이름, 카테고리ID, 기간, 섹션, 부모이름, 세부장르인지) 목록을 만든다."""
    for section, info in CATEGORY_TREE.items():
        for cat_id, cat_name, subs in info["groups"]:
            for period in PERIODS_MAIN:
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
                for period in PERIODS_SUB:
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
