// composer-stats-step —— 输入框状态区“第 x 步”芯片。
//
// 口径：步数 = 当前轮内去重后的模型响应数（assistantResponseId）。
//       一轮开始尚未产生响应时按 1 计；工具执行期间维持当前步数。
// 数据：sessions.readRows（首读）+ sessions.onDidChangeRows（增量），
//       需要 sessions.read 授权；未授权时芯片显示“步数·未授权”。
// 悬停：当前步数与轮状态、本轮工具调用次数、模型（context.get，无需授权）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ITEM_ID = "step";
const PAGE_LIMIT = 200;
const MAX_PAGES = 500;
const HEARTBEAT_MS = 30000;
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60000;
const SUB_RETRY_MS = 5000;
const SNAPSHOT_FILE = "step-state.json";
const SNAPSHOT_MAX = 50;
const SNAPSHOT_DELAY = 2000;

const TURN_STATE_ZH = {
  running: "运行中",
  completedSuccess: "已完成",
  completedInterrupted: "已中断",
  failed: "失败",
};
const TURN_STATE_EN = {
  running: "running",
  completedSuccess: "completed",
  completedInterrupted: "interrupted",
  failed: "failed",
};

// 只区分中文与“其他语言”；其他语言统一回退英文。
function isZhLocale(locale) {
  return String(locale ?? "en-US").toLowerCase().startsWith("zh");
}

// —— 纯逻辑：状态与投影（运行时与测试共用） ——

export function newStepState() {
  return { turnRowId: -1, turnId: null, turnState: null, rows: new Map() };
}

export function applyStepRow(st, row) {
  if (!row || typeof row.rowId !== "number") return;
  if (row.kind === "turnHeader") {
    if (row.rowId > st.turnRowId) {
      st.turnRowId = row.rowId;
      st.turnId = row.turnId ?? null;
      st.turnState = row.state ?? null;
      st.rows = new Map();
    } else if (row.rowId === st.turnRowId) {
      st.turnState = row.state ?? st.turnState;
    }
    return;
  }
  if (st.turnId !== null && row.turnId === st.turnId) {
    st.rows.set(row.rowId, {
      kind: row.kind,
      aid: typeof row.assistantResponseId === "string" ? row.assistantResponseId : null,
      tid: row.kind === "toolCall" && typeof row.toolCallId === "string" ? row.toolCallId : null,
      state: typeof row.state === "string" ? row.state : null,
      model: typeof row.model === "string" ? row.model : null,
    });
  }
}

export function stepView(st) {
  if (st.turnId === null) return null;
  const aids = new Set();
  const tids = new Set();
  let model = null;
  for (const r of st.rows.values()) {
    if (r.aid) aids.add(r.aid);
    if (r.tid) tids.add(r.tid);
    if (r.model) model = r.model;
  }
  const steps = aids.size === 0 && st.turnState === "running" ? 1 : aids.size;
  return { steps, rawResponses: aids.size, toolCalls: tids.size, turnState: st.turnState, model };
}

// —— 详情卡片的文本排版（宿主 Tooltip 仅支持纯文本，上限 200 字符） ——

// 按行累加，超出预算就停，避免把一行切成半句。
export function fitLines(lines, max = 200) {
  const out = [];
  let len = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (len + add > max) break;
    out.push(line);
    len += add;
  }
  return out.join("\n");
}

export const RULE = "─".repeat(14);

export function stepTooltip(v, model, zh) {
  if (!v) return null;
  return `${zh ? "步数" : "Step"} · ${v.steps}`;
}

// 快照里只存数字，悬停文案按当前语言重建，切换语言后也能立即刷新。
function localizedTooltip(text, zh) {
  return `${zh ? "步数" : "Step"} · ${text}`;
}

// —— 扩展装配 ——

let cleanup = null;

export function deactivate() {
  cleanup?.();
  cleanup = null;
}

export function activate(ctx) {
  let stopped = false;
  let zh = false;
  let granted = null;
  let grantAttempts = 0;
  const sessions = new Map(); // sessionId -> { status, state, ctxInfo }
  const visible = new Set();
  const disposers = [];
  const timers = new Map();
  let heartbeat = null;
  const dataDir = typeof ctx.extension?.dataPath === "string" ? ctx.extension.dataPath : "";
  const snapPath = dataDir ? join(dataDir, SNAPSHOT_FILE) : "";
  const snapshot = new Map(); // sessionId -> { text, tooltip, at }
  let snapTimer = null;

  const describe = (e) =>
    e && e.code ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  const log = (level, msg) => {
    try {
      ctx.log[level](msg);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  // 本地快照：宿主重启会清空槽位，插件激活时先用最后展示值回填，等真实数据覆盖。
  function loadSnapshot() {
    if (!snapPath) return;
    try {
      const parsed = JSON.parse(readFileSync(snapPath, "utf8"));
      if (parsed?.v !== 2) return; // 旧格式（第 N 步文案）不再回填
      for (const [id, e] of Object.entries(parsed?.sessions ?? {})) {
        if (typeof e?.text !== "string" || !e.text) continue;
        snapshot.set(id, {
          text: e.text,
          tooltip: typeof e.tooltip === "string" && e.tooltip ? e.tooltip : e.text,
          at: Number.isFinite(e.at) ? e.at : 0,
        });
      }
      if (snapshot.size > 0) log("info", "restored chip snapshots: " + snapshot.size);
    } catch (e) {
      if (e?.code !== "ENOENT") log("warn", "load snapshot failed: " + describe(e));
    }
  }

  function snapshotPayload() {
    const rows = [...snapshot.entries()]
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, SNAPSHOT_MAX);
    const out = {};
    for (const [id, e] of rows) out[id] = { text: e.text, tooltip: e.tooltip, at: e.at };
    return { v: 2, sessions: out };
  }

  function persistSnapshot() {
    if (!snapPath) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(snapPath, JSON.stringify(snapshotPayload()), "utf8");
    } catch (e) {
      log("warn", "persist snapshot failed: " + describe(e));
    }
  }

  function scheduleSnapshot() {
    if (!snapPath || snapTimer) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      persistSnapshot();
    }, SNAPSHOT_DELAY);
  }

  // 实际写槽位：remember=true 时同步更新快照，供下一次宿主重启回填。
  function writePatch(id, patch, force, remember) {
    const st = sessions.get(id);
    const key = `${patch.text}
${patch.tooltip}`;
    if (!force && st && st.lastKey === key) return false;
    if (st) st.lastKey = key;
    try {
      ctx.slots.update(ITEM_ID, patch, { sessionId: id });
    } catch (e) {
      log("warn", `slots.update failed: ${describe(e)}`);
      return false;
    }
    if (remember) {
      snapshot.set(id, { text: patch.text, tooltip: patch.tooltip, at: Date.now() });
      scheduleSnapshot();
    }
    return true;
  }

  // 用快照回填；已有真实统计时不覆盖。
  function applySnapshot(id, force = false) {
    const st = sessions.get(id);
    const v = st ? stepView(st.state) : null;
    if (v && v.steps > 0) return false;
    const s = snapshot.get(id);
    if (!s) return false;
    return writePatch(id, { text: s.text, tooltip: localizedTooltip(s.text, zh) }, force, false);
  }

  // 语言切换：重写快照悬停文案，并强制重绘当前可见会话。
  function relocalize() {
    for (const [id, s] of snapshot) snapshot.set(id, { ...s, tooltip: localizedTooltip(s.text, zh) });
    scheduleSnapshot();
    for (const id of visible) {
      if (!render(id, true)) applySnapshot(id, true);
    }
  }

  function render(id, force = false) {
    if (stopped || !visible.has(id)) return false;
    const st = sessions.get(id);
    if (granted === false) {
      return writePatch(
        id,
        {
          text: zh ? "步数·未授权" : "Steps · no grant",
          tooltip: zh
            ? "未获得会话读取授权，无法统计步数。重新启用插件可再次申请授权。"
            : "Session read grant missing; re-enable the plugin to retry.",
        },
        force,
        false,
      );
    }
    if (!st) return false;
    // 不按加载状态门禁：有数据就展示，读行失败不会把已有芯片抹掉。
    const v = stepView(st.state);
    if (!v || v.steps <= 0) return false;
    const text = String(v.steps);
    return writePatch(
      id,
      { text, tooltip: stepTooltip(v, st.ctxInfo?.model, zh) },
      force,
      true,
    );
  }

  function scheduleRender(id, delay = 250) {
    if (stopped || timers.has(id)) return;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        render(id);
      }, delay),
    );
  }

  async function loadInto(id, target) {
    const rows = [];
    let before;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await ctx.sessions.readRows({
        sessionId: id,
        limit: PAGE_LIMIT,
        ...(before !== undefined ? { beforeRowId: before } : {}),
      });
      if (!Array.isArray(page?.rows) || page.rows.length === 0) break;
      rows.push(...page.rows);
      if (!page.hasMore) break;
      before = page.rows.reduce((m, r) => Math.min(m, r.rowId), Infinity);
    }
    rows.sort((a, b) => a.rowId - b.rowId);
    for (const r of rows) applyStepRow(target, r);
  }

  function subscribeRows(id, st) {
    if (stopped || st.subscribed) return;
    st.subscribed = true;
    try {
      const d = ctx.sessions.onDidChangeRows(
        { sessionId: id },
        (ev) => {
          if (!ev || stopped) return;
          if (ev.kind === "reset") {
            // 先算到临时状态：reset 自带的行不完整时，不抹掉原有统计。
            const next = newStepState();
            for (const r of ev.rows ?? []) applyStepRow(next, r);
            if (next.turnId !== null) st.state = next;
            st.status = "ready";
            st.rowsLoaded = true;
            st.loadFailures = 0;
            scheduleRender(id);
          } else if (ev.kind === "rows") {
            for (const r of ev.upserted ?? []) applyStepRow(st.state, r);
            scheduleRender(id);
          } else if (ev.kind === "stale") {
            // 重载期间继续展示旧值，成功后再整体替换。
            const next = newStepState();
            loadInto(id, next)
              .then(() => {
                if (next.turnId !== null) st.state = next;
                st.status = "ready";
                st.rowsLoaded = true;
                st.loadFailures = 0;
                scheduleRender(id);
              })
              .catch((e) => {
                log("warn", `reload failed: ${describe(e)}`);
                scheduleLoad(id, st);
              });
          }
        },
        (e) => {
          // 行流断开不清空已有芯片：保留最后一次统计结果，仅标记降级并安排重连。
          log("warn", `rows stream ended, keeping last values: ${describe(e)}`);
          const cur = sessions.get(id);
          if (cur) cur.status = "degraded";
          st.subscribed = false;
          try {
            d?.dispose?.();
          } catch {
            /* 忽略清理异常 */
          }
          scheduleSubscribe(id, st);
        },
      );
      disposers.push(d);
    } catch (e) {
      st.subscribed = false;
      log("warn", `onDidChangeRows failed: ${describe(e)}`);
      scheduleSubscribe(id, st);
    }
  }

  function scheduleSubscribe(id, st) {
    if (stopped || st.subTimer || !visible.has(id)) return;
    st.subTimer = setTimeout(() => {
      st.subTimer = null;
      if (!stopped && granted === true) subscribeRows(id, st);
    }, SUB_RETRY_MS);
  }

  function loadWait(st) {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min((st.loadFailures ?? 1) - 1, 4));
  }

  function scheduleLoad(id, st) {
    if (stopped || st.loadTimer || !visible.has(id)) return;
    const wait = loadWait(st);
    st.nextLoadAt = Date.now() + wait;
    st.loadTimer = setTimeout(() => {
      st.loadTimer = null;
      if (!st.rowsLoaded) loadSession(id, st);
    }, wait);
  }

  // 读行失败只降级：保留已有数据，按退避重试（宿主切回会话后会重新授权读取）。
  async function loadSession(id, st) {
    if (stopped || granted !== true || st.loading) return;
    if (st.nextLoadAt && Date.now() < st.nextLoadAt) return;
    st.loading = true;
    try {
      await loadInto(id, st.state);
      st.rowsLoaded = true;
      st.status = "ready";
      st.loadFailures = 0;
      st.nextLoadAt = 0;
      log("info", `rows loaded: ${id}`);
    } catch (e) {
      st.status = "degraded";
      st.loadFailures = (st.loadFailures ?? 0) + 1;
      log("warn", `readRows failed (${st.loadFailures}): ${describe(e)}`);
      scheduleLoad(id, st);
    } finally {
      st.loading = false;
    }
    render(id);
  }

  function ensureTracking(id) {
    if (stopped || granted !== true) return;
    let st = sessions.get(id);
    if (!st) {
      st = { status: "loading", state: newStepState(), ctxInfo: null, rowsLoaded: false, loadFailures: 0 };
      sessions.set(id, st);
      refreshContext(id);
    }
    if (!st.subscribed) subscribeRows(id, st);
    if (!st.rowsLoaded) loadSession(id, st);
  }

  async function refreshContext(id) {
    const st = sessions.get(id);
    if (!st || stopped) return;
    try {
      const info = await ctx.context.get({ sessionId: id });
      st.ctxInfo = info ? `${info.model.providerId}/${info.model.modelId}` : null;
    } catch {
      st.ctxInfo = null;
    }
    scheduleRender(id);
  }

  async function ensureGrant() {
    if (granted !== null) return granted;
    grantAttempts += 1;
    try {
      const r = await ctx.grants.request();
      granted = Array.isArray(r?.granted) && r.granted.includes("sessions.read");
    } catch (e) {
      log("warn", `grants.request failed: ${describe(e)}`);
      if (e?.code === "host-unavailable" && grantAttempts < 3) {
        granted = null;
        setTimeout(() => {
          ensureGrant()
            .then((ok) => {
              if (ok) for (const id of visible) ensureTracking(id);
              else renderAll();
            })
            .catch(() => {});
        }, 5000);
        return false;
      }
      granted = false;
    }
    return granted;
  }

  function renderAll(force = false) {
    for (const id of visible) render(id, force);
  }

  function syncVisible(list) {
    const next = new Set();
    for (const s of Array.isArray(list) ? list : []) {
      if (s && typeof s.sessionId === "string") next.add(s.sessionId);
    }
    // 不做清空：切走再切回时保留最后一次统计，避免芯片忽隐忽现。
    const prev = new Set(visible);
    visible.clear();
    for (const id of next) {
      visible.add(id);
      if (!prev.has(id)) {
        const st = sessions.get(id);
        if (st) st.nextLoadAt = 0; // 重新可见时立即补读，不等退避
      }
    }
    if (granted === true) for (const id of visible) ensureTracking(id);
    for (const id of visible) {
      if (!render(id)) applySnapshot(id);
    }
  }

  try {
    disposers.push(
      ctx.commands.register("show", () => {
        /* 点击暂无动作，悬停查看详情 */
      }),
    );
  } catch (e) {
    log("warn", `commands.register failed: ${describe(e)}`);
  }

  ctx.env
    .get()
    .then((r) => {
      zh = isZhLocale(r?.locale);
      relocalize();
    })
    .catch(() => {});

  try {
    disposers.push(
      ctx.env.onDidChange((r) => {
        const next = isZhLocale(r?.locale);
        if (next === zh) return;
        zh = next;
        for (const st of sessions.values()) st.lastKey = "";
        relocalize();
      }),
    );
  } catch (e) {
    log("warn", `env.onDidChange failed: ${describe(e)}`);
  }

  try {
    disposers.push(
      ctx.workbench.onDidChange(
        (ev) => syncVisible(ev?.sessions),
        (e) => log("warn", `workbench stream ended: ${describe(e)}`),
      ),
    );
  } catch (e) {
    log("warn", `workbench.onDidChange failed: ${describe(e)}`);
  }

  try {
    disposers.push(
      ctx.context.onDidChange((ev) => {
        if (ev && sessions.has(ev.sessionId)) refreshContext(ev.sessionId);
      }),
    );
  } catch (e) {
    log("warn", `context.onDidChange failed: ${describe(e)}`);
  }

  (async () => {
    // 先回填快照：不等待授权与读行，插件一激活就有值。
    loadSnapshot();
    for (const [id, s] of snapshot) {
      writePatch(id, { text: s.text, tooltip: s.tooltip }, false, false);
    }
    try {
      syncVisible(await ctx.workbench.visibleSessions());
    } catch (e) {
      log("warn", `visibleSessions failed: ${describe(e)}`);
    }
    const ok = await ensureGrant();
    if (ok) for (const id of visible) ensureTracking(id);
    else renderAll();
  })().catch((e) => log("error", `init failed: ${describe(e)}`));

  // 宿主持久化被清空时（重启、热重载）用同一份值重写，确保芯片常驻。
  heartbeat = setInterval(() => {
    if (stopped) return;
    for (const id of visible) {
      if (!render(id, true)) applySnapshot(id, true);
    }
  }, HEARTBEAT_MS);

  cleanup = () => {
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    if (snapTimer) {
      clearTimeout(snapTimer);
      snapTimer = null;
    }
    persistSnapshot();
    for (const st of sessions.values()) {
      if (st.loadTimer) clearTimeout(st.loadTimer);
      if (st.subTimer) clearTimeout(st.subTimer);
    }
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const d of disposers) {
      try {
        d?.dispose?.();
      } catch {
        /* 忽略清理异常 */
      }
    }
    sessions.clear();
  };
}
