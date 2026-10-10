import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseShardProgress,
  estimateNodeProgress,
  combineNodeProgress,
  RecipeSwitchHistory,
} from "../RecipeLoadProgress.js";

// ── parseShardProgress ──────────────────────────────────────────────────────

test("parses a standard vLLM/safetensors tqdm shard line", () => {
  const log =
    "Loading safetensors checkpoint shards:  45%|####      | 9/20 [01:23<01:42,  8.19s/it]";
  assert.deepEqual(parseShardProgress(log), { percent: 45, current: 9, total: 20 });
});

test("parses MiniMax H3's own 'Completed' wording", () => {
  const log = "Multi-thread loading shards: 15% Completed | 2/13 [00:21:20, 10.56s/it]";
  assert.deepEqual(parseShardProgress(log), { percent: 15, current: 2, total: 13 });
});

test("takes the LAST matching line, not the first, across multiple log lines", () => {
  const log = [
    "INFO some unrelated startup line",
    "Loading safetensors checkpoint shards:  10%|#  | 2/20 [00:10<01:30, 5.00s/it]",
    "Loading safetensors checkpoint shards:  50%|##### | 10/20 [00:50<00:50, 5.00s/it]",
  ].join("\n");
  assert.deepEqual(parseShardProgress(log), { percent: 50, current: 10, total: 20 });
});

test("returns null when no line matches (loader hasn't started, or never prints this format)", () => {
  assert.equal(parseShardProgress("container starting...\nno shard info here\n"), null);
  assert.equal(parseShardProgress(""), null);
  assert.equal(parseShardProgress(null), null);
});

// ── estimateNodeProgress ─────────────────────────────────────────────────────

test("a real shard-loading line yields an exact percent and a rate-based ETA", () => {
  const r = estimateNodeProgress({
    shardProgress: { percent: 50, current: 10, total: 20 },
    elapsedMs: 100_000, // 10 shards in 100s -> 10s/shard, 10 remaining -> 100s ETA
    historicalAverageMs: null,
  });
  assert.equal(r.source, "log");
  assert.equal(r.percent, 50);
  assert.equal(r.etaSeconds, 100);
});

test("no log signal falls back to elapsed / historical average, capped below 100%", () => {
  const r = estimateNodeProgress({
    shardProgress: null,
    elapsedMs: 450_000,
    historicalAverageMs: 500_000,
  });
  assert.equal(r.source, "estimate");
  assert.equal(r.percent, 90);
  assert.equal(r.etaSeconds, 50);
});

test("the historical estimate never claims 100% before health actually passes", () => {
  const r = estimateNodeProgress({
    shardProgress: null,
    elapsedMs: 600_000, // already past the historical average
    historicalAverageMs: 500_000,
  });
  assert.equal(r.source, "estimate");
  assert.equal(r.percent, 95, "clamped, not claiming completion the caller hasn't confirmed");
  assert.equal(r.etaSeconds, 0);
});

test("no log signal and no history yet -> honestly null, not a fabricated number", () => {
  assert.equal(
    estimateNodeProgress({ shardProgress: null, elapsedMs: 30_000, historicalAverageMs: null }),
    null
  );
});

// ── combineNodeProgress ──────────────────────────────────────────────────────

test("averages multiple nodes' estimates into one combined reading", () => {
  const combined = combineNodeProgress([
    { percent: 40, etaSeconds: 60, source: "log" },
    { percent: 60, etaSeconds: 30, source: "log" },
  ]);
  assert.equal(combined.percent, 50);
  assert.equal(combined.etaSeconds, 60, "takes the longer of the two ETAs");
  assert.equal(combined.source, "log");
});

test("a node with no signal is excluded rather than dragging the average to 0", () => {
  const combined = combineNodeProgress([{ percent: 80, etaSeconds: 10, source: "log" }, null]);
  assert.equal(combined.percent, 80);
});

test("any node running on the historical fallback marks the combined result as an estimate", () => {
  const combined = combineNodeProgress([
    { percent: 50, etaSeconds: 60, source: "log" },
    { percent: 50, etaSeconds: 60, source: "estimate" },
  ]);
  assert.equal(combined.source, "estimate");
});

test("all nodes silent -> null, not a fabricated combined reading", () => {
  assert.equal(combineNodeProgress([null, null]), null);
});

// ── RecipeSwitchHistory ──────────────────────────────────────────────────────

function tempHistoryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-switch-history-test-"));
  return path.join(dir, "history.json");
}

test("a recipe with no recorded switches has no average yet", () => {
  const h = new RecipeSwitchHistory(tempHistoryPath());
  assert.equal(h.averageMs("deepseek-dual"), null);
});

test("recording a duration makes it available as the average", () => {
  const h = new RecipeSwitchHistory(tempHistoryPath());
  h.record("deepseek-dual", 500_000);
  assert.equal(h.averageMs("deepseek-dual"), 500_000);
});

test("the average is a rolling window, not a single overwritten value", () => {
  const h = new RecipeSwitchHistory(tempHistoryPath());
  h.record("deepseek-dual", 400_000);
  h.record("deepseek-dual", 600_000);
  assert.equal(h.averageMs("deepseek-dual"), 500_000);
});

test("history is capped to the most recent samples, not an unbounded log", () => {
  const h = new RecipeSwitchHistory(tempHistoryPath());
  for (let i = 1; i <= 10; i++) h.record("deepseek-dual", i * 100_000);
  // Only the last 5 (600k..1000k) should count: average = 800k.
  assert.equal(h.averageMs("deepseek-dual"), 800_000);
});

test("recipes are tracked independently", () => {
  const h = new RecipeSwitchHistory(tempHistoryPath());
  h.record("deepseek-dual", 500_000);
  h.record("glm53-exl3", 300_000);
  assert.equal(h.averageMs("deepseek-dual"), 500_000);
  assert.equal(h.averageMs("glm53-exl3"), 300_000);
});

test("history persists across instances reading the same file", () => {
  const filePath = tempHistoryPath();
  new RecipeSwitchHistory(filePath).record("deepseek-dual", 500_000);
  const reloaded = new RecipeSwitchHistory(filePath);
  assert.equal(reloaded.averageMs("deepseek-dual"), 500_000);
});
