"""'전체 + 하위' 카테고리 ID 묶음 — 신작(first-releases)·실시간 랭킹(reading-books) API용.

이 두 API는 베스트셀러 API와 달리 부모 ID 하나만 넣으면 빈 목록을 준다.
리디 화면이 쓰는 대로 부모와 하위 ID를 전부 콤마로 넣어야 한다(2026-10-18 확인).
"""

from . import config

# BL 웹툰은 트리에 하위가 없지만 리디 화면은 4250,4251 을 같이 보낸다.
_EXTRA_CHILDREN = {4250: [4251]}


def main_groups():
    """[(키, 이름, 섹션, 'id,id,…'), …] — 섹션별 '전체'(웹소설·E북·웹툰)와 11개 대분류."""
    out = []
    per_section = {}
    for section, info in config.CATEGORY_TREE.items():
        ids_all = []
        for gid, gname, children in info["groups"]:
            ids = [gid] + [c[0] for c in children] + _EXTRA_CHILDREN.get(gid, [])
            ids_all.extend(ids)
            out.append((str(gid), gname, section, ",".join(str(i) for i in ids)))
        per_section[section] = ids_all
    # 섹션 전체 (웹소설·E북은 config.ALL_GROUPS 의 ID를 키로, 웹툰은 1600 하나라 생략)
    for section, (all_id, all_name, _) in config.ALL_GROUPS.items():
        out.insert(0, (str(all_id), all_name, section, ",".join(str(i) for i in per_section[section])))
    return out
