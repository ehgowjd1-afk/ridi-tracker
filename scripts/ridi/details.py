"""작품 상세페이지에서 태그·키워드와 걸려 있는 이벤트를 가져온다.

랭킹 API가 대부분의 정보를 주기 때문에, 상세페이지는 두 가지 때문에만 연다.
  1) 태그/키워드 (#환생/회귀, #계략남, #기다리면무료 ...)
  2) 이 작품에 걸린 이벤트 링크
덤으로 리뷰 수집에 필요한 셀 ID도 여기서 같이 챙긴다.
"""

import json
import re

from . import config
from .client import RidiError

_PREPARED_RE = re.compile(
    r'<script[^>]+id="ISLANDS__PreparedData"[^>]*>(.*?)</script>',
    re.DOTALL,
)
_EVENT_LINK_RE = re.compile(r'href="/event/(\d+)')
_EXCLUSIVE_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.DOTALL)


def fetch_detail(client, book_id):
    """상세페이지 하나를 열어 필요한 것만 뽑아낸다. 실패하면 None."""
    url = f"{config.WEB_BASE}/books/{book_id}"
    try:
        html = client.get_text(url)
    except RidiError as e:
        return {"id": str(book_id), "error": str(e)}

    result = {
        "id": str(book_id),
        "keywords": [],
        "event_ids": [],
        "review_cell_id": None,
        "exclusive_label": None,
    }

    # --- 태그/키워드 + 리뷰 셀 ID ---
    m = _PREPARED_RE.search(html)
    if m:
        try:
            prepared = json.loads(m.group(1))
        except json.JSONDecodeError:
            prepared = None
        if prepared:
            grid = (((prepared.get("props") or {}).get("gridQuery") or {})
                    .get("riGrid") or {}).get("grid") or {}
            meta = ((grid.get("meta") or {}).get("gridPageMeta") or {})
            result["keywords"] = [k for k in (meta.get("keywords") or []) if k]
            for cell in grid.get("cells") or []:
                if cell.get("type") == "BookDetailHomeReview":
                    result["review_cell_id"] = cell.get("id")
                    break

    # --- 이 작품에 걸린 이벤트 ---
    result["event_ids"] = sorted(set(_EVENT_LINK_RE.findall(html)))

    # --- 독점 문구 (제목에 "리디에만 있는 독점 작품!" 등이 붙는다) ---
    t = _EXCLUSIVE_TITLE_RE.search(html)
    if t:
        title = t.group(1)
        for label in ("리디에만 있는 독점 작품", "단독 선공개", "리디 오리지널"):
            if label in title:
                result["exclusive_label"] = label
                break

    return result


# 작품의 '내용'을 설명하지 않는 태그들 — 따로 빼둔다.
# (그대로 두면 나중에 키워드 분석할 때 "별점1000개이상"이 상위 키워드로 잡힌다)
_FORMAT_TAGS = {
    "ebook", "전자책", "웹툰", "웹소설", "만화", "단행본", "라이트노벨",
    "연재", "연재중", "완결", "로맨스 웹소설", "로판 웹소설", "판타지 웹소설",
    "BL 웹소설", "로맨스 e북", "로판 e북", "판타지 e북", "BL 소설 e북",
}
_SPECIAL_TAGS = {"원작소설有", "원작웹툰有", "독점", "선공개", "리디오리지널"}
_STAT_PATTERNS = [
    re.compile(r"^별점\s*[\d,]+개?\s*이상$"),
    re.compile(r"^리뷰\s*[\d,]+개?\s*이상$"),
    re.compile(r"^평점\s*[\d.]+점?\s*이상$"),
    re.compile(r"^조회수?\s*[\d,]+.*이상$"),
    re.compile(r"^[\d,]+\s*(화|권)\s*이상$"),
    re.compile(r"^기다리면무료"),
    re.compile(r"^무료\s*[\d,]+\s*(화|권)"),
]


def split_keywords(keywords, exclude=None):
    """키워드를 '작품 내용 태그'와 '그 외 표시'로 나눈다.

    exclude: 작가명·출판사명처럼 태그로 볼 수 없는 이름 모음.
             리디는 태그 배열 끝에 작가·CP사 이름을 같이 넣어둔다.
    """
    skip = {s.strip() for s in (exclude or []) if s and s.strip()}

    tags, meta = [], []
    seen_tag, seen_meta = set(), set()

    for raw in keywords:
        k = (raw or "").strip()
        if not k:
            continue
        is_meta = (
            k in _FORMAT_TAGS
            or k in _SPECIAL_TAGS
            or any(p.match(k) for p in _STAT_PATTERNS)
        )
        if is_meta:
            if k not in seen_meta:
                seen_meta.add(k)
                meta.append(k)
        elif k in skip:
            continue          # 작가·출판사 이름은 버린다 (이미 따로 갖고 있음)
        elif k not in seen_tag:
            seen_tag.add(k)
            tags.append(k)

    return tags, meta
