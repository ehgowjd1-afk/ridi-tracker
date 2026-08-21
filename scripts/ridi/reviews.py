"""독자 리뷰 수집.

리디 리뷰는 GraphQL로 로그인 없이 읽을 수 있다.
필요한 것: 작품 상세페이지에서 얻은 리뷰 셀 ID(UUID) + book_id.
"""

from . import config
from .client import RidiError

REVIEW_QUERY = """
query BookDetailHomeReviewsPagination($id: UUID!, $context: BookDetailHomeReviewCellContext!) {
  riGrid {
    cells {
      bookDetailHome {
        reviewCell(id: $id, context: $context) {
          cell {
            reviews {
              userIdx
              userId
              rating
              ratingId
              likeVoteCnt
              isBuyer
              status
              timestamp
              content
            }
            pagination {
              ... on PageLimitOutput {
                hasMore
                offset
                input { page limit }
              }
            }
          }
        }
      }
    }
  }
}
"""


def fetch_reviews(client, book_id, review_cell_id, max_reviews=None, page_size=50):
    """한 작품의 리뷰를 최신순으로 가져온다.

    한 번에 최대 100건까지 받을 수 있어서, 기본값 50이면 요청 한 번으로 끝난다.
    """
    if not review_cell_id:
        return []
    limit_total = max_reviews or config.REVIEWS_PER_BOOK

    collected = []
    page = 1
    while len(collected) < limit_total:
        variables = {
            "id": review_cell_id,
            "context": {
                "bookId": str(book_id),
                "buyerOnly": False,   # 구매자 외 리뷰도 포함
                "order": "RECENT",
                "pageLimitInput": {"limit": page_size, "page": page},
            },
        }
        try:
            data = client.post_graphql(REVIEW_QUERY, variables)
        except RidiError:
            break

        if data.get("errors"):
            break
        cell = (((((data.get("data") or {}).get("riGrid") or {}).get("cells") or {})
                 .get("bookDetailHome") or {}).get("reviewCell") or {}).get("cell") or {}
        batch = cell.get("reviews") or []
        if not batch:
            break

        for r in batch:
            if r.get("status") != "VISIBLE":
                continue
            collected.append({
                "id": r.get("ratingId"),
                "user": r.get("userId"),
                "rating": r.get("rating"),
                "content": (r.get("content") or "").strip(),
                "at": r.get("timestamp"),
                "likes": r.get("likeVoteCnt") or 0,
                "buyer": bool(r.get("isBuyer")),
            })

        if not (cell.get("pagination") or {}).get("hasMore"):
            break
        page += 1

    return collected[:limit_total]


def merge_reviews(existing, fresh):
    """기존에 모아둔 리뷰와 새로 받은 리뷰를 합친다 (덮어쓰지 않고 누적)."""
    by_id = {str(r["id"]): r for r in existing if r.get("id") is not None}
    added = 0
    for r in fresh:
        rid = str(r.get("id"))
        if rid not in by_id:
            added += 1
        by_id[rid] = r
    merged = sorted(by_id.values(), key=lambda r: (r.get("at") or ""), reverse=True)
    return merged, added
