/**
 * Power orchestrator tests with fake nodes, a fake power client, and a fake
 * recipe registry. No SSH, no Kasa, no real outlet.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createPowerOrchestrator } from "../powerOrchestrator.js";

function makeHarness({
  sparks,
  online = {},
  storedRecipeId = null,
  activeId = null,
  conflict = false,
  switchInFlight = false,
  stayOffline = false,
}) {
  const state = { ...online };
  const calls = {
    shutdown: [],
    wake: [],
    powerOn: [],
    powerOff: [],
    switch: [],
    progress: [],
    events: [],
    saved: [],
  };
  const powerClient = {
    hasPowerControl: (spark) => Boolean(spark.powerControl?.onUrl || spark.powerControl?.offUrl),
    powerOn: async (list) => {
      calls.powerOn.push(list.map((s) => s.id));
      if (!stayOffline) for (const s of list) state[s.id] = true;
      return list.map((s) => ({ id: s.id, ok: true, target: s.powerControl?.target }));
    },
    powerOff: async (list) => {
      calls.powerOff.push(list.map((s) => s.id));
      return list.map((s) => ({ id: s.id, ok: true, target: s.powerControl?.target }));
    },
  };
  const powerState = {
    loadPowerState: () => ({ lastActiveRecipeId: storedRecipeId }),
    recordActiveRecipe: (id, ids) => calls.saved.push({ activeId: id, ids }),
    recordShutdown: () => calls.saved.push({ shutdown: true }),
    recordWake: () => calls.saved.push({ wake: true }),
  };
  const recipeRegistry = {
    list: async () => ({
      recipes: activeId ? [{ id: activeId, active: true }] : [],
      activeId,
      conflict,
      conflictIds: conflict ? ["a", "b"] : [],
    }),
  };
  const orchestrator = createPowerOrchestrator({
    registry: { sparks },
    getOnline: (id) => Boolean(state[id]),
    checkOnlineNow: async () => {},
    recipeRegistry,
    modelRegistry: null,
    powerClient,
    powerState,
    shutdownSpark: async (spark) => {
      calls.shutdown.push(spark.id);
      state[spark.id] = false;
    },
    wakeSpark: async (spark) => {
      calls.wake.push(spark.id);
      if (!stayOffline) state[spark.id] = true;
    },
    switchRecipe: async (_rr, _mr, id, onProgress) => {
      calls.switch.push(id);
      onProgress?.({ phase: "starting", targetId: id });
    },
    isSwitchInFlight: () => switchInFlight,
    onProgress: (s) => calls.progress.push(s),
    recordEvent: (e) => calls.events.push(e),
    sleep: async () => {},
    now: () => Date.now(),
    onlineTimeoutMs: 5,
    offlineTimeoutMs: 5,
    pollMs: 1,
  });
  return { orchestrator, calls, state };
}

const remote = (id, extra = {}) => ({
  id,
  name: id,
  kind: "spark",
  isLocal: false,
  powerControl: { onUrl: "http://kasa/on", offUrl: "http://kasa/off", target: id },
  ...extra,
});

test("shutdown-all captures the recipe, shuts down remotes, powers off, and skips the local outlet", async () => {
  const local = {
    id: "nas",
    name: "nas",
    kind: "host",
    isLocal: true,
    powerControl: { offUrl: "http://kasa/off", target: "9" },
  };
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a"), remote("b"), local],
    online: { a: true, b: true, nas: true },
    activeId: "glm53-exl3",
  });

  await orchestrator.shutdownAll();

  assert.deepEqual(calls.saved[0], { activeId: "glm53-exl3", ids: ["glm53-exl3"] });
  assert.deepEqual(calls.shutdown, ["a", "b", "nas"]);
  assert.deepEqual(calls.powerOff, [["a", "b"]], "one batch request for the shared endpoint");
  assert.equal(calls.powerOff.flat().includes("nas"), false, "local dashboard host is never power-cut");
  assert.equal(calls.progress.at(-1).phase, "done");
});

test("shutdown-all powers off an offline remote with a configured outlet", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
  });

  await orchestrator.shutdownAll();

  assert.deepEqual(calls.shutdown, []);
  assert.deepEqual(calls.powerOff, [["a"]]);
});

test("shutdown-all refuses while a recipe switch is in flight", async () => {
  const { orchestrator } = makeHarness({
    sparks: [remote("a")],
    online: { a: true },
    switchInFlight: true,
  });
  await assert.rejects(() => orchestrator.shutdownAll(), /recipe switch is in progress/);
});

test("wake-all refuses while a recipe switch is in flight", async () => {
  const { orchestrator } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    switchInFlight: true,
  });
  await assert.rejects(() => orchestrator.wakeAll(), /recipe switch is in progress/);
});

test("wake-all powers on every offline node with an outlet, including DGX Sparks", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a"), remote("b"), remote("c")],
    online: { a: false, b: false, c: false },
    storedRecipeId: "glm53-exl3",
    activeId: null,
  });

  await orchestrator.wakeAll();

  assert.deepEqual(calls.powerOn, [["a", "b", "c"]]);
  assert.deepEqual(calls.switch, ["glm53-exl3"]);
  assert.equal(calls.progress.at(-1).phase, "done");
});

test("wake-all skips the recipe switch when the stored recipe is already active", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    storedRecipeId: "glm53-exl3",
    activeId: "glm53-exl3",
  });

  await orchestrator.wakeAll();

  assert.deepEqual(calls.switch, []);
  assert.equal(calls.progress.at(-1).phase, "done");
});

test("wake-all switches away from a different active recipe", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    storedRecipeId: "glm53-exl3",
    activeId: "minimax-h3",
  });

  await orchestrator.wakeAll();

  assert.deepEqual(calls.switch, ["glm53-exl3"]);
});

test("wake-all falls back to Wake-on-LAN for hosts without an outlet", async () => {
  const host = { id: "pc", name: "pc", kind: "host", isLocal: false, powerControl: null };
  const { orchestrator, calls } = makeHarness({
    sparks: [host],
    online: { pc: false },
  });

  await orchestrator.wakeAll();

  assert.deepEqual(calls.wake, ["pc"]);
  assert.deepEqual(calls.powerOn, []);
});

test("wake-all fails when a node has no power endpoint and no Wake-on-LAN", async () => {
  const spark = { id: "spark1", name: "Spark 1", kind: "spark", isLocal: false, powerControl: null };
  const { orchestrator, calls } = makeHarness({
    sparks: [spark],
    online: { spark1: false },
  });

  await orchestrator.wakeAll();

  assert.equal(calls.progress.at(-1).phase, "failed");
  assert.match(calls.progress.at(-1).error, /could not be powered on/);
});

test("wake-all reports a node that never comes online", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    stayOffline: true,
  });

  await orchestrator.wakeAll();

  assert.equal(calls.progress.at(-1).phase, "failed");
  assert.match(calls.progress.at(-1).error, /did not come online/);
});

test("wake-all reports a conflicting recipe state instead of guessing", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    storedRecipeId: "glm53-exl3",
    conflict: true,
  });

  await orchestrator.wakeAll();

  assert.equal(calls.progress.at(-1).phase, "failed");
  assert.match(calls.progress.at(-1).error, /conflicting state/);
});
