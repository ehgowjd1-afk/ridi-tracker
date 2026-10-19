#!/usr/bin/env python3
"""신작 성과 수집기 — 리디 '이번주 인기 신작'이 쓰는 first-releases API (하루 한 번).

  GET api.ridibooks.com/v2/first-releases?category_includes=부모,하위,…&order_by=sales&limit=50&offset=N
  → 등록 60일 안쪽 작품을 판매순으로 전부(totalCount) 준다. order_by 는 sales / recent / recommend.
  (BL 웹툰 124종, 로맨스 웹소설 46종 — 2026-10-18)

저장: docs/data/newworks/<YYYY-MM-DD>.json (그날 전체) + newworks/latest.json
  {date, groups: {키: {name, section, total, ids: [판매순 ID…]}}, books: {ID: {t, a, reg, n, rc, ad, pb, c}}}
"""

import argparse
import datetime as dt
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from ridi import config  # noqa: E402
from ridi.client import RidiClient, RidiError  # noqa: E402
from ridi.groups import main_groups  # noqa: E402
from ridi.storage import Store  # noqa: E402

URL = f"{config.API_BASE}/v2/first-releases"
LIMIT = 50
MAX_PAGES = 12   # 600위까지 — 전체 웹소설(519)은 다 담기고, e북(1,000~2,300)은 판매순 상위만


def today_kst():
    return (dt.datetime.utcnow() + dt.timedelta(hours=9)).strftime("%Y-%m-%d")


def slim(b):
    s = b.get("serial") or {}
    authors = [a.get("name") for a in (b.get("authors") or []) if a.get("name")]
    return {
        "t": s.get("title") or b.get("title") or "",
        "a": authors[:4],
        "reg": (b.get("registrationDate") or "")[:10],
        "pub": (b.get("publicationDate") or "")[:10],
        "n": s.get("total") or s.get("totalEpisodeCount"),
        "c": bool(s.get("completion") or s.get("isCompleted")),
        "rc": sum((q.get("count") or 0) for q in (b.get("ratings") or [])),
        "ad": bool(b.get("adultsOnly")),
        "pb": ((b.get("publisher") or {}).get("name")) or "",
        # 리디 목록 화면에 보이는 것들: 소개 한 토막, 회당 대여·소장가, 무료 회차 수
        "d": " ".join(str((b.get("introduction") or {}).get("description") or "").split())[:160],
        "pr": ((b.get("rental") or {}).get("fullPrice")),
        "pp": ((b.get("purchase") or {}).get("fullPrice")),
        "fr": ((s.get("free") or {}).get("rental")) or 0,
        "x": bool(b.get("isOnly") or b.get("isOriginal") or b.get("isPreExclusive")),
        # 독점 종류: o isOriginal / s isOnly / p isPreExclusive(= 화면의 'RIDI ONLY') — books.json 의 xt 와 같은 뜻
        "xt": "o" if b.get("isOriginal") else ("s" if b.get("isOnly") else ("p" if b.get("isPreExclusive") else None)),
    }


def fetch_group(client, cats, order="sales"):
    ids, books, total = [], {}, None
    for page in range(MAX_PAGES):
        params = {"category_includes": cats, "order_by": order, "limit": LIMIT, "offset": page * LIMIT}
        data = client.get_json(URL, params)
        d = data.get("data") or {}
        total = d.get("totalCount", total)
        items = d.get("items") or []
        for it in items:
            b = it.get("book") or {}
            s = b.get("serial") or {}
            bid = str(s.get("serialId") or b.get("bookId") or "")
            if not bid or bid in books:
                continue
            ids.append(bid)
            books[bid] = slim(b)
        if len(items) < LIMIT:
            break
    return ids, books, total


def shard(book_id):
    s = str(book_id)
    return ("0" + s[-2:])[-2:]


def attach_interest(store, today, books):
    """관심 수(docs/data/interest/<월>/<NN>.json)에서 최신값(i)과 7일 전 대비 증가(i7)를 붙인다."""
    months = sorted({today[:7], (dt.date.fromisoformat(today) - dt.timedelta(days=10)).strftime("%Y-%m")})
    cache = {}
    week_ago = (dt.date.fromisoformat(today) - dt.timedelta(days=7)).strftime("%Y-%m-%d")
    hit = 0
    for bid, b in books.items():
        series = []
        for m in months:
            key = (m, shard(bid))
            if key not in cache:
                cache[key] = store.read("interest", m, f"{shard(bid)}.json", default=None) or {}
            h = cache[key]
            arr = (h.get("count") or {}).get(bid)
            if arr:
                series.extend(zip(h.get("days") or [], arr))
        series = [(d, v) for d, v in series if v is not None]
        if not series:
            continue
        series.sort()
        b["i"] = series[-1][1]
        old = [v for d, v in series if d <= week_ago]
        if old:
            b["i7"] = series[-1][1] - old[-1]
        hit += 1
    return hit


def attach_history(store, today, out):
    """어제 파일과 비교한 판매순 변동(d1)과 처음 본 날(since)을 묶음마다 붙인다."""
    folder = os.path.join(store.root, "newworks")
    dates = sorted(f[:-5] for f in os.listdir(folder) if f.endswith(".json") and f[:4].isdigit() and f[:-5] < today) if os.path.isdir(folder) else []
    prev = store.read("newworks", f"{dates[-1]}.json", default=None) if dates else None
    for key, g in out["groups"].items():
        pg = (prev or {}).get("groups", {}).get(key)
        since = dict((pg or {}).get("since") or {})
        d1 = {}
        if pg:
            prev_rank = {bid: i + 1 for i, bid in enumerate(pg.get("ids") or [])}
            for i, bid in enumerate(g["ids"]):
                d1[bid] = (prev_rank[bid] - (i + 1)) if bid in prev_rank else "new"
                since.setdefault(bid, prev["date"] if bid in prev_rank else today)
        else:
            for bid in g["ids"]:
                since.setdefault(bid, today)
        g["d1"] = d1
        g["since"] = {bid: since[bid] for bid in g["ids"] if bid in since}
    return dates[-1] if dates else None


def attach_sales_stats(store, today, out):
    """신작 판매순의 날짜별 궤적(newworks/<날짜>.json)으로 작품마다 최고 순위와 그때 회차, 1위·TOP10 첫 달성 회차를 센다.
    순위는 회차가 올라온 뒤 튀므로 '몇 화째에 몇 위'로 봐야 한다(사용자 지적 2026-10-19)."""
    folder = os.path.join(store.root, "newworks")
    dates = sorted(f[:-5] for f in os.listdir(folder) if f.endswith(".json") and f[:4].isdigit() and f[:-5] < today) if os.path.isdir(folder) else []
    stats = {key: {} for key in out["groups"]}
    def feed(date, data):
        for key, g in (data.get("groups") or {}).items():
            if key not in stats:
                continue
            books = data.get("books") or {}
            for i, bid in enumerate(g.get("ids") or []):
                if bid not in out["books"]:
                    continue
                n = (books.get(bid) or {}).get("n")
                s = stats[key].setdefault(bid, {"ep0": n, "days": 0})
                s["days"] += 1
                r = i + 1
                if "peak" not in s or r < s["peak"][0]:
                    s["peak"] = [r, date, n]
                if r <= 10 and "t10" not in s:
                    s["t10"] = [date, n]
                if r == 1 and "t1" not in s:
                    s["t1"] = [date, n]
    for d in dates:
        data = store.read("newworks", f"{d}.json", default=None)
        if data:
            feed(d, data)
    feed(today, out)
    for key, g in out["groups"].items():
        g["stats"] = {bid: stats[key][bid] for bid in g["ids"] if bid in stats[key]}


def attach_best(store, today, out, days=60):
    """일간(E북은 주간) 베스트셀러 200위 기록(daily/<날짜>.json)에서 신작마다 최고 순위·그때 회차, 1위·TOP10 첫 달성 회차."""
    folder = os.path.join(store.root, "daily")
    cut = (dt.date.fromisoformat(today) - dt.timedelta(days=days)).strftime("%Y-%m-%d")
    dates = sorted(f[:-5] for f in os.listdir(folder) if f.endswith(".json") and f[:-5] >= cut) if os.path.isdir(folder) else []
    want = set(out["books"])
    best = {key: {} for key in out["groups"]}
    period = {}
    for d in dates:
        D = store.read("daily", f"{d}.json", default=None)
        if not D:
            continue
        snaps = D.get("snapshots") or {}
        for key in out["groups"]:
            rk = (D.get("rankings") or {}).get(f"{key}-DAILY") or (D.get("rankings") or {}).get(f"{key}-WEEKLY")
            if not rk:
                continue
            period[key] = rk.get("period")
            for i, bid in enumerate(rk.get("ids") or []):
                bid = str(bid)
                if bid not in want:
                    continue
                ep = (snaps.get(bid) or {}).get("ep")
                s = best[key].setdefault(bid, {"days": 0})
                s["days"] += 1
                r = i + 1
                if "peak" not in s or r < s["peak"][0]:
                    s["peak"] = [r, d, ep]
                if r <= 10 and "t10" not in s:
                    s["t10"] = [d, ep]
                if r == 1 and "t1" not in s:
                    s["t1"] = [d, ep]
    for key, g in out["groups"].items():
        g["best"] = {bid: best[key][bid] for bid in g["ids"] if bid in best[key]}
        g["best_period"] = period.get(key)
    return len(dates)


def main():
    ap = argparse.ArgumentParser(description="리디 신작 판매순 수집")
    ap.add_argument("--interval", type=float, default=None)
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "docs", "data"))
    args = ap.parse_args()

    today = today_kst()
    store = Store(args.data_dir)
    client = RidiClient(interval=args.interval)
    out = {"date": today, "groups": {}, "books": {}}
    print(f"[신작 판매순] {today}")
    for key, name, section, cats in main_groups():
        try:
            ids, books, total = fetch_group(client, cats)
        except RidiError as e:
            print(f"  ✗ {name}: {e}")
            continue
        out["groups"][key] = {"name": name, "section": section, "total": total, "ids": ids}
        out["books"].update(books)
        print(f"  {name}: {len(ids)}종 (리디 집계 {total})")
    hit = attach_interest(store, today, out["books"])
    prev_date = attach_history(store, today, out)
    attach_sales_stats(store, today, out)
    nd = attach_best(store, today, out)
    store.write(out, "newworks", f"{today}.json")
    store.write(out, "newworks", "latest.json")
    print(f"저장: 묶음 {len(out['groups'])}개, 작품 {len(out['books'])}종 (관심 수 붙은 작품 {hit}종, 어제 파일 {prev_date or '없음'}, 베스트 기록 {nd}일치)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
