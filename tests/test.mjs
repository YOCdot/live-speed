// composer-stats 纯逻辑单测：轮次/步数 reducer、速度判定、详情卡片文本与预算。
// 运行：node test.mjs
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginUrl = (dir) => pathToFileURL(join(root, dir, "dist", "main.mjs")).href;
const turn = await import(pluginUrl("composer-stats-turn"));
const step = await import(pluginUrl("composer-stats-step"));
const speed = await import(pluginUrl("composer-stats-speed"));
const { newTurnState, applyTurnRow, turnView } = turn;
const { newStepState, applyStepRow, stepView } = step;
const { fmtTps, newSpeedState, applySpeedRow, applySpeedEvent, resolveSpeed, speedText } = speed;

const NL = "\n";
const now = 1_000_000;
const iso = (ms) => new Date(ms).toISOString();
const th = (rowId, turnId, state, extra = {}) => ({ kind: "turnHeader", rowId, turnId, state, ...extra });
const at = (rowId, turnId, aid, extra = {}) => ({
  kind: "assistantText",
  rowId,
  turnId,
  assistantResponseId: aid,
  text: "x",
  state: "complete",
  ...extra,
});
const tc = (rowId, turnId, aid, tid) => ({
  kind: "toolCall",
  rowId,
  turnId,
  assistantResponseId: aid,
  toolCallId: tid,
  toolName: "Bash",
  status: "success",
  inputText: "",
});

// —— 轮次 ——

{
  const st = newTurnState();
  assert.equal(turnView(st), null, "空状态无视图");
  applyTurnRow(st, th(1, "t1", "running", { startedAt: iso(now - 3000) }));
  let v = turnView(st, now);
  assert.equal(v.count, 1);
  assert.equal(v.current.state, "running");
  assert.equal(v.current.duration, 3000, "运行中按 now-startedAt 计时");
  applyTurnRow(st, th(1, "t1", "completedSuccess", { outputTokens: 120, activeMs: 8000 }));
  applyTurnRow(st, th(5, "t2", "running", { startedAt: iso(now - 1000), outputTokens: 30 }));
  v = turnView(st, now);
  assert.equal(v.count, 2);
  assert.equal(v.current.duration, 1000);
  assert.equal(v.totalOutputTokens, 150, "累计输出求和");
  assert.equal(v.current.outputTokens, 30);
  applyTurnRow(st, th(3, "t1b", "failed"));
  v = turnView(st, now);
  assert.equal(v.count, 3, "乱序 upsert 也计入");
  assert.equal(v.current.state, "running", "当前轮取最大 rowId");
}

// —— 步数 ——

{
  const st = newStepState();
  assert.equal(stepView(st), null, "无轮时无视图");
  applyStepRow(st, th(1, "t1", "running"));
  let v = stepView(st);
  assert.equal(v.steps, 1, "新轮无响应按 1 计");
  applyStepRow(st, at(2, "t1", "r1", { model: "GLM-5.4" }));
  applyStepRow(st, tc(3, "t1", "r1", "c1"));
  applyStepRow(st, tc(4, "t1", "r1", "c2"));
  applyStepRow(st, at(5, "t1", "r2"));
  v = stepView(st);
  assert.equal(v.steps, 2, "同一响应多行去重");
  assert.equal(v.toolCalls, 2);
  assert.equal(v.model, "GLM-5.4");
  applyStepRow(st, at(5, "t1", "r2", { state: "streaming" }));
  assert.equal(stepView(st).steps, 2, "流式 upsert 不改计数");
  applyStepRow(st, th(6, "t2", "running"));
  v = stepView(st);
  assert.equal(v.steps, 1, "新轮重置后按 1 计");
  assert.equal(v.toolCalls, 0);
  applyStepRow(st, at(7, "t2", "r3"));
  applyStepRow(st, th(6, "t2", "completedInterrupted"));
  v = stepView(st);
  assert.equal(v.steps, 1);
  assert.equal(v.turnState, "completedInterrupted");
  applyStepRow(st, th(8, "t3", "completedInterrupted"));
  assert.equal(stepView(st).steps, 0, "完成轮无响应则步数为 0");
  applyStepRow(st, at(9, "t1", "r9"));
  assert.equal(stepView(st).steps, 0, "旧 turnId 的迟到行被忽略");
}

// —— 速度判定 ——

{
  const ev = (tps, extra = {}) => ({
    sessionId: "s1",
    requestId: "q1",
    model: { providerId: "bigmodel", modelId: "GLM-5.4" },
    phase: "final",
    outputTokensPerSecond: tps,
    ...extra,
  });

  assert.equal(resolveSpeed(newSpeedState()), null);
  assert.equal(speedText(null), null);

  {
    const st = newSpeedState();
    applySpeedRow(st, th(1, "t1", "completedSuccess", { startedAt: iso(now - 20000), outputTokens: 300, modelDurationMs: 10000 }));
    const v = resolveSpeed(st);
    assert.equal(v.source, "session", "历史会话取会话平均");
    assert.equal(Math.round(v.tps), 30);
    assert.equal(speedText(v), "30");
    assert.equal(speedText(v, false), "30");
  }
  {
    const st = newSpeedState();
    applySpeedRow(st, th(1, "t1", "running", { startedAt: iso(now - 5000), outputTokens: 100, modelDurationMs: 4000 }));
    assert.equal(applySpeedEvent(st, ev(42.5, { phase: "streaming", timeToFirstTokenMs: 780, outputTokens: 120 }), now), true);
    const v = resolveSpeed(st);
    assert.equal(v.source, "live");
    assert.equal(v.tps, 42.5);
    assert.equal(v.ttft, 780);
    assert.equal(v.tokens, 120);
    assert.equal(applySpeedEvent(st, { sessionId: "s1" }, now), false, "字段非法不覆盖");
    assert.equal(resolveSpeed(st).source, "live");
  }
  {
    const st = newSpeedState();
    applySpeedRow(st, th(1, "t1", "completedSuccess", { startedAt: iso(now - 20000), outputTokens: 300, modelDurationMs: 10000 }));
    applySpeedEvent(st, ev(55), now - 10000);
    assert.equal(resolveSpeed(st).source, "step");
    applySpeedRow(st, th(9, "t2", "running", { startedAt: iso(now), outputTokens: 0 }));
    const v = resolveSpeed(st);
    assert.equal(v.source, "session", "无实时值时取会话平均");
    assert.equal(Math.round(v.tps), 30);
  }
  {
    const st = newSpeedState();
    applySpeedEvent(st, ev(7.25), now);
    const v = resolveSpeed(st);
    assert.equal(v.source, "step");
    assert.equal(speedText(v), "7", "速度一律取整");
    assert.equal(fmtTps(7.5), "8", "四舍五入");
    assert.equal(fmtTps(0.4), "0");
  }
  {
    const st = newSpeedState();
    applySpeedRow(st, th(1, "t1", "completedSuccess", { startedAt: iso(now), outputTokens: 0, modelDurationMs: 1000 }));
    applySpeedRow(st, th(2, "t2", "completedSuccess", { startedAt: iso(now), outputTokens: 50 }));
    assert.equal(st.rowAvg, null, "缺 outputTokens 或 modelDurationMs 不算平均");
    assert.equal(resolveSpeed(st), null);
  }
}

// —— 详情卡片：与官方上下文卡片同一套文案、单位与行式 ——

{
  assert.equal(turn.compact(234000, true), "23.4万");
  assert.equal(turn.compact(1000000, true), "100万");
  assert.equal(turn.compact(9500, true), "9500");
  assert.equal(turn.compact(234000, false), "234k");
  assert.equal(turn.compact(1000000, false), "1M");
  assert.equal(turn.compact(NaN, true), null);

  assert.equal(turn.bar(0), "▱".repeat(10));
  assert.equal(turn.bar(1), "▰".repeat(10));
  assert.equal(turn.bar(0.5), "▰".repeat(5) + "▱".repeat(5));
  assert.equal(turn.bar(-1), "▱".repeat(10));
  assert.equal(turn.bar(2), "▰".repeat(10));
  assert.equal(turn.bar(0.234), "▰▰" + "▱".repeat(8));

  assert.equal(turn.fitLines(["a", "b"]), "a" + NL + "b");
  assert.equal(turn.fitLines(["a".repeat(199), "b"]), "a".repeat(199));
  assert.equal(turn.fitLines(["x".repeat(201)]), "");

  // 官方分类标签逐字一致
  assert.equal(turn.ctxLabel("messages", true), "消息");
  assert.equal(turn.ctxLabel("mcp_tool_schemas", true), "MCP 工具");
  assert.equal(turn.ctxLabel("system_tool_schemas", true), "系统工具");
  assert.equal(turn.ctxLabel("skills", true), "技能");
  assert.equal(turn.ctxLabel("meta_user_context", true), "其他");
  assert.equal(turn.ctxLabel("system_prompt", true), "系统提示词");

  const v = {
    count: 12,
    current: { state: "running", outputTokens: 12345, duration: 192000 },
    totalOutputTokens: 123456,
  };
  const info = {
    model: "bigmodel/deepseek-flash",
    used: 234000,
    window: 1000000,
    categories: [
      { id: "messages", chars: 6380 },
      { id: "mcp_tool_schemas", chars: 2590 },
      { id: "system_tool_schemas", chars: 770 },
      { id: "meta_user_context", chars: 260 },
    ],
  };
  const zhCard = turn.turnTooltip(v, info, true);
  assert.equal(zhCard, "轮次 · 12");
  assert.ok(zhCard.length <= 200, `轮次卡片长度 ${zhCard.length}`);
  const enCard = turn.turnTooltip(v, info, false);
  assert.equal(enCard, "Round · 12", "英文悬停独立本地化");
  // 无上下文数据时退回本轮输出 token
  assert.equal(turn.turnTooltip(v, { model: "m/x" }, true), "轮次 · 12");
  assert.equal(turn.turnTooltip({ count: 1, current: { state: "running", outputTokens: null, duration: null } }, null, true), "轮次 · 1");

  const stepCard = step.stepTooltip(
    { steps: 7, rawResponses: 7, toolCalls: 9, turnState: "running", model: null },
    "bigmodel/deepseek-flash",
    true,
  );
  assert.equal(stepCard, "步数 · 7");
  assert.equal(step.stepTooltip({ steps: 1, toolCalls: 0, turnState: "running" }, null, false), "Step · 1");

  const liveCard = speed.speedTooltip({ source: "live", tps: 169, ttft: 620, tokens: 1234, model: "m/x" }, true);
  assert.equal(liveCard, "Tokens / 秒 · 169");
  const liveCardEn = speed.speedTooltip({ source: "live", tps: 169, ttft: 620, tokens: 1234, model: "m/x" }, false);
  assert.equal(liveCardEn, "Tokens / Second · 169");
  const avgCard = speed.speedTooltip(
    { source: "turn", tps: 23.45, ttft: null, tokens: 4521, model: "m/x", modelDurationMs: 192000 },
    true,
  );
  assert.equal(avgCard, "Tokens / 秒 · 23");
  const avgCardEn = speed.speedTooltip(
    { source: "turn", tps: 23.45, ttft: null, tokens: 4521, model: "m/x", modelDurationMs: 192000 },
    false,
  );
  assert.equal(avgCardEn, "Tokens / Second · 23");
  assert.equal(speed.speedTooltip(null), null);

  // 极端值仍守 200 字符预算，且不出现被切断的半行
  const extreme = turn.turnTooltip(
    {
      count: 9999,
      current: { state: "completedInterrupted", outputTokens: 12345678, duration: 359999000 },
      totalOutputTokens: 999999999,
    },
    {
      model: "bigmodel-individual-coding-plan/GLM-5.4",
      used: 1990000,
      window: 2000000,
      categories: [
        { id: "messages", chars: 6000 },
        { id: "mcp_tool_schemas", chars: 3000 },
        { id: "system_tool_schemas", chars: 800 },
        { id: "skills", chars: 200 },
      ],
    },
    true,
  );
  assert.ok(extreme.length <= 200, `极端 tooltip: ${extreme.length}`);
  for (const line of extreme.split(NL)) assert.ok(!line.endsWith("·"), "不出现悬空分隔符");
}

// —— 文案长度预算（宿主限制：text ≤40、tooltip ≤200） ——

for (let n = 1; n <= 999; n += 100) {
  assert.ok(`第${n}轮`.length <= 40);
  assert.ok(`第${n}步`.length <= 40);
  assert.ok(fmtTps(n * 12.34).length <= 40);
}

console.log("PASS: composer-stats reducer、详情卡片与格式化用例全部通过");
