// turn-stats-bar 状态栏注入器（CDP 方案）
// 连接 Codex 桌面应用（需以 --remote-debugging-port=9222 启动），
// 在输入框上方注入一条单行中文状态栏，数据按“当前对话”读 rollout 文件，
// 不依赖 MCP widget，避免空白块与串线程。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_PORT = process.env.TURN_STATS_CDP_PORT || "9224";
const HOST = `127.0.0.1:${CDP_PORT}`;
const POLL_MS = 2500;
const CODE_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const RATE_CARD_PATH = path.join(
  CODE_HOME,
  "codex-usage-tracker",
  "kernel-v1",
  "rate-card.json",
);
const SESSION_ROOTS = [
  path.join(CODE_HOME, "sessions"),
  path.join(CODE_HOME, "archived_sessions"),
];
const DEFAULT_MODEL = process.env.TURN_STATS_MODEL || "deepseek-v4-flash";

// ---------- 页面注入脚本（幂等，随 tick 重发） ----------
const INSTALL_SCRIPT = String.raw`
(function () {
  var VERSION = 7;
  if (window.__catStatuslineInstalled) {
    if (window.__catStatuslineVersion === VERSION) {
      try { window.__catStatuslineEnsure && window.__catStatuslineEnsure(); } catch (e) {}
      return;
    }
    try { if (window.__catStatuslineObserver) window.__catStatuslineObserver.disconnect(); } catch (e) {}
    var old = document.getElementById('cat-statusline');
    if (old) old.remove();
    var oldStyle = document.getElementById('cat-statusline-style');
    if (oldStyle) oldStyle.remove();
  }
  window.__catStatuslineVersion = VERSION;
  window.__catStatuslineInstalled = true;

  function ensureStyle() {
    if (document.getElementById('cat-statusline-style')) return;
    var st = document.createElement('style');
    st.id = 'cat-statusline-style';
    st.textContent =
      '#cat-statusline{display:block;padding:2px 10px 2px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;font-size:12px;line-height:1.5;color:var(--color-token-text-secondary,#9aa1aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;border-bottom:1px solid color-mix(in srgb,var(--color-token-border,rgba(128,128,128,.28)) 45%,transparent);user-select:none;z-index:2147483000}' +
      '#cat-statusline b{color:var(--color-token-text-primary,#e6e8eb);font-weight:600}' +
      '#cat-statusline .csl-off{opacity:.55}';
    (document.head || document.documentElement).appendChild(st);
  }

  function composerHost() {
    var pm = document.querySelector('.ProseMirror');
    if (pm) {
      var f = pm.closest('form');
      if (f) return f;
      var p = pm.parentElement;
      for (var i = 0; p && i < 6; i++, p = p.parentElement) {
        if (p.querySelector && p.querySelector('button[class*="size-token-button-compose"]')) return p;
      }
    }
    var send = document.querySelector('button[class*="size-token-button-compose"]');
    if (send) {
      var c = send.closest('form') || send.parentElement;
      return c;
    }
    return null;
  }

  function ensure() {
    var node = document.getElementById('cat-statusline');
    if (!node) {
      node = document.createElement('div');
      node.id = 'cat-statusline';
      node.textContent = '— · — · 缓存命中 —% · 上下文 —/— — · 输入→输出 —→—';
    }
    // 没有输入框 = 不在对话页（首页/设置/归档等）→ 隐藏状态栏
    if (!document.querySelector('.ProseMirror')) {
      node.style.display = 'none';
      return;
    }
    node.style.display = '';
    var host = composerHost();
    if (host) {
      var container = host.parentNode;
      if (node.parentNode !== container || node.nextSibling !== host) {
        container.insertBefore(node, host);
      }
      node.style.position = '';
      node.style.left = '';
      node.style.right = '';
      node.style.bottom = '';
      node.classList.remove('csl-fixed');
    } else {
      // 兜底：悬浮在底部输入区上方，避免完全消失
      node.style.position = 'fixed';
      node.style.left = '0';
      node.style.right = '0';
      node.style.bottom = '96px';
      if (!document.body.contains(node)) document.body.appendChild(node);
      node.classList.add('csl-fixed');
    }
  }

  window.__catStatuslineEnsure = ensure;
  window.__catStatuslineUpdate = function (text, convId) {
    var node = document.getElementById('cat-statusline');
    if (!node) return;
    if (convId != null && resolveConvId() !== convId) return;
    if (node.textContent !== String(text)) node.textContent = String(text);
  };
  window.__catStatuslineSetOffline = function (off) {
    var node = document.getElementById('cat-statusline');
    if (node) node.classList.toggle('csl-off', !!off);
  };

  ensureStyle();
  ensure();
  // 只创建一次 observer；用 rAF 合并高频 DOM 变化，避免切换对话时反复重挂状态栏
  if (!window.__catStatuslineObserver || window.__catStatuslineObserverVersion !== VERSION) {
    if (window.__catStatuslineObserver) {
      try { window.__catStatuslineObserver.disconnect(); } catch (e) {}
    }
    var ensurePending = false;
    function scheduleEnsure() {
      if (ensurePending) return;
      ensurePending = true;
      (window.requestAnimationFrame || function (cb) { setTimeout(cb, 50); })(function () {
        ensurePending = false;
        try { ensure(); } catch (e) {}
      });
    }
    window.__catStatuslineObserver = new MutationObserver(scheduleEnsure);
    window.__catStatuslineObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.__catStatuslineObserverVersion = VERSION;
  }

  // ---------- 读取当前对话（React fiber，来自 codex-app-transfer 验证过的方案） ----------
  var __CONVID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function fiberOf(el) {
    if (!el) return null;
    for (var k in el) { if (k.indexOf('__reactFiber$') === 0) return el[k]; }
    return null;
  }
  function convIdFromFiber(start) {
    if (!start) return null;
    var f = fiberOf(start), n = 0;
    while (f && n < 40) {
      var bags = [f.memoizedProps, f.memoizedState];
      for (var b = 0; b < bags.length; b++) {
        var bag = bags[b];
        if (bag && typeof bag === 'object') {
          for (var key in bag) {
            if (key === 'conversationId' || /[Cc]onversationId$/.test(key)) {
              var v = bag[key];
              if (typeof v === 'string' && __CONVID_RE.test(v)) return v;
            }
          }
        }
      }
      f = f.return; n++;
    }
    return null;
  }
  function sidebarConvId() {
    try {
      var active = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
      if (active) {
        var raw = active.getAttribute('data-app-action-sidebar-thread-id') || '';
        var id = raw.replace(/^local:/, '');
        if (__CONVID_RE.test(id)) return id;
      }
    } catch (e) {}
    return null;
  }
  function fiberConvId() {
    try {
      var pm = document.querySelector('.ProseMirror');
      var start = pm;
      for (var depth = 0; start && depth < 20; depth++, start = start.parentElement) {
        var f = fiberOf(start);
        if (!f) continue;
        var id = null;
        var n = 0;
        while (f && n < 120) {
          var bags = [f.memoizedProps, f.memoizedState];
          for (var b = 0; b < bags.length; b++) {
            var bag = bags[b];
            if (bag && typeof bag === 'object') {
              for (var key in bag) {
                if (key === 'conversationId' || /[Cc]onversationId$/.test(key)) {
                  var v = bag[key];
                  if (typeof v === 'string' && __CONVID_RE.test(v)) id = v;
                }
              }
            }
          }
          if (id) break;
          f = f.return; n++;
        }
        if (id) return id;
      }
    } catch (e) {}
    return null;
  }
  // 双来源校验：都存在且一致才用；若仅有一个来源（新对话尚未生成侧边栏条目等），
  // 用唯一来源；两个来源都存在但不一致 → null（fail-closed，绝不串对话）
  function resolveConvId() {
    var a = sidebarConvId();
    var b = fiberConvId();
    if (a && b) return a === b ? a : null;
    return a || b || null;
  }
  function readCtxUsage() {
    try {
      var ring = document.querySelector('[aria-label^="Context usage:"]');
      if (!ring) return null;
      var f = fiberOf(ring), n = 0;
      while (f && n < 25) {
        var bags = [f.memoizedProps, f.memoizedState];
        for (var b = 0; b < bags.length; b++) {
          var bag = bags[b];
          if (bag && typeof bag === 'object') {
            for (var key in bag) {
              var v = bag[key];
              if (v && typeof v === 'object' &&
                  typeof v.usedTokens === 'number' && typeof v.contextWindow === 'number') {
                return { used: v.usedTokens, win: v.contextWindow };
              }
            }
          }
        }
        f = f.return; n++;
      }
    } catch (e) {}
    return null;
  }

  // ---------- 实时 tps：监听对话流文本增量（2s 滑窗，字符→token 粗估） ----------
  if (!window.__catStatuslineTpsObs) {
    var lastText = '';
    var lastAt = 0;
    var lastTps = null;
    function sample() {
      var scroller = document.querySelector('[data-testid^="conversation"], [class*="thread"]');
      var text = scroller ? (scroller.innerText || '') : '';
      var now = Date.now();
      if (lastAt) {
        var dt = (now - lastAt) / 1000;
        var d = Math.max(0, text.length - lastText.length);
        if (dt > 0.5 && dt < 10 && d > 0) {
          lastTps = Math.round((d / dt) * 0.6); // 中文≈0.6 token/字
        }
      }
      lastText = text;
      lastAt = now;
      window.__lastStatuslineTps = lastTps;
    }
    window.__catStatuslineTpsObs = new MutationObserver(function () {
      var now = Date.now();
      if (now - (window.__catStatuslineLastSampleAt || 0) >= 2000) {
        window.__catStatuslineLastSampleAt = now;
        sample();
      }
    });
    var root = document.body || document.documentElement;
    window.__catStatuslineTpsObs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  window.__catStatuslineRead = function () {
    var a = sidebarConvId();
    var b = fiberConvId();
    return {
      convId: resolveConvId(),
      sidebarId: a,
      fiberId: b,
      confident: !!(a && b && a === b),
      ctx: readCtxUsage(),
      lastTps: window.__lastStatuslineTps || null,
    };
  };
})();
`;

// ---------- rollout 解析 ----------
function walkFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

function findRollout(convId) {
  const files = [];
  for (const root of SESSION_ROOTS) walkFiles(root, files);
  const suffix = `-${convId}.jsonl`;
  const matches = files.filter((f) => f.endsWith(suffix));
  if (!matches.length) return null;
  matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return matches[0];
}

// rollout 缓存：按 convId 缓存路径与解析结果，文件 mtime 未变则不再重读
const rolloutCache = new Map();
function loadRollout(convId) {
  const cached = rolloutCache.get(convId);
  if (cached) {
    try {
      if (statSync(cached.path).mtimeMs === cached.mtimeMs) return cached;
    } catch {
      // file gone: fall through and re-resolve
    }
  }
  const path = findRollout(convId);
  if (!path) {
    rolloutCache.delete(convId);
    return null;
  }
  const entry = { path, mtimeMs: statSync(path).mtimeMs, parsed: parseRollout(path) };
  rolloutCache.set(convId, entry);
  return entry;
}

function readRateCard() {
  try {
    const raw = readFileSync(RATE_CARD_PATH, "utf8");
    const card = JSON.parse(raw);
    return card.models || {};
  } catch {
    return {};
  }
}

function parseRollout(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let total = null;
  let last = null;
  let contextWindow = null;
  let sessionId = null;
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session_meta") {
      if (!sessionId && obj.payload?.id) sessionId = obj.payload.id;
      continue;
    }
    if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;
    const info = obj.payload.info || {};
    if (info.model_context_window) contextWindow = info.model_context_window;
    if (info.total_token_usage) total = info.total_token_usage;
    if (info.last_token_usage) last = info.last_token_usage;
  }
  return { total, last, contextWindow, sessionId };
}

function fmtK(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e5) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtCny(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n === 0) return "¥0";
  if (n < 0.01) return "≈¥" + n.toFixed(5);
  return "¥" + n.toFixed(2);
}

function costOf(usage, rates) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (input === 0 && output === 0) return null;
  const r = rates[DEFAULT_MODEL] || {};
  const inRateRaw = Number(r.input_per_million);
  const cachedRateRaw = Number(r.cached_input_per_million);
  const outRateRaw = Number(r.output_per_million);
  const inRate = Number.isFinite(inRateRaw) ? inRateRaw : 1;
  const cachedRate = Number.isFinite(cachedRateRaw) ? cachedRateRaw : 0.02;
  const outRate = Number.isFinite(outRateRaw) ? outRateRaw : 2;
  return ((input - cached) * inRate + cached * cachedRate + output * outRate) / 1e6;
}

function cachePct(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  if (input <= 0) return null;
  return (100 * cached) / input;
}

function buildLine(convId, ctx, tps, rates) {
  const entry = convId ? loadRollout(convId) : null;
  const rollout = entry?.path ?? null;
  let parsed = entry?.parsed ?? { total: null, last: null, contextWindow: null, sessionId: null };
  // 严格身份校验：文件内 session_meta.id 必须等于当前对话，否则按无数据处理
  if (parsed.sessionId && parsed.sessionId !== convId) {
    parsed = { total: null, last: null, contextWindow: null, sessionId: null };
  }
  const last = parsed.last || {};
  const total = parsed.total || {};
  // 上下文兜底：最新请求输入量 ≈ 当前上下文已用，窗口取 token_count 的 model_context_window
  const ctxUsed = ctx?.used ?? (Number(last.input_tokens) > 0 ? Number(last.input_tokens) : null);
  const ctxWin = ctx?.win ?? (Number(parsed.contextWindow) > 0 ? Number(parsed.contextWindow) : null);
  const effCtx = ctxUsed !== null && ctxWin !== null ? { used: ctxUsed, win: ctxWin } : ctx;
  const cache = cachePct(last);
  const costLast = costOf(last, rates);
  const costTotal = costOf(total, rates);
  const hasLast = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0) > 0;

  const parts = [
    DEFAULT_MODEL,
    tps ? `≈${tps} tps` : "—",
    cache === null ? "缓存 —%" : `缓存 ${Math.round(cache)}%`,
  ];
  if (effCtx && effCtx.win) {
    const used = Number(effCtx.used) || 0;
    const win = Number(effCtx.win) || 0;
    const pct = win > 0 ? (100 * used) / win : null;
    parts.push(`上下文 ${fmtK(used)}/${fmtK(win)} ${pct === null ? "—" : Math.round(pct) + "%"}`);
  } else {
    parts.push("上下文 —/—");
  }
  parts.push(hasLast ? `${fmtK(last.input_tokens)}→${fmtK(last.output_tokens)}` : "—→—");
  parts.push(`本轮 ${costLast === null ? "—" : fmtCny(costLast)}`);
  parts.push(`线程 ${costTotal === null ? "—" : fmtCny(costTotal)}`);
  return { text: parts.join(" · "), hasData: !!(convId && rollout && last.input_tokens) };
}

// ---------- CDP 客户端 ----------
let ws = null;
let msgId = 0;
const pending = new Map();

async function getWsUrl() {
  const res = await fetch(`http://${HOST}/json`);
  const list = await res.json();
  const pages = (list || []).filter((t) => t.type === "page");
  // 主对话页是 app://-/index.html（无 initialRoute/avatar-overlay）；头像浮层不是目标。
  const page = pages.find((t) => !/avatar-overlay|initialRoute/.test(t.url || "")) || pages[0];
  if (!page) throw new Error("未找到 Codex 页面目标");
  return page.webSocketDebuggerUrl;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onopen = () => resolve(sock);
    sock.onerror = (e) => reject(new Error("CDP WebSocket 连接失败"));
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || "CDP error"));
        else p.resolve(m.result);
      }
    };
  });
}

async function send(method, params) {
  if (!ws) throw new Error("未连接");
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
    }, 10000);
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error");
  }
  return r.result?.value;
}

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const url = await getWsUrl();
  ws = await openWs(url);
}

// ---------- 主循环 ----------
let lastTps = null;
let activeConvId = null;
let pendingConvId = null;
let pendingCount = 0;

// 双来源一致时立即切换；单一来源需连续 2 次轮询稳定后才切换。切换瞬间清空 tps。
function resolveConv(candidate, confident) {
  if (candidate === activeConvId) {
    pendingConvId = null;
    pendingCount = 0;
    return activeConvId;
  }
  if (candidate !== null && confident) {
    activeConvId = candidate;
    pendingConvId = null;
    pendingCount = 0;
    lastTps = null;
    return activeConvId;
  }
  if (candidate !== null && candidate === pendingConvId) {
    pendingCount += 1;
    if (pendingCount >= 2) {
      activeConvId = candidate;
      pendingConvId = null;
      pendingCount = 0;
      lastTps = null;
      return activeConvId;
    }
    return null;
  }
  pendingConvId = candidate;
  pendingCount = candidate !== null ? 1 : 0;
  return null;
}

async function tick() {
  await ensureConnected();
  const read = await evaluate(
    `${INSTALL_SCRIPT}; window.__catStatuslineRead ? window.__catStatuslineRead() : null;`,
  );
  if (read?.lastTps) lastTps = read.lastTps;
  const convId = resolveConv(read?.convId ?? null, read?.confident === true);
  const ctx = read?.ctx || null;
  const rates = readRateCard();
  const { text, hasData } = buildLine(convId, ctx, lastTps, rates);
  await evaluate(
    `window.__catStatuslineUpdate(${JSON.stringify(text)}, ${JSON.stringify(convId)}); window.__catStatuslineSetOffline(${hasData ? "false" : "true"});`,
  );
}

async function main() {
  console.log(`[turn-stats-bar] 注入器启动，等待 Codex 调试端口 ${CDP_PORT} ...`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      ws = null;
      console.log("[turn-stats-bar] 重试:", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
