#!/usr/bin/env python3
"""실시간 랭킹 수집기 — 리디 장르 페이지의 '실시간 랭킹'(reading-books API), 한 시간에 한 번.

  GET api.ridibooks.com/v2/reading-books?category_includes=부모,하위,…&limit=50
  → '지금 읽히는' 순위 50위. 몇 분마다 바뀐다(2026-10-18 실측: 5분 사이 50위 중 47개 자리 바뀜).

저장: docs/data/live/<YYYY-MM-DD>.json
  {date, samples: [{at: "HH:MM", ranks: {키: [ID…]}}, …]}, books: {ID: {t, a}}}   (그날 파일에 시각별로 덧붙임)
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


def now_kst():
    return dt.datetime.utcnow() + dt.timedelta(hours=9)


def main():
    ap = argparse.ArgumentParser(description="리디 실시간 랭킹 수집")
    ap.add_argument("--interval", type=float, default=None)
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "docs", "data"))
    args = ap.parse_args()

    now = now_kst()
    date, at = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    store = Store(args.data_dir)
    client = RidiClient(interval=args.interval)
    day = store.read("live", f"{date}.json", default=None) or {"date": date, "samples": [], "books": {}}
    sample = {"at": at, "ranks": {}}
    print(f"[실시간 랭킹] {date} {at}")
    for key, name, section, cats in main_groups():
        try:
            data = client.get_json(config.READING_URL, {"category_includes": cats, "limit": 50})
        except RidiError as e:
            print(f"  ✗ {name}: {e}")
            continue
        ids = []
        for it in ((data.get("data") or {}).get("items") or []):
            b = it.get("book") or {}
            s = b.get("serial") or {}
            bid = str(s.get("serial_id") or b.get("book_id") or "")
            if not bid:
                continue
            ids.append(bid)
            if bid not in day["books"]:
                day["books"][bid] = {"t": s.get("title") or b.get("title") or "",
                                     "a": [a.get("name") for a in (b.get("authors") or []) if a.get("name")][:3]}
        sample["ranks"][key] = ids
        print(f"  {name}: {len(ids)}위")
    day["samples"].append(sample)
    store.write(day, "live", f"{date}.json")
    print(f"저장: 오늘 {len(day['samples'])}번째 표본")
    return 0


if __name__ == "__main__":
    sys.exit(main())
