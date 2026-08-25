"""수집한 데이터를 파일로 저장하는 부분.

저장 위치는 전부 docs/data/ 아래. (GitHub Pages가 docs/ 폴더를 웹사이트로 서빙)

  index.json              날짜 목록·랭킹 목록 등 안내판
  latest.json             오늘 랭킹 + 변동(▲▼/NEW/이탈)  ← 사이트가 제일 먼저 읽음
  books.json              작품 카탈로그(가벼운 정보) — 검색용
  daily/YYYY-MM-DD.json   그날의 전체 랭킹 (누적 보관, 덮어쓰지 않음)
  history/YYYY-MM.json    달 단위 순위·별점 추이 (그래프용)
  books/{id}.json         작품 상세 (소개글·태그·걸린 이벤트)
  reviews/{id}.json       리뷰 누적
  events/latest.json      진행 중 이벤트
  events/YYYY-MM-DD.json  그날의 이벤트 기록
"""

import json
import os

DATA_DIRS = ["daily", "history", "books", "reviews", "events"]


class Store:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        for d in DATA_DIRS:
            os.makedirs(os.path.join(self.root, d), exist_ok=True)

    # ------------------------------------------------------------ 기본 입출력
    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def read(self, *parts, default=None):
        p = self.path(*parts)
        if not os.path.exists(p):
            return default
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return default

    def write(self, data, *parts, pretty=False):
        p = self.path(*parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            if pretty:
                json.dump(data, f, ensure_ascii=False, indent=1)
            else:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, p)
        return p

    # ------------------------------------------------------------ 작품 카탈로그
    # 목록 화면에 필요한 최소 정보만, 짧은 이름으로 담는다.
    # (작품이 만 개를 넘어가면 이름을 길게 쓰는 것만으로 파일이 몇 배가 된다)
    #   t 제목 / a 작가 / r 별점 / rc 별점참여수 / ep 회차수 / u 화·권 단위
    #   c 완결 / x 독점 / ad 성인 / pb 출판사 / p 가격 / dc 할인율 / s 표지용ID
    # 표지 주소와 작품 주소는 ID로 만들 수 있으므로 저장하지 않는다.
    @staticmethod
    def compact(b):
        out = {
            "t": b.get("title"),
            "a": b.get("authors") or [],
            "r": b.get("rating"),
            "rc": b.get("rating_count"),
            "ep": b.get("total_episodes"),
            "u": b.get("unit"),
        }
        if b.get("is_completed"):
            out["c"] = 1
        if b.get("is_exclusive"):
            out["x"] = 1
        if b.get("adults_only"):
            out["ad"] = 1
        if b.get("is_set"):
            # 세트(묶음) 상품. 리디 순위에 단행본과 따로 올라오므로 합치지 않고
            # 화면에서 '세트' 표시만 붙인다.
            out["st"] = 1
            if b.get("set_total"):
                out["sn"] = b["set_total"]
        if b.get("publisher"):
            out["pb"] = b["publisher"]
        if b.get("price_all") is not None:
            out["p"] = b["price_all"]
        if b.get("discount_rate"):
            out["dc"] = b["discount_rate"]
        if b.get("series_id") and b["series_id"] != b.get("id"):
            out["s"] = b["series_id"]
        return out

    def update_catalog(self, books):
        """작품 카탈로그를 갱신한다 (있으면 최신값으로 교체, 없으면 추가)."""
        catalog = self.read("books.json", default={}) or {}
        for b in books.values():
            catalog[b["id"]] = self.compact(b)
        self.write(catalog, "books.json")
        return len(catalog)

    def save_book_detail(self, book, detail=None):
        """작품 상세 파일. 소개글·태그·걸린 이벤트를 담는다."""
        existing = self.read("books", f"{book['id']}.json", default={}) or {}
        payload = {
            "id": book["id"],
            "title": book["title"],
            "description": book.get("description") or existing.get("description", ""),
            "rating_dist": book.get("rating_dist") or existing.get("rating_dist"),
            "authors_full": book.get("authors_full") or existing.get("authors_full"),
            "wait_for_free": book.get("wait_for_free") or existing.get("wait_for_free"),
            "keywords": existing.get("keywords", []),
            "tags": existing.get("tags", []),
            "meta_tags": existing.get("meta_tags", []),
            "event_ids": existing.get("event_ids", []),
            "exclusive_label": existing.get("exclusive_label"),
            "review_cell_id": existing.get("review_cell_id"),
            "detail_fetched_at": existing.get("detail_fetched_at"),
        }
        # 랭킹 API의 로맨스 가이드에서 뽑은 키워드도 합쳐준다 (같은 기준으로 걸러서)
        from .details import split_keywords
        exclude = [a.get("name") for a in (book.get("authors_full") or [])]
        exclude += (book.get("authors") or []) + [book.get("publisher")]
        guide_kw, guide_meta = split_keywords(
            book.get("keywords_from_guide") or [], exclude=exclude)
        if detail and not detail.get("error"):
            payload["keywords"] = detail.get("keywords") or payload["keywords"]
            payload["tags"] = detail.get("tags") or payload["tags"]
            payload["meta_tags"] = detail.get("meta_tags") or payload["meta_tags"]
            payload["event_ids"] = detail.get("event_ids") or payload["event_ids"]
            payload["exclusive_label"] = detail.get("exclusive_label") or payload["exclusive_label"]
            payload["review_cell_id"] = detail.get("review_cell_id") or payload["review_cell_id"]
            payload["detail_fetched_at"] = detail.get("fetched_at")
        if guide_kw:
            merged = list(payload["tags"])
            for k in guide_kw:
                if k not in merged:
                    merged.append(k)
            payload["tags"] = merged
        if guide_meta:
            merged = list(payload["meta_tags"])
            for k in guide_meta:
                if k not in merged:
                    merged.append(k)
            payload["meta_tags"] = merged
        self.write(payload, "books", f"{book['id']}.json")

    # ------------------------------------------------------------ 키워드 모음
    def write_tag_index(self):
        """모든 작품의 태그를 한 파일(tags.json)로 모은다 — 키워드 분석 화면용.

        작품마다 파일을 따로 열면 화면에서 200개를 읽어야 해서 너무 느리다.
        태그 이름은 사전에 한 번만 적고, 작품별로는 번호만 담아 파일을 작게 만든다.
            {"dict": ["현대물","첫사랑",...], "books": {"작품ID":[0,1,5], ...}}
        """
        names, index, books = [], {}, {}
        folder = self.path("books")
        if not os.path.isdir(folder):
            return 0, 0
        for fn in os.listdir(folder):
            if not fn.endswith(".json"):
                continue
            data = self.read("books", fn, default=None)
            if not data:
                continue
            tags = data.get("tags") or []
            if not tags:
                continue
            ids = []
            for t in tags:
                if t not in index:
                    index[t] = len(names)
                    names.append(t)
                ids.append(index[t])
            books[fn[:-5]] = ids
        self.write({"dict": names, "books": books}, "tags.json")
        return len(books), len(names)

    # ------------------------------------------------------------ 진행 상황 메모
    # 어떤 작품의 상세·리뷰를 언제 가져왔는지 기록해 둔다.
    # (작품 파일을 수천 개씩 열어보지 않고 다음 대상을 고르기 위해)
    def read_meta(self):
        m = self.read("_meta.json", default=None) or {}
        m.setdefault("details", {})   # {작품ID: 상세를 마지막으로 본 날}
        m.setdefault("reviews", {})   # {작품ID: 리뷰를 마지막으로 본 날}
        m.setdefault("files", {})     # {작품ID: 1}  상세 파일이 이미 만들어졌는지
        return m

    def write_meta(self, meta):
        self.write(meta, "_meta.json")

    # ------------------------------------------------------------ 추이(그래프)
    def update_history(self, date, rank_map, rating_map):
        """달 단위 추이 파일을 갱신한다 (그래프용).

        rank_map:   {book_id: {ranking_key: 순위}}
        rating_map: {book_id: 평균별점}

        저장 형태
            {"month":"2026-08",
             "days":["2026-08-20","2026-08-21","2026-08-22"],
             "rank":{"작품ID":{"1650-DAILY":[12,11,null]}},
             "rating":{"작품ID":[4.8,4.8,4.9]}}

        날짜를 매번 적으면 파일이 몇 배로 커지므로, days 순서에 맞춘 배열로 넣는다.
        배열이 days보다 짧으면 나머지 날은 '기록 없음'을 뜻한다.
        """
        month = date[:7]
        hist = self.read("history", f"{month}.json", default=None) or {
            "month": month, "days": [], "rank": {}, "rating": {}
        }

        # 같은 날 두 번 돌리면 마지막 값으로 덮어쓴다
        if hist["days"] and hist["days"][-1] == date:
            slot = len(hist["days"]) - 1
        else:
            hist["days"].append(date)
            slot = len(hist["days"]) - 1

        def put(series, value):
            while len(series) < slot:
                series.append(None)
            if len(series) == slot:
                series.append(value)
            else:
                series[slot] = value

        for book_id, ranks in rank_map.items():
            book_slot = hist["rank"].setdefault(book_id, {})
            for key, rank in ranks.items():
                put(book_slot.setdefault(key, []), rank)

        for book_id, rating in rating_map.items():
            if rating is not None:
                put(hist["rating"].setdefault(book_id, []), rating)

        self.write(hist, "history", f"{month}.json")
        return month

    # ------------------------------------------------------------ 안내판
    def update_index(self, date, meta):
        idx = self.read("index.json", default=None) or {"dates": [], "months": []}
        if date not in idx["dates"]:
            idx["dates"].append(date)
            idx["dates"].sort()
        month = date[:7]
        if month not in idx["months"]:
            idx["months"].append(month)
            idx["months"].sort()
        idx.update(meta)
        self.write(idx, "index.json", pretty=True)
        return idx
