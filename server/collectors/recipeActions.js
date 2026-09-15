/**
 * recipeActions — the recipe-switching state machine.
 *
 * Mirrors comfyActions.js's precedent (a recipe-level mutation action living outside the HTTP
 * route handler), scaled up to a multi-node, multi-minute operation: sync each node's model
 * (Model Registry pull + checksum verify), stop whatever recipe is currently live,
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

const CLEAR_CONTAINERS_TIMEOUT_MS = 30_000;
/** Containers that persist across every recipe switch — never touched by the sweep below.
 *  portainer_agent is the fleet's own persistent infrastructure. The rest are kernel-nfsd
 *  exporters (DSpark, deepseek-v41-flash-exl3, and any future recipe using the same
 *  "share weights over NFSv4 instead of copying them onto the worker" pattern) — every one
 *  of those recipes' own start scripts already prefers reusing a live exporter over
 *  rebuilding it (nfs_ensure_server()'s nfs_live_container() check), specifically because a
 *  privileged --network host container holding kernel-level NFS state (rpc.nfsd,
 *  /proc/fs/nfsd) can take Docker's kill well past its wait timeout even though it does
 *  genuinely exit — confirmed live 2026-09-14: every deepseek-v41-flash-exl3 retry hit
 *  "could not kill container: tried to kill container, but did not receive an exit event"
 *  because this sweep force-killed dsv41-exl3-nfs on every single attempt, throwing away
 *  the reuse path's entire point and re-triggering the same slow teardown each time. Only
 *  one kernel nfsd can ever be live host-wide regardless of which named container started
 *  it ("a second nfsd will not start" — see nfs-share.sh), so leaving a stray one running
 *  across a recipe switch can never itself conflict with whatever starts next. */
const PERSISTENT_CONTAINER_NAMES = [
  "portainer_agent",
  "vllm-fn-nfs",
  "glm53-nfs",
  "dsv41-nfs",
  "dsv41-exl3-nfs",
  "dspark-nfs",
];

/**
 * Force-stop and remove every running container on every head/worker Spark except the
 * fleet's own persistent infrastructure (PERSISTENT_CONTAINER_NAMES above) —
 * regardless of name, image, or whether probeRecipe's live detection currently believes
 * anything is active there.
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
 * Scoped to head/worker Sparks only (never the Model Registry host or any other tracked
 * host) — this fleet's invariant is "exactly one recipe's containers, or none, ever run on
 * a compute Spark at a time" (see RecipeRegistry.js's module doc), so sweeping everything
 * but the known persistent infrastructure there is safe by construction.
 */
async function clearStaleContainers(recipeRegistry) {
  const sparks = recipeRegistry.sparkRegistry.sparks.filter(
    (s) => s.role === "head" || s.role === "worker"
  );
  const excludeArgs = PERSISTENT_CONTAINER_NAMES.map((name) => `-e ${JSON.stringify(name)}`).join(" ");
  const sweepCmd = `docker ps --format '{{.Names}}' | grep -vx ${excludeArgs} | xargs -r docker rm -f`;
  await Promise.all(
    sparks.map((spark) =>
      sshExec(spark, sweepCmd, { timeoutMs: CLEAR_CONTAINERS_TIMEOUT_MS, noBatch: true })
    )
  );
}

/**
 * Sync every node's tied models (recipe node's optional `modelIds` array, each referencing
 * a Model Registry entry) onto that node's own configured model folder, verifying checksums
 * on arrival. A node with no `modelIds` (or an empty one) is left alone — this is opt-in per
 * node, not assumed for every recipe. Synced sequentially, not in parallel, per model — two
 * large concurrent transfers to the same node would split one link's bandwidth across both
 * rather than actually finishing either sooner, and needlessly doubles concurrent SSH
 * connections against modelSync's own MaxStartups-conscious shard count.
 */
export async function syncModelsForRecipe(recipeRegistry, modelRegistry, recipe) {
  for (const node of recipe.nodes) {
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
      const model = modelRegistry.getModel(modelId);
      if (!model) {
        throw new RecipeSwitchError(`Recipe ${recipe.id} references unknown model ${modelId}`);
      }
      await syncModelToSpark(modelRegistry, recipeRegistry.sparkRegistry, model, spark);
    }
  }
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
 * @returns {Promise<void>}
 */
export async function switchRecipe(recipeRegistry, modelRegistry, targetId, onProgress) {
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

    emit("clearing-conflicts", { from: current?.id ?? null });
    await withTimeout(
      clearStaleContainers(recipeRegistry),
      CLEAR_CONTAINERS_TIMEOUT_MS + 10_000,
      "clearing stray containers timed out"
    );

    emit("syncing-model", { from: current?.id ?? null });
    await withTimeout(
      syncModelsForRecipe(recipeRegistry, modelRegistry, target),
      MODEL_SYNC_PHASE_TIMEOUT_MS,
      `syncing model(s) for ${target.id} timed out`
    );

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
