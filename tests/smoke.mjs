// 用模拟宿主跑通三个插件的 activate()，并覆盖“行日志故障不得拖垮实时值”的三条降级路径。
// 运行：node smoke.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (d) => pathToFileURL(join(root, d, "dist", "main.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const rows = [
  { kind: "turnHeader", rowId: 1, turnId: "t1", state: "completedSuccess", startedAt: iso(now - 30000), endedAt: iso(now - 20000), activeMs: 10000, outputTokens: 120, modelDurationMs: 4000 },
  { kind: "userInput", rowId: 2, turnId: "t1", text: "hi", origin: "realUser" },
  { kind: "assistantText", rowId: 3, turnId: "t1", assistantResponseId: "r1", text: "a", state: "complete", model: "GLM-5.4" },
  { kind: "toolCall", rowId: 4, turnId: "t1", assistantResponseId: "r1", toolCallId: "c1", toolName: "Bash", status: "success", inputText: "" },
  { kind: "assistantText", rowId: 5, turnId: "t1", assistantResponseId: "r2", text: "b", state: "complete" },
  { kind: "turnHeader", rowId: 6, turnId: "t2", state: "running", startedAt: iso(now - 5000) },
];
const contextInfo = {
  sessionId: "sess_test1",
  revision: 7,
  phase: "request",
  measuredAt: now,
  model: { providerId: "bigmodel", modelId: "deepseek-flash", contextWindow: 1000000 },
  tokenMethod: "estimated",
  estimatedTokens: 234000,
  categories: [
    { id: "messages", chars: 6380, tokens: 15950 },
    { id: "mcp_tool_schemas", chars: 2590, tokens: 6475 },
    { id: "system_tool_schemas", chars: 770, tokens: 1925 },
    { id: "meta_user_context", chars: 260, tokens: 650 },
  ],
};
const speedEvent = (extra = {}) => ({
  sessionId: "sess_test1",
  requestId: "q1",
  model: { providerId: "bigmodel", modelId: "deepseek-flash" },
  phase: "streaming",
  outputTokensPerSecond: 168.7,
  outputTokens: 1234,
  timeToFirstTokenMs: 620,
  ...extra,
});

function makeCtx({ sessionId = "sess_test1", visible, readRowsFails = false, readRowsGate = null, rowsError = false, dataPath = "", locale = "en-US" } = {}) {
  const updates = [];
  const listeners = new Map();
  const sub = (name) => (listener, onError) => {
    listeners.set(name, { listener, onError });
    return { dispose() {} };
  };
  return {
    updates,
    emit(name, ev) {
      listeners.get(name)?.listener?.(ev);
    },
    fireError(name, err) {
      listeners.get(name)?.onError?.(err);
    },
    ctx: {
      extension: { id: "composer-stats-speed", version: "0.0.0", path: "", dataPath },
      log: { info() {}, warn() {}, error() {} },
      commands: { register: () => ({ dispose() {} }) },
      slots: { update: (itemId, patch, scope) => updates.push({ itemId, patch, scope }) },
      env: { get: async () => ({ locale }), onDidChange: sub("env") },
      grants: { request: async () => ({ granted: ["sessions.read"] }) },
      views: { open: async () => {} },
      workbench: {
        visibleSessions: async () => visible ?? [{ sessionId, isDraft: false, focused: true }],
        onDidChange: sub("workbench"),
      },
      context: { get: async () => contextInfo, onDidChange: sub("context") },
      sessions: {
        readRows: async () => {
          if (readRowsFails || readRowsGate?.fail) {
            const e = new Error("the session is not available to read");
            e.code = "unavailable";
            throw e;
          }
          return { logEpoch: "e1", revision: 3, rows, hasMore: false };
        },
        onDidChangeRows: (input, listener, onError) => {
          listeners.set("rows", { listener, onError });
          if (rowsError) queueMicrotask(() => onError?.(Object.assign(new Error("stream lost"), { code: "unavailable" })));
          return { dispose() {} };
        },
      },
      models: { onDidGenerate: sub("models") },
    },
  };
}

const last = (m) => [...m.updates].reverse().find((u) => u.patch.text) ?? null;
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  → " + extra}`);
  if (!cond) failed += 1;
};
// “闪无”的回归断言：任何一次写入都不允许是空文本
const noEmptyWrites = (m, label) =>
  check(`${label}: 从未写入空值（不闪）`, m.updates.every((u) => !!u.patch.text), JSON.stringify(m.updates.filter((u) => !u.patch.text)));

// —— 轮次 / 步数 ——
for (const [dir, expectText, expectInTooltip] of [
  ["composer-stats-turn", "2", ["Round · 2"]],
  ["composer-stats-step", "1", ["Step · 1"]],
]) {
  const m = await import(url(dir));
  const h = makeCtx();
  let threw = null;
  try {
    m.activate(h.ctx);
  } catch (e) {
    threw = e;
  }
  await sleep(120);
  check(`${dir}: activate 不抛异常`, threw === null, threw?.message);
  const u = last(h);
  check(`${dir}: 芯片文本 = ${expectText}`, u?.patch.text === expectText, u?.patch.text);
  for (const frag of expectInTooltip) {
    check(`${dir}: 详情含「${frag}」`, (u?.patch.tooltip ?? "").includes(frag), JSON.stringify(u?.patch.tooltip));
  }
  check(`${dir}: tooltip ≤200`, (u?.patch.tooltip ?? "").length <= 200);
  check(`${dir}: 作用域为当前会话`, u?.scope?.sessionId === "sess_test1", JSON.stringify(u?.scope));
  noEmptyWrites(h, dir);
  m.deactivate?.();
}

// —— 速度：正常路径 ——
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx();
  m.activate(h.ctx);
  await sleep(120);
  check("speed: 加载即有历史平均", last(h)?.patch.text === "30", last(h)?.patch.text);
  check("speed: 详情为图标+速度", (last(h)?.patch.tooltip ?? "").startsWith("Tokens / Second · 30"), last(h)?.patch.tooltip);
  h.emit("models", speedEvent());
  await sleep(350);
  check("speed: 实时事件覆盖为 169 Tokens/秒", last(h)?.patch.text === "169", last(h)?.patch.text);
  check("speed: 详情与芯片一致", last(h)?.patch.tooltip === "Tokens / Second · 169", last(h)?.patch.tooltip);
  noEmptyWrites(h, "speed");
  m.deactivate?.();
}

// —— 速度：行日志读取失败，实时值仍必须显示 ——
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx({ readRowsFails: true });
  m.activate(h.ctx);
  await sleep(150);
  check("speed(降级): 无历史值时不写入任何条目", h.updates.length === 0, JSON.stringify(h.updates));
  h.emit("models", speedEvent());
  await sleep(350);
  check("speed(降级): readRows 失败后实时值仍显示", last(h)?.patch.text === "169", last(h)?.patch.text);
  noEmptyWrites(h, "speed(降级)");
  m.deactivate?.();
}

// —— 速度：行流报错，实时值仍必须显示 ——
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx({ rowsError: true });
  m.activate(h.ctx);
  await sleep(150);
  h.emit("models", speedEvent({ outputTokensPerSecond: 42 }));
  await sleep(350);
  check("speed(降级): 行流断开后实时值仍显示", last(h)?.patch.text === "42", last(h)?.patch.text);
  m.deactivate?.();
}

// —— 速度：事件所属会话不在可见列表，也不能丢 ——
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx({ visible: [] });
  m.activate(h.ctx);
  await sleep(120);
  h.emit("models", speedEvent());
  await sleep(350);
  check("speed(降级): 不可见会话的事件也会写入", last(h)?.patch.text === "169", last(h)?.patch.text);
  m.deactivate?.();
}

// —— 步数：增量事件推进步数 ——
{
  const m = await import(url("composer-stats-step"));
  const h = makeCtx();
  m.activate(h.ctx);
  await sleep(80);
  h.emit("rows", { kind: "rows", logEpoch: "e1", revision: 4, upserted: [{ kind: "assistantText", rowId: 7, turnId: "t2", assistantResponseId: "r3", text: "c", state: "streaming" }] });
  await sleep(350);
  check("step: 单响应仍是第 1 步", last(h)?.patch.text === "1", last(h)?.patch.text);
  h.emit("rows", { kind: "rows", logEpoch: "e1", revision: 5, upserted: [{ kind: "assistantText", rowId: 8, turnId: "t2", assistantResponseId: "r4", text: "d", state: "streaming" }] });
  await sleep(350);
  check("step: 第二个响应后变成第 2 步", last(h)?.patch.text === "2", last(h)?.patch.text);
  m.deactivate?.();
}


// —— 轮次：reset 行不完整时不得抹掉已有统计（闪无回归） ——
{
  const m = await import(url("composer-stats-turn"));
  const h = makeCtx();
  m.activate(h.ctx);
  await sleep(120);
  check("turn(reset): 初始为第 2 轮", last(h)?.patch.text === "2", last(h)?.patch.text);
  h.emit("rows", { kind: "reset", logEpoch: "e2", revision: 9, rows: [{ kind: "assistantText", rowId: 11, turnId: "t9", assistantResponseId: "r9", text: "x", state: "streaming" }] });
  await sleep(350);
  check("turn(reset): 不完整 reset 后仍显示第 2 轮", last(h)?.patch.text === "2", last(h)?.patch.text);
  noEmptyWrites(h, "turn(reset)");
  m.deactivate?.();
}

// —— 速度：reset 行不完整时保留历史平均 ——
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx();
  m.activate(h.ctx);
  await sleep(120);
  check("speed(reset): 初始为 30 Tokens/秒", last(h)?.patch.text === "30", last(h)?.patch.text);
  h.emit("rows", { kind: "reset", logEpoch: "e2", revision: 9, rows: [] });
  await sleep(350);
  check("speed(reset): 空 reset 后仍显示 30 Tokens/秒", last(h)?.patch.text === "30", last(h)?.patch.text);
  noEmptyWrites(h, "speed(reset)");
  m.deactivate?.();
}

// —— 速度：宿主重启后回填上一次的值（不闪无） ——
{
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "composer-stats-"));
  const m = await import(url("composer-stats-speed"));
  const h1 = makeCtx({ dataPath: dir });
  m.activate(h1.ctx);
  await sleep(120);
  h1.emit("models", speedEvent({ phase: "final", outputTokensPerSecond: 120 }));
  await sleep(300);
  check("speed(持久化): 结束时写为 120 Tokens/秒", last(h1)?.patch.text === "120", last(h1)?.patch.text);
  m.deactivate?.();
  await sleep(300);
  const h2 = makeCtx({ dataPath: dir, visible: [], readRowsFails: true });
  m.activate(h2.ctx);
  await sleep(200);
  check("speed(持久化): 新实例立即回填上次值", last(h2)?.patch.text === "120", last(h2)?.patch.text);
  check("speed(持久化): 详情同样回填", (last(h2)?.patch.tooltip ?? "").includes("120"), JSON.stringify(last(h2)?.patch.tooltip));
  noEmptyWrites(h2, "speed(持久化)");
  m.deactivate?.();
}
// —— 轮次：宿主重启后从本地快照回填（读行失败也不消失） ——
{
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "composer-stats-turn-"));
  const m = await import(url("composer-stats-turn"));
  const h1 = makeCtx({ dataPath: dir });
  m.activate(h1.ctx);
  await sleep(150);
  check("turn(快照): 首次激活为第 2 轮", last(h1)?.patch.text === "2", last(h1)?.patch.text);
  m.deactivate?.();
  const h2 = makeCtx({ dataPath: dir, readRowsFails: true });
  m.activate(h2.ctx);
  await sleep(150);
  check("turn(快照): 重启且读行失败时立即回填第 2 轮", last(h2)?.patch.text === "2", last(h2)?.patch.text);
  noEmptyWrites(h2, "turn(快照)");
  m.deactivate?.();
}

// —— 步数：宿主重启后从本地快照回填（读行失败也不消失） ——
{
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "composer-stats-step-"));
  const m = await import(url("composer-stats-step"));
  const h1 = makeCtx({ dataPath: dir });
  m.activate(h1.ctx);
  await sleep(150);
  check("step(快照): 首次激活为第 1 步", last(h1)?.patch.text === "1", last(h1)?.patch.text);
  m.deactivate?.();
  const h2 = makeCtx({ dataPath: dir, readRowsFails: true });
  m.activate(h2.ctx);
  await sleep(150);
  check("step(快照): 重启且读行失败时立即回填第 1 步", last(h2)?.patch.text === "1", last(h2)?.patch.text);
  noEmptyWrites(h2, "step(快照)");
  m.deactivate?.();
}

// —— 速度：读行失败时也能用持久化值回填 ——
{
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "composer-stats-speed-"));
  const m = await import(url("composer-stats-speed"));
  const h1 = makeCtx({ dataPath: dir });
  m.activate(h1.ctx);
  await sleep(120);
  h1.emit("models", speedEvent({ phase: "final", outputTokensPerSecond: 155 }));
  await sleep(300);
  m.deactivate?.();
  const h2 = makeCtx({ dataPath: dir, visible: [], readRowsFails: true });
  m.activate(h2.ctx);
  await sleep(250);
  check("speed(快照): 读行失败时回填上次 155 Tokens/秒", last(h2)?.patch.text === "155", last(h2)?.patch.text);
  noEmptyWrites(h2, "speed(快照)");
  m.deactivate?.();
}

// —— 速度：新会话没有数据时，不得拿其他会话的值回填 ——
{
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "composer-stats-speed-"));
  const m = await import(url("composer-stats-speed"));
  const h1 = makeCtx({ dataPath: dir });
  m.activate(h1.ctx);
  await sleep(120);
  h1.emit("models", speedEvent({ phase: "final", outputTokensPerSecond: 155 }));
  await sleep(300);
  m.deactivate?.();
  const h2 = makeCtx({
    dataPath: dir,
    readRowsFails: true,
    visible: [{ sessionId: "sess_new", isDraft: false, focused: true }],
  });
  m.activate(h2.ctx);
  await sleep(250);
  const scopedNew = h2.updates.filter((u) => u.scope?.sessionId === "sess_new");
  check("speed(不回填): 新会话无数据时不写入", scopedNew.length === 0, JSON.stringify(scopedNew));
  noEmptyWrites(h2, "speed(不回填)");
  m.deactivate?.();
}

// —— 轮次：首次读行失败后，会话重新可见时自动补读（宿主切回会话后恢复授权的场景） ——
{
  const m = await import(url("composer-stats-turn"));
  const gate = { fail: true };
  const h = makeCtx({ readRowsGate: gate });
  m.activate(h.ctx);
  await sleep(250);
  check("turn(重试): 读行持续失败时不显示", last(h)?.patch.text == null, JSON.stringify(h.updates));
  gate.fail = false;
  h.emit("workbench", { sessions: [] }); // 切走
  await sleep(20);
  h.emit("workbench", { sessions: [{ sessionId: "sess_test1", isDraft: false, focused: true }] }); // 切回
  await sleep(350);
  check("turn(重试): 会话重新可见后补读成功并显示", last(h)?.patch.text === "2", last(h)?.patch.text);
  noEmptyWrites(h, "turn(重试)");
  m.deactivate?.();
}

// —— i18n：中文悬停、运行时语言切换、未知语言回退英文 ——
{
  const m = await import(url("composer-stats-turn"));
  const h = makeCtx({ locale: "zh-CN" });
  m.activate(h.ctx);
  await sleep(150);
  check("turn(i18n): 中文悬停", last(h)?.patch.tooltip === "轮次 · 2", last(h)?.patch.tooltip);
  h.emit("env", { locale: "en-US" });
  await sleep(350);
  check("turn(i18n): 切换英文", last(h)?.patch.tooltip === "Round · 2", last(h)?.patch.tooltip);
  m.deactivate?.();
}
{
  const m = await import(url("composer-stats-step"));
  const h = makeCtx({ locale: "zh-CN" });
  m.activate(h.ctx);
  await sleep(150);
  check("step(i18n): 中文悬停", last(h)?.patch.tooltip === "步数 · 1", last(h)?.patch.tooltip);
  h.emit("env", { locale: "en-US" });
  await sleep(350);
  check("step(i18n): 切换英文", last(h)?.patch.tooltip === "Step · 1", last(h)?.patch.tooltip);
  m.deactivate?.();
}
{
  const m = await import(url("composer-stats-speed"));
  const h = makeCtx({ locale: "zh-CN" });
  m.activate(h.ctx);
  await sleep(150);
  check("speed(i18n): 中文悬停", last(h)?.patch.tooltip === "Tokens / 秒 · 30", last(h)?.patch.tooltip);
  h.emit("env", { locale: "en-US" });
  await sleep(350);
  check("speed(i18n): 切换英文", last(h)?.patch.tooltip === "Tokens / Second · 30", last(h)?.patch.tooltip);
  m.deactivate?.();
}
{
  const m = await import(url("composer-stats-turn"));
  const h = makeCtx({ locale: "fr-FR" });
  m.activate(h.ctx);
  await sleep(150);
  check("turn(i18n): 未知语言回退英文", last(h)?.patch.tooltip === "Round · 2", last(h)?.patch.tooltip);
  m.deactivate?.();
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
