"""랭킹 수집 + 작품 정보 정리.

리디 랭킹 API 하나에 작품 상세정보가 거의 다 들어 있어서,
여기서 필요한 것만 골라 담는다.
"""

from . import config


def fetch_ranking(client, category_id, period, limit=200):
    """카테고리 하나의 랭킹 200위를 가져온다."""
    data = client.get_json(config.BESTSELLER_URL, {
        "category_includes": category_id,
        "limit": limit,
        "period": period,
        "only_rent_available": 0,
    })
    if not data.get("success"):
        raise RuntimeError(data.get("message") or "랭킹 응답 실패")
    return data["data"].get("items") or []


# ---------------------------------------------------------------- 값 꺼내기
def _avg_rating(ratings):
    """별점 분포([{rating:1,count:6},...])에서 평균과 참여자 수를 계산."""
    if not ratings:
        return None, 0
    total = sum(r.get("count", 0) for r in ratings)
    if total == 0:
        return None, 0
    score = sum(r.get("rating", 0) * r.get("count", 0) for r in ratings)
    return round(score / total, 2), total


def _keywords_from_guide(guide):
    """로맨스 가이드 글에서 '*작품 키워드: a, b, c.' 부분만 뽑아낸다."""
    if not guide:
        return []
    for line in guide.splitlines():
        line = line.strip()
        if line.startswith("*작품 키워드:"):
            body = line.split(":", 1)[1].strip().rstrip(".")
            return [k.strip() for k in body.split(",") if k.strip()]
    return []


def _authors(book):
    out = []
    for a in book.get("authors") or []:
        out.append({"id": a.get("author_id"), "name": a.get("name"), "role": a.get("role")})
    return out


def _main_authors(book):
    """대표 작가 이름만 (글/그림/원작 위주, 번역가 제외)."""
    keep = {"author", "story_writer", "comic_author", "illustrator", "original_author"}
    names = [a["name"] for a in _authors(book) if a["role"] in keep]
    if not names:
        names = [a["name"] for a in _authors(book)]
    # 중복 제거하면서 순서 유지
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def parse_book(item):
    """랭킹 응답의 작품 하나를 우리가 쓸 형태로 정리."""
    book = item.get("book") or {}
    serial = book.get("serial") or {}
    intro = book.get("introduction") or {}
    purchase = book.get("purchase") or {}
    purchase_all = serial.get("purchase_all") or {}
    wff = serial.get("wait_for_free") or {}

    avg, rating_count = _avg_rating(book.get("ratings"))

    book_id = str(book.get("book_id") or "")
    series_id = str(serial.get("serial_id") or book_id)

    return {
        "id": book_id,
        "series_id": series_id,
        # 시리즈 제목이 있으면 그쪽이 사람이 부르는 이름 ("첫 실패 1화" → "첫 실패")
        "title": serial.get("title") or book.get("web_title") or book.get("title") or "",
        "book_title": book.get("title") or "",
        "authors": _main_authors(book),
        "authors_full": _authors(book),
        "publisher": (book.get("publisher") or {}).get("name"),
        "cover": (book.get("cover") or {}).get("large"),
        "url": f"{config.WEB_BASE}/books/{book_id}",

        # 별점
        "rating": avg,
        "rating_count": rating_count,
        "rating_dist": {str(r.get("rating")): r.get("count", 0) for r in (book.get("ratings") or [])},

        # 분류
        "categories": [c.get("name") for c in (book.get("categories") or [])],
        "category_ids": [c.get("category_id") for c in (book.get("categories") or [])],
        "genre": (book.get("categories") or [{}])[0].get("genre"),

        # 연재 정보
        "is_completed": serial.get("completion"),
        "total_episodes": serial.get("total"),
        "unit": serial.get("unit"),
        "free_episodes": (serial.get("free") or {}).get("purchase"),
        "last_episode_at": serial.get("last_opened_episode_date"),

        # 독점 여부
        "is_original": book.get("is_original"),      # 리디 오리지널
        "is_only": book.get("is_only"),              # 리디 단독
        "is_pre_exclusive": book.get("is_pre_exclusive"),  # 선독점
        "is_exclusive": bool(book.get("is_original") or book.get("is_only")
                             or book.get("is_pre_exclusive")),

        # 성인
        "adults_only": book.get("adults_only"),

        # 가격
        "price": purchase.get("sale_price"),
        "price_full": purchase.get("full_price"),
        "price_all": purchase_all.get("sale_price"),
        "price_all_full": purchase_all.get("full_price"),
        "discount_rate": purchase_all.get("max_discount_rate"),

        # 기다리면무료
        "wait_for_free": {
            "interval_hours": wff.get("interval_hours"),
            "opening_date": wff.get("opening_date"),
            "closing_date": wff.get("closing_date"),
        } if wff else None,

        # 글
        "description": (intro.get("description") or "").strip(),
        "keywords_from_guide": _keywords_from_guide(intro.get("romance_guide")),

        # 화면 배지 (할인/신규 등)
        "badges": [b.get("badge_type") for b in (item.get("badges") or []) if b.get("badge_type")],

        "published_at": book.get("publication_date"),
        "registered_at": book.get("registration_date"),
    }


def snapshot_of(book):
    """날마다 달라지는 값만 따로 뽑는다 (추이 그래프용, 파일 크기 절약)."""
    return {
        "r": book["rating"],
        "rc": book["rating_count"],
        "ep": book["total_episodes"],
        "p": book["price_all"] if book["price_all"] is not None else book["price"],
        "c": 1 if book["is_completed"] else 0,
    }
