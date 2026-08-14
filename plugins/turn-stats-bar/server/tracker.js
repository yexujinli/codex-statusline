import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RATE_CARD_SCHEMA = "codex-usage-tracker.kernel-rate-card.v1";
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RATE_FIELDS = [
  "input_per_million",
  "cached_input_per_million",
  "output_per_million",
  "credits_input_per_million",
  "credits_cached_input_per_million",
  "credits_output_per_million",
];
const CONFIDENCE_VALUES = new Set(["exact", "estimated", "user_override"]);
const MEASURES = [
  "calls",
  "input_tokens",
  "uncached_input_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
  "output_tokens",
  "cache_reuse",
  "context_pressure",
];

export function createClient(options = {}) {
  const autoStart = options.autoStart !== false;
  const home = os.homedir();
  const codexHome =
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex");
  const cacheRoot =
    options.cacheRoot ??
    process.env.CODEX_USAGE_TRACKER_CACHE_ROOT ??
    path.join(codexHome, "codex-usage-tracker", "kernel-v1");
  const rateCardFile =
    options.rateCardFile ?? path.join(cacheRoot, "rate-card.json");
  const baseUrl = (
    options.baseUrl ??
    process.env.TURN_STATS_TRACKER_URL ??
    "http://127.0.0.1:8765"
  ).replace(/\/+$/, "");
  const api = `${baseUrl}/api/kernel/v1`;

  let lastSourceMtime = 0;
  let lastRefreshMs = 0;
  let lastServiceStartMs = 0;

  async function requestJson(endpoint, { method = "GET", body } = {}) {
    const response = await fetch(`${api}${endpoint}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 240);
      } catch {
        // ignore body read errors
      }
      throw new Error(`tracker ${method} ${endpoint} -> ${response.status} ${detail}`);
    }
    return response.json();
  }

  async function trackerStatus() {
    try {
      return await requestJson("/status");
    } catch {
      return null;
    }
  }

  function resolveTrackerExe() {
    if (process.env.CODEX_USAGE_TRACKER_EXE) {
      return process.env.CODEX_USAGE_TRACKER_EXE;
    }
    const candidates = [
      path.join(home, ".local", "bin", "codex-usage-tracker.exe"),
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "pipx",
        "pipx",
        "venvs",
        "codex-usage-tracking",
        "Scripts",
        "codex-usage-tracker.exe",
      ),
      "codex-usage-tracker",
    ];
    for (const candidate of candidates) {
      if (candidate === "codex-usage-tracker") return candidate;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return "codex-usage-tracker";
  }

  async function ensureService() {
    if ((await trackerStatus()) !== null) return true;
    if (!autoStart) return false;
    const now = Date.now();
    if (now - lastServiceStartMs < 60_000) return false;
    lastServiceStartMs = now;
    try {
      const child = spawn(resolveTrackerExe(), ["service", "serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      return false;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if ((await trackerStatus()) !== null) return true;
    }
    return false;
  }

  async function latestSourceMtime() {
    let latest = 0;
    for (const root of [
      path.join(codexHome, "sessions"),
      path.join(codexHome, "archived_sessions"),
    ]) {
      try {
        const entries = await fs.promises.readdir(root, { recursive: true });
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          try {
            const stat = await fs.promises.stat(path.join(root, entry));
            if (stat.mtimeMs > latest) latest = stat.mtimeMs;
          } catch {
            // unreadable file: ignore
          }
        }
      } catch {
        // missing root: ignore
      }
    }
    return latest;
  }

  async function refreshIfNeeded() {
    const now = Date.now();
    if (now - lastRefreshMs < 2_000) return;
    const mtime = await latestSourceMtime();
    if (mtime <= lastSourceMtime) return;
    lastSourceMtime = mtime;
    lastRefreshMs = now;
    try {
      await requestJson("/refresh", {
        method: "POST",
        body: { wait_seconds: 3 },
      });
    } catch {
      // refresh failures are non-fatal; the committed snapshot stays readable
    }
  }

  async function runQuery(request) {
    const payload = await requestJson("/query", {
      method: "POST",
      body: { requests: [request] },
    });
    return payload.results?.[0] ?? null;
  }

  async function latestCall() {
    const result = await runQuery({
      dataset: "calls",
      operation: "rows",
      dimensions: ["turn", "model", "event_at"],
      measures: MEASURES,
      order_by: "event_at",
      descending: true,
      limit: 1,
    });
    return result?.rows?.[0] ?? null;
  }

  async function turnAggregate(turn) {
    if (!turn) return [];
    const result = await runQuery({
      dataset: "calls",
      operation: "aggregate",
      dimensions: ["thread", "turn", "model"],
      measures: MEASURES,
      filters: [{ field: "turn", operator: "eq", value: turn }],
      limit: 20,
    });
    return result?.rows ?? [];
  }

  async function threadAggregate(thread) {
    if (!thread) return [];
    const result = await runQuery({
      dataset: "calls",
      operation: "aggregate",
      dimensions: ["thread", "model"],
      measures: MEASURES,
      filters: [{ field: "thread", operator: "eq", value: thread }],
      limit: 50,
    });
    return result?.rows ?? [];
  }

  function readRateCard() {
    let raw;
    try {
      raw = fs.readFileSync(rateCardFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { status: "absent", card: null, reason: null };
      }
      return { status: "invalid", card: null, reason: "unreadable" };
    }
    try {
      const card = JSON.parse(raw);
      if (
        !card ||
        typeof card !== "object" ||
        card.schema !== RATE_CARD_SCHEMA ||
        !card.source ||
        typeof card.source !== "object" ||
        !card.models ||
        typeof card.models !== "object"
      ) {
        return { status: "invalid", card: null, reason: "schema" };
      }
      for (const [model, rates] of Object.entries(card.models)) {
        if (!MODEL_NAME.test(model) || !rates || typeof rates !== "object") {
          return { status: "invalid", card: null, reason: `model:${model}` };
        }
        if (
          !CONFIDENCE_VALUES.has(rates.confidence) ||
          !RATE_FIELDS.every((field) => isFiniteNonNegative(rates[field]))
        ) {
          return { status: "invalid", card: null, reason: `model:${model}` };
        }
      }
      return { status: "ready", card, reason: null };
    } catch {
      return { status: "invalid", card: null, reason: "json" };
    }
  }

  function configureRateCard(input) {
    const model = String(input.model ?? "").trim();
    if (!MODEL_NAME.test(model)) {
      throw new Error(`invalid model name: ${model || "(empty)"}`);
    }
    if (!CONFIDENCE_VALUES.has(input.confidence)) {
      throw new Error("confidence must be exact, estimated, or user_override");
    }
    const rates = {};
    for (const field of RATE_FIELDS) {
      if (!isFiniteNonNegative(input[field])) {
        throw new Error(`${field} must be a non-negative finite number`);
      }
      rates[field] = Number(input[field]);
    }
    const existing = readRateCard();
    if (existing.status === "invalid") {
      throw new Error(
        `existing rate card is invalid (${existing.reason}); fix rate-card.json first`,
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const card = existing.card ?? {
      schema: RATE_CARD_SCHEMA,
      source: {
        name: "Local user override",
        url: "https://example.invalid/local-user-override",
        effective_at: today,
        fetched_at: today,
      },
      models: {},
    };
    card.models[model] = {
      ...rates,
      confidence: input.confidence,
    };

    if (fs.existsSync(rateCardFile)) {
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      fs.copyFileSync(rateCardFile, `${rateCardFile}.bak-${stamp}`);
    }
    fs.mkdirSync(path.dirname(rateCardFile), { recursive: true });
    const tempFile = `${rateCardFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(card, null, 2) + "\n", "utf8");
    fs.renameSync(tempFile, rateCardFile);
    return {
      status: "ready",
      source: card.source,
      model_count: Object.keys(card.models).length,
      written: true,
    };
  }

  function estimateCost(rows, card) {
    const usageByModel = {};
    let totalTokens = 0;
    for (const row of rows) {
      const model = row.model ?? "unconfigured";
      const usage = (usageByModel[model] ??= {
        uncached_input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      });
      usage.uncached_input_tokens += Number(row.uncached_input_tokens ?? 0);
      usage.cached_input_tokens += Number(row.cached_input_tokens ?? 0);
      usage.output_tokens += Number(row.output_tokens ?? 0);
      const rowTotal =
        Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
      usage.total_tokens += rowTotal;
      totalTokens += rowTotal;
    }
    if (!card || rows.length === 0) {
      return {
        estimated_cost_usd: null,
        coverage_percent: totalTokens === 0 ? 100 : 0,
        rated_tokens: 0,
        total_tokens: totalTokens,
        unrated_models: Object.keys(usageByModel).sort(),
      };
    }
    let cost = 0;
    let ratedTokens = 0;
    const unratedModels = [];
    for (const [model, usage] of Object.entries(usageByModel)) {
      const rates = card.models[model];
      if (!rates) {
        if (model !== "unconfigured") unratedModels.push(model);
        continue;
      }
      ratedTokens += usage.total_tokens;
      cost +=
        (usage.uncached_input_tokens * rates.input_per_million +
          usage.cached_input_tokens * rates.cached_input_per_million +
          usage.output_tokens * rates.output_per_million) /
        1_000_000;
    }
    return {
      estimated_cost_usd: ratedTokens > 0 ? cost : null,
      coverage_percent: totalTokens === 0 ? 100 : (100 * ratedTokens) / totalTokens,
      rated_tokens: ratedTokens,
      total_tokens: totalTokens,
      unrated_models: unratedModels.sort(),
    };
  }

  function sumRows(rows) {
    const totals = {
      calls: 0,
      input_tokens: 0,
      uncached_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      output_tokens: 0,
    };
    for (const row of rows) {
      for (const key of Object.keys(totals)) {
        totals[key] += Number(row[key] ?? 0);
      }
    }
    totals.total_tokens = totals.input_tokens + totals.output_tokens;
    return totals;
  }

  function cacheReusePct(rows) {
    const totals = sumRows(rows);
    if (totals.input_tokens <= 0) return null;
    return (100 * totals.cached_input_tokens) / totals.input_tokens;
  }

  function contextFromRow(row) {
    if (!row) return null;
    const used = Number(row.input_tokens ?? 0);
    const pressure = Number(row.context_pressure ?? 0);
    const windowTokens = pressure > 0 ? used / pressure : null;
    return {
      used_tokens: used,
      pressure_pct: pressure > 0 ? pressure * 100 : null,
      window_tokens: windowTokens,
      remaining_tokens: windowTokens === null ? null : windowTokens - used,
    };
  }

  async function collectTurnStats() {
    const serviceUp = await ensureService();
    if (!serviceUp) {
      return {
        service: "stopped",
        state: "service_stopped",
        message: "codex-usage-tracker service is not reachable",
      };
    }
    await refreshIfNeeded();
    const status = await trackerStatus();
    const rateCard = readRateCard();
    const rateCardStatus = {
      status: rateCard.status,
      source: rateCard.card?.source ?? null,
      model_count: rateCard.card
        ? Object.keys(rateCard.card.models).length
        : null,
      reason: rateCard.reason ?? null,
    };
    const base = {
      service: "ok",
      state: "ready",
      generated_at: new Date().toISOString(),
      generation: status?.generation ?? null,
      rate_card: rateCardStatus,
    };
    if (!status?.generation) {
      return { ...base, state: "no_generation", message: "等待首次刷新" };
    }
    try {
      const latest = await latestCall();
      const turn = latest?.turn ?? null;
      const turnRows = turn ? await turnAggregate(turn) : [];
      const thread = turnRows[0]?.thread ?? latest?.thread ?? null;
      const threadRows = thread ? await threadAggregate(thread) : [];
      const card = rateCard.status === "ready" ? rateCard.card : null;
      const turnCost = estimateCost(turnRows, card);
      const threadCost = estimateCost(threadRows, card);
      return {
        ...base,
        model: latest?.model ?? null,
        thread,
        turn,
        latest_call: latest
          ? {
              event_at: latest.event_at ?? null,
              input_tokens: Number(latest.input_tokens ?? 0),
              cached_input_tokens: Number(latest.cached_input_tokens ?? 0),
              uncached_input_tokens: Number(latest.uncached_input_tokens ?? 0),
              output_tokens: Number(latest.output_tokens ?? 0),
            }
          : null,
        context: contextFromRow(latest),
        turn: {
          calls: sumRows(turnRows).calls,
          tokens: sumRows(turnRows),
          cache_reuse_pct: cacheReusePct(turnRows),
        },
        thread: {
          calls: sumRows(threadRows).calls,
          tokens: sumRows(threadRows),
          cache_reuse_pct: cacheReusePct(threadRows),
        },
        cost: {
          configured: card !== null,
          turn_estimated_usd: turnCost.estimated_cost_usd,
          thread_estimated_usd: threadCost.estimated_cost_usd,
          coverage_percent: Math.min(
            turnCost.coverage_percent,
            threadCost.coverage_percent,
          ),
          unrated_models: [
            ...new Set([...turnCost.unrated_models, ...threadCost.unrated_models]),
          ].sort(),
        },
      };
    } catch (error) {
      return {
        ...base,
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    collectTurnStats,
    configureRateCard,
    estimateCost,
    readRateCard,
    trackerStatus,
  };
}

function isFiniteNonNegative(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    !Number.isNaN(value)
  );
}
