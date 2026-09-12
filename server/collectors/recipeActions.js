/**
 * recipeActions — the recipe-switching state machine.
 *
 * Mirrors comfyActions.js's precedent (a recipe-level mutation action living outside the HTTP
 * route handler), scaled up to a multi-node, multi-minute operation: stop whatever recipe is
 * currently live, confirm it actually stopped, start the target recipe's node(s), then poll
 * each node's own API until it reports healthy. Every phase transition calls `onProgress` so
 * the caller (index.js) can push it over the WebSocket immediately — this can run for many
 * minutes (cold model loads), and a caller watching a static "in progress" spinner with no
 * detail is worse than no dashboard at all.
 *
 * Refuses to run a second switch concurrently and refuses to proceed on a detected conflict
 * (two recipes' nodes both reporting running at once) rather than guessing which one to stop.
 */
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { sshExec } from "./ssh.js";
import {
  probeNodeShardProgress,
  estimateNodeProgress,
  combineNodeProgress,
  RecipeSwitchHistory,
} from "./RecipeLoadProgress.js";
import { RECIPE_SWITCH_HISTORY_JSON_PATH } from "../config.js";

const STOP_TIMEOUT_MS = 60_000;
// Cold model loads on these recipes are measured in minutes (DeepSeek DSpark ~9 minutes,
// MiniMax H3 ~9 minutes) — this only bounds the launcher script itself; recipes whose
// start command already blocks until healthy (start.sh --launch, make up) return well before
// this fires. It exists so a truly hung launcher does not tie up the switch forever.
const START_TIMEOUT_MS = 30 * 60_000;
const STOP_CONFIRM_TIMEOUT_MS = 60_000;
const STOP_CONFIRM_POLL_MS = 3_000;
const HEALTH_TIMEOUT_MS = 15 * 60_000;
const HEALTH_POLL_MS = 5_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

export class RecipeSwitchError extends Error {}

/** Rolling history of past switch durations, used to estimate progress once a node's
 * shard-loading log signal is gone (or a recipe's loader never prints one at all). */
const switchHistory = new RecipeSwitchHistory(RECIPE_SWITCH_HISTORY_JSON_PATH);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RecipeSwitchError(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one recipe node's start/stop command over its own SSH connection. */
async function runNodeCommand(recipeRegistry, node, cmd, timeoutMs) {
  const spark = recipeRegistry._sparkForNode(node);
  if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
  return sshExec(spark, `cd ${node.workdir} && ${cmd}`, { timeoutMs, noBatch: true });
}

/** Poll one recipe node's health endpoint until it responds 200 or the deadline passes. */
async function waitForNodeHealth(recipeRegistry, node) {
  const spark = recipeRegistry._sparkForNode(node);
  if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
  const host = llmProbeHost(spark);
  if (!isAllowedTargetHost(host)) {
    throw new RecipeSwitchError(`Invalid or disallowed health-check host: ${host}`);
  }
  const url = `http://${host}:${node.llmPort}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new RecipeSwitchError(`${node.role} node never became healthy at ${url}: ${lastError}`);
}

/** Poll one recipe's own probeRecipe() until every node reports not-running, or the deadline passes. */
async function waitForRecipeStopped(recipeRegistry, recipe) {
  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  let probed = await recipeRegistry.probeRecipe(recipe);
  while (probed.active && Date.now() < deadline) {
    await sleep(STOP_CONFIRM_POLL_MS);
    probed = await recipeRegistry.probeRecipe(recipe);
  }
  if (probed.active) {
    throw new RecipeSwitchError(
      `${recipe.id} did not confirm stopped within ${STOP_CONFIRM_TIMEOUT_MS / 1000}s`
    );
  }
}

/**
 * Poll every target node's shard-loading progress (falling back to a historical-average
 * estimate once the log signal is gone) and report the combined result via `onProgress`,
 * until `isStopped()` returns true. Runs alongside `waitForNodeHealth` for the same nodes —
 * this never decides success/failure itself, only reports how far along the load looks.
 *
 * @param {import("./RecipeRegistry.js").RecipeRegistry} recipeRegistry
 * @param {object} target - the recipe being switched to
 * @param {number} startedAt - epoch ms when the start command was issued
 * @param {number | null} historicalAverageMs
 * @param {(progress: object) => void} onProgress
 * @param {() => boolean} isStopped
 */
async function pollSwitchProgress(recipeRegistry, target, startedAt, historicalAverageMs, onProgress, isStopped) {
  while (!isStopped()) {
    const nodeEstimates = await Promise.all(
      target.nodes.map(async (node) => {
        const spark = recipeRegistry._sparkForNode(node);
        if (!spark) return null;
        const shardProgress = await probeNodeShardProgress(spark, node);
        return estimateNodeProgress({
          shardProgress,
          elapsedMs: Date.now() - startedAt,
          historicalAverageMs,
        });
      })
    );
    if (isStopped()) return;
    const combined = combineNodeProgress(nodeEstimates);
    if (combined) onProgress(combined);
    await sleep(HEALTH_POLL_MS);
  }
}

let _switchInFlight = false;

/**
 * Switch the cluster to `targetId`. Stops whatever recipe is currently live (if different),
 * confirms the stop, starts the target's node(s), then waits for each to report healthy.
 *
 * @param {import("./RecipeRegistry.js").RecipeRegistry} recipeRegistry
 * @param {string} targetId
 * @param {(state: object) => void} onProgress - called on every phase transition
 * @returns {Promise<{ switched: boolean, from: string | null, to: string, alreadyActive?: boolean }>}
 */
export async function switchRecipe(recipeRegistry, targetId, onProgress) {
  if (_switchInFlight) {
    throw new RecipeSwitchError("a recipe switch is already in progress");
  }
  const target = recipeRegistry.get(targetId);
  if (!target) throw new RecipeSwitchError(`Unknown recipe: ${targetId}`);

  _switchInFlight = true;
  const emit = (phase, extra = {}) => {
    const state = { phase, targetId, startedAt: extra.startedAt, ...extra };
    try {
      onProgress?.(state);
    } catch {
      /* progress reporting must never abort the switch itself */
    }
  };

  try {
    emit("checking-current-state");
    const snapshot = await recipeRegistry.list();
    if (snapshot.conflict) {
      throw new RecipeSwitchError(
        `Cluster is in a conflicting state — recipes reporting running at once: ${snapshot.conflictIds.join(", ")}. Resolve manually (stop the stray one) before switching.`
      );
    }
    if (snapshot.activeId === targetId) {
      emit("already-active");
      return { switched: false, from: targetId, to: targetId, alreadyActive: true };
    }

    const current = snapshot.activeId ? recipeRegistry.get(snapshot.activeId) : null;

    if (current) {
      emit("stopping", { from: current.id });
      await withTimeout(
        Promise.all(current.nodes.map((n) => runNodeCommand(recipeRegistry, n, n.stopCmd, STOP_TIMEOUT_MS))),
        STOP_TIMEOUT_MS + 10_000,
        `stopping ${current.id} timed out`
      );

      emit("confirming-stopped", { from: current.id });
      await waitForRecipeStopped(recipeRegistry, current);
    }

    emit("starting", { from: current?.id ?? null });
    await withTimeout(
      Promise.all(target.nodes.map((n) => runNodeCommand(recipeRegistry, n, n.startCmd, START_TIMEOUT_MS))),
      START_TIMEOUT_MS + 10_000,
      `starting ${target.id} timed out`
    );

    emit("health-checking", { from: current?.id ?? null });
    const loadStartedAt = Date.now();
    const historicalAverageMs = switchHistory.averageMs(target.id);
    const progressStopped = { value: false };
    const progressLoop = pollSwitchProgress(
      recipeRegistry,
      target,
      loadStartedAt,
      historicalAverageMs,
      (progress) => emit("health-checking", { from: current?.id ?? null, progress }),
      () => progressStopped.value
    );
    try {
      await Promise.all(target.nodes.map((n) => waitForNodeHealth(recipeRegistry, n)));
    } finally {
      progressStopped.value = true;
      await progressLoop;
    }
    switchHistory.record(target.id, Date.now() - loadStartedAt);

    emit("done", { from: current?.id ?? null });
  } catch (err) {
    emit("failed", { error: err.message });
    throw err;
  } finally {
    _switchInFlight = false;
  }
}

export function isSwitchInFlight() {
  return _switchInFlight;
}
