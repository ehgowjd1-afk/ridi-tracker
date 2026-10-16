#!/usr/bin/env python3
"""Node 수집기 대신 리디에 요청을 보내는 작은 도우미.

2026-10-14부터 리디(클라우드플레어)가 GitHub Actions의 Node fetch·curl 요청을 "Just a moment"(403)로
막는다. 파이썬 urllib 요청은 통과하므로, Node 스크립트는 이 파일을 자식 프로세스로 띄워 요청한다
(scripts/pyfetch.cjs). 표준입력으로 {url, method, headers, body} JSON 하나를 받고,
표준출력으로 {status, headers, body} JSON 하나를 돌려준다. 네트워크 오류는 status 0 + error.
"""
import gzip
import json
import sys
import urllib.error
import urllib.request


def main():
    spec = json.loads(sys.stdin.read() or "{}")
    url = spec["url"]
    method = (spec.get("method") or "GET").upper()
    headers = dict(spec.get("headers") or {})
    body = spec.get("body")
    data = body.encode("utf-8") if isinstance(body, str) else None
    headers.setdefault("Accept-Encoding", "gzip")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    timeout = float(spec.get("timeout") or 60)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
            rh = {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        rh = {k.lower(): v for k, v in e.headers.items()}
    except Exception as e:  # 네트워크 오류 등
        sys.stdout.write(json.dumps({"status": 0, "error": str(e), "headers": {}, "body": ""}))
        return 0
    if rh.get("content-encoding") == "gzip":
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
    sys.stdout.write(json.dumps({"status": status, "headers": rh, "body": raw.decode("utf-8", errors="replace")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
