/* 리디 요청을 파이썬(urllib)으로 보내는 fetch 대용.
 *
 * 2026-10-14부터 리디(클라우드플레어)가 GitHub Actions의 Node fetch·curl 을 403("Just a moment")으로 막는다.
 * 파이썬 urllib 은 통과하므로, 요청마다 scripts/pyfetch/ridi_fetch.py 를 자식 프로세스로 띄워 대신 보낸다.
 * (요청 사이에 2초 넘게 쉬므로 프로세스 띄우는 비용은 문제가 안 된다)
 *
 * 쓰는 법: const { pyFetch } = require("../pyfetch.cjs");  또는  import { pyFetch } from "../pyfetch.cjs";
 *   const res = await pyFetch(url, { method, headers, body });   // fetch 와 같은 모양의 작은 응답 객체
 *   res.status, res.ok, await res.text(), await res.json(), res.headers.get("content-type")
 * 파이썬이 없으면(로컬 등) PYFETCH=0 으로 끄면 보통 fetch 를 쓴다.
 */
const { execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "pyfetch", "ridi_fetch.py");
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const OFF = process.env.PYFETCH === "0";

function run(spec) {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, ["-I", SCRIPT], { maxBuffer: 64 * 1024 * 1024, timeout: (spec.timeout || 60) * 1000 + 15000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error("pyfetch: " + (stderr || err.message).trim().slice(0, 300)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("pyfetch: 응답을 읽지 못함 " + String(stdout).slice(0, 120))); }
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(spec));
  });
}

async function pyFetch(url, init) {
  init = init || {};
  if (OFF) return fetch(url, init);
  const spec = { url, method: init.method || "GET", headers: init.headers || {}, body: typeof init.body === "string" ? init.body : (init.body ? String(init.body) : null) };
  const r = await run(spec);
  if (!r.status) throw new Error(r.error || "요청 실패");
  const headers = r.headers || {};
  return {
    status: r.status, ok: r.status >= 200 && r.status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => r.body || "",
    json: async () => JSON.parse(r.body || "null"),
  };
}

module.exports = { pyFetch };
