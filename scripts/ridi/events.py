"""이벤트 수집 (진행 중 + 종료된 것).

리디 이벤트 목록 API는 로그인 없이 열려 있다 (19금 이벤트도 목록에는 나옴).
다만 이벤트 상세페이지 안의 '이 이벤트에 포함된 작품 목록'은 로그인이 필요해서,
작품 ↔ 이벤트 연결은 반대 방향(작품 상세페이지)에서 details.py가 처리한다.

status 는 두 가지만 허용된다 (API가 알려준 값):
    ongoing    진행 중
    completed  종료됨

⚠️ 페이지 넘기기 주의:
   응답의 totalCount 는 믿을 수 없다 (종료 이벤트는 실제로 145건인데 72로 나옴).
   offset 을 limit 만큼씩 늘려가며 빈 페이지가 나올 때까지 받아야 전부 가져온다.
"""

from . import config
from .client import RidiError

PAGE_LIMIT = 100
MAX_PAGES = 12          # 안전장치 (한 장르에 1,200건 넘게 있을 리 없음)


def fetch_events(client, status="ongoing", verbose=True):
    """모든 장르의 이벤트를 모아서 중복 없이 돌려준다."""
    events = {}
    for genre in config.EVENT_GENRES:
        got = 0
        for page in range(MAX_PAGES):
            try:
                data = client.get_json(config.EVENTS_URL, {
                    "genres[0]": genre,
                    "status": status,
                    "platform": "web",
                    "limit": PAGE_LIMIT,
                    "offset": page * PAGE_LIMIT,
                })
            except RidiError as e:
                if verbose:
                    print(f"  [이벤트/{status}] {genre} 건너뜀 ({e})")
                break

            items = (data.get("data") or {}).get("items") or []
            if not items:
                break                      # 빈 페이지 = 끝
            got += len(items)

            for e in items:
                eid = str(e.get("id"))
                if eid in events:
                    if genre not in events[eid]["genres"]:
                        events[eid]["genres"].append(genre)
                    continue
                events[eid] = {
                    "id": eid,
                    "title": e.get("title") or "",
                    "description": (e.get("description") or "").strip(),
                    "start_date": e.get("startDate"),
                    "end_date": e.get("endDate"),
                    "banner": e.get("bannerImageUrl"),
                    "url": config.WEB_BASE + (e.get("link") or f"/event/{eid}"),
                    "type": e.get("type"),
                    "status": "ongoing" if status == "ongoing" else "ended",
                    "genres": [genre],
                }

        if verbose:
            print(f"  [이벤트/{status}] {genre:<26} {got:>4}건 · 누적 {len(events)}")

    return list(events.values())


def merge_ended(previous_ended, completed, ongoing_ids, last_ongoing, date):
    """종료 이벤트 보관함을 갱신한다.

    두 곳에서 모은다.
      1) 리디가 '종료'라고 알려준 것 (과거분)
      2) 어제까지 진행 중이었는데 오늘 목록에서 사라진 것 (우리가 매일 모은 기록)
    """
    by_id = {}
    for e in previous_ended:
        by_id[str(e["id"])] = dict(e)

    added_api, added_ours = 0, 0

    for e in completed:
        eid = str(e["id"])
        if eid in ongoing_ids:
            continue                       # 아직 진행 중이면 종료로 넣지 않는다
        prev = by_id.get(eid) or {}
        merged = dict(e)
        merged["status"] = "ended"
        merged["first_seen"] = prev.get("first_seen") or date
        merged["ended_seen"] = prev.get("ended_seen") or date
        if eid not in by_id:
            added_api += 1
        by_id[eid] = merged

    # 우리 기록: 어제 목록에 있었는데 오늘 사라진 것
    for e in last_ongoing:
        eid = str(e["id"])
        if eid in ongoing_ids or eid in by_id:
            continue
        merged = dict(e)
        merged["status"] = "ended"
        merged["first_seen"] = e.get("first_seen") or date
        merged["ended_seen"] = date
        merged["from_our_record"] = True
        by_id[eid] = merged
        added_ours += 1

    out = sorted(by_id.values(), key=lambda e: (e.get("end_date") or ""), reverse=True)
    return out, added_api, added_ours


def carry_first_seen(ongoing, last_ongoing, date):
    """진행 중 이벤트에 '언제부터 우리 기록에 보였는지'를 남긴다."""
    prev = {str(e["id"]): e.get("first_seen") for e in last_ongoing}
    for e in ongoing:
        e["first_seen"] = prev.get(str(e["id"])) or date
    return ongoing
