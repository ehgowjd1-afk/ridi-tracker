/* 회차별 댓글 수 — 트래커 순위에 나온 모든 웹툰 (AI 안 씀, 무료)
 *
 * 작품마다 docs/data/cmt_counts/<id>.json 에 회차별 댓글 수를 모은다. 숫자만 저장(댓글 내용·아이디 없음).
 *   eps: [[회차 id, 화 번호(없으면 null), 공개 시각, 지금까지 댓글 수, 센 시각, [[공개 후 시간, 댓글 수], ...] | null]]
 *   - '지금까지 댓글 수'는 회차 댓글 수 API 한 번으로 센다(회차마다 요청 1번).
 *   - 새 회차는 공개 후 약 1·3·7·30일째에 댓글 수를 남겨(snaps) 같은 시점끼리 비교할 수 있게 한다.
 *     (지난 회차는 '센 때까지의 전체 수'라, 화면은 30일 지난 회차끼리만 전체 수로 비교하고 최근 회차는 3·7일째 값끼리 비교)
 * 매일 정해진 시간(--minutes) 안에서 이 순서로 일한다:
 *   ① 이미 다 센 연재 중 작품(또는 순위 파일의 회차 수가 늘어난 작품): 새 회차 확인(회차 목록 1번) + 최근 회차 1·3·7·30일째 댓글 수
 *   ② 아직 다 못 센 작품: 순위 높은 작품부터 전 회차 댓글 수 (중간에 끊기면 다음 날 이어서)
 *   ③ 오래된 작품: 마지막으로 센 지 --refresh-days 지나면 다시 셈(완결작은 거의 안 바뀜)
 * 리디 부담: 요청 사이 2초(ridi_comments.mjs), 429가 3번이면 멈춤.
 *
 *   node scripts/cmt/cmt_counts.mjs [--minutes 90] [--refresh-days 60] [--only id,id] [--summary FILE]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import * as R from "./ridi_comments.mjs";

const DIR = "docs/data/cmt_counts";
const INDEX = DIR + "/_index.json";
const args = { minutes: 90, refreshDays: 60, only: null, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--minutes") args.minutes = Number(v());
  else if (k === "--refresh-days") args.refreshDays = Number(v());
  else if (k === "--only") args.only = v().split(",").map((s) => s.trim()).filter((s) => /^\d{5,12}$/.test(s));
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["minutes", "refreshDays"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);

const T0 = Date.now();
const HOUR = 3600e3, DAY = 24 * HOUR;
const timeLeft = () => args.minutes * 60e3 - (Date.now() - T0);
const SNAP_H = [24, 72, 168, 720];     // 공개 후 이 시간이 지나면 한 번씩 댓글 수를 남긴다(1·3·7·30일)
const LIVE_H = 30 * 24;                // 이 기간 안의 회차만 '최근 회차'로 따로 센다
const ACTIVE_DAYS = 45;                // 마지막 회차가 이 기간 안이면 '연재 중'
const log = (...a) => console.log(...a);
const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return d; } };
const iso = (t) => new Date(t).toISOString();

// ---- 대상: 순위에 나온 웹툰 전부, 순위 높은 순 (웹툰·BL웹툰 본 분류를 세부 장르보다 먼저)
function universe() {
  const latest = readJSON("docs/data/latest.json", { rankings: {}, books: {} });
  const best = new Map();
  for (const [key, r] of Object.entries(latest.rankings || {})) {
    if (r.section !== "webtoon") continue;
    const main = !r.is_sub;
    (r.ids || []).forEach((id, i) => {
      const score = (main ? 0 : 1000) + i;   // 본 분류 순위가 먼저
      if (!best.has(id) || score < best.get(id)) best.set(id, score);
    });
  }
  const ids = [...best.keys()].sort((a, b) => best.get(a) - best.get(b));
  const title = (id) => { const b = (latest.books || {})[id] || {}; return b.title || b.t || ""; };
  const epCount = (id) => Number(((latest.books || {})[id] || {}).ep) || 0;
  return { ids, title, epCount };
}

const index = readJSON(INDEX, { updated_at: null, works: {} });
mkdirSync(DIR, { recursive: true });
const stat = { listed: 0, counted: 0, newEps: 0, snaps: 0, backfilled: 0, refreshed: 0, partial: 0, errors: 0 };

function load(id) { return readJSON(`${DIR}/${id}.json`, null); }
function save(w) {
  writeFileSync(`${DIR}/${w.id}.json`, JSON.stringify(w));
  const last = w.eps.filter((e) => e[2]).map((e) => e[2]).sort().at(-1) || null;
  index.works[w.id] = { at: w.at, done: w.done, last, n: w.eps.length };
}

// 회차 목록을 받아 파일과 합친다 (새 회차 추가, 사라진 회차는 그대로 둠)
async function syncList(id, title, w) {
  const s = await R.fetchSeries(id);
  stat.listed++;
  w ||= { id, t: title, at: null, done: false, eps: [] };
  delete w.none;
  if (title) w.t = title;
  const have = new Map(w.eps.map((e) => [e[0], e]));
  for (const e of s.episodes) {
    if (have.has(e.id)) { const x = have.get(e.id); x[1] = e.no; x[2] = e.reg; continue; }
    const row = [e.id, e.no, e.reg, null, null, null];
    w.eps.push(row); have.set(e.id, row);
    if (w.done) stat.newEps++;
  }
  // 공개 순서대로
  const order = new Map(s.episodes.map((e, i) => [e.id, i]));
  w.eps.sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9));
  return w;
}

async function countEp(row) {
  const n = await R.fetchCount(row[0]);
  stat.counted++;
  const now = Date.now();
  row[3] = n; row[4] = iso(now);
  // 최근 회차면 공개 후 시간과 함께 남긴다(같은 시점끼리 비교용)
  const age = (now - Date.parse(row[2])) / HOUR;
  if (row[2] && age <= LIVE_H + 48) {
    row[5] ||= [];
    row[5].push([Math.round(age), n]);
    stat.snaps++;
  }
}

// 최근 회차 중 아직 1·3·7·30일째 값이 없는 것
function snapDue(row, now) {
  if (!row[2]) return false;
  const age = (now - Date.parse(row[2])) / HOUR;
  if (age > LIVE_H + 48 || age < 0) return false;
  const have = (row[5] || []).map((s) => s[0]);
  return SNAP_H.some((h) => age >= h && !have.some((a) => a >= h && a < h + 48));
}

let blocked = false;
async function guard(fn, id) {
  try { await fn(); return true; }
  catch (e) {
    if (e instanceof R.RidiBlocked) { blocked = true; log("리디가 요청을 막아 멈춥니다"); return false; }
    // 연재 회차가 없는 작품은 다 센 것으로 두어 매일 다시 묻지 않는다
    //   단 이미 기록이 있으면 지우지 않는다(리디가 잠깐 성인 인증·점검 페이지를 줄 수 있음) — 오류로만 세고 다음에 다시
    if (e instanceof R.NoEpisodes) {
      const old = load(id);
      if (old && old.eps && old.eps.length) { stat.errors++; log(`  회차 목록 못 읽음(기존 기록 유지) ${id}: ${e.message}`); return false; }
      save({ id, t: "", at: iso(Date.now()), done: true, none: true, eps: [] }); stat.none = (stat.none || 0) + 1; return true;
    }
    stat.errors++; log(`  오류 ${id}: ${e.message}`); return false;
  }
}

try {
  const { ids: all, title, epCount } = universe();
  const ids = args.only || all;
  log(`대상 웹툰 ${ids.length}개 (순위에 나온 웹툰 전부) · 이미 다 센 작품 ${Object.values(index.works).filter((x) => x.done).length}개 · 시간 ${args.minutes}분`);
  const now = Date.now();

  // ① 연재 중인 작품: 새 회차 확인 + 최근 회차 댓글 수
  const active = ids.filter((id) => {
    const x = index.works[id];
    if (!x || !x.done || (x.at && now - Date.parse(x.at) <= 20 * HOUR)) return false;
    const recent = x.last && now - Date.parse(x.last) < ACTIVE_DAYS * DAY;
    const grew = x.n > 0 && epCount(id) > x.n;   // 휴재·시즌 휴식 뒤 복귀: 순위 파일의 회차 수가 늘었음
    return recent || grew;
  });
  log(`① 연재 중 확인 ${active.length}개`);
  for (const id of active) {
    if (blocked || timeLeft() < 5 * 60e3) break;
    let w = load(id);
    await guard(async () => {
      w = await syncList(id, title(id), w);
      const t = Date.now();
      for (const row of w.eps) {
        if (row[3] == null || snapDue(row, t)) await countEp(row);
      }
      w.at = iso(Date.now());
      save(w);
    }, id);
  }

  // ② 아직 다 못 센 작품: 순위 높은 순으로 전 회차
  const todo = ids.filter((id) => !(index.works[id] && index.works[id].done));
  log(`② 아직 다 못 센 작품 ${todo.length}개`);
  for (const id of todo) {
    if (blocked || timeLeft() < 3 * 60e3) break;
    let w = load(id);
    const ok = await guard(async () => {
      w = await syncList(id, title(id), w);
      for (const row of w.eps) {
        if (timeLeft() < 2 * 60e3) break;
        if (row[3] == null) await countEp(row);
      }
      w.done = w.eps.every((e) => e[3] != null);
      w.at = iso(Date.now());
      save(w);
      if (w.done) stat.backfilled++; else stat.partial++;
    }, id);
    if (!ok && w) save(w);
  }

  // ③ 오래 안 센 작품 다시 세기 (완결작 등)
  const stale = ids.filter((id) => { const x = index.works[id]; return x && x.done && x.at && now - Date.parse(x.at) > args.refreshDays * DAY; });
  log(`③ 다시 셀 작품 ${stale.length}개`);
  for (const id of stale) {
    if (blocked || timeLeft() < 3 * 60e3) break;
    let w = load(id);
    await guard(async () => {
      w = await syncList(id, title(id), w);
      const since = Date.now() - args.refreshDays * DAY;   // 이번 차례에 이미 다시 센 회차는 건너뜀(이어서 세기)
      let full = true;
      for (const row of w.eps) {
        if (row[3] != null && row[4] && Date.parse(row[4]) > since) continue;
        if (timeLeft() < 2 * 60e3) { full = false; break; }
        await countEp(row);
      }
      if (full) { w.at = iso(Date.now()); stat.refreshed++; }
      save(w);
    }, id);
  }
} finally {
  index.updated_at = iso(Date.now());
  writeFileSync(INDEX, JSON.stringify(index));
  const done = Object.values(index.works).filter((x) => x.done).length;
  const lines = [`## 회차별 댓글 수 (모든 웹툰)`, `- 리디 요청 ${R.requests}번, ${Math.round((Date.now() - T0) / 60e3)}분`,
    `- 회차 목록 ${stat.listed}번, 댓글 수 ${stat.counted}번 (새 회차 ${stat.newEps}개, 1·3·7·30일째 기록 ${stat.snaps}개)`,
    `- 새로 다 센 작품 ${stat.backfilled}개, 이어서 셀 작품 ${stat.partial}개, 다시 센 작품 ${stat.refreshed}개 · 다 센 작품 합계 ${done}개`,
    ...(stat.errors ? [`- 오류 ${stat.errors}개`] : []), ...(blocked ? ["- 리디가 요청을 막아 일찍 멈춤"] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
