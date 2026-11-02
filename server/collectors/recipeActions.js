/**
 * recipeActions — the recipe-switching state machine.
 *
 * Wake dependencies, validate resources/artifacts/transport before stopping,
 * remove owned model containers, stage verified artifacts, prepare runtimes,
 * warm small services first, then start large ranks and check serving health.
 * Progress and attached output feed the existing persisted Apply sessions.
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

const CLEAR_CONTAINERS_TIMEOUT_MS = 60_000;

/** Remove only explicitly owned model containers, including half-started ranks. */
async function clearStaleContainers(recipeRegistry, requiredNodes, getOnline, options) {
  const ids = new Set([...requiredNodes.map((spark) => spark.id), ...(options.cleanupHostIds || [])]);
  const names = new Set([
    ...recipeRegistry.all().flatMap((recipe) => recipe.nodes.map((node) => node.containerName).filter(Boolean)),
    ...(options.ownedContainers || []),
  ]);
  if (names.size === 0) return;
  const quoted = [...names].map((name) => "'" + name.replaceAll("'", "'\\''") + "'").join(" ");
  const command = `for name in ${quoted}; do if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name" || exit $?; fi; done`;
  await settleAll(recipeRegistry.sparkRegistry.sparks.filter((spark) =>
    (ids.has(spark.id) || spark.role === "head" || spark.role === "worker") && getOnline(spark.id) === true
  ).map(async (spark) => {
    report(options, spark, "Stopping owned model containers; preserving unrelated containers and NFS");
    await sshExec(spark, command, { timeoutMs: CLEAR_CONTAINERS_TIMEOUT_MS, signal: options.signal, cancelRemote: true,
      onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined });
  }));
}

async function checkMemory(plan, loaded, options) {
  if (!plan) return;
  for (const spark of plan.requiredNodes) {
    const remaining = plan.resources.get(spark.id).memoryGiB - (loaded.get(spark.id) || 0);
    const command = "python3 -c 'from pathlib import Path; print(next(int(x.split()[1])/1024**2 for x in Path(\"/proc/meminfo\").read_text().splitlines() if x.startswith(\"MemAvailable:\")))'";
    const available = Number(await sshExec(spark, command, { timeoutMs: 15_000, signal: options.signal, cancelRemote: true }));
    if (!Number.isFinite(available) || available < remaining + 8) {
      throw new RecipeSwitchError(`${spark.name || spark.id}: need ${(remaining + 8).toFixed(1)} GiB available for remaining models and reserve, have ${Number.isFinite(available) ? available.toFixed(1) : "unknown"}`);
    }
  }
}

/** Stage each node's selected artifacts, or stat the canonical files before any stop. */
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
    const spark = options.sourceOnly ? modelRegistry.registryHost() : recipeRegistry._sparkForNode(node);
    if (!spark) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
    for (const modelId of modelIds) {
      options.signal?.throwIfAborted();
      const model = modelRegistry.getModel(modelId);
      if (!model) {
        throw new RecipeSwitchError(`Recipe ${recipe.id} references unknown model ${modelId}`);
      }
      report(options, spark, `${options.sourceOnly ? "Checking canonical" : "Verifying staged"} artifacts for ${modelId}`);
      const result = await syncModelToSpark(modelRegistry, model, spark, {
        verify: !options.sourceOnly,
        requireVerified: Boolean(options.plan),
        includePattern: node.modelFiles?.[modelId],
        signal: options.signal,
        onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined,
      });
      if (options.sourceOnly) {
        const destination = recipeRegistry._sparkForNode(node);
        if (!destination) throw new RecipeSwitchError(`no Spark configured for role ${node.role}`);
        await syncModelToSpark(modelRegistry, model, destination, {
          verify: false, requireVerified: true, preflightOnly: true,
          includePattern: node.modelFiles?.[modelId], signal: options.signal,
        });
      }
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
  if (node.llmPort == null) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const status = await recipeRegistry._probeNode(node, options);
      if (status.running) return;
      await sleep(HEALTH_POLL_MS, options.signal);
    }
    throw new RecipeSwitchError(`${node.role} rank did not become running`);
  }
  const url = `http://${host}:${node.llmPort}${node.healthPath || "/health"}`;
  const deadline = Date.now() + (node.healthTimeoutMs || HEALTH_TIMEOUT_MS);
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
        if (node.waitForWarmup && (await res.json()).warming !== false) {
          lastError = "native engine is warming";
        } else {
          report(options, spark, "Serving health passed");
          return;
        }
      } else {
        lastError = `HTTP ${res.status}`;
      }
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
  const target = options.plan?.target ?? recipeRegistry.get(targetId);
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
    const requiredNodes = options.plan?.requiredNodes ?? recipeRegistry.resolveRequiredNodes(target);
    if (typeof options.getOnline !== "function" || typeof options.checkOnlineNow !== "function") {
      throw new RecipeSwitchError("Recipe node readiness is not configured");
    }
    await waitForRequiredNodes(requiredNodes, options, emit);
    if (options.validatePlan) await bounded(options.validatePlan, MODEL_SYNC_PHASE_TIMEOUT_MS, "revalidating the deployment plan timed out");
    const requiredIds = new Set(requiredNodes.map((spark) => spark.id));
    const probeOptions = {
      signal: options.signal,
      getOnline: (id) => requiredIds.has(id) || options.getOnline(id) === true,
    };
    if (options.plan && target.nodes.some((node) => node.modelIds?.length)) {
      await bounded(() => syncModelsForRecipe(recipeRegistry, modelRegistry, target, { ...options, sourceOnly: true }),
        MODEL_SYNC_PHASE_TIMEOUT_MS, "checking canonical artifacts timed out");
    }
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
        () => settleAll(current.nodes.filter((node) => node.stopCmd).map((n) => runNodeCommand(recipeRegistry, n, n.stopCmd, STOP_TIMEOUT_MS, options, "Stop recipe"))),
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

    if (options.plan?.input.recipeId?.startsWith("deepseek-")) {
      emit("preparing", { message: "Retaining only the selected DeepSeek deployment cache" });
      for (const spark of requiredNodes.filter((spark) => spark.id !== modelRegistry?.getRegistryConfig().hostId)) {
        await sshExec(spark, `python3 ~/.local/share/sparkdash-models/model-runtime.py evict ${target.id}`, {
          timeoutMs: 300_000, signal: options.signal, cancelRemote: true,
          onOutput: options.onLog ? (line) => report(options, spark, line.text, line.stream) : undefined,
        });
      }
    }
    if (target.nodes.some((node) => node.modelIds?.length)) {
      emit("syncing-model", { from: current?.id ?? null });
      await bounded(
        () => syncModelsForRecipe(recipeRegistry, modelRegistry, target, options),
        MODEL_SYNC_PHASE_TIMEOUT_MS,
        `syncing model(s) for ${target.id} timed out`
      );
    }
    emit("preparing");
    const ordered = [...target.nodes].sort((a, b) => (a.startOrder ?? 20) - (b.startOrder ?? 20));
    for (const node of ordered) {
      if (node.prepareCmd) await bounded(
        () => runNodeCommand(recipeRegistry, node, node.prepareCmd, MODEL_SYNC_PHASE_TIMEOUT_MS, options, "Prepare model"),
        MODEL_SYNC_PHASE_TIMEOUT_MS, `preparing ${node.role} timed out`
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
    emit("starting");
    const loaded = new Map();
    await checkMemory(options.plan, loaded, options);
    for (const node of ordered.filter((node) => node.serviceId)) {
      await runNodeCommand(recipeRegistry, node, node.startCmd, START_TIMEOUT_MS, options, "Start small service");
      await waitForNodeHealth(recipeRegistry, node, options);
      loaded.set(node.sparkId, (loaded.get(node.sparkId) || 0) + node.memoryGiB);
      await checkMemory(options.plan, loaded, options);
    }
    await checkMemory(options.plan, loaded, options);
    for (const node of ordered.filter((node) => !node.serviceId && node.startCmd)) {
      await bounded(
        () => runNodeCommand(recipeRegistry, node, node.startCmd, START_TIMEOUT_MS, options, "Start large model"),
        START_TIMEOUT_MS + 10_000, `starting ${node.role} timed out`
      );
    }


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
    options.commitPlan?.();

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
