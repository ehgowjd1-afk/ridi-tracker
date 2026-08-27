#!/usr/bin/env python3
"""외부 자료(블로그 등)로 특정 날짜의 주간·월간 랭킹을 채워 넣는 일회성 도구.

⚠️ 왜 조심해서 만드는가
  - 우리 데이터는 '작품 ID' 기준인데 외부 자료는 '제목'뿐이다.
  - 같은 제목이 여러 ID로 존재한다 (연재본/e북/개정판/세트).
  - 잘못 고르면 엉뚱한 작품이 그날 순위에 박힌다.

그래서 이렇게 안전장치를 둔다.
  1. 후보를 좁힌다 — 그 랭킹의 앞뒤 날짜(있는 날)에 실제로 올랐던 작품만 대상.
  2. 여러 ID가 걸리면, 앞뒤 날짜에서 그 작품이 기록한 '최고 순위'가 높은 ID를 고른다
     (즉 그 랭킹의 주인공 버전을 고른다).
  3. 못 찾은 항목은 억지로 채우지 않고 그 자리를 비운다.
  4. 넣은 날에는 source="manual" 표시를 남겨, 우리가 직접 수집한 날과 구분한다.

사용법:
  python scripts/import_manual.py           # 무엇이 들어갈지 미리보기만
  python scripts/import_manual.py --write    # 실제로 daily 파일 만들고 추이에 반영
"""

import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ridi.storage import Store  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")

# ────────────────────────────────────────────────────────────────
# 채워 넣을 날짜와, 그 근거가 되는 외부 자료.
#   출처: arkleode 네이버 블로그 "[3] 리디 로맨스 (1-60위)" (사용자 제공, 2026-08-27 게시)
#   일간은 자료에 없음. 주간·월간만.
TARGET_DATE = "2026-08-27"
SOURCE = "arkleode 블로그 (2026-08-27), 사용자 확인"

# 근처의 '실제로 수집한' 날들 — 후보 풀과 ID 판정에 쓴다.
REFERENCE_DATES = ["2026-08-26", "2026-08-28"]

# 각 칸: (랭킹키, [1위 제목, 2위 제목, ...])
TABLES = {
    "1650-WEEKLY": [
        "하나의 더치", "첫 실패", "졸업은 해야지", "룰 브레이커(Rule Breaker)", "요망한 여름",
        "불량 짝사랑", "언더커버 브이로그", "없는 진심", "시대가 원하는 인재상", "어떤 사랑",
        "표시목", "언더커버 오피스", "욕망의 발로", "겨울은 열대어의 무늬를 모른다", "러브:제로(Love:Zero)",
        "브루탈 스캔들", "스위트 스폿(Sweet Spot)", "문란한 고백", "세 번의 밤", "망가진 모든 것의 사정",
        "더티 어프로치", "우리의 완벽한 악연", "순정과 과보호의 역학관계", "오차 범위", "여우짓 예시 좀",
        "연하의 연하", "아 템포, 데이지", "인투 더 섀도우(Into the shadow)", "그대 나의 지옥이 되어",
        "터치 유어 바디(Touch Your Body)", "한 명의 난초가 되기까지", "파멸의 낙원", "양의 언덕", "재혼 맞선",
        "사춘기", "타인의 타인의 타인", "어텀, 칠리!", "밤이 오지 않는 잠에", "후회의 끝자락", "피치핑크 #2791",
        "꽃은 미끼야", "신애", "이주", "숫것", "시절연애", "더 고스트(The Ghost)", "우리의 죄를 사하여",
        "산삼보다 더 귀한 신랑을 캤습니다", "메리 사이코", "가시 돋친 순애", "더 누드(The Nude)", "일탈 1995",
        "상사화", "제물이 될지어다", "첫사랑 따위 개나 줘", "하나의 더치 (15세 개정판)", "야행성 폭우",
        "류안", "핑커 퐁커 스토커", "청선재",
    ],
    "1650-MONTHLY": [
        "첫 실패", "러브:제로(Love:Zero)", "하나의 더치", "양의 언덕", "졸업은 해야지",
        "타인의 타인의 타인", "재혼 맞선", "사춘기", "야행성 폭우", "표시목",
        "꽃은 미끼야", "터치 유어 바디(Touch Your Body)", "들개는 포식하는 꿈을 꾼다", "류안", "시절연애",
        "숫것", "핑커 퐁커 스토커", "다잉 메시지", "문란한 고백", "상사화",
        "우리의 죄를 사하여", "개같은 아저씨", "신애", "메리 사이코", "산삼보다 더 귀한 신랑을 캤습니다",
        "잘못된 친구를 사귀면", "일탈 1995", "제물이 될지어다", "가전칠우쟁론기(家電七友爭論記)", "청선재",
        "더티 어프로치", "스위트 스폿(Sweet Spot)", "제철 맞은 로맨스", "연하의 연하", "시대가 원하는 인재상",
        "파멸의 낙원", "피치핑크 #2791", "리얼 페이크 러브", "더티 에어", "크래시게이트(Crashgate)",
        "크레이지 페어", "교란종(攪亂種)", "노하우 다이렉트", "닳고 달은 아저씨", "야행(夜行)",
        "음란한 좋은 선배", "XOXO, 미스 미니", "목화다방", "여우 덫", "불량 식품에 길들여지면",
    ],
    "1700-WEEKLY": [
        "이혼 절대 사수!", "상사도 밤에 쓰려면 없다", "불청객, 범", "열애영화", "멜팅 슈가(Melting Sugar)",
        "사채업자 집에 입주교사로 들어가면", "서울에서 남자애 하나가 내려왔다더라", "이주", "러브:제로(Love:Zero)", "결락",
        "인 더 미들", "국대 남친에게 매일 밤 혼나고 싶어!", "젖몸살을 끝내는 법 [삽화본]", "푹푹", "겨울 정원 (외전증보판)",
        "숫것", "[GL] 옆집 언니", "난잡한 정략결혼", "[GL] 십 분의 오", "늦은 더위",
        # 21~60위 (블로그 두·세 번째 이미지)
        "환불 불가 소꿉친구", "또라이 상사 사용법", "겨울, 서리", "한 명의 난초가 되기까지", "닳고 달은 아저씨",
        "불량 식품에 길들여지면", "핑커 퐁커 스토커", "럭-키 흥신소", "멜팅 닥터(Melting Doctor)", "제철 맞은 로맨스",
        "양의 언덕", "김우진의 여사친 걔", "스트레이트 플러시", "소꿉친구가 셋이면", "스플린(Spleen)",
        "폭군의 우울", "더 누드(The Nude)", "그 여름의 사정", "여름 올가미", "움켜쥐면 모래",
        "낭군 실종 사건", "개조심!(Cave Canem!)", "유휴시간", "네 번째 남편", "교란종(攪亂種)",
        "신애", "소꿉친구한테 헤어지자고 했더니 감금당함", "더티 너티 러브", "은밀한 작전(A Covert Operation)", "신구간(新舊間)",
        "메리 사이코", "냉궁에 핀 열락", "저주하고 싶은 대상이 있나요?", "어쩌다 오빠 친구와", "빨강",
        "일곱 계단을 올라서", "전소", "소꿉친구 갑을전복기", "모린은 출장 중",
    ],
    "1700-MONTHLY": [
        "양의 언덕", "러브:제로(Love:Zero)", "숫것", "김우진의 여사친 걔", "멜팅 슈가(Melting Sugar)",
        "더티 너티 러브", "어느 쓰레기통의 취향저격", "산삼보다 더 귀한 신랑을 캤습니다", "사내 반려식물 관리 지침서", "상사도 밤에 쓰려면 없다",
        "가시 돋친 순애", "교란종(攪亂種)", "모린은 출장 중", "신애", "한 명의 난초가 되기까지",
        "은애하는 이를 묻지 마소서", "우리의 죄를 사하여", "구멍가게 불법 의료원", "제물이 될지어다", "꽃은 미끼야",
        # 21~60위 (블로그 두·세 번째 이미지)
        "난잡한 정략결혼", "남편이 가출했다", "여우 사냥", "시절연애", "일탈 1995",
        "국대 남친에게 매일 밤 혼나고 싶어!", "더 홀(The Hole)", "은산", "스토커 관찰 일지", "미드나잇 스캔들",
        "꽃거지", "저주가 친절하고 소꿉친구가 맛있어요", "몽영(夢影)", "순종적 임신", "할 짓 다 해 놓고선",
        "엉망, 진창", "화상흔", "맴맴", "메리 사이코", "낭군 실종 사건",
        "우기", "청선재", "진혼가(鎭魂歌)", "파수", "안티체스(Antichess)",
        "상태 이상 캠퍼스 로맨스", "움켜쥐면 모래", "불철주야 : 밤낮을 가리지 아니함", "불량 식품에 길들여지면", "터치 유어 바디(Touch Your Body)",
        "꽃등", "엽차에 동동", "개같은 아저씨", "임신 교육", "천산에는 연꽃이 핀다",
        "외꺼풀이 되고 싶었다", "슈가 쇼크(Sugar shock)", "러브 어택 트리거", "더 누드(The Nude)", "나의 엔젤",
    ],
}

# 랭킹키 → 메타(이름·섹션·기간). daily 파일의 rankings 항목을 만들 때 쓴다.
KEY_META = {
    "1650-WEEKLY": ("로맨스 웹소설", "webnovel", "WEEKLY", 1650),
    "1650-MONTHLY": ("로맨스 웹소설", "webnovel", "MONTHLY", 1650),
    "1700-WEEKLY": ("로맨스 e북", "ebook", "WEEKLY", 1700),
    "1700-MONTHLY": ("로맨스 e북", "ebook", "MONTHLY", 1700),
}


def norm(s):
    return re.sub(r"[^가-힣A-Za-z0-9]", "", re.sub(r"[\(\[（].*?[\)\]）]", "", s or "")).lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="실제로 파일에 반영")
    ap.add_argument("--redo", action="store_true",
                    help="이미 넣은 그 날짜 기록을 지우고 다시 넣는다 (history에서도 제거)")
    args = ap.parse_args()

    store = Store(DATA_DIR)
    catalog = store.read("books.json", default={}) or {}

    # 제목(정규화) → 그 제목을 가진 ID들
    name_to_ids = {}
    for bid, c in catalog.items():
        name_to_ids.setdefault(norm(c.get("t")), []).append(bid)

    # 참조 날짜들의 각 랭킹: id → 순위
    ref = {}
    for d in REFERENCE_DATES:
        daily = store.read("daily", f"{d}.json", default=None)
        if daily:
            ref[d] = daily.get("rankings", {})

    def best_rank(key, bid):
        best = 9999
        for d in ref:
            ids = (ref[d].get(key) or {}).get("ids") or []
            if bid in ids:
                best = min(best, ids.index(bid) + 1)
        return best

    resolved_tables = {}
    report = []
    for key, titles in TABLES.items():
        # 후보 풀: 참조 날짜들에서 이 랭킹에 실제로 오른 작품
        pool = set()
        for d in ref:
            pool.update((ref[d].get(key) or {}).get("ids") or [])

        ids, misses, dups = [], [], []
        for i, title in enumerate(titles):
            cands = [b for b in name_to_ids.get(norm(title), []) if b in pool]
            if not cands:
                # 풀에 없으면 카탈로그 전체에서라도 (단, 유일할 때만)
                whole = name_to_ids.get(norm(title), [])
                if len(whole) == 1:
                    cands = whole
            if not cands:
                ids.append(None)
                misses.append(f"{i+1}위 «{title}»")
                continue
            cands.sort(key=lambda b: best_rank(key, b))
            ids.append(cands[0])
            if len(cands) > 1:
                dups.append(f"{i+1}위 «{title}» {len(cands)}개 후보 → {cands[0]}")

        resolved_tables[key] = ids
        found = sum(1 for x in ids if x)
        report.append(f"[{key}] {KEY_META[key][0]} {KEY_META[key][2]}: {found}/{len(titles)} 매칭"
                      + (f", 못찾음 {len(misses)}" if misses else ""))
        for m in misses:
            report.append(f"    · {m}")

    print("=" * 60)
    print(f"  {TARGET_DATE} 외부 자료 반영 {'(실제 기록)' if args.write else '(미리보기)'}")
    print(f"  출처: {SOURCE}")
    print("=" * 60)
    print("\n".join(report))

    if not args.write:
        print("\n미리보기입니다. 실제로 넣으려면 --write 를 붙이세요.")
        return 0

    # daily 파일 만들기 (순위만, source 표시 포함). None(못찾음)은 자리에서 제외.
    rankings = {}
    for key, ids in resolved_tables.items():
        name, section, period, cat_id = KEY_META[key]
        clean = [x for x in ids if x]
        rankings[key] = {
            "name": name, "group": name, "section": section, "period": period,
            "category_id": cat_id, "is_sub": False, "ids": clean,
        }

    existing = store.read("daily", f"{TARGET_DATE}.json", default=None)
    if existing and existing.get("rankings"):
        if not args.redo:
            print(f"\n이미 {TARGET_DATE} 파일이 있습니다. 다시 넣으려면 --redo 를 붙이세요.")
            return 1
        if existing.get("source") != "manual":
            print(f"\n⚠️ {TARGET_DATE} 는 우리가 직접 수집한 날입니다. 덮어쓰지 않습니다. 중단.")
            return 1
        print(f"기존 {TARGET_DATE}(manual) 기록을 지우고 다시 넣습니다.")
        remove_from_history(store, TARGET_DATE)

    store.write({
        "date": TARGET_DATE,
        "collected_at": TARGET_DATE + "T00:00:00+09:00",
        "source": "manual",
        "source_note": SOURCE,
        "rankings": rankings,
        "snapshots": {},
    }, "daily", f"{TARGET_DATE}.json")

    # 추이(history)에도 이 날의 순위를 끼워 넣는다 (날짜 순서에 맞는 자리에)
    rank_map = {}
    for key, r in rankings.items():
        for i, bid in enumerate(r["ids"]):
            rank_map.setdefault(bid, {})[key] = i + 1
    inject_history(store, TARGET_DATE, rank_map)

    # index.json 의 날짜 목록에 추가
    idx = store.read("index.json", default={}) or {}
    dates = idx.get("dates", [])
    if TARGET_DATE not in dates:
        dates.append(TARGET_DATE)
        dates.sort()
        idx["dates"] = dates
        store.write(idx, "index.json", pretty=True)

    print(f"\n✓ {TARGET_DATE} 저장 완료 (source=manual). 추이·날짜목록에도 반영.")
    return 0


def remove_from_history(store, date):
    """history에서 특정 날짜 칸을 뺀다 (--redo 로 다시 넣기 전에)."""
    month = date[:7]
    hist = store.read("history", f"{month}.json", default=None)
    if not hist or date not in hist["days"]:
        return
    pos = hist["days"].index(date)
    hist["days"].pop(pos)
    for bid, keymap in hist["rank"].items():
        for k, series in keymap.items():
            if pos < len(series):
                series.pop(pos)
    for bid, series in hist["rating"].items():
        if pos < len(series):
            series.pop(pos)
    store.write(hist, "history", f"{month}.json")


def inject_history(store, date, rank_map):
    """이미 만들어진 그 달 history 파일의 올바른 자리에 이 날짜 순위를 끼워 넣는다.

    history 구조:
        {"days":[...], "rank":{작품ID:{랭킹키:[값]}}, "rating":{작품ID:[값]}}
    각 값 배열은 days 순서에 맞춰 있다. 날짜를 중간에 넣으려면, 모든 배열의
    같은 위치(pos)에 칸을 하나씩 삽입해야 한다. 그러지 않으면 이후 날짜들이
    하루씩 밀려 완전히 어긋난다.
    """
    month = date[:7]
    hist = store.read("history", f"{month}.json", default=None)
    if not hist:
        print("  (history 파일이 없어 추이 반영은 건너뜀)")
        return
    days = hist["days"]
    if date in days:
        print(f"  (history에 이미 {date} 있음, 추이 반영 건너뜀)")
        return

    old_days = list(days)
    new_days = sorted(old_days + [date])
    pos = new_days.index(date)
    hist["days"] = new_days

    def pad(series, length):
        while len(series) < length:
            series.append(None)

    # 1) rank: {작품ID: {랭킹키: [값]}}
    for bid, keymap in hist["rank"].items():
        this = rank_map.get(bid, {})
        for k, series in keymap.items():
            pad(series, len(old_days))
            series.insert(pos, this.get(k))     # 이 작품이 그날 이 랭킹에 없었으면 None
    # 새로 등장한 작품(기존 history에 없던)도 추가
    for bid, this in rank_map.items():
        km = hist["rank"].setdefault(bid, {})
        for k, rank in this.items():
            if k not in km:
                km[k] = [None] * len(new_days)
            km[k][pos] = rank

    # 2) rating: 이 날짜는 별점 자료가 없으므로 전부 None 칸만 삽입
    for bid, series in hist["rating"].items():
        pad(series, len(old_days))
        series.insert(pos, None)

    store.write(hist, "history", f"{month}.json")
    print(f"  추이(history)의 {pos+1}번째 자리에 {date} 삽입 완료")


if __name__ == "__main__":
    sys.exit(main())
