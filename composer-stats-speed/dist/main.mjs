// composer-stats-speed —— 输入框状态区“x Tokens/秒”芯片。
//
// 口径：显示最近一次模型生成的速度。
//   实时：宿主 models.onDidGenerate 事件（流式期间逐步刷新）。
//   兜底：会话行日志里本轮 turnHeader 的 outputTokens / modelDurationMs，
//         插件加载即有值，不依赖实时事件是否送达。
// 数据：models.onDidGenerate（实时，唯一权威来源）+ 插件数据目录里的最后一次值
//       （宿主重启后回填，标注“上次”）+ sessions.readRows（历史兜底；当前版本宿主
//       因输出校验 ZodError 不可用，失败不影响实时路径）。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ITEM_ID = "speed";
const PAGE_LIMIT = 200;
const MAX_PAGES = 500;
const HEARTBEAT_MS = 30000;
const STORE_VERSION = 2;
const ROW_RETRY_BASE_MS = 4000;
const ROW_RETRY_MAX_MS = 60000;
const SUB_RETRY_MS = 5000;

function toMs(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// 只区分中文与“其他语言”；其他语言统一回退英文。
function isZhLocale(locale) {
  return String(locale ?? "en-US").toLowerCase().startsWith("zh");
}

// —— 纯逻辑（运行时与测试共用） ——

export function fmtTps(v) {
  if (!Number.isFinite(v) || v < 0) return "0";
  return String(Math.round(v));
}

export function fmtTokens(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : null;
}

export function fmtMs(v) {
  if (!Number.isFinite(v) || v < 0) return null;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function newSpeedState() {
  return { live: null, currentTurn: null, rowAvg: null, headers: new Map() };
}

// 消费一行会话日志：只关心 turnHeader（本轮 token 与模型耗时）。
export function applySpeedRow(st, row) {
  if (!row || row.kind !== "turnHeader" || typeof row.rowId !== "number") return;
  const t = {
    rowId: row.rowId,
    startedAt: toMs(row.startedAt),
    state: typeof row.state === "string" ? row.state : null,
    outputTokens: Number.isFinite(row.outputTokens) ? row.outputTokens : null,
    modelDurationMs: Number.isFinite(row.modelDurationMs) ? row.modelDurationMs : null,
  };
  st.headers.set(row.rowId, t);
  if (!st.currentTurn || t.rowId > st.currentTurn.rowId) st.currentTurn = t;
  else if (t.rowId === st.currentTurn.rowId) st.currentTurn = { ...st.currentTurn, ...t };
  if (t.outputTokens > 0 && t.modelDurationMs > 0) {
    if (!st.rowAvg || t.rowId >= st.rowAvg.turnRowId) {
      st.rowAvg = {
        turnRowId: t.rowId,
        tps: t.outputTokens / (t.modelDurationMs / 1000),
        tokens: t.outputTokens,
        modelDurationMs: t.modelDurationMs,
        state: t.state,
      };
    }
  }
}

// 会话平均：所有有 token 与耗时数据的轮次加权平均。
export function sessionAvg(st) {
  let tokens = 0;
  let ms = 0;
  let turns = 0;
  for (const h of st.headers.values()) {
    if (h.outputTokens > 0 && h.modelDurationMs > 0) {
      tokens += h.outputTokens;
      ms += h.modelDurationMs;
      turns += 1;
    }
  }
  if (ms <= 0) return null;
  return { tps: tokens / (ms / 1000), tokens, modelDurationMs: ms, turns };
}

// 消费一次实时速度事件。
export function applySpeedEvent(st, ev, at) {
  if (!ev || typeof ev.sessionId !== "string") return false;
  const tps = Number(ev.outputTokensPerSecond);
  if (!Number.isFinite(tps) || tps < 0) return false;
  st.live = {
    tps,
    ttft: Number.isFinite(ev.timeToFirstTokenMs) ? ev.timeToFirstTokenMs : null,
    tokens: Number.isFinite(ev.outputTokens) ? ev.outputTokens : null,
    model: ev.model ? `${ev.model.providerId}/${ev.model.modelId}` : null,
    phase: ev.phase === "final" ? "final" : "streaming",
    at: Number.isFinite(at) ? at : Date.now(),
  };
  return true;
}

// 选定要展示的速度：
//   1. 正在运行 → 实时速度（streaming 事件）
//   2. 本步结束 → 本步平均（final 事件）
//   3. 历史会话 → 会话平均（所有轮次加权）
//   4. 行数据不可用时退回最新一轮平均/上次值
export function resolveSpeed(st) {
  const live = st.live;
  const cur = st.currentTurn;
  const liveIsCurrent = live && (!cur || cur.startedAt == null || live.at >= cur.startedAt);
  if (live && liveIsCurrent && !live.fromStore && live.phase === "streaming") {
    return {
      source: "live",
      tps: live.tps,
      ttft: live.ttft,
      tokens: live.tokens,
      model: live.model,
    };
  }
  if (live && liveIsCurrent && !live.fromStore && live.phase === "final") {
    return {
      source: "step",
      tps: live.tps,
      ttft: live.ttft,
      tokens: live.tokens,
      model: live.model,
    };
  }
  const avg = sessionAvg(st);
  if (avg) {
    return {
      source: "session",
      tps: avg.tps,
      tokens: avg.tokens,
      modelDurationMs: avg.modelDurationMs,
      turns: avg.turns,
      model: live?.model ?? null,
    };
  }
  if (st.rowAvg) {
    return {
      source: "turn",
      tps: st.rowAvg.tps,
      tokens: st.rowAvg.tokens,
      model: live?.model ?? null,
      modelDurationMs: st.rowAvg.modelDurationMs,
      state: st.rowAvg.state,
    };
  }
  if (live) {
    return {
      source: live.fromStore ? "last" : "stale-live",
      tps: live.tps,
      ttft: live.ttft,
      tokens: live.tokens,
      model: live.model,
    };
  }
  return null;
}

export function speedText(v, zh = true) {
  return v ? fmtTps(v.tps) : null;
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

export function speedTooltip(v, zh = true) {
  if (!v) return null;
  return `${zh ? "Tokens / 秒" : "Tokens / Second"} · ${fmtTps(v.tps)}`;
}


// —— 扩展装配 ——
//
// 两条数据路径互不阻断：
//   实时：models.onDidGenerate（无需授权）——事件到达即写值，任何行口径故障都不影响它。
//   历史：sessions.readRows（需 sessions.read 授权）——失败只降级为“仅有实时值”，
//         不把会话标记为不可用，也不删除会话状态。

let cleanup = null;

export function deactivate() {
  cleanup?.();
  cleanup = null;
}

export function activate(ctx) {
  let stopped = false;
  let zh = false;
  let granted = null; // null=未判定；false=未授权（仅失去历史兜底）
  let grantAttempts = 0;
  const sessions = new Map(); // sessionId -> { live, currentTurn, rowAvg, rowsLoaded, rowsBroken }
  const tracked = new Set(); // 已启动行口径跟踪的会话
  const disposers = [];
  const timers = new Map();
  const dataDir = typeof ctx.extension?.dataPath === "string" ? ctx.extension.dataPath : "";
  const storePath = dataDir ? join(dataDir, "speed-last.json") : "";
  let persistTimer = null;
  let heartbeat = null;

  const describe = (e) =>
    e && e.code ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  const log = (level, msg) => {
    try {
      ctx.log[level](msg);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  function ensureState(id) {
    let st = sessions.get(id);
    if (!st) {
      st = newSpeedState();
      sessions.set(id, st);
    }
    return st;
  }

  // 实时事件是速度的唯一权威来源，宿主重启不会重放；把最后一次值落盘以便回填。
  async function loadStore() {
    if (!storePath) return;
    try {
      const parsed = JSON.parse(await readFile(storePath, "utf8"));
      if (parsed?.v !== STORE_VERSION) return; // 旧格式可能含跨会话回填的污染值，不再回填
      let n = 0;
      for (const [id, e] of Object.entries(parsed?.sessions ?? {})) {
        if (!e || !Number.isFinite(e.tps)) continue;
        const st = ensureState(id);
        if (st.live) continue;
        st.live = {
          tps: e.tps,
          ttft: Number.isFinite(e.ttft) ? e.ttft : null,
          tokens: Number.isFinite(e.tokens) ? e.tokens : null,
          model: typeof e.model === "string" ? e.model : null,
          phase: "final",
          at: Number.isFinite(e.at) ? e.at : 0,
          fromStore: true,
        };
        n += 1;
      }
      if (n > 0) log("info", "restored last speeds: " + n);
    } catch (e) {
      if (e?.code !== "ENOENT") log("warn", "load last speeds failed: " + describe(e));
    }
  }

  async function persistNow() {
    if (!storePath) return;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(storePath, JSON.stringify(storePayload()), "utf8");
    } catch (e) {
      log("warn", "persist last speeds failed: " + describe(e));
    }
  }

  function storePayload() {
    const rows = [...sessions.entries()]
      .filter(([, st]) => st.live && Number.isFinite(st.live.tps))
      .sort((a, b) => (b[1].live.at ?? 0) - (a[1].live.at ?? 0))
      .slice(0, 50);
    const payload = { v: STORE_VERSION, sessions: {} };
    for (const [id, st] of rows) {
      payload.sessions[id] = {
        tps: st.live.tps,
        ttft: st.live.ttft,
        tokens: st.live.tokens,
        model: st.live.model,
        at: st.live.at,
      };
    }
    return payload;
  }

  // 停用时同步落盘：宿主可能不等异步写完成就结束进程。
  function persistSync() {
    if (!storePath) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(storePath, JSON.stringify(storePayload()), "utf8");
    } catch (e) {
      log("warn", "persist last speeds failed: " + describe(e));
    }
  }

  function schedulePersist(delay = 3000) {
    if (!storePath || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, delay);
  }

  // 只要 resolveSpeed 有值就写芯片；无值时保持不动，避免“更新即闪没”。
  // force=true 用于周期重写：宿主持久化被清空后也能恢复。
  function render(id, force = false) {
    if (stopped) return;
    const st = sessions.get(id);
    const v = st ? resolveSpeed(st) : null;
    const text = speedText(v, zh);
    if (!text) return;
    const tooltip = speedTooltip(v, zh) ?? text;
    const key = `${text}
${tooltip}`;
    if (!force && st && st.lastKey === key) return; // 内容未变不重复写入，减少重绘
    if (st) st.lastKey = key;
    try {
      ctx.slots.update(ITEM_ID, { text, tooltip }, { sessionId: id });
    } catch (e) {
      log("warn", `slots.update failed: ${describe(e)}`);
    }
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

  function renderAll(force = false) {
    for (const id of sessions.keys()) render(id, force);
  }

  async function readAllRows(id) {
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
    return rows;
  }

  function rowWait(st) {
    return Math.min(ROW_RETRY_MAX_MS, ROW_RETRY_BASE_MS * 2 ** Math.min((st.rowFailures ?? 1) - 1, 4));
  }

  // 历史值加载失败只降级：保留已有实时值，按退避重试（宿主切回会话后会重新授权读取）。
  async function loadRows(id, st) {
    if (stopped || st.loading) return;
    if (st.nextLoadAt && Date.now() < st.nextLoadAt) return;
    st.loading = true;
    try {
      const rows = await readAllRows(id);
      for (const r of rows) applySpeedRow(st, r);
      st.rowsLoaded = true;
      st.rowsBroken = false;
      st.rowFailures = 0;
      st.nextLoadAt = 0;
      log("info", `rows loaded for ${id}: ${rows.length} rows`);
      render(id);
    } catch (e) {
      st.rowsBroken = true;
      st.rowFailures = (st.rowFailures ?? 0) + 1;
      log("warn", `readRows failed (${st.rowFailures}), keeping realtime values: ${describe(e)}`);
      scheduleRowLoad(id, st);
    } finally {
      st.loading = false;
    }
  }

  function scheduleRowLoad(id, st, delay) {
    if (stopped) return;
    const wait = delay ?? rowWait(st);
    st.nextLoadAt = Date.now() + wait;
    if (st.loadTimer || !visible.has(id)) return;
    st.loadTimer = setTimeout(() => {
      st.loadTimer = null;
      if (!stopped && !st.rowsLoaded) loadRows(id, st);
    }, wait);
  }

  function scheduleSubscribe(id, st) {
    if (stopped || st.subTimer || !visible.has(id)) return;
    st.subTimer = setTimeout(() => {
      st.subTimer = null;
      if (!stopped && granted === true) trackRows(id);
    }, SUB_RETRY_MS);
  }

  function trackRows(id) {
    if (stopped || granted !== true) return;
    const st = ensureState(id);
    if (tracked.has(id)) {
      if (!st.rowsLoaded) loadRows(id, st);
      return;
    }
    tracked.add(id);
    try {
      const d = ctx.sessions.onDidChangeRows(
        { sessionId: id },
        (ev) => {
          if (stopped || !ev) return;
          if (ev.kind === "reset") {
            // 先算到临时状态：reset 自带的行不完整时，保留原有统计与实时值。
            const next = newSpeedState();
            next.live = st.live;
            for (const r of ev.rows ?? []) applySpeedRow(next, r);
            if (next.currentTurn || next.rowAvg) Object.assign(st, next, { rowsLoaded: true });
            else st.rowsLoaded = true;
            st.rowFailures = 0;
            scheduleRender(id);
          } else if (ev.kind === "rows") {
            for (const r of ev.upserted ?? []) applySpeedRow(st, r);
            scheduleRender(id);
          } else if (ev.kind === "stale") {
            loadRows(id, st);
          }
        },
        (e) => {
          // 行流断开不影响实时值：只标记 broken，之后按可见性重连。
          st.rowsBroken = true;
          tracked.delete(id);
          log("warn", `rows stream ended, realtime path kept: ${describe(e)}`);
          scheduleSubscribe(id, st);
        },
      );
      disposers.push(d);
    } catch (e) {
      st.rowsBroken = true;
      tracked.delete(id);
      log("warn", `onDidChangeRows failed, realtime path kept: ${describe(e)}`);
      scheduleSubscribe(id, st);
    }
    if (!st.rowsLoaded) loadRows(id, st);
  }

  function trackVisible() {
    if (granted !== true) return;
    for (const id of visible) trackRows(id);
  }

  async function ensureGrant() {
    if (granted !== null) return granted;
    grantAttempts += 1;
    try {
      const r = await ctx.grants.request();
      granted = Array.isArray(r?.granted) && r.granted.includes("sessions.read");
      log("info", `sessions.read grant: ${granted}`);
    } catch (e) {
      log("warn", `grants.request failed: ${describe(e)}`);
      if (e?.code === "host-unavailable" && grantAttempts < 3) {
        granted = null;
        setTimeout(() => {
          ensureGrant()
            .then(() => {
              trackVisible();
              renderAll();
            })
            .catch(() => {});
        }, 5000);
        return false;
      }
      granted = false;
    }
    return granted;
  }

  // 可见会话只用来“预热”历史值；渲染不再依赖可见性，避免漏掉事件所属会话。
  const visible = new Set();
  function adoptVisible(list) {
    const prev = new Set(visible);
    visible.clear();
    for (const s of Array.isArray(list) ? list : []) {
      if (s && typeof s.sessionId === "string") {
        visible.add(s.sessionId);
        const st = ensureState(s.sessionId);
        if (!prev.has(s.sessionId)) st.nextLoadAt = 0; // 重新可见时立即补读，不等退避
      }
    }
    trackVisible();
    renderAll();
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
      renderAll(true);
    })
    .catch(() => {});

  try {
    disposers.push(
      ctx.env.onDidChange((r) => {
        const next = isZhLocale(r?.locale);
        if (next === zh) return;
        zh = next;
        for (const st of sessions.values()) st.lastKey = "";
        renderAll(true);
      }),
    );
  } catch (e) {
    log("warn", `env.onDidChange failed: ${describe(e)}`);
  }

  try {
    disposers.push(
      ctx.workbench.onDidChange(
        (ev) => adoptVisible(ev?.sessions),
        (e) => log("warn", `workbench stream ended: ${describe(e)}`),
      ),
    );
  } catch (e) {
    log("warn", `workbench.onDidChange failed: ${describe(e)}`);
  }

  try {
    disposers.push(
      ctx.models.onDidGenerate(
        (ev) => {
          if (stopped || !ev || typeof ev.sessionId !== "string") return;
          const st = ensureState(ev.sessionId);
          if (!applySpeedEvent(st, ev, Date.now())) return;
          log("info", `speed event ${ev.sessionId} ${ev.phase} ${ev.outputTokensPerSecond}`);
          if (ev.phase === "final") {
            render(ev.sessionId);
            schedulePersist();
          } else {
            scheduleRender(ev.sessionId);
          }
          if (granted === true) trackRows(ev.sessionId);
        },
        (e) => log("warn", `models stream ended: ${describe(e)}`),
      ),
    );
  } catch (e) {
    log("warn", `models.onDidGenerate failed: ${describe(e)}`);
  }

  (async () => {
    await loadStore();
    renderAll();
    try {
      adoptVisible(await ctx.workbench.visibleSessions());
    } catch (e) {
      log("warn", `visibleSessions failed: ${describe(e)}`);
    }
    await ensureGrant();
    trackVisible();
    renderAll();
  })().catch((e) => log("error", `init failed: ${describe(e)}`));

  // 宿主持久化被清空时（重启、热重载）用回填值重写，确保芯片常驻。
  heartbeat = setInterval(() => {
    if (stopped) return;
    for (const id of visible) render(id, true);
  }, HEARTBEAT_MS);

  cleanup = () => {
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistSync();
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
    tracked.clear();
    visible.clear();
  };
}
