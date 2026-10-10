/* 회차 댓글 분석 — 숫자 판정 (AI 결과를 받은 뒤 다시 계산할 수 있게 따로 둠)
 * [터짐][대박][논쟁][댓글 급증][이탈 경고][니즈 누적][니즈 폭발][핵심 니즈]
 */
import { CFG } from "./cmt_config.mjs";

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function judge(w) {
  const num = w.episodes.filter((e) => e.no != null);
  for (const e of num) { delete e.needRun; delete e.needBurst; }
  const an = num.filter((e) => e.analyzed);
  for (const e of an) {
    const cs = w.sample.filter((c) => c.ep === e.id && c.lab);
    const cnt = (f) => cs.filter(f).length;
    const needs = {};
    for (const c of cs) for (const d of c.lab.nd) {
      needs[d] ||= { met: 0, lack: 0, ask: 0, split: 0 };
      if (needs[d][c.lab.st] != null) needs[d][c.lab.st]++;
    }
    const by = (key) => cs.reduce((o, c) => ((o[c.lab[key]] = (o[c.lab[key]] || 0) + 1), o), {});
    e.ai = { n: cs.length, ty: by("ty"), ax: by("ax"), ev: by("ev"), needs,
      churn: cnt((c) => c.lab.ac === "churn"), pay: cnt((c) => c.lab.ac === "pay"), stay: cnt((c) => c.lab.ac === "stay"), share: cnt((c) => c.lab.ac === "share"),
      long: cnt((c) => c.lab.rd === "long"), lo: cnt((c) => c.lab.cf === "lo") };
    const sh = (k) => (e.ai.n ? (e.ai.ty[k] || 0) / e.ai.n : 0);
    e.ai.cheerShare = Math.round(sh("cheer") * 100) / 100;
    e.ai.complainShare = Math.round(sh("complain") * 100) / 100;
    e.ai.churnShare = e.ai.n ? Math.round((e.ai.churn / e.ai.n) * 100) / 100 : 0;
  }
  // 댓글 수 판정 (분석 안 한 회차는 숫자만 → '댓글 급증')
  num.forEach((e, i) => {
    e.flags = [];
    const up = e.ratio != null && e.ratio >= CFG.boom;
    if (e.analyzed && e.ai && e.ai.n) {
      const prevA = an.filter((x) => x.ai && x.ai.n && num.indexOf(x) < i).slice(-CFG.baseEps);
      const prevCheer = prevA.length ? avg(prevA.map((x) => x.ai.cheerShare)) : null;
      if (up && e.ai.cheerShare >= CFG.controversyShare && e.ai.complainShare >= CFG.controversyShare) e.flags.push("논쟁");
      else if (up && (prevCheer == null || e.ai.cheerShare > prevCheer)) e.flags.push(e.ratio >= CFG.big ? "대박" : "터짐");
      else if (up) e.flags.push("댓글 급증");
      const prevChurn = prevA.length ? avg(prevA.map((x) => x.ai.churnShare)) : null;
      if (prevChurn != null && e.ai.churn >= CFG.churnMin && e.ai.churnShare >= CFG.churnX * Math.max(prevChurn, 0.02)) e.flags.push("이탈 경고(댓글)");
    } else if (up) e.flags.push("댓글 급증");
    const run = num.slice(Math.max(0, i - CFG.dropRun + 1), i + 1);
    if (run.length === CFG.dropRun && run.every((x) => x.ratio != null && x.ratio <= CFG.drop)) e.flags.push("이탈 경고");
  });
  // 니즈 누적 → 니즈 폭발
  const codes = new Set(an.flatMap((e) => Object.keys((e.ai && e.ai.needs) || {})));
  w.needStats = {};
  for (const d of codes) {
    let run = 0, built = false;
    const st = { met: 0, lack: 0, ask: 0, split: 0, likes: 0, eps: [], pay: 0, askBeforeBurst: 0, burstRatios: [] };
    for (const e of an) {
      const x = (e.ai && e.ai.needs[d]) || { met: 0, lack: 0, ask: 0, split: 0 };
      const want = x.ask + x.lack;
      const wasBuilt = built;   // 폭발은 '앞 회차들에서 이미 쌓인' 니즈가 이 화에서 채워질 때만
      run = want >= CFG.needMin ? run + 1 : 0;
      if (run >= CFG.needRun) { built = true; if (!e.flags.includes("니즈 누적")) e.flags.push("니즈 누적"); (e.needRun ||= []).push(d); }
      if (wasBuilt && x.met >= CFG.burstMin) {
        const core = e.flags.some((f) => f === "터짐" || f === "대박");
        e.flags.push(core ? "핵심 니즈" : "니즈 폭발");
        (e.needBurst ||= []).push(d);
        st.burstRatios.push(e.ratio);
        built = false; run = 0;
      } else if (!st.burstRatios.length) st.askBeforeBurst += want;
      for (const k of ["met", "lack", "ask", "split"]) st[k] += x[k];
      if (x.met + x.lack + x.ask + x.split) st.eps.push(e.no);
    }
    const rel = w.sample.filter((c) => c.lab && c.lab.nd.includes(d));
    st.likes = rel.reduce((t, c) => t + c.like, 0);
    st.pay = rel.filter((c) => c.lab.ac === "pay").length;
    w.needStats[d] = st;
  }
  w.newNeeds = {};
  for (const c of w.sample) if (c.lab && c.lab.nn) {
    const k = c.lab.nn;
    w.newNeeds[k] ||= { count: 0, likes: 0, eps: [] };
    w.newNeeds[k].count++; w.newNeeds[k].likes += c.like;
    if (!w.newNeeds[k].eps.includes(c.no)) w.newNeeds[k].eps.push(c.no);
  }
}
