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


def split_keywords(keywords):
    """키워드 목록에서 의미별로 나눈다 (화면에서 쓰기 좋게).

    리디는 태그 배열에 형식·연재상태·CP사·작가명까지 섞어 넣는다.
    """
    formats = {"ebook", "전자책", "웹툰", "웹소설", "만화", "연재", "완결", "단행본"}
    special = {"기다리면무료", "원작소설有", "원작웹툰有", "독점", "선공개"}

    tags, meta = [], []
    for k in keywords:
        if k in formats or k in special:
            meta.append(k)
        else:
            tags.append(k)
    return tags, meta
