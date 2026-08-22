"""리디 서버에 요청을 보내는 부분.

- 요청 사이에 반드시 쉬는 시간을 둔다 (서버에 부담 주지 않기 위해)
- 실패하면 몇 번 다시 시도한다
- 표준 라이브러리만 사용 (설치할 것 없음)
"""

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config


class RidiClient:
    def __init__(self, interval=None, verbose=True):
        self.interval = config.REQUEST_INTERVAL_SEC if interval is None else interval
        self.page_interval = max(self.interval, config.PAGE_INTERVAL_SEC)
        self.verbose = verbose
        self._last_request_at = 0.0
        self.request_count = 0
        self.rate_limit_hits = 0          # 오늘 429를 몇 번 만났는지

    # ------------------------------------------------------------ 내부 도구
    def _wait(self, interval):
        elapsed = time.time() - self._last_request_at
        if elapsed < interval:
            time.sleep(interval - elapsed)
        self._last_request_at = time.time()

    def _open(self, req, interval=None):
        gap = self.interval if interval is None else interval
        last_error = None
        for attempt in range(1, config.MAX_RETRIES + 1):
            self._wait(gap)
            try:
                with urllib.request.urlopen(req, timeout=config.REQUEST_TIMEOUT_SEC) as resp:
                    raw = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.decompress(raw)
                    self.request_count += 1
                    return raw.decode("utf-8", errors="replace")
            except urllib.error.HTTPError as e:
                # 400/404는 다시 시도해도 똑같으므로 바로 포기
                if e.code in (400, 404):
                    body = e.read().decode("utf-8", errors="replace")[:200]
                    raise RidiError(f"HTTP {e.code}: {body}") from e
                # 429는 "너무 빠르다"는 뜻. 짧게 여러 번 조르지 말고 길게 한 번만 쉰다.
                if e.code == 429:
                    self.rate_limit_hits += 1
                    if attempt >= 2:
                        raise RateLimited("리디가 요청을 막았습니다 (429)") from e
                    if self.verbose:
                        print(f"    429 — {config.RATE_LIMIT_WAIT_SEC:.0f}초 쉬었다 다시 시도")
                    time.sleep(config.RATE_LIMIT_WAIT_SEC)
                    continue
                last_error = e
            except Exception as e:  # 네트워크 오류 등
                last_error = e
            if attempt < config.MAX_RETRIES:
                wait = config.RETRY_BACKOFF_SEC * attempt
                if self.verbose:
                    print(f"    재시도 {attempt}/{config.MAX_RETRIES} ({last_error}) — {wait:.0f}초 대기")
                time.sleep(wait)
        raise RidiError(f"요청 실패: {last_error}")

    def _headers(self, extra=None):
        h = {
            "User-Agent": config.USER_AGENT,
            "Accept-Language": "ko-KR,ko;q=0.9",
            "Accept-Encoding": "gzip",
        }
        if extra:
            h.update(extra)
        return h

    # ------------------------------------------------------------ 공개 메서드
    def get_json(self, url, params=None):
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers=self._headers({"Accept": "application/json"}))
        return json.loads(self._open(req))

    def get_text(self, url):
        """상세페이지 같은 무거운 HTML. API보다 간격을 더 두고 받아온다."""
        req = urllib.request.Request(url, headers=self._headers({
            "Accept": "text/html,application/xhtml+xml",
        }))
        return self._open(req, interval=self.page_interval)

    def post_graphql(self, query, variables):
        body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        req = urllib.request.Request(
            config.GRAPHQL_URL,
            data=body,
            headers=self._headers({
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": config.WEB_BASE,
                "Referer": config.WEB_BASE + "/",
            }),
            method="POST",
        )
        return json.loads(self._open(req))


class RidiError(Exception):
    pass


class RateLimited(RidiError):
    """리디가 '요청이 너무 많다'(429)고 막은 경우."""
    pass
