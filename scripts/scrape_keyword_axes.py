#!/usr/bin/env python3
"""리디 키워드파인더의 '키워드 분류(축)'를 긁어와 docs/data/keyword-axes.json 으로 저장.

리디는 장르·포맷(웹소설/웹툰)마다 키워드를 축으로 분류해 둔다.
  예) BL 웹툰/만화: 소재/관계 · 인물(공) · 인물(수) · 분위기/기타 · BL브랜드 · 만웹대여제
각 축의 키워드는 우리 태그 이름과 그대로 연결된다.

페이지(/keyword-finder/<genre>)의 __NEXT_DATA__ 안에
  props.pageProps.dehydratedState.queries → ["KeywordFinder",...] → data.keywordFinder
가 통째로 들어 있어 서버사이드 GET 한 번으로 모든 세트를 얻는다.

사용법:
  python scripts/scrape_keyword_axes.py            # 미리보기
  python scripts/scrape_keyword_axes.py --write     # 파일로 저장
"""

import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ridi.client import RidiClient  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")
KST = datetime.timezone(datetime.timedelta(hours=9))

# 우리가 추적하는 분류를 덮는 키워드파인더 장르들.
#   webnovel: romance(로맨스/로판) · fantasy(판타지) · bl(BL 소설 세트)
#   webtoon : comic(웹툰 세트) · bl(BL 웹툰/만화 세트)
GENRES = ["romance", "fantasy", "bl", "comic"]

_NEXT_RE = re.compile(
    r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL)


def fetch_genre(client, genre):
    html = client.get_text(f"https://ridibooks.com/keyword-finder/{genre}")
    m = _NEXT_RE.search(html)
    if not m:
        raise RuntimeError(f"{genre}: __NEXT_DATA__ 없음")
    data = json.loads(m.group(1))
    queries = (((data.get("props") or {}).get("pageProps") or {})
               .get("dehydratedState") or {}).get("queries") or []
    kf = None
    for q in queries:
        key = q.get("queryKey") or []
        if key and key[0] == "KeywordFinder":
            kf = ((q.get("state") or {}).get("data") or {}).get("keywordFinder")
            break
    if not kf:
        raise RuntimeError(f"{genre}: KeywordFinder 데이터 없음")

    sets = []
    for s in kf.get("sets") or []:
        axes = []
        for g in s.get("groups") or []:
            tags = []
            for k in g.get("keywords") or []:
                name = ((k.get("tag") or {}).get("name") or "").strip()
                if name:
                    tags.append(name)
            axes.append({"title": g.get("title"), "tags": tags})
        sets.append({"setId": s.get("id"), "title": s.get("title"), "axes": axes})
    return {"genre": kf.get("genre"), "title": kf.get("title"), "sets": sets}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    client = RidiClient()
    out = {"fetched": datetime.datetime.now(KST).strftime("%Y-%m-%d"), "genres": {}}
    for genre in GENRES:
        info = fetch_genre(client, genre)
        out["genres"][genre] = info
        print(f"[{genre}] {info['title']}")
        for s in info["sets"]:
            axisline = ", ".join(f"{a['title']}({len(a['tags'])})" for a in s["axes"])
            print(f"   set {s['setId']} «{s['title']}»: {axisline}")

    if args.write:
        os.makedirs(DATA_DIR, exist_ok=True)
        path = os.path.join(DATA_DIR, "keyword-axes.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"\n✓ 저장: {path}")
    else:
        print("\n미리보기입니다. 저장하려면 --write 를 붙이세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
