/**
 * Power orchestrator tests with fake nodes and a fake power client.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createPowerOrchestrator } from "../powerOrchestrator.js";

function makeHarness({
  sparks,
  online = {},
  switchInFlight = false,
  stayOffline = false,
  shutdown = null,
  checkOnlineNow = async () => {},
  onPowerOff = async () => {},
  sleep = async () => {},
  now = () => Date.now(),
  offlineTimeoutMs = 5,
  pollMs = 1,
}) {
  const state = { ...online };
  const calls = {
    shutdown: [],
    wake: [],
    powerOn: [],
    powerOff: [],
    progress: [],
    events: [],
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
      await onPowerOff(list);
      return list.map((s) => ({ id: s.id, ok: true, target: s.powerControl?.target }));
    },
  };
  const orchestrator = createPowerOrchestrator({
    registry: { sparks },
    getOnline: (id) => Boolean(state[id]),
    checkOnlineNow,
    powerClient,
    shutdownSpark: async (spark) => {
      calls.shutdown.push(spark.id);
      if (shutdown) await shutdown(spark, state);
      else state[spark.id] = false;
    },
    wakeSpark: async (spark) => {
      calls.wake.push(spark.id);
      if (!stayOffline) state[spark.id] = true;
    },
    isSwitchInFlight: () => switchInFlight,
    onProgress: (s) => calls.progress.push(s),
    recordEvent: (e) => calls.events.push(e),
    sleep,
    now,
    onlineTimeoutMs: 5,
    offlineTimeoutMs,
    pollMs,
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("shutdown-all shuts down remotes, powers off, and skips the local outlet", async () => {
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
  });

  await orchestrator.shutdownAll();

  assert.deepEqual(calls.shutdown, ["a", "b", "nas"]);
  assert.deepEqual(calls.powerOff, [["a", "b"]], "one batch request for the shared endpoint");
  assert.equal(calls.powerOff.flat().includes("nas"), false, "local dashboard host is never power-cut");
  assert.equal(calls.progress.at(-1).phase, "done");
});

test("shutdown-all dispatches remote SSH concurrently and waits for the batch before shutting down locally", async () => {
  const local = {
    id: "nas",
    name: "nas",
    kind: "host",
    isLocal: true,
    powerControl: { offUrl: "http://kasa/off", target: "9" },
  };
  const ssh = { a: deferred(), b: deferred(), c: deferred() };
  const powerOff = deferred();
  const { orchestrator, calls } = makeHarness({
    sparks: [local, remote("a"), remote("b"), remote("c")],
    online: { nas: true, a: true, b: true, c: true },
    shutdown: async (spark, state) => {
      if (!spark.isLocal) await ssh[spark.id].promise;
      state[spark.id] = false;
    },
    onPowerOff: () => powerOff.promise,
    now: () => 0,
  });
  const running = orchestrator.shutdownAll();

  try {
    await nextTurn();
    assert.deepEqual(new Set(calls.shutdown), new Set(["a", "b", "c"]),
      "every remote SSH command starts while the others are still blocked");
    assert.deepEqual(calls.powerOff, []);

    ssh.c.resolve();
    ssh.b.resolve();
    await nextTurn();
    assert.deepEqual(calls.powerOff, [], "no power cut while a remote SSH command is pending");
    assert.equal(calls.shutdown.includes("nas"), false);

    ssh.a.resolve();
    await nextTurn();
    assert.deepEqual(calls.powerOff, [["a", "b", "c"]],
      "one registry-ordered batch, regardless of shutdown completion order");
    assert.equal(calls.shutdown.includes("nas"), false,
      "the local host waits for the power-off batch to finish");

    powerOff.resolve();
    await running;
    assert.equal(calls.shutdown.at(-1), "nas");
    assert.equal(calls.powerOff.flat().includes("nas"), false);
    assert.equal(calls.progress.at(-1).completed, 4);
  } finally {
    for (const gate of Object.values(ssh)) gate.resolve();
    powerOff.resolve();
    await running;
  }
});

test("shutdown-all waits for remotes to go offline independently before cutting power", async () => {
  const checks = [];
  const finishedChecks = [];
  const offline = { a: deferred(), b: deferred() };
  const { orchestrator, calls, state } = makeHarness({
    sparks: [remote("a"), remote("b")],
    online: { a: true, b: true },
    shutdown: async () => {},
    checkOnlineNow: async (id) => {
      checks.push(id);
      await offline[id].promise;
      finishedChecks.push(id);
    },
    now: () => 0,
  });
  const running = orchestrator.shutdownAll();

  try {
    await nextTurn();
    assert.deepEqual(new Set(checks), new Set(["a", "b"]),
      "one blocked offline check must not prevent another remote from being checked");
    assert.deepEqual(calls.powerOff, []);

    state.b = false;
    offline.b.resolve();
    await nextTurn();
    assert.deepEqual(finishedChecks, ["b"]);
    assert.deepEqual(calls.powerOff, [], "one offline remote cannot trigger an early batch");

    state.a = false;
    offline.a.resolve();
    await running;
    assert.deepEqual(calls.powerOff, [["a", "b"]]);
    assert.equal(calls.progress.at(-1).completed, 2);
  } finally {
    state.a = false;
    state.b = false;
    for (const gate of Object.values(offline)) gate.resolve();
    await running;
  }
});

test("shutdown-all excludes SSH failures and offline timeouts from the single power-off batch", async () => {
  const local = { id: "nas", name: "nas", kind: "host", isLocal: true,
    powerControl: { offUrl: "http://kasa/off", target: "9" } };
  const timeout = deferred();
  const checks = [];
  let clock = 0;
  const { orchestrator, calls } = makeHarness({
    sparks: [local, remote("failed"), remote("slow"), remote("ready"), remote("offline")],
    online: { nas: true, failed: true, slow: true, ready: true, offline: false },
    shutdown: async (spark, state) => {
      if (spark.id === "failed") throw new Error("SSH refused");
      if (spark.id !== "slow") state[spark.id] = false;
    },
    checkOnlineNow: async (id) => { checks.push(id); },
    sleep: async (ms) => {
      await timeout.promise;
      clock += ms;
    },
    now: () => clock,
    offlineTimeoutMs: 2,
    pollMs: 2,
  });
  const running = orchestrator.shutdownAll();

  try {
    await nextTurn();
    assert.deepEqual(new Set(calls.shutdown), new Set(["failed", "slow", "ready"]));
    assert.deepEqual(new Set(checks), new Set(["slow", "ready"]),
      "failed SSH and initially offline nodes do not enter the offline wait");
    assert.deepEqual(calls.powerOff, [], "the batch waits for the outstanding timeout");
    assert.equal(calls.shutdown.includes("nas"), false);

    timeout.resolve();
    await running;
    assert.deepEqual(calls.powerOff, [["ready", "offline"]],
      "failed and still-online nodes are never power-cut");
    assert.equal(calls.shutdown.at(-1), "nas");
    const final = calls.progress.at(-1);
    assert.equal(final.phase, "done");
    assert.equal(final.completed, 5);
    assert.ok(final.results.some((result) =>
      result.id === "failed" && !result.ok && /SSH refused/.test(result.error)));
    assert.ok(final.results.some((result) =>
      result.id === "slow" && !result.ok && /timeout/.test(result.error)));
  } finally {
    timeout.resolve();
    await running;
  }
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

test("wake-all powers on offline nodes without any recipe or saved-recipe state dependency", async () => {
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a"), remote("b"), remote("c")],
    online: { a: false, b: false, c: false },
  });

  await orchestrator.wakeAll();

  assert.deepEqual(calls.powerOn, [["a", "b", "c"]]);
  assert.equal(calls.progress.at(-1).phase, "done");
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
  let clock = 0;
  const { orchestrator, calls } = makeHarness({
    sparks: [remote("a")],
    online: { a: false },
    stayOffline: true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  await orchestrator.wakeAll();

  assert.equal(calls.progress.at(-1).phase, "failed");
  assert.match(calls.progress.at(-1).error, /did not come online/);
});

