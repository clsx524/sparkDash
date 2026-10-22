/**
 * recipeActions — the recipe-switching state machine.
 *
 * Mirrors comfyActions.js's precedent (a recipe-level mutation action living outside the HTTP
 * route handler), scaled up to a multi-node, multi-minute operation: sync each node's model
 * (using rsync quick-check, without hashing weights), stop whatever recipe is currently live,
 * confirm it actually stopped, start the target recipe's node(s), then poll each node's own
 * API until it reports healthy. Every phase transition calls `onProgress` so the caller
 * (index.js) can push it over the WebSocket immediately — this can run for many minutes (cold
 * model loads, multi-hundred-GB syncs), and a caller watching a static "in progress" spinner
 * with no detail is worse than no dashboard at all.
 *
 * Refuses to run a second switch concurrently and refuses to proceed on a detected conflict
 * (two recipes' nodes both reporting running at once) rather than guessing which one to stop.
 */
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { sshExec } from "./ssh.js";
import { syncModelToSpark } from "./modelSync.js";
import {
  probeNodeShardProgress,
  estimateNodeProgress,
  combineNodeProgress,
  RecipeSwitchHistory,
} from "./RecipeLoadProgress.js";
import { RECIPE_SWITCH_HISTORY_JSON_PATH } from "../config.js";
import { setTimeout as delay } from "node:timers/promises";
import { abortable, settleAll } from "../util/abort.js";

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
// Model syncs can move hundreds of GB between hosts — hours, not minutes.
const MODEL_SYNC_PHASE_TIMEOUT_MS = 6 * 60 * 60_000;
const READINESS_TIMEOUT_MS = 5 * 60_000;
const READINESS_POLL_MS = 2_000;

export class RecipeSwitchError extends Error {}

/** Rolling history of past switch durations, used to estimate progress once a node's
 * shard-loading log signal is gone (or a recipe's loader never prints one at all). */
const switchHistory = new RecipeSwitchHistory(RECIPE_SWITCH_HISTORY_JSON_PATH);

function sleep(ms, signal) {
  return delay(ms, undefined, { signal });
}

async function withTimeout(promise, ms, message, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RecipeSwitchError(message)), ms);
  });
  try {
    return await abortable(() => Promise.race([promise, timeout]), signal);
  } finally {
    clearTimeout(timer);
  }
}

function report(options, spark, text, stream = "action") {
  try {
    options.onLog?.({ stream, nodeId: spark?.id, nodeName: spark?.name || spark?.id, text });
  } catch {
    /* diagnostic subscribers cannot change deployment behavior */
  }
}

/** Run one recipe node's start/stop command over its own SSH connection. */
async function runNodeCommand(recipeRegistry, node, cmd, timeoutMs, options, action) {
  options.signal?.throwIfAborted();
  const spark = recipeRegistry._sparkForNode(node);
  if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
  report(options, spark, `${action} from ${node.workdir}`);
  try {
    const result = await sshExec(spark, `cd ${node.workdir} && ${cmd}`, {
      timeoutMs,
      signal: options.signal, cancelRemote: true,
      onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined,
    });
    options.signal?.throwIfAborted();
    report(options, spark, `${action} command completed (exit 0)`);
    return result;
  } catch (err) {
    report(options, spark, options.signal?.aborted
      ? `${action} cancelled; attached command stopped`
      : `${action} failed${err.exitCode != null ? ` (exit ${err.exitCode})` : ""}: ${err.message}`);
    throw err;
  }
}

const CLEAR_CONTAINERS_TIMEOUT_MS = 30_000;
/** Containers that persist across every recipe switch — never touched by the sweep below.
 *  portainer_agent is the fleet's own persistent infrastructure. qwen3-embedding (spark1),
 *  semif (spark2), qwen3-tts (spark1) and qwen3-asr (spark2) are standalone always-on
 *  services, independent of whichever recipe is active — none is a recipe container
 *  (no recipes.json entry, no start.sh), so the sweep below treated them as unrecognized
 *  cruft on every recipe switch (confirmed live 2026-09-20: embedding and semif removed
 *  the moment GLM was reactivated). The rest are
 *  kernel-nfsd exporters (DSpark, deepseek-v41-flash-exl3, and any future recipe using the
 *  same "share weights over NFSv4 instead of copying them onto the worker" pattern) —
 *  every one of those recipes' own start scripts already prefers reusing a live exporter
 *  over rebuilding it (nfs_ensure_server()'s nfs_live_container() check), specifically
 *  because a privileged --network host container holding kernel-level NFS state (rpc.nfsd,
 *  /proc/fs/nfsd) can take Docker's kill well past its wait timeout even though it does
 *  genuinely exit — confirmed live 2026-09-14: every deepseek-v41-flash-exl3 retry hit
 *  "could not kill container: tried to kill container, but did not receive an exit event"
 *  because this sweep force-killed dsv41-exl3-nfs on every single attempt, throwing away
 *  the reuse path's entire point and re-triggering the same slow teardown each time. Only
 *  one kernel nfsd can ever be live host-wide regardless of which named container started
 *  it ("a second nfsd will not start" — see nfs-share.sh), so leaving a stray one running
 *  across a recipe switch can never itself conflict with whatever starts next. */
export const PERSISTENT_CONTAINER_NAMES = [
  "portainer_agent",
  "qwen3-embedding",
  "semif",
  "qwen3-tts",
  "qwen3-asr",
  "vllm-fn-nfs",
  "glm53-nfs",
  "dsv41-nfs",
  "dsv41-exl3-nfs",
  "dspark-nfs",
];

/**
 * Force-stop and remove every running container on online head/worker Sparks and
 * the target's required compute nodes, except the fleet's persistent infrastructure
 * (PERSISTENT_CONTAINER_NAMES above), regardless of live recipe detection.
 * Offline unrelated nodes are skipped, never contacted or woken by this sweep.
 *
 * Exists because that detection can be wrong (a runningPattern that doesn't match a
 * recipe's real status text, a crashed sparkDash losing track, a container started by
 * hand), and because several TP2 recipes only declare a head node in recipes.json — their
 * worker-side container on the other physical Spark is invisible to target.nodes entirely,
 * so a check scoped to just the target's own declared nodes would still miss it. Confirmed
 * live 2026-09-13: GLM's runningPattern ("running") never matched its actual `Up 8 hours`
 * status text, so the normal "stopping" phase below silently skipped it — both its head and
 * worker containers were still running (host networking, so `docker ps`'s own Ports column
 * shows nothing there either — port-based detection doesn't work for this fleet's
 * containers) when the next switch's start.sh hit "PORT=8888 is already bound" on the head
 * and a worker-container conflict on the other node.
 *
 * The target's explicit dependencies include all TP ranks, even when one head-side
 * launcher starts the whole cluster. Online head/worker nodes are also swept to
 * preserve conflict cleanup when moving between single-node and multi-node recipes.
 * Other tracked hosts (such as an unrelated Model Registry) are never swept.
 */
async function clearStaleContainers(recipeRegistry, requiredNodes, getOnline, options) {
  const requiredIds = new Set(requiredNodes.map((spark) => spark.id));
  const sparks = recipeRegistry.sparkRegistry.sparks.filter(
    (spark) => (requiredIds.has(spark.id) || spark.role === "head" || spark.role === "worker") &&
      getOnline(spark.id) === true
  );
  const excludeArgs = PERSISTENT_CONTAINER_NAMES.map((name) => `-e ${JSON.stringify(name)}`).join(" ");
  const sweepCmd = `docker ps --format '{{.Names}}' | grep -vx ${excludeArgs} | xargs -r docker rm -f`;
  await settleAll(
    sparks.map(async (spark) => {
      options.signal?.throwIfAborted();
      report(options, spark, "Clearing conflicting containers; preserving standalone services");
      await sshExec(spark, sweepCmd, {
        timeoutMs: CLEAR_CONTAINERS_TIMEOUT_MS,
        signal: options.signal, cancelRemote: true,
        onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined,
      });
      report(options, spark, "Container cleanup completed");
    })
  );
}

/**
 * Sync every node's tied models (recipe node's optional `modelIds` array, each referencing
 * a Model Registry entry) onto that node's own configured model folder. Already-staged
 * manifest files need only a target-side presence check; missing files use rsync's
 * size/mtime quick-check, never SHA256. Nodes with no modelIds are left alone. Syncs
 * run sequentially per model — two
 * large concurrent transfers to the same node would split one link's bandwidth across both
 * rather than actually finishing either sooner, and needlessly doubles concurrent SSH
 * connections against modelSync's own MaxStartups-conscious shard count.
 */
export async function syncModelsForRecipe(recipeRegistry, modelRegistry, recipe, options = {}) {
  for (const node of recipe.nodes) {
    options.signal?.throwIfAborted();
    const modelIds = Array.isArray(node.modelIds) ? node.modelIds : [];
    if (modelIds.length === 0) continue;
    if (!modelRegistry) {
      throw new RecipeSwitchError(
        `Recipe ${recipe.id} node ${node.role} references model(s) ${modelIds.join(", ")} but no Model Registry is configured`
      );
    }
    const spark = recipeRegistry._sparkForNode(node);
    if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
    for (const modelId of modelIds) {
      options.signal?.throwIfAborted();
      const model = modelRegistry.getModel(modelId);
      if (!model) {
        throw new RecipeSwitchError(`Recipe ${recipe.id} references unknown model ${modelId}`);
      }
      report(options, spark, `Checking staged files for ${modelId} (no checksum pass)`);
      const result = await syncModelToSpark(modelRegistry, model, spark, {
        verify: false,
        signal: options.signal,
        onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined,
      });
      report(options, spark, result.skipped
        ? `${modelId}: files already staged; registry access and transfer skipped`
        : `${modelId}: model files ready`);
    }
  }
}

/** Poll one recipe node's health endpoint until it responds 200 or the deadline passes. */
async function waitForNodeHealth(recipeRegistry, node, options) {
  const spark = recipeRegistry._sparkForNode(node);
  if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
  const host = llmProbeHost(spark);
  if (!isAllowedTargetHost(host)) {
    throw new RecipeSwitchError(`Invalid or disallowed health-check host: ${host}`);
  }
  const url = `http://${host}:${node.llmPort}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no attempt made";
  let reportedError = null;
  report(options, spark, `Waiting for serving health at ${url}`);
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS);
      const res = await fetch(url, { signal });
      options.signal?.throwIfAborted();
      if (res.ok) {
        report(options, spark, "Serving health passed (HTTP 200)");
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      options.signal?.throwIfAborted();
      lastError = err.message;
    }
    if (lastError !== reportedError) {
      report(options, spark, `Serving health not ready: ${lastError}`);
      reportedError = lastError;
    }
    await sleep(HEALTH_POLL_MS, options.signal);
  }
  throw new RecipeSwitchError(`${node.role} node never became healthy at ${url}: ${lastError}`);
}

/** Poll one recipe's own probeRecipe() until every node reports not-running, or the deadline passes. */
async function waitForRecipeStopped(recipeRegistry, recipe, options) {
  const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
  let probed = await abortable(() => recipeRegistry.probeRecipe(recipe, options), options.signal);
  while (probed.active && Date.now() < deadline) {
    await sleep(STOP_CONFIRM_POLL_MS, options.signal);
    probed = await abortable(() => recipeRegistry.probeRecipe(recipe, options), options.signal);
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
async function pollSwitchProgress(recipeRegistry, target, startedAt, historicalAverageMs, onProgress, isStopped, signal) {
  while (!isStopped() && !signal.aborted) {
    const nodeEstimates = await Promise.all(
      target.nodes.map(async (node) => {
        const spark = recipeRegistry._sparkForNode(node);
        if (!spark) return null;
        const shardProgress = await abortable(
          () => probeNodeShardProgress(spark, node, { signal }), signal,
        ).catch((error) => {
          if (signal.aborted) return null;
          throw error;
        });
        return estimateNodeProgress({
          shardProgress,
          elapsedMs: Date.now() - startedAt,
          historicalAverageMs,
        });
      })
    );
    if (isStopped() || signal.aborted) return;
    const combined = combineNodeProgress(nodeEstimates);
    if (combined) onProgress(combined);
    try {
      await delay(HEALTH_POLL_MS, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
}

async function checkRequiredNodes(requiredNodes, options) {
  const online = await Promise.all(requiredNodes.map(async (spark) => {
    options.signal?.throwIfAborted();
    const result = await abortable(() => options.checkOnlineNow(spark.id), options.signal);
    return typeof result === "boolean" ? result : options.getOnline(spark.id) === true;
  }));
  return requiredNodes.filter((_, index) => !online[index]);
}

/** Readiness never touches launchers or unrelated outlets, and never wakes twice. */
async function waitForRequiredNodes(requiredNodes, options, emit) {
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const timeoutMs = Math.min(options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS, READINESS_TIMEOUT_MS);
  const pollMs = options.readinessPollMs ?? READINESS_POLL_MS;
  const deadline = now() + timeoutMs;
  const names = requiredNodes.map((spark) => spark.name || spark.id);
  const timeoutMessage = () => `Required nodes did not become online within ${timeoutMs / 1000}s: ${names.join(", ")}`;
  const bounded = async (operation) => {
    options.signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new RecipeSwitchError(timeoutMessage());
    const result = await abortable(
      () => withTimeout(Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return operation();
      }), remaining, timeoutMessage(), options.signal), options.signal);
    if (now() > deadline) throw new RecipeSwitchError(timeoutMessage());
    options.signal?.throwIfAborted();
    return result;
  };
  const checkAll = () => bounded(() => checkRequiredNodes(requiredNodes, options));
  const lastOnline = new Map();
  const reportNodes = (pending) => {
    const offlineIds = new Set(pending.map((spark) => spark.id));
    for (const spark of requiredNodes) {
      const online = !offlineIds.has(spark.id);
      if (lastOnline.get(spark.id) !== online) {
        report(options, spark, online ? "Node is online over SSH" : "Node is offline; waiting for SSH");
        lastOnline.set(spark.id, online);
      }
    }
  };
  emit("checking-nodes", { requiredNodes: names });
  let pending = await checkAll();
  reportNodes(pending);
  if (pending.length) {
    if (typeof options.wakeNodes !== "function") {
      throw new RecipeSwitchError("Recipe node wake is not configured");
    }
    emit("powering-on", {
      requiredNodes: names,
      pendingNodes: pending.map((spark) => spark.name || spark.id),
    });
    await bounded(() => options.wakeNodes(pending));
    // Check every dependency again, including nodes that were initially online.
    pending = await checkAll();
    emit("waiting-online", {
      requiredNodes: names,
      pendingNodes: pending.map((spark) => spark.name || spark.id),
    });
    reportNodes(pending);
  }
  while (pending.length) {
    emit("waiting-online", {
      requiredNodes: names,
      pendingNodes: pending.map((spark) => spark.name || spark.id),
    });
    await bounded(() => pause(Math.min(pollMs, deadline - now()), options.signal));
    pending = await checkAll();
    reportNodes(pending);
    emit("waiting-online", {
      requiredNodes: names,
      pendingNodes: pending.map((spark) => spark.name || spark.id),
    });
  }
}

let _switchInFlight = false;

/**
 * Switch the cluster to `targetId`. Syncs each target node's tied model (if any), always stops
 * whatever recipe is currently live first — even when it is the same recipe as the target, so
 * "activate" is a full kill-and-redeploy-fresh, never a same-target no-op — confirms the stop,
 * force-clears any stray container the graceful stop above missed (see
 * clearStaleContainers — live probe detection or a head-only recipe definition can both leave
 * something running undetected), starts the target's node(s), then waits for each to report
 * healthy. Config (.env etc.) is ansible's job, applied ahead of time by the relevant playbook
 * run — this never generates or copies config, only starts/stops the node commands already
 * provisioned there.
 *
 * @param {import("./RecipeRegistry.js").RecipeRegistry} recipeRegistry
 * @param {import("./ModelRegistry.js").ModelRegistry | null} modelRegistry - null is fine for
 *   recipes whose nodes have no `modelId` tied to them
 * @param {string} targetId
 * @param {(state: object) => void} onProgress - called on every phase transition
 * @param {object} options - getOnline(id), checkOnlineNow(id), wakeNodes(sparks),
 *   isPowerActionInFlight(); optional now/sleep/readinessTimeoutMs/readinessPollMs
 *   allow deterministic readiness testing (timeout is capped at five minutes).
 *   `signal` stops remaining steps and attached commands; cancellation does not roll back
 *   power-on, copied weights, or already-detached services. Exclusivity lasts through unwind.
 * @returns {Promise<void>}
 */
export async function switchRecipe(recipeRegistry, modelRegistry, targetId, onProgress, options = {}) {
  if (_switchInFlight) {
    throw new RecipeSwitchError("a recipe switch is already in progress");
  }
  const target = recipeRegistry.get(targetId);
  if (!target) throw new RecipeSwitchError(`Unknown recipe: ${targetId}`);

  _switchInFlight = true;
  const controller = new AbortController();
  const requestedSignal = options.signal;
  const cancel = () => controller.abort(requestedSignal.reason);
  if (requestedSignal?.aborted) cancel();
  else requestedSignal?.addEventListener("abort", cancel, { once: true });
  options = { ...options, signal: controller.signal };
  const pending = new Set();
  const bounded = (operation, ms, message) => {
    options.signal.throwIfAborted();
    const task = Promise.resolve().then(() => {
      options.signal.throwIfAborted();
      return operation();
    });
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return withTimeout(task, ms, message, options.signal);
  };
  const emit = (phase, extra = {}) => {
    if (!["failed", "cancelled"].includes(phase)) options.signal.throwIfAborted();
    const state = { phase, targetId, startedAt: extra.startedAt, ...extra };
    try {
      onProgress?.(state);
    } catch {
      /* progress reporting must never abort the switch itself */
    }
  };

  try {
    emit("checking-nodes");
    if (options.isPowerActionInFlight?.()) {
      throw new RecipeSwitchError("a fleet power action is already in progress");
    }
    const requiredNodes = recipeRegistry.resolveRequiredNodes(target);
    if (typeof options.getOnline !== "function" || typeof options.checkOnlineNow !== "function") {
      throw new RecipeSwitchError("Recipe node readiness is not configured");
    }
    await waitForRequiredNodes(requiredNodes, options, emit);
    const requiredIds = new Set(requiredNodes.map((spark) => spark.id));
    const probeOptions = {
      signal: options.signal,
      getOnline: (id) => requiredIds.has(id) || options.getOnline(id) === true,
    };
    emit("checking-current-state");
    const snapshot = await abortable(() => recipeRegistry.list(probeOptions), options.signal);
    if (snapshot.conflict) {
      throw new RecipeSwitchError(
        `Cluster is in a conflicting state — recipes reporting running at once: ${snapshot.conflictIds.join(", ")}. Resolve manually (stop the stray one) before switching.`
      );
    }

    const current = snapshot.activeId ? recipeRegistry.get(snapshot.activeId) : null;

    if (current) {
      emit("stopping", { from: current.id });
      await bounded(
        () => settleAll(current.nodes.map((n) => runNodeCommand(recipeRegistry, n, n.stopCmd, STOP_TIMEOUT_MS, options, "Stop recipe"))),
        STOP_TIMEOUT_MS + 10_000,
        `stopping ${current.id} timed out`
      );

      emit("confirming-stopped", { from: current.id });
      await waitForRecipeStopped(recipeRegistry, current, probeOptions);
      report(options, null, `Previous recipe ${current.id} confirmed stopped`);
    }

    emit("clearing-conflicts", { from: current?.id ?? null });
    await bounded(
      () => clearStaleContainers(recipeRegistry, requiredNodes, probeOptions.getOnline, options),
      CLEAR_CONTAINERS_TIMEOUT_MS + 10_000,
      "clearing stray containers timed out"
    );

    if (target.nodes.some((node) => node.modelIds?.length)) {
      emit("syncing-model", { from: current?.id ?? null });
      await bounded(
        () => syncModelsForRecipe(recipeRegistry, modelRegistry, target, options),
        MODEL_SYNC_PHASE_TIMEOUT_MS,
        `syncing model(s) for ${target.id} timed out`
      );
    }

    // Sync/status work can outlast the readiness poll. Never start a launcher
    // after one of its dependencies dropped, and never wake a second time.
    emit("rechecking-nodes", { from: current?.id ?? null });
    const dropped = await bounded(
      () => checkRequiredNodes(requiredNodes, options),
      Math.min(options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS, READINESS_TIMEOUT_MS),
      "rechecking required nodes timed out"
    );
    if (dropped.length) {
      throw new RecipeSwitchError(`Required nodes went offline before start: ${dropped.map((spark) => spark.name || spark.id).join(", ")}`);
    }
    emit("starting", { from: current?.id ?? null });
    await bounded(
      () => settleAll(target.nodes.map((n) => runNodeCommand(recipeRegistry, n, n.startCmd, START_TIMEOUT_MS, options, "Start recipe"))),
      START_TIMEOUT_MS + 10_000,
      `starting ${target.id} timed out`
    );


    emit("health-checking", { from: current?.id ?? null });
    const loadStartedAt = Date.now();
    const historicalAverageMs = switchHistory.averageMs(target.id);
    const progressStopped = { value: false };
    const progressStop = new AbortController();
    const progressLoop = pollSwitchProgress(
      recipeRegistry,
      target,
      loadStartedAt,
      historicalAverageMs,
      (progress) => emit("health-checking", { from: current?.id ?? null, progress }),
      () => progressStopped.value,
      AbortSignal.any([progressStop.signal, options.signal])
    );
    try {
      await settleAll(target.nodes.map((n) => waitForNodeHealth(recipeRegistry, n, options)));
    } finally {
      progressStopped.value = true;
      progressStop.abort();
      await progressLoop;
    }
    options.signal.throwIfAborted();
    switchHistory.record(target.id, Date.now() - loadStartedAt);

    emit("done", { from: current?.id ?? null });
  } catch (err) {
    // Stop siblings before waiting for them; retain exclusivity until they unwind.
    const cancelled = requestedSignal?.aborted;
    controller.abort(err);
    await Promise.allSettled(pending);
    emit(cancelled ? "cancelled" : "failed", cancelled
      ? { message: "Apply cancelled. Already-started services and staged weights were left in place." }
      : { error: err.message });
    throw err;
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    requestedSignal?.removeEventListener("abort", cancel);
    _switchInFlight = false;
  }
}

export function isSwitchInFlight() {
  return _switchInFlight;
}
