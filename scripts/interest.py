#!/usr/bin/env python3
"""리디 '관심' 수 수집기 (하루 한 번, GitHub Actions에서 실행).

무엇을 모으나
  1) BL 웹툰 카테고리(4250) 전체 목록 — 카테고리 API로 최신 등록순 최대 6,000종.
     완결 여부·회차 수·마지막 회차 공개일·작가·출판사·별점 수가 들어 있어
     "순위 밖에서 최근 완결한 작품"을 찾는 데 쓴다.          → docs/data/bl_webtoon/list.json
  2) 작품별 '관심' 수 — 한 번이라도 순위에 들었던 모든 작품(books.json) + 위 BL 웹툰 목록.
     리디 GraphQL의 headerCell 이 한 요청에 100작품씩 돌려준다(2026-10-16 확인, 셀 ID는 아무 값이나 됨,
     성인 작품·웹소설도 로그인 없이 나옴). 상세페이지(한 장 900KB)를 열 필요가 없다.
     날짜별로 쌓아 두어 증가량을 볼 수 있게 한다.
       → docs/data/interest/<YYYY-MM>/<NN>.json  (NN = 작품 ID 끝 두 자리, 전 작품 별점 rc 파일과 같은 꼴:
          {month, days:[날짜…], count:{작품ID:[날짜 순 관심 수, 없으면 null]}})

순서: 오늘 순위에 있는 작품 → 나머지 카탈로그 → BL 웹툰 목록에만 있는 작품.
요청 수 상한(--max-requests)에 걸리면 뒤쪽은 그날 비운다(null).
"""

import argparse
import datetime as dt
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from ridi import config  # noqa: E402
from ridi.client import RidiClient, RateLimited, RidiError  # noqa: E402
from ridi.storage import Store  # noqa: E402

CATEGORY_URL = f"{config.API_BASE}/v2/category/books"
BL_WEBTOON_CATEGORY = "4250"
SWEEP_LIMIT = 200
SWEEP_MAX_OFFSET = 6000          # 리디가 허용하는 상한 (그 뒤는 빈 목록)
SHORT_RE = re.compile(r"단편")   # 단편선·단편집·단편 콜렉션 모두 잡힌다
BATCH = 100                      # 한 GraphQL 요청에 담는 작품 수 (200까지 되는 걸 확인했지만 여유를 둔다)
ANY_CELL = "00000000-0000-0000-0000-000000000000"


def today_kst():
    return (dt.datetime.utcnow() + dt.timedelta(hours=9)).strftime("%Y-%m-%d")


def shard(book_id):
    s = str(book_id)
    return ("0" + s[-2:])[-2:]


# ---------------------------------------------------------------- 1) 카테고리 전체 목록
def sweep_category(client, category_id):
    """카테고리 목록 API를 최신 등록순으로 끝까지 넘기며 작품 정보를 모은다."""
    items = []
    for offset in range(0, SWEEP_MAX_OFFSET, SWEEP_LIMIT):
        params = {
            "category_id": category_id, "tab": "books", "limit": SWEEP_LIMIT,
            "platform": "web", "offset": offset, "order_by": "recent",
        }
        data = client.get_json(CATEGORY_URL, params)
        page = ((data.get("data") or {}).get("items")) or []
        if not page:
            break
        for x in page:
            b = x.get("book") or x
            s = b.get("serial") or {}
            f = b.get("file") or {}
            authors = []
            for a in b.get("authors") or []:
                name = (a.get("name") or "").strip()
                if not name:
                    continue
                role = a.get("role") or ""
                authors.append(name if role == "author" else f"{name}({role})")
            items.append({
                "id": str(b.get("bookId") or ""),
                "t": s.get("title") or b.get("title") or "",
                "a": "/".join(authors),
                "pub": ((b.get("publisher") or {}).get("name")) or "",
                "c": bool(s.get("completion")),                       # 완결
                "n": s.get("total"),                                  # 회차 수
                "reg": (b.get("registrationDate") or "")[:10],         # 등록일
                "last": (s.get("lastOpenedEpisodeDate") or "")[:10],   # 마지막 회차 공개일
                "ad": bool(b.get("adultsOnly")),
                "rc": sum((q.get("count") or 0) for q in (b.get("ratings") or [])),
                "wt": bool(f.get("webtoon")),                         # 세로 스크롤 웹툰(아니면 페이지 만화)
                "orig": bool(b.get("isOriginal")),
                "only": bool(b.get("isOnly")),
                "short": bool(SHORT_RE.search(s.get("title") or b.get("title") or "")),
            })
        print(f"  목록 {offset + len(page):>5}종 …", flush=True)
        if len(page) < SWEEP_LIMIT:
            break
    return items


# ---------------------------------------------------------------- 2) 관심 수 (GraphQL 묶음)
def fetch_interest_batch(client, ids):
    """작품 ID 묶음의 관심 수를 한 요청으로 받는다. 반환: {id: 수 또는 None}."""
    parts = []
    for i, bid in enumerate(ids):
        parts.append(
            f'b{i}: headerCell(id:"{ANY_CELL}", context:{{bookId:"{bid}", deviceType:DESKTOP}})'
            " { cell { information { userInterestBookCount } } }"
        )
    query = "{ riGrid { cells { bookDetailHome { " + " ".join(parts) + " } } } }"
    res = client.post_graphql(query, {})
    home = (((((res.get("data") or {}).get("riGrid") or {}).get("cells") or {}).get("bookDetailHome")) or {})
    out = {}
    for i, bid in enumerate(ids):
        node = home.get(f"b{i}") or {}
        info = ((node.get("cell") or {}).get("information")) or {}
        n = info.get("userInterestBookCount")
        out[bid] = int(n) if isinstance(n, (int, float)) else None
    return out


def ranked_ids(store):
    latest = store.read("latest.json", default={}) or {}
    seen = []
    for r in (latest.get("rankings") or {}).values():
        seen.extend(str(i) for i in (r.get("ids") or []))
    return list(dict.fromkeys(seen))


def save_counts(store, today, counts):
    """{id: 수|None} 를 월별·칸별 파일에 오늘 칸으로 적는다 (rc 파일과 같은 방식)."""
    month = today[:7]
    by_shard = {}
    for bid in counts:
        by_shard.setdefault(shard(bid), []).append(bid)
    for nn, ids in sorted(by_shard.items()):
        h = store.read("interest", month, f"{nn}.json", default=None) or {"month": month, "days": [], "count": {}}
        if today not in h["days"]:
            h["days"].append(today)
            h["days"].sort()
        slot = h["days"].index(today)
        for bid in ids:
            arr = h["count"].setdefault(bid, [])
            while len(arr) < len(h["days"]):
                arr.append(None)
            arr[slot] = counts[bid]
        for arr in h["count"].values():            # 오늘 못 받은 작품도 칸 수는 맞춘다
            while len(arr) < len(h["days"]):
                arr.append(None)
        store.write(h, "interest", month, f"{nn}.json")


def main():
    ap = argparse.ArgumentParser(description="리디 관심 수 수집")
    ap.add_argument("--max-requests", type=int, default=400, help="관심 수 GraphQL 요청 수 상한 (100작품/요청)")
    ap.add_argument("--interval", type=float, default=None, help="요청 간격(초)")
    ap.add_argument("--sweep-only", action="store_true", help="카테고리 목록만 갱신하고 관심 수는 건너뜀")
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "docs", "data"))
    args = ap.parse_args()

    today = today_kst()
    store = Store(args.data_dir)
    client = RidiClient(interval=args.interval)
    print(f"[리디 관심 수] {today} / 요청 상한 {args.max_requests}")

    # 1) BL 웹툰 카테고리 목록
    print("\n[1/2] BL 웹툰 카테고리 목록")
    listing = sweep_category(client, BL_WEBTOON_CATEGORY)
    store.write({"updated": today, "category": BL_WEBTOON_CATEGORY, "count": len(listing), "items": listing},
                "bl_webtoon", "list.json")
    print(f"  {len(listing)}종 저장 (완결 {sum(1 for x in listing if x['c'])}종, 단편선 {sum(1 for x in listing if x['short'])}종)")
    if args.sweep_only:
        return 0

    # 2) 관심 수 — 순위권 → 나머지 카탈로그 → BL 웹툰 목록에만 있는 작품
    catalog = store.read("books.json", default={}) or {}
    order = ranked_ids(store)
    seen = set(order)
    for bid in catalog:
        if bid not in seen:
            order.append(bid); seen.add(bid)
    n_catalog = len(order)
    for it in listing:
        if it["id"] and it["id"] not in seen:
            order.append(it["id"]); seen.add(it["id"])
    print(f"\n[2/2] 관심 수 — 대상 {len(order)}종 (순위권 {len(ranked_ids(store))}, 카탈로그까지 {n_catalog}, "
          f"BL 웹툰 목록에만 있는 작품 {len(order) - n_catalog})")

    counts, requests, got = {}, 0, 0
    stopped = None
    for i in range(0, len(order), BATCH):
        if requests >= args.max_requests:
            stopped = f"요청 상한 {args.max_requests}"
            break
        ids = order[i:i + BATCH]
        try:
            part = fetch_interest_batch(client, ids)
        except RateLimited as e:
            stopped = str(e)
            break
        except RidiError as e:
            print(f"  ✗ {i}~{i + len(ids)} 묶음 실패 — {e}")
            part = {bid: None for bid in ids}
        requests += 1
        counts.update(part)
        got += sum(1 for v in part.values() if v is not None)
        if requests % 20 == 0:
            print(f"  {requests}번째 요청 — {got:,}작품 받음", flush=True)
            save_counts(store, today, counts); counts = {}

    if counts:
        save_counts(store, today, counts)
    print(f"\n완료: 관심 수 {got:,}작품 저장 (요청 {requests}번)" + (f" — 중단: {stopped}" if stopped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
