#!/usr/bin/env python3
"""리디 트래커 — 하루 한 번 돌리는 수집기.

AI를 부르지 않는 평범한 파이썬 스크립트입니다. 정해진 동작만 반복하므로
매일 돌려도 비용이 들지 않습니다.

사용법:
    python scripts/collect.py                  # 전체 수집
    python scripts/collect.py --quick          # 빠른 확인용 (랭킹 몇 개만)
    python scripts/collect.py --skip-reviews   # 리뷰 빼고
"""

import argparse
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ridi import config, details, events as events_mod, rankings, reviews as reviews_mod
from ridi.client import RidiClient, RidiError
from ridi.storage import Store

KST = datetime.timezone(datetime.timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_DIR = os.path.join(ROOT, "docs", "data")


def today_kst():
    return datetime.datetime.now(KST).strftime("%Y-%m-%d")


def now_kst():
    return datetime.datetime.now(KST).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 1. 랭킹
def collect_rankings(client, targets):
    """랭킹을 전부 가져온다. 반환: (랭킹표, 작품모음, 실패목록)"""
    tables, books, failures = {}, {}, []
    total = len(targets)

    for i, t in enumerate(targets, 1):
        label = f"{t['name']}({config.PERIOD_LABELS[t['period']]})"
        try:
            items = rankings.fetch_ranking(client, t["category_id"], t["period"])
        except (RidiError, RuntimeError) as e:
            print(f"  [{i}/{total}] {label:<34} 실패 — {e}")
            failures.append({"key": t["key"], "name": label, "error": str(e)})
            continue

        ids = []
        for item in items:
            book = rankings.parse_book(item)
            if not book["id"]:
                continue
            ids.append(book["id"])
            # 같은 작품이 여러 랭킹에 나오면 마지막 값으로 갱신 (내용은 동일)
            books[book["id"]] = book

        tables[t["key"]] = {
            "name": t["name"],
            "group": t["group"],
            "section": t["section"],
            "period": t["period"],
            "category_id": t["category_id"],
            "is_sub": t["is_sub"],
            "ids": ids,
        }
        print(f"  [{i}/{total}] {label:<34} {len(ids):>3}위까지")

    return tables, books, failures


# ---------------------------------------------------------------- 2. 변동 계산
def compute_changes(today_tables, prev_tables):
    """어제와 비교해서 ▲▼ / NEW / 순위권 이탈을 계산."""
    changes = {}
    for key, table in today_tables.items():
        prev = (prev_tables or {}).get(key, {}).get("ids") or []
        prev_rank = {bid: i + 1 for i, bid in enumerate(prev)}
        today_rank = {bid: i + 1 for i, bid in enumerate(table["ids"])}

        moves, new_ids = {}, []
        for bid, rank in today_rank.items():
            if bid in prev_rank:
                diff = prev_rank[bid] - rank      # 양수면 순위 상승
                if diff != 0:
                    moves[bid] = diff
            elif prev:                            # 어제 데이터가 있을 때만 NEW 판정
                new_ids.append(bid)

        dropped = [bid for bid in prev_rank if bid not in today_rank] if prev else []
        risers = sorted(moves.items(), key=lambda kv: -kv[1])[:20]

        changes[key] = {
            "moves": moves,
            "new": new_ids,
            "out": dropped,
            "top_risers": risers,
            "has_prev": bool(prev),
        }
    return changes


# ---------------------------------------------------------------- 3. 상세·리뷰 대상 고르기
def name_exclusions(book):
    """태그에서 걸러낼 이름들 (작가·번역가·출판사)."""
    if not book:
        return []
    names = [a.get("name") for a in (book.get("authors_full") or [])]
    names += book.get("authors") or []
    if book.get("publisher"):
        names.append(book["publisher"])
    return [n for n in names if n]


def best_ranks(tables, only_main=True, only_daily=False):
    """작품별로 오늘 기록한 가장 높은 순위를 구한다."""
    best = {}
    for table in tables.values():
        if only_main and table["is_sub"]:
            continue
        if only_daily and table["period"] != "DAILY":
            continue
        for i, bid in enumerate(table["ids"]):
            r = i + 1
            if bid not in best or r < best[bid]:
                best[bid] = r
    return best


def pick_detail_targets(meta, books, tables, limit):
    """상세페이지를 열 작품을 고른다.

    우선순위: (1) 아직 한 번도 상세를 안 본 작품 중 상위권
              (2) 마지막으로 본 지 오래된 작품
    """
    ranks = best_ranks(tables)
    seen = meta.get("details", {})

    never, stale = [], []
    for bid in books:
        rank = ranks.get(bid, 9999)
        if bid in seen:
            stale.append((seen[bid], rank, bid))
        else:
            never.append((rank, bid))

    never.sort()
    stale.sort()
    picked = [bid for _, bid in never[:limit]]
    if len(picked) < limit:
        picked += [bid for _, _, bid in stale[:limit - len(picked)]]
    return picked


def pick_review_targets(meta, books, tables, limit):
    """리뷰를 가져올 작품을 고른다 — 오래 안 본 것 + 상위권 위주."""
    ranks = best_ranks(tables, only_daily=True)
    seen = meta.get("reviews", {})

    scored = []
    for bid, rank in ranks.items():
        if bid not in books:
            continue
        scored.append((seen.get(bid, ""), rank, bid))
    scored.sort()  # 한 번도 안 본 것("") 먼저, 그 다음 오래된 것, 그 안에서 상위권
    return [bid for _, _, bid in scored[:limit]]


# ---------------------------------------------------------------- 메인
def main():
    ap = argparse.ArgumentParser(description="리디 랭킹·리뷰·이벤트 수집기")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    ap.add_argument("--quick", action="store_true", help="랭킹 6개만 — 동작 확인용")
    ap.add_argument("--skip-details", action="store_true")
    ap.add_argument("--skip-reviews", action="store_true")
    ap.add_argument("--skip-events", action="store_true")
    ap.add_argument("--interval", type=float, default=None, help="요청 간격(초)")
    ap.add_argument("--max-details", type=int, default=config.MAX_DETAIL_FETCHES_PER_RUN)
    ap.add_argument("--max-reviews", type=int, default=config.MAX_REVIEW_FETCHES_PER_RUN)
    args = ap.parse_args()

    started = time.time()
    date = today_kst()
    store = Store(args.data_dir)
    meta = store.read_meta()
    client = RidiClient(interval=args.interval)

    targets = list(config.iter_ranking_targets())
    if args.quick:
        targets = [t for t in targets if not t["is_sub"] and t["period"] == "DAILY"][:6]

    print("=" * 66)
    print(f"  리디 트래커 수집 시작 — {now_kst()} (한국시간)")
    print(f"  저장 위치: {args.data_dir}")
    print("=" * 66)

    # --- 1. 랭킹 ---
    print(f"\n[1/5] 랭킹 수집 — 총 {len(targets)}개")
    tables, books, failures = collect_rankings(client, targets)
    if not tables:
        print("\n랭킹을 하나도 가져오지 못했습니다. 중단합니다.")
        return 1
    print(f"  → 랭킹 {len(tables)}개, 작품 {len(books)}종 확보")

    # --- 2. 어제와 비교 ---
    print("\n[2/5] 어제와 비교")
    prev_date = None
    idx = store.read("index.json", default={}) or {}
    for d in reversed(idx.get("dates", [])):
        if d < date:
            prev_date = d
            break
    prev = store.read("daily", f"{prev_date}.json", default=None) if prev_date else None
    changes = compute_changes(tables, (prev or {}).get("rankings"))
    if prev_date:
        n_new = sum(len(c["new"]) for c in changes.values())
        n_out = sum(len(c["out"]) for c in changes.values())
        print(f"  → 기준일 {prev_date} / 신규 진입 {n_new}건, 순위권 이탈 {n_out}건")
    else:
        print("  → 비교할 이전 기록이 없습니다 (오늘이 첫 수집)")

    # --- 3. 이벤트 ---
    all_events = []
    if not args.skip_events:
        print(f"\n[3/5] 진행 중 이벤트 수집 — 장르 {len(config.EVENT_GENRES)}종")
        all_events = events_mod.fetch_events(client)
        print(f"  → 이벤트 {len(all_events)}건")
        store.write({"date": date, "updated_at": now_kst(), "events": all_events},
                    "events", "latest.json")
        store.write({"date": date, "events": all_events}, "events", f"{date}.json")
    else:
        print("\n[3/5] 이벤트 건너뜀")

    # --- 4. 상세 (태그·걸린 이벤트) ---
    detail_map = {}
    if not args.skip_details and args.max_details > 0:
        picked = pick_detail_targets(meta, books, tables, args.max_details)
        print(f"\n[4/5] 작품 상세 수집 — {len(picked)}건 (하루 상한 {args.max_details})")
        for i, bid in enumerate(picked, 1):
            d = details.fetch_detail(client, bid)
            d["fetched_at"] = now_kst()
            detail_map[bid] = d
            if d.get("error"):
                print(f"  [{i}/{len(picked)}] {bid} 실패 — {d['error']}")
            else:
                tags, meta_tags = details.split_keywords(
                    d.get("keywords") or [], exclude=name_exclusions(books.get(bid)))
                d["tags"], d["meta_tags"] = tags, meta_tags
                meta["details"][bid] = date
                title = books.get(bid, {}).get("title", bid)[:24]
                print(f"  [{i}/{len(picked)}] {title:<26} 태그 {len(tags)}개 / 이벤트 {len(d['event_ids'])}개")
    else:
        print("\n[4/5] 작품 상세 건너뜀")

    # --- 5. 리뷰 ---
    review_stats = {"books": 0, "added": 0}
    if not args.skip_reviews and args.max_reviews > 0:
        picked = pick_review_targets(meta, books, tables, args.max_reviews)
        print(f"\n[5/5] 리뷰 수집 — {len(picked)}작품 (작품당 최대 {config.REVIEWS_PER_BOOK}건)")
        for i, bid in enumerate(picked, 1):
            # 리뷰를 읽으려면 상세페이지에서 얻는 '리뷰 셀 ID'가 필요하다
            cell_id = (detail_map.get(bid) or {}).get("review_cell_id")
            if not cell_id:
                saved = store.read("books", f"{bid}.json", default={}) or {}
                cell_id = saved.get("review_cell_id")
            if not cell_id:
                d = details.fetch_detail(client, bid)
                cell_id = d.get("review_cell_id")
                if not d.get("error"):
                    d["fetched_at"] = now_kst()
                    tags, meta_tags = details.split_keywords(
                        d.get("keywords") or [], exclude=name_exclusions(books.get(bid)))
                    d["tags"], d["meta_tags"] = tags, meta_tags
                    detail_map.setdefault(bid, d)
                    meta["details"][bid] = date
            if not cell_id:
                continue

            fresh = reviews_mod.fetch_reviews(client, bid, cell_id)
            meta["reviews"][bid] = date
            if not fresh:
                continue
            existing = store.read("reviews", f"{bid}.json", default={}) or {}
            merged, added = reviews_mod.merge_reviews(existing.get("reviews", []), fresh)
            history = (existing.get("history") or [])
            if not history or history[-1].get("date") != date:
                history = history + [{"date": date, "count": len(merged)}]
            else:
                history[-1]["count"] = len(merged)
            store.write({
                "id": bid,
                "title": books.get(bid, {}).get("title", ""),
                "updated_at": now_kst(),
                "count": len(merged),
                "history": history,
                "reviews": merged,
            }, "reviews", f"{bid}.json")
            review_stats["books"] += 1
            review_stats["added"] += added
            title = books.get(bid, {}).get("title", bid)[:24]
            print(f"  [{i}/{len(picked)}] {title:<26} 새 리뷰 {added:>3}건 (누적 {len(merged)})")
        print(f"  → {review_stats['books']}작품 / 새 리뷰 {review_stats['added']}건")
    else:
        print("\n[5/5] 리뷰 건너뜀")

    # --- 저장 ---
    print("\n저장 중...")

    # 작품 상세 파일은 (1) 새로 상세를 가져온 작품 (2) 아직 파일이 없는 작품만 쓴다.
    # 매번 전부 다시 쓰면 바뀐 파일이 수천 개가 되어 기록이 지저분해지기 때문.
    written = 0
    for bid, book in books.items():
        d = detail_map.get(bid)
        if d and not d.get("error"):
            store.save_book_detail(book, d)
            meta["files"][bid] = 1
            written += 1
        elif bid not in meta["files"]:
            store.save_book_detail(book, None)
            meta["files"][bid] = 1
            written += 1
    print(f"  작품 상세 파일 {written}개 기록")

    store.update_catalog(books)
    store.write_meta(meta)

    daily = {
        "date": date,
        "collected_at": now_kst(),
        "rankings": tables,
        "snapshots": {bid: rankings.snapshot_of(b) for bid, b in books.items()},
    }
    store.write(daily, "daily", f"{date}.json")

    rank_map = {}
    for key, table in tables.items():
        if table["is_sub"]:
            continue
        for i, bid in enumerate(table["ids"]):
            rank_map.setdefault(bid, {})[key] = i + 1
    rating_map = {bid: b["rating"] for bid, b in books.items()}
    store.update_history(date, rank_map, rating_map)

    store.write({
        "date": date,
        "prev_date": prev_date,
        "updated_at": now_kst(),
        "rankings": tables,
        "changes": changes,
        "event_count": len(all_events),
    }, "latest.json")

    elapsed = time.time() - started
    store.update_index(date, {
        "updated_at": now_kst(),
        "latest_date": date,
        "book_count": len(books),
        "ranking_count": len(tables),
        "event_count": len(all_events),
        "sections": {k: v["label"] for k, v in config.CATEGORY_TREE.items()},
        "periods": config.PERIOD_LABELS,
        "last_run": {
            "requests": client.request_count,
            "seconds": round(elapsed, 1),
            "failures": failures,
            "reviews": review_stats,
            "details": len(detail_map),
        },
    })

    print("=" * 66)
    print(f"  완료 — {len(tables)}개 랭킹 / {len(books)}종 작품 / {len(all_events)}건 이벤트")
    print(f"  요청 {client.request_count}회, {elapsed/60:.1f}분 소요")
    if failures:
        print(f"  실패한 랭킹 {len(failures)}개: " + ", ".join(f['name'] for f in failures[:5]))
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
