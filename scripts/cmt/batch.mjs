/* 회차 댓글·별점 리뷰 시범이 같이 쓰는 Claude 일괄(Batches) 처리
 *
 * - 보내기 전에 깨진 글자(반쪽 난 이모지)가 든 요청을 막는다 — 서버가 요청 전체를 400으로 거절함
 * - 일괄이 생기는 즉시 예상 비용을 먼저 기록하고(charge), 결과를 받으면 실제 금액으로 맞춘다(stage)
 *   → 중간에 끊겨도 보낸 일괄이 사용액에서 빠지지 않는다. 서버가 요청을 거절(4xx)했으면 셀 돈이 없다.
 * - 기다림 상한은 실행 시작(tStart)부터 잰다 — 작업 시간 제한보다 먼저 정상적으로 끝나게
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRICE = { "claude-haiku-5-5": { in: 0.10, out: 0.50 }, "claude-sonnet-5-5": { in: 2, out: 10 } };
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class Waiting extends Error { constructor(id) { super("일괄 처리가 아직 끝나지 않음: " + id); this.batchId = id; } }

// 토큰 사용량 → 달러 (일괄이라 반값)
export function costOf(model, u) {
  const p = PRICE[model];
  if (!p) throw new Error("가격을 모르는 모델: " + model);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.in * 0.1 +
    (u.cache_creation_input_tokens || 0) * p.in * 1.25) / 1e6 / 2;
}

export function hasBrokenText(s) { return LONE.test(s); }

/* opts: { mock: bool, mockAnswer(customId, body) → 객체, waitMin, tStart, charge(usd, label), report, log }
 * report.batches[key] 에 일괄 번호, report.cost[key] 에 실제 비용, report.notes 에 메모가 들어간다. */
export function createBatcher(opts) {
  const { mock, mockAnswer, waitMin, tStart, charge, report, log } = opts;
  let client = null;
  async function sdk() {
    if (!client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
    return client;
  }
  function mockBatch(label, requests) {
    const out = new Map();
    for (const r of requests) {
      const obj = mockAnswer(r.custom_id, r.params.messages[0].content);
      out.set(r.custom_id, { type: "succeeded", message: { stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 300 }, content: [{ type: "text", text: JSON.stringify(obj) }] } });
    }
    log(`  ${label} (가짜 답) ${requests.length}건`);
    return { id: "mock", out };
  }
  async function runBatch(label, requests, est, key) {
    if (!requests.length) throw new Error(`${label}: 보낼 요청이 없습니다`);
    const bad = requests.find((r) => hasBrokenText(r.params.messages.map((m) => m.content).join("")));
    if (bad) throw new Error(`${label}: 깨진 글자가 든 요청(${bad.custom_id})이 있어 보내지 않습니다`);
    if (mock) return mockBatch(label, requests);
    const c = await sdk();
    let b;
    try { b = await c.messages.batches.create({ requests }, { maxRetries: 0 }); }
    catch (e) {
      if (!(e.status >= 400 && e.status < 500)) charge(est, label + " 만들기 오류(생겼을 수 있어 예상치로 셈)");
      throw new Error(`${label} 일괄을 만들지 못했습니다: ${e.message} — 콘솔(Batches)에서 생겼는지 확인 필요`);
    }
    report.batches[key] = b.id;
    charge(est, label + " 보냄(예상치로 먼저 셈)");
    log(`  ${label} 일괄 ${b.id} (${requests.length}건)`);
    while (b.processing_status !== "ended") {
      if (Date.now() - tStart > waitMin * 60e3) throw new Waiting(b.id);
      await sleep(30000);
      b = await c.messages.batches.retrieve(b.id);
      log(`  … 처리 중 ${b.request_counts.processing} / 완료 ${b.request_counts.succeeded}`);
    }
    const out = new Map();
    for await (const r of await c.messages.batches.results(b.id)) out.set(r.custom_id, r.result);
    return { id: b.id, out };
  }
  // 단계 하나: 보내고(예상치 먼저 셈) → apply(결과) → 실제 금액으로 맞춤(실제 − 예상). 못 기다리면 예상치가 그대로 남는다.
  async function stage(label, reqs, est, key, apply) {
    let r;
    try { r = await runBatch(label, reqs, est, key); }
    catch (e) { if (e instanceof Waiting) report.notes.push(e.message + " — 예상 비용으로 기록됨"); throw e; }
    const applied = apply(r.out);
    const usd = mock ? 0 : applied;   // 가짜 답의 사용량은 세지 않는다
    report.cost[key] = usd;
    if (!mock) charge(usd - est, label + " 실제 금액으로 맞춤");
    return usd;
  }
  return { runBatch, stage };
}

// 실패하지 않은 결과의 비용 합 (apply 안에서 씀)
export function usageCost(model, res) { return res && res.type === "succeeded" ? costOf(model, res.message.usage || {}) : 0; }
