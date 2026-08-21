"""진행 중인 이벤트 수집.

리디 이벤트 목록 API는 로그인 없이 열려 있다 (19금 이벤트도 목록에는 나옴).
다만 이벤트 상세페이지 안의 '이 이벤트에 포함된 작품 목록'은 로그인이 필요해서,
작품 ↔ 이벤트 연결은 반대 방향(작품 상세페이지)에서 details.py가 처리한다.
"""

from . import config
from .client import RidiError


def fetch_events(client, verbose=True):
    """모든 장르의 진행 중 이벤트를 모아서 중복 없이 돌려준다."""
    events = {}
    for genre in config.EVENT_GENRES:
        offset = 0
        while True:
            try:
                data = client.get_json(config.EVENTS_URL, {
                    "genres[0]": genre,
                    "status": "ongoing",
                    "platform": "web",
                    "limit": 100,
                    "offset": offset,
                })
            except RidiError as e:
                if verbose:
                    print(f"  [이벤트] {genre} 건너뜀 ({e})")
                break

            payload = data.get("data") or {}
            items = payload.get("items") or []
            for e in items:
                eid = str(e.get("id"))
                if eid in events:
                    # 이미 본 이벤트면 장르만 추가
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
                    "genres": [genre],
                }

            total = payload.get("totalCount") or 0
            offset += len(items)
            if not items or offset >= total:
                break

        if verbose:
            print(f"  [이벤트] {genre:<26} 누적 {len(events)}건")

    return list(events.values())
