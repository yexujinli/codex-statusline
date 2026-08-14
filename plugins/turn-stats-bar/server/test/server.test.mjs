import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "../tracker.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turn-stats-bar-test-"));
}

test("rate card: absent when file missing", () => {
  const client = createClient({
    baseUrl: "http://127.0.0.1:59999",
    cacheRoot: tempDir(),
    autoStart: false,
  });
  assert.equal(client.readRateCard().status, "absent");
});

test("rate card: invalid JSON is invalid", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "rate-card.json"), "{not json", "utf8");
  const client = createClient({ cacheRoot: dir, autoStart: false });
  assert.equal(client.readRateCard().status, "invalid");
});

test("rate card: wrong schema is invalid", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "rate-card.json"),
    JSON.stringify({ schema: "wrong", models: {} }),
    "utf8",
  );
  const client = createClient({ cacheRoot: dir, autoStart: false });
  assert.equal(client.readRateCard().status, "invalid");
});

test("rate card: configure creates card and backs up on update", () => {
  const dir = tempDir();
  const client = createClient({ cacheRoot: dir, autoStart: false });
  const first = client.configureRateCard({
    model: "gpt-example",
    input_per_million: 10,
    cached_input_per_million: 1,
    output_per_million: 20,
    credits_input_per_million: 5,
    credits_cached_input_per_million: 0.5,
    credits_output_per_million: 10,
    confidence: "user_override",
  });
  assert.equal(first.status, "ready");
  assert.equal(first.model_count, 1);
  assert.equal(client.readRateCard().status, "ready");

  const second = client.configureRateCard({
    model: "gpt-other",
    input_per_million: 1,
    cached_input_per_million: 0.1,
    output_per_million: 2,
    credits_input_per_million: 1,
    credits_cached_input_per_million: 0.1,
    credits_output_per_million: 2,
    confidence: "estimated",
  });
  assert.equal(second.model_count, 2);
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("rate-card.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(client.readRateCard().card.models["gpt-example"].confidence, "user_override");
});

test("rate card: rejects invalid input", () => {
  const client = createClient({ cacheRoot: tempDir(), autoStart: false });
  assert.throws(
    () =>
      client.configureRateCard({
        model: "bad model!",
        confidence: "user_override",
        input_per_million: 1,
        cached_input_per_million: 0,
        output_per_million: 1,
        credits_input_per_million: 0,
        credits_cached_input_per_million: 0,
        credits_output_per_million: 0,
      }),
    /invalid model name/,
  );
  assert.throws(
    () =>
      client.configureRateCard({
        model: "gpt-x",
        confidence: "nope",
        input_per_million: 1,
        cached_input_per_million: 0,
        output_per_million: 1,
        credits_input_per_million: 0,
        credits_cached_input_per_million: 0,
        credits_output_per_million: 0,
      }),
    /confidence/,
  );
  assert.throws(
    () =>
      client.configureRateCard({
        model: "gpt-x",
        confidence: "exact",
        input_per_million: -1,
        cached_input_per_million: 0,
        output_per_million: 1,
        credits_input_per_million: 0,
        credits_cached_input_per_million: 0,
        credits_output_per_million: 0,
      }),
    /input_per_million/,
  );
});

test("rate card: refuses to overwrite an invalid existing card", () => {
  const dir = tempDir();
  const file = path.join(dir, "rate-card.json");
  fs.writeFileSync(file, "broken", "utf8");
  const client = createClient({ cacheRoot: dir, autoStart: false });
  assert.throws(
    () =>
      client.configureRateCard({
        model: "gpt-x",
        confidence: "exact",
        input_per_million: 1,
        cached_input_per_million: 0,
        output_per_million: 1,
        credits_input_per_million: 0,
        credits_cached_input_per_million: 0,
        credits_output_per_million: 0,
      }),
    /invalid/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "broken");
});

test("cost: matches the tracker formula and reports unrated models", () => {
  const dir = tempDir();
  const client = createClient({ cacheRoot: dir, autoStart: false });
  client.configureRateCard({
    model: "gpt-example",
    input_per_million: 10,
    cached_input_per_million: 1,
    output_per_million: 20,
    credits_input_per_million: 5,
    credits_cached_input_per_million: 0.5,
    credits_output_per_million: 10,
    confidence: "exact",
  });
  const card = client.readRateCard().card;
  const rows = [
    {
      model: "gpt-example",
      input_tokens: 1_000_000,
      uncached_input_tokens: 1_000_000,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
    {
      model: "other-model",
      input_tokens: 0,
      uncached_input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 500_000,
    },
  ];
  const result = client.estimateCost ? client.estimateCost(rows, card) : null;
  assert.ok(result);
  assert.equal(result.estimated_cost_usd, 10);
  assert.ok(Math.abs(result.coverage_percent - (1_000_000 / 1_500_000) * 100) < 1e-9);
  assert.deepEqual(result.unrated_models, ["other-model"]);
});

test("collectTurnStats: reports stopped service when tracker is down", async () => {
  const client = createClient({
    baseUrl: "http://127.0.0.1:59999",
    cacheRoot: tempDir(),
    autoStart: false,
  });
  const stats = await client.collectTurnStats();
  assert.equal(stats.service, "stopped");
  assert.equal(stats.state, "service_stopped");
});

async function trackerIsLive() {
  try {
    const response = await fetch("http://127.0.0.1:8765/api/kernel/v1/status", {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await trackerIsLive();

test(
  "collectTurnStats: integration with the live local tracker",
  { skip: live ? false : "local tracker service is not running" },
  async () => {
    const client = createClient({ autoStart: false });
    const stats = await client.collectTurnStats();
    assert.equal(stats.service, "ok");
    assert.ok(["ready", "no_generation"].includes(stats.state));
    if (stats.state === "ready") {
      assert.equal(typeof stats.generation, "number");
      assert.ok(stats.turn);
      assert.ok(stats.thread);
      assert.ok("cache_reuse_pct" in stats.turn);
      assert.ok("cost" in stats);
      assert.ok(stats.rate_card);
    }
  },
);
