#!/usr/bin/env python3
"""daily/*.json 들을 근거로 history 파일을 처음부터 다시 만든다.

history(추이) 파일은 날짜를 중간에 끼워 넣는 편집을 반복하면 값이 어긋날 수 있다.
daily 파일들은 각 날짜의 '정답'이므로, 그걸로 추이를 통째로 재구성하면 확실하다.

  - 각 daily 의 rankings(전체 랭킹 = is_sub=False)에서 순위를 뽑는다.
  - 세부 장르에만 있는 작품도 최대 3키까지 함께 담는다 (collect.py와 같은 규칙).
  - rating 은 snapshots 의 r 값을 쓴다 (있을 때만).

사용법:
  python scripts/rebuild_history.py            # 미리보기
  python scripts/rebuild_history.py --write     # 실제로 history 다시 씀
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ridi.storage import Store  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")
MAX_SUB_KEYS = 3


def rank_map_for(daily):
    """하루치 daily → {작품ID: {랭킹키: 순위}} (collect.py 와 동일 규칙)."""
    tables = daily.get("rankings", {})
    rank_map = {}
    for key, t in tables.items():
        if t.get("is_sub"):
            continue
        for i, bid in enumerate(t.get("ids", [])):
            rank_map.setdefault(bid, {})[key] = i + 1
    in_main = set(rank_map)
    for key, t in tables.items():
        if not t.get("is_sub"):
            continue
        for i, bid in enumerate(t.get("ids", [])):
            if bid in in_main:
                continue
            slot = rank_map.setdefault(bid, {})
            if len(slot) < MAX_SUB_KEYS:
                slot[key] = i + 1
    return rank_map


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    store = Store(DATA_DIR)
    idx = store.read("index.json", default={}) or {}
    dates = sorted(idx.get("dates", []))
    if not dates:
        print("index.json 에 날짜가 없습니다.")
        return 1

    # 월별로 묶어 각각 재구성
    months = {}
    for d in dates:
        months.setdefault(d[:7], []).append(d)

    for month, mdates in months.items():
        hist = {"month": month, "days": [], "rank": {}, "rating": {}}
        for date in mdates:
            daily = store.read("daily", f"{date}.json", default=None)
            if not daily:
                continue
            slot = len(hist["days"])
            hist["days"].append(date)

            rmap = rank_map_for(daily)
            snaps = daily.get("snapshots", {})

            # 이번 날짜의 값들을 slot 위치에 채운다. 이전 작품들은 None 패딩.
            for bid, ranks in rmap.items():
                book = hist["rank"].setdefault(bid, {})
                for k, rank in ranks.items():
                    series = book.setdefault(k, [])
                    while len(series) < slot:
                        series.append(None)
                    series.append(rank)
            # rating
            for bid, snap in snaps.items():
                r = snap.get("r")
                if r is None:
                    continue
                series = hist["rating"].setdefault(bid, [])
                while len(series) < slot:
                    series.append(None)
                series.append(r)

        # 길이를 days 에 맞춰 뒤를 None 패딩 (그날 순위에 없던 작품)
        n = len(hist["days"])
        for book in hist["rank"].values():
            for series in book.values():
                while len(series) < n:
                    series.append(None)
        for series in hist["rating"].values():
            while len(series) < n:
                series.append(None)

        print(f"[{month}] {len(hist['days'])}일치, 추적 작품 {len(hist['rank'])}종")
        if args.write:
            store.write(hist, "history", f"{month}.json")

    if not args.write:
        print("\n미리보기입니다. 실제로 다시 쓰려면 --write 를 붙이세요.")
    else:
        print("\n✓ history 재구성 완료.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
