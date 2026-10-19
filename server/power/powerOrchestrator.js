/**
 * Fleet power orchestration.
 *
 * shutdown-all: capture the live recipe, gracefully shut down online nodes
 * over SSH, wait for each to go offline, then cut its outlet. The dashboard
 * host is shut down last and its outlet is never cut (that would kill the
 * controller mid-flight).
 *
 * wake-all: power on every offline node that has a power endpoint (the outlet
 * approach works for every unit, not just `kind === "host"`), fall back to
 * Wake-on-LAN for hosts without one, wait for the nodes to come online, then
 * re-activate the recipe captured at shutdown time.
 *
 * The orchestrator is transport-agnostic: it receives the shutdown/WoL/recipe
 * callbacks and the online predicate, so tests can drive it without SSH, a
 * real Kasa strip, or a real recipe switch.
 */

const DEFAULT_ONLINE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_OFFLINE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_POLL_MS = 2_000;

export function createPowerOrchestrator({
  registry,
  getOnline,
  checkOnlineNow = null,
  recipeRegistry,
  modelRegistry,
  powerClient,
  powerState,
  shutdownSpark,
  wakeSpark,
  switchRecipe,
  isSwitchInFlight,
  onProgress,
  recordEvent = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS,
  offlineTimeoutMs = DEFAULT_OFFLINE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
}) {
  let inFlight = null;

  function isInFlight() {
    return inFlight;
  }

  function makeState(action) {
    return {
      action,
      phase: "starting",
      startedAt: now(),
      updatedAt: now(),
      total: 0,
      completed: 0,
      current: null,
      recipeId: null,
      recipeIds: [],
      error: null,
      results: [],
      recipeSwitch: null,
    };
  }

  function makeEmitter(state) {
    return (patch) => {
      Object.assign(state, patch, { updatedAt: now() });
      try {
        onProgress?.({ ...state });
      } catch {
        /* progress reporting must never abort the action */
      }
    };
  }

  function addResult(emit, state, result) {
    emit({ results: [...state.results, result] });
  }

  async function waitFor(predicate, timeoutMs, forceCheck) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (forceCheck) await forceCheck();
      if (predicate()) return true;
      await sleep(pollMs);
    }
    if (forceCheck) await forceCheck();
    return predicate();
  }

  async function shutdownAll() {
    if (inFlight) throw new Error("A power action is already in progress");
    if (isSwitchInFlight?.()) throw new Error("A recipe switch is in progress");
    inFlight = "shutdown-all";
    const state = makeState("shutdown-all");
    const emit = makeEmitter(state);

    try {
      emit({ phase: "capturing-recipe" });
      const snapshot = await recipeRegistry.list();
      const activeIds = snapshot.recipes.filter((r) => r.active).map((r) => r.id);
      const activeId = snapshot.activeId || null;
      powerState.recordActiveRecipe(activeId, activeIds);
      emit({ recipeId: activeId, recipeIds: activeIds });

      const sparks = registry.sparks;
      const remotes = sparks.filter((s) => !s.isLocal);
      const local = sparks.find((s) => s.isLocal) || null;
      const onlineRemotes = remotes.filter((s) => getOnline(s.id));
      const offlineRemotes = remotes.filter((s) => !getOnline(s.id));
      emit({ total: remotes.length + (local ? 1 : 0) });

      const completedIds = new Set();
      const markCompleted = (id) => {
        if (completedIds.has(id)) return;
        completedIds.add(id);
        emit({ completed: completedIds.size });
      };

      /** Nodes whose outlet must be cut, collected so one batch request covers them all. */
      const toPowerOff = [];

      for (const spark of onlineRemotes) {
        const name = spark.name || spark.id;
        emit({ phase: "shutting-down", current: name });
        try {
          await shutdownSpark(spark);
          addResult(emit, state, { id: spark.id, name, ok: true, message: "Shutdown initiated" });
        } catch (err) {
          addResult(emit, state, {
            id: spark.id,
            name,
            ok: false,
            error: err?.message || String(err),
          });
          markCompleted(spark.id);
          continue;
        }

        emit({ phase: "waiting-offline", current: name });
        const offline = await waitFor(
          () => !getOnline(spark.id),
          offlineTimeoutMs,
          checkOnlineNow ? () => checkOnlineNow(spark.id) : null
        );
        if (!offline) {
          addResult(emit, state, {
            id: spark.id,
            name,
            ok: false,
            error: "Still online after timeout; power-off skipped",
          });
          markCompleted(spark.id);
          continue;
        }

        if (powerClient.hasPowerControl(spark)) {
          toPowerOff.push(spark);
        } else {
          markCompleted(spark.id);
        }
      }

      // Offline remotes: no graceful shutdown to run, but their outlet may
      // still be live (crashed node). Cut it when a power endpoint exists.
      for (const spark of offlineRemotes) {
        if (powerClient.hasPowerControl(spark)) {
          toPowerOff.push(spark);
        } else {
          addResult(emit, state, {
            id: spark.id,
            name: spark.name || spark.id,
            ok: false,
            skipped: true,
            error: "Offline — no power endpoint configured",
          });
          markCompleted(spark.id);
        }
      }

      // One batch request per distinct endpoint, not one request per node.
      if (toPowerOff.length > 0) {
        emit({ phase: "powering-off" });
        const results = await powerClient.powerOff(toPowerOff);
        for (const result of results) {
          const spark = toPowerOff.find((s) => s.id === result.id);
          const name = spark?.name || result.id;
          addResult(emit, state, {
            id: result.id,
            name,
            ok: Boolean(result.ok),
            error: result.error || null,
            message: result.ok ? "Powered off" : null,
          });
          recordEvent({
            type: "power.off",
            severity: result.ok ? "info" : "warn",
            sparkId: result.id,
            sparkName: spark?.name,
            message: result.ok
              ? `Power off requested for ${name}`
              : `Power off failed for ${name}: ${result.error || "unknown error"}`,
          });
          markCompleted(result.id);
        }
      }

      // Local dashboard host last: graceful shutdown only. Cutting its own
      // outlet would kill the controller before the request could complete.
      if (local) {
        const name = local.name || local.id;
        if (!getOnline(local.id)) {
          addResult(emit, state, {
            id: local.id,
            name,
            ok: false,
            skipped: true,
            error: "Offline — skipped",
          });
          markCompleted(local.id);
        } else {
          emit({ phase: "shutting-down", current: name });
          try {
            await shutdownSpark(local);
            addResult(emit, state, {
              id: local.id,
              name,
              ok: true,
              message: "Shutdown initiated (power-off skipped for the dashboard host)",
            });
          } catch (err) {
            addResult(emit, state, {
              id: local.id,
              name,
              ok: false,
              error: err?.message || String(err),
            });
          }
          markCompleted(local.id);
        }
      }

      emit({ phase: "done" });
      powerState.recordShutdown();
    } catch (err) {
      emit({ phase: "failed", error: err?.message || String(err) });
      throw err;
    } finally {
      inFlight = null;
    }
  }

  async function wakeAll() {
    if (inFlight) throw new Error("A power action is already in progress");
    if (isSwitchInFlight?.()) throw new Error("A recipe switch is in progress");
    inFlight = "wake-all";
    const state = makeState("wake-all");
    const emit = makeEmitter(state);

    try {
      const stored = powerState.loadPowerState();
      const recipeId = stored.lastActiveRecipeId || null;
      emit({ recipeId });

      const offline = registry.sparks.filter((s) => !getOnline(s.id));
      emit({ total: offline.length });

      const powerSparks = offline.filter((s) => powerClient.hasPowerControl(s));
      const wolSparks = offline.filter(
        (s) => !powerClient.hasPowerControl(s) && s.kind === "host"
      );
      const skipped = offline.filter(
        (s) => !powerClient.hasPowerControl(s) && s.kind !== "host"
      );

      let failed = false;

      if (powerSparks.length > 0) {
        emit({ phase: "powering-on" });
        const results = await powerClient.powerOn(powerSparks);
        for (const result of results) {
          const spark = powerSparks.find((s) => s.id === result.id);
          const name = spark?.name || result.id;
          addResult(emit, state, {
            id: result.id,
            name,
            ok: Boolean(result.ok),
            error: result.error || null,
            message: result.ok ? "Power on requested" : null,
          });
          if (!result.ok) failed = true;
          recordEvent({
            type: "power.on",
            severity: result.ok ? "info" : "warn",
            sparkId: result.id,
            sparkName: spark?.name,
            message: result.ok
              ? `Power on requested for ${name}`
              : `Power on failed for ${name}: ${result.error || "unknown error"}`,
          });
          emit({ completed: state.completed + 1 });
        }
      }

      for (const spark of wolSparks) {
        const name = spark.name || spark.id;
        emit({ phase: "powering-on", current: name });
        try {
          await wakeSpark(spark);
          addResult(emit, state, { id: spark.id, name, ok: true, message: "Wake-on-LAN sent" });
        } catch (err) {
          failed = true;
          addResult(emit, state, {
            id: spark.id,
            name,
            ok: false,
            error: err?.message || String(err),
          });
        }
        emit({ completed: state.completed + 1 });
      }

      for (const spark of skipped) {
        const name = spark.name || spark.id;
        failed = true;
        addResult(emit, state, {
          id: spark.id,
          name,
          ok: false,
          skipped: true,
          error: "No power endpoint or Wake-on-LAN",
        });
        emit({ completed: state.completed + 1 });
      }

      if (failed) {
        emit({ phase: "failed", error: "One or more nodes could not be powered on" });
        return;
      }

      const toWait = [...powerSparks, ...wolSparks];
      if (toWait.length > 0) {
        emit({ phase: "waiting-online" });
        const allOnline = await waitFor(
          () => toWait.every((s) => getOnline(s.id)),
          onlineTimeoutMs,
          checkOnlineNow
            ? async () => {
                await Promise.all(toWait.map((s) => checkOnlineNow(s.id)));
              }
            : null
        );
        if (!allOnline) {
          const offlineAfter = toWait.filter((s) => !getOnline(s.id));
          emit({
            phase: "failed",
            error: `Nodes did not come online: ${offlineAfter
              .map((s) => s.name || s.id)
              .join(", ")}`,
          });
          return;
        }
      }

      if (recipeId) {
        emit({ phase: "reactivating-recipe", recipeId });
        const snapshot = await recipeRegistry.list();
        if (snapshot.conflict) {
          emit({
            phase: "failed",
            error: `Cluster is in a conflicting state: ${snapshot.conflictIds.join(", ")}`,
          });
          return;
        }
        if (snapshot.activeId === recipeId) {
          emit({ phase: "done", message: `Recipe ${recipeId} is already active` });
          powerState.recordWake();
          return;
        }
        if (isSwitchInFlight?.()) {
          emit({ phase: "failed", error: "A recipe switch is already in progress" });
          return;
        }
        recordEvent({
          type: "power.recipe.reactivate",
          severity: "info",
          message: `Re-activating recipe ${recipeId} after wake-all`,
        });
        await switchRecipe(recipeRegistry, modelRegistry, recipeId, (progress) => {
          emit({ phase: "reactivating-recipe", recipeId, recipeSwitch: progress });
        });
      }

      emit({ phase: "done" });
      powerState.recordWake();
    } catch (err) {
      emit({ phase: "failed", error: err?.message || String(err) });
      throw err;
    } finally {
      inFlight = null;
    }
  }

  return { shutdownAll, wakeAll, isInFlight };
}
