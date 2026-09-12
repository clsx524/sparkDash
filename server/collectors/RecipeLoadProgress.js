/**
 * RecipeLoadProgress — estimate how far a recipe switch's cold model load has gotten,
 * for a progress bar during `switchRecipe`'s `health-checking` phase (see recipeActions.js).
 *
 * Two independent signal sources, in order of preference:
 *
 * 1. Log-tail parsing. Weight loaders (vLLM's safetensors loader, MiniMax H3's own loader,
 *    ...) print a standard tqdm-style progress line while reading shards off disk, e.g.:
 *      "Loading safetensors checkpoint shards:  45%|####      | 9/20 [01:23<01:42,  8.19s/it]"
 *      "Multi-thread loading shards: 15% Completed | 2/13 [00:21:20, 10.56s/it]"
 *    Both match `(\d+)%.*?(\d+)/(\d+)`. This is the real signal, not an estimate — while
 *    shards are loading it is exact. ETA is derived from our own elapsed time and shard
 *    count rather than parsing tqdm's own bracket text, since that text's format is not
 *    guaranteed to be the same across every recipe's loader (linear extrapolation from
 *    "this many shards took this long" is equivalent and format-independent).
 *
 * 2. Historical average. Once shards are done (or for a recipe/node whose loader never
 *    prints a parseable line — no assumption is made that every recipe does), there is no
 *    log signal left, only unstructured init: CUDA graph capture, KV cache allocation,
 *    warmup. For that stretch, and as the sole signal for a node with no parseable log at
 *    all, fall back to `elapsed / historicalAverage` from past successful switches to the
 *    same recipe, clamped below 100% — it is an estimate, never claimed as a hard fact, and
 *    the caller marks it `source: "estimate"` so the UI can render it distinctly.
 *
 * If neither signal is available (first-ever switch to a recipe, before any shard line has
 * appeared), progress is honestly `null` rather than a fabricated number.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { sshExec } from "./ssh.js";

/** Matches both example formats above: percent, then a `current/total` shard count. */
const SHARD_PROGRESS_RE = /(\d+)%.*?(\d+)\/(\d+)/g;

/** How many lines of recent container output to scan for the last progress line. */
const LOG_TAIL_LINES = 20;

/** Keep at most this many past durations per recipe for the rolling average. */
const MAX_HISTORY_SAMPLES = 5;

/**
 * Parse the last shard-loading progress line out of raw `docker logs` text.
 * Returns null when no line in the tail matches (loader hasn't started yet, already
 * finished, or this recipe's loader does not print this format at all).
 *
 * @param {string} logText
 * @returns {{ percent: number, current: number, total: number } | null}
 */
export function parseShardProgress(logText) {
  if (typeof logText !== "string" || !logText) return null;
  let last = null;
  for (const m of logText.matchAll(SHARD_PROGRESS_RE)) {
    last = m;
  }
  if (!last) return null;
  const percent = Number(last[1]);
  const current = Number(last[2]);
  const total = Number(last[3]);
  if (!Number.isFinite(percent) || !Number.isFinite(current) || !Number.isFinite(total)) {
    return null;
  }
  return { percent: Math.min(100, Math.max(0, percent)), current, total };
}

/**
 * Tail one node's container log over SSH and parse its shard-loading progress, if any.
 * Never throws — a probe failure (container not up yet, SSH hiccup) is not fatal to the
 * switch itself, it just means no progress signal for this poll.
 *
 * @param {object} spark - Spark config for this node's role (see RecipeRegistry._sparkForNode)
 * @param {{ containerName?: string }} node
 * @returns {Promise<{ percent: number, current: number, total: number } | null>}
 */
export async function probeNodeShardProgress(spark, node) {
  if (!node?.containerName) return null;
  try {
    const out = await sshExec(spark, `docker logs --tail ${LOG_TAIL_LINES} ${node.containerName} 2>&1`, {
      timeoutMs: 8000,
    });
    return parseShardProgress(out);
  } catch {
    return null;
  }
}

/**
 * Combine a node's shard-progress reading (if any) with elapsed time into one estimate.
 *
 * @param {object} args
 * @param {{ percent: number, current: number, total: number } | null} args.shardProgress
 * @param {number} args.elapsedMs - time since this node's load started
 * @param {number | null} args.historicalAverageMs - past average total load time, if any
 * @returns {{ percent: number, etaSeconds: number | null, source: "log" | "estimate" } | null}
 */
export function estimateNodeProgress({ shardProgress, elapsedMs, historicalAverageMs }) {
  if (shardProgress) {
    const { percent, current, total } = shardProgress;
    // Linear extrapolation from observed rate: this many shards took this long, so the
    // remaining ones should take proportionally as long. Undefined until at least one
    // shard has landed.
    const etaSeconds =
      current > 0 && total > current
        ? Math.round(((elapsedMs / current) * (total - current)) / 1000)
        : null;
    return { percent, etaSeconds, source: "log" };
  }
  if (Number.isFinite(historicalAverageMs) && historicalAverageMs > 0) {
    const percent = Math.min(95, Math.round((elapsedMs / historicalAverageMs) * 100));
    const etaSeconds = Math.max(0, Math.round((historicalAverageMs - elapsedMs) / 1000));
    return { percent, etaSeconds, source: "estimate" };
  }
  return null;
}

/**
 * Average a set of per-node estimates into one number for the overall switch. Nodes with no
 * signal at all are excluded rather than treated as 0%, so one silent node does not drag an
 * otherwise-healthy readout down to a misleading half value.
 *
 * @param {Array<{ percent: number, etaSeconds: number | null, source: string } | null>} nodeEstimates
 * @returns {{ percent: number, etaSeconds: number | null, source: "log" | "estimate" } | null}
 */
export function combineNodeProgress(nodeEstimates) {
  const usable = nodeEstimates.filter(Boolean);
  if (!usable.length) return null;
  const percent = Math.round(usable.reduce((sum, e) => sum + e.percent, 0) / usable.length);
  const etas = usable.map((e) => e.etaSeconds).filter((s) => Number.isFinite(s));
  const etaSeconds = etas.length ? Math.max(...etas) : null;
  // "estimate" if ANY node is running on the historical fallback rather than a real log
  // signal — the combined number is only as trustworthy as its weakest input.
  const source = usable.some((e) => e.source === "estimate") ? "estimate" : "log";
  return { percent, etaSeconds, source };
}

function readHistory(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeHistoryAtomically(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Rolling average of past successful health-checking durations, per recipe id. Used as the
 * historical fallback in estimateNodeProgress once a node's shard-loading log signal is gone
 * (or never existed). Persisted so the estimate survives a server restart; loss of this file
 * only means falling back to "no estimate yet" for one switch, never a correctness issue.
 */
export class RecipeSwitchHistory {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this._data = readHistory(filePath);
  }

  /** @param {string} recipeId @returns {number | null} */
  averageMs(recipeId) {
    const samples = this._data[recipeId];
    if (!Array.isArray(samples) || !samples.length) return null;
    return samples.reduce((sum, v) => sum + v, 0) / samples.length;
  }

  /** @param {string} recipeId @param {number} durationMs */
  record(recipeId, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const samples = Array.isArray(this._data[recipeId]) ? this._data[recipeId] : [];
    const next = [...samples, durationMs].slice(-MAX_HISTORY_SAMPLES);
    this._data = { ...this._data, [recipeId]: next };
    try {
      writeHistoryAtomically(this.filePath, this._data);
    } catch (err) {
      console.error("[RecipeSwitchHistory] failed to persist:", err.message);
    }
  }
}
