#!/usr/bin/env python3
"""BL 웹툰 '관심' 수 수집기 (하루 한 번, GitHub Actions에서 실행).

무엇을 모으나
  1) BL 웹툰 카테고리(4250) 전체 목록 — 리디 카테고리 API로 최신 등록순 최대 6,000종.
     완결 여부·회차 수·마지막 회차 공개일·작가·출판사·별점 수가 들어 있어
     "순위 밖에서 최근 완결한 작품"을 찾는 데 쓴다.      → docs/data/bl_webtoon/list.json
  2) 대상 작품의 '관심' 수 — 작품 상세페이지 데이터(__NEXT_DATA__)의 userInterestBookCount.
     성인 작품은 성인 인증 안내 페이지만 보여 주지만 이 값은 그 안에도 들어 있다(2026-10-15 확인).
     날짜별로 쌓아 두어 증가량을 볼 수 있게 한다.           → docs/data/interest.json

대상(--scope)
  short : 단편선 — 목록에서 제목에 '단편'이 들어간 작품 + 순위권 중 태그 '단편모음'인 작품 (기본)
  bl    : 위 단편선 + BL 웹툰 일간·주간·월간 200위 합집합

상세페이지는 무거워서(한 장 ~900KB) 간격 4초, 한 회차 상한(--max-details)을 둔다.
429가 두 번 연속이면 그 회차를 접는다(다음 날 이어서).
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
from ridi.details import _DATA_SCRIPT_RE  # noqa: E402
from ridi.storage import Store  # noqa: E402

CATEGORY_URL = f"{config.API_BASE}/v2/category/books"
BL_WEBTOON_CATEGORY = "4250"
SWEEP_LIMIT = 200
SWEEP_MAX_OFFSET = 6000          # 리디가 허용하는 상한 (그 뒤는 빈 목록)
SHORT_RE = re.compile(r"단편")   # 단편선·단편집·단편 콜렉션 모두 잡힌다
INTEREST_RE = re.compile(r'"userInterestBookCount":(\d+)')


def today_kst():
    return (dt.datetime.utcnow() + dt.timedelta(hours=9)).strftime("%Y-%m-%d")


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
            })
        print(f"  목록 {offset + len(page):>5}종 …", flush=True)
        if len(page) < SWEEP_LIMIT:
            break
    return items


# ---------------------------------------------------------------- 2) 관심 수
def fetch_interest(client, book_id):
    """상세페이지를 열어 관심 수만 뽑는다. 못 찾으면 None."""
    html = client.get_text(f"{config.WEB_BASE}/books/{book_id}")
    for m in _DATA_SCRIPT_RE.finditer(html):
        hit = INTEREST_RE.search(m.group(1))
        if hit:
            return int(hit.group(1))
    hit = INTEREST_RE.search(html)
    return int(hit.group(1)) if hit else None


def pick_targets(scope, listing, store):
    """수집 대상 ID와 '단편선 여부'를 정한다. 반환: [(id, short, title, authors, pub, rc)] 우선순위 순."""
    by_id = {it["id"]: it for it in listing if it["id"]}
    short_ids = {i for i, it in by_id.items() if SHORT_RE.search(it["t"] or "")}

    # 순위권(BL 웹툰 일·주·월) + 그중 태그가 '단편모음'인 작품
    latest = store.read("latest.json", default={}) or {}
    ranked = []
    for r in (latest.get("rankings") or {}).values():
        if r.get("is_sub") or r.get("name") != "BL 웹툰":
            continue
        ranked.extend(str(i) for i in (r.get("ids") or []))
    ranked_u = list(dict.fromkeys(ranked))
    for bid in ranked_u:
        det = store.read("books", f"{bid}.json", default=None)
        if not det:
            continue
        tags = (det.get("tags") or []) + (det.get("meta_tags") or []) + (det.get("keywords") or [])
        if any("단편" in (t or "") for t in tags) or SHORT_RE.search(det.get("title") or ""):
            short_ids.add(bid)

    catalog = store.read("books.json", default={}) or {}
    wanted = list(short_ids)
    if scope == "bl":
        wanted += [i for i in ranked_u if i not in short_ids]

    out = []
    for bid in wanted:
        it = by_id.get(bid) or {}
        cat = catalog.get(bid) or {}
        out.append((
            bid, bid in short_ids,
            it.get("t") or cat.get("t") or "",
            it.get("a") or "/".join(cat.get("a") or []),
            it.get("pub") or cat.get("pb") or "",
            it.get("rc") or cat.get("rc") or 0,
        ))
    # 단편선 먼저, 그 안에서는 별점 많은 순
    out.sort(key=lambda x: (not x[1], -(x[5] or 0)))
    return out


def main():
    ap = argparse.ArgumentParser(description="BL 웹툰 관심 수 수집")
    ap.add_argument("--scope", choices=["short", "bl"], default="short")
    ap.add_argument("--max-details", type=int, default=400, help="이번 회차에 열 상세페이지 수")
    ap.add_argument("--interval", type=float, default=None, help="요청 간격(초)")
    ap.add_argument("--sweep-only", action="store_true", help="카테고리 목록만 갱신하고 관심 수는 건너뜀")
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "docs", "data"))
    args = ap.parse_args()

    today = today_kst()
    store = Store(args.data_dir)
    client = RidiClient(interval=args.interval)
    print(f"[BL 웹툰 관심 수] {today} / 범위 {args.scope} / 상세 상한 {args.max_details}")

    # 1) 카테고리 목록
    print("\n[1/2] BL 웹툰 카테고리 목록")
    listing = sweep_category(client, BL_WEBTOON_CATEGORY)
    store.write({"updated": today, "category": BL_WEBTOON_CATEGORY, "count": len(listing), "items": listing},
                "bl_webtoon", "list.json")
    print(f"  {len(listing)}종 저장 (완결 {sum(1 for x in listing if x['c'])}종, "
          f"제목에 '단편' {sum(1 for x in listing if SHORT_RE.search(x['t'] or ''))}종)")
    if args.sweep_only:
        return 0

    # 2) 관심 수
    targets = pick_targets(args.scope, listing, store)
    data = store.read("interest.json", default=None) or {"updated": None, "works": {}}
    works = data.setdefault("works", {})
    todo = [t for t in targets if today not in (works.get(t[0], {}).get("s") or {})]
    print(f"\n[2/2] 관심 수 — 대상 {len(targets)}종, 오늘 아직 안 본 것 {len(todo)}종, 이번 회차 상한 {args.max_details}")

    done = fail = 0
    stopped = None
    for bid, short, title, authors, pub, rc in todo[: args.max_details]:
        try:
            n = fetch_interest(client, bid)
        except RateLimited as e:
            stopped = str(e)
            break
        except RidiError as e:
            fail += 1
            print(f"  ✗ {bid} {title[:30]} — {e}")
            continue
        if n is None:
            fail += 1
            print(f"  ? {bid} {title[:30]} — 관심 수 항목을 못 찾음")
            continue
        w = works.setdefault(bid, {})
        w.update({"t": title, "a": authors, "pub": pub, "short": bool(short)})
        w.setdefault("s", {})[today] = n
        done += 1
        if done % 20 == 0 or done <= 3:
            print(f"  [{done}] {title[:30]} 관심 {n:,}")
        if done % 25 == 0:
            data["updated"] = today
            store.write(data, "interest.json")       # 중간 저장 (멈춰도 잃지 않게)

    data["updated"] = today
    store.write(data, "interest.json")
    print(f"\n완료: 관심 수 {done}건 저장, 실패 {fail}건, 남은 대상 {max(0, len(todo) - done - fail)}건"
          + (f" — 중단: {stopped}" if stopped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
