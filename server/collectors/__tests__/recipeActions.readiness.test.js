import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecipeSessionStore } from "../../recipes/RecipeSessionStore.js";

// Resolve transport/progress dependencies before importing the real state machine.
// No regression in this file can reach a real SSH host or write switch history.
const sshModule = `
  export const sshExec = (...args) => globalThis.recipeTestSsh(...args);
  export const copyToSpark = (...args) => globalThis.recipeTestCopy(...args);
`;
const progressModule = `
  export const probeNodeShardProgress = async () => null;
  export const estimateNodeProgress = () => null;
  export const combineNodeProgress = () => null;
  export class RecipeSwitchHistory { averageMs() { return null; } record() {} }
`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier === "./ssh.js" ? sshModule :
      specifier === "./RecipeLoadProgress.js" ? progressModule : null;
    if (source && context.parentURL?.includes("/collectors/")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { RecipeRegistry } = await import("../RecipeRegistry.js");
const { switchRecipe, isSwitchInFlight } = await import("../recipeActions.js");
const { syncModelToSpark } = await import("../modelSync.js");
hooks.deregister();

function setup(t, { tp = 2, online = ["spark1", "spark2"], sameTarget = false } = {}) {
  const sparks = [
    { id: "spark1", name: "Head", role: "head", lanIp: "192.168.1.11", modelFolder: "/models" },
    { id: "spark2", name: "Worker", role: "worker", lanIp: "192.168.1.12" },
    { id: "atom", name: "Atom", role: "worker", lanIp: "192.168.1.13" },
  ];
  const registry = new RecipeRegistry({ sparks });
  const launcher = { role: "head", sparkId: "spark1", workdir: "~/recipe", statusCmd: "status", startCmd: "start", stopCmd: "stop", runningPattern: "running", llmPort: 8888 };
  const recipe = {
    id: "target", label: "Target", tp,
    requiredNodes: [{ sparkId: "spark1" }, { sparkId: "spark2" }, ...(tp === 3 ? [{ sparkId: "atom" }] : [])],
    nodes: [launcher],
  };
  const unrelated = {
    id: "deepseek", tp: 3,
    requiredNodes: [{ sparkId: "spark1" }, { sparkId: "spark2" }, { sparkId: "atom" }],
    nodes: [{ ...launcher, workdir: "~/deepseek" }],
  };
  registry._recipes = [recipe, unrelated];
  const onlineIds = new Set(online);
  const commands = [];
  const copies = [];
  const wakes = [];
  const checks = [];
  const phases = [];
  let now = 0;
  let active = sameTarget;
  globalThis.recipeTestSsh = async (spark, command, options) => {
    commands.push({ id: spark.id, command, options });
    if (command === "cd ~/recipe && stop") active = false;
    if (command.includes(" && status")) return command.includes("~/recipe") && active ? "running" : "stopped";
    if (command.includes("find -L")) return "";
    return "";
  };
  globalThis.recipeTestCopy = async (...args) => copies.push(args);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true }));
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) =>
    realSetTimeout(fn, ms === 5000 ? 0 : ms, ...args));
  const options = {
    getOnline: (id) => onlineIds.has(id),
    checkOnlineNow: async (id) => { checks.push(id); return onlineIds.has(id); },
    wakeNodes: async (targets) => { wakes.push(targets.map((spark) => spark.id)); },
    isPowerActionInFlight: () => false,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
  return {
    registry, recipe, sparks, commands, copies, wakes, checks, phases, onlineIds, options,
    apply: (modelRegistry = null) => switchRecipe(registry, modelRegistry, recipe.id, (state) => phases.push(state), options),
    advance: (ms) => { now += ms; },
    elapsed: () => now,
  };
}

function applyCommands(h) {
  return h.commands.filter(({ command }) => !command.includes(" && status"));
}

test("GLM TP2 wakes only worker; offline Atom never blocks status, cleanup or apply", async (t) => {
  const h = setup(t, { online: ["spark1"] });
  h.options.sleep = async (ms) => { h.advance(ms); h.onlineIds.add("spark2"); };
  await h.apply();
  assert.deepEqual(h.wakes, [["spark2"]]);
  assert.equal(h.elapsed(), 2000);
  assert.ok(h.commands.some(({ id, command }) => id === "spark2" && command.includes("docker rm -f")));
  assert.ok(h.commands.some(({ command }) => command === "cd ~/recipe && start"));
  assert.ok(h.commands.every(({ id, command }) => id !== "atom" && !command.includes("~/deepseek")));
  assert.equal(h.phases.at(-1).phase, "done");
  assert.deepEqual(h.phases.find((state) => state.phase === "waiting-online").pendingNodes, ["Worker"]);
});

test("TP3 resolves and wakes all three offline dependencies once", async (t) => {
  const h = setup(t, { tp: 3, online: [] });
  h.options.wakeNodes = async (targets) => {
    h.wakes.push(targets.map((spark) => spark.id));
    targets.forEach((spark) => h.onlineIds.add(spark.id));
  };
  await h.apply();
  assert.deepEqual(h.wakes, [["spark1", "spark2", "atom"]]);
  assert.equal(h.elapsed(), 0);
  assert.ok(h.commands.some(({ id, command }) => id === "atom" && command.includes("docker rm -f")));
});

test("already online applies immediately without waking; same-target still stops and starts", async (t) => {
  const h = setup(t, { sameTarget: true });
  await h.apply();
  assert.deepEqual(h.wakes, []);
  assert.equal(h.elapsed(), 0);
  assert.deepEqual(h.checks, ["spark1", "spark2", "spark1", "spark2"]);
  const stops = h.commands.findIndex(({ command }) => command === "cd ~/recipe && stop");
  const starts = h.commands.findIndex(({ command }) => command === "cd ~/recipe && start");
  assert.ok(stops >= 0 && starts > stops);
});

test("each readiness round rechecks initially-online nodes, without a second wake", async (t) => {
  const h = setup(t, { online: ["spark1"] });
  let sleeps = 0;
  h.options.wakeNodes = async (targets) => {
    h.wakes.push(targets.map((spark) => spark.id));
    h.onlineIds.delete("spark1");
    h.onlineIds.add("spark2");
  };
  h.options.sleep = async (ms) => {
    h.advance(ms);
    sleeps++;
    assert.equal(applyCommands(h).length, 0);
    h.onlineIds.add("spark1");
  };
  await h.apply();
  assert.equal(sleeps, 1);
  assert.deepEqual(h.wakes, [["spark2"]]);
  assert.deepEqual(h.phases.find((state) => state.phase === "waiting-online").pendingNodes, ["Head"]);
  assert.deepEqual(h.checks.slice(0, 6), ["spark1", "spark2", "spark1", "spark2", "spark1", "spark2"]);
});

test("five-minute timeout never runs status, sync, cleanup or start; releases switch lock", async (t) => {
  const h = setup(t, { online: [] });
  await assert.rejects(h.apply(), /did not become online within 300s/);
  assert.equal(h.elapsed(), 300000);
  assert.deepEqual(h.wakes, [["spark1", "spark2"]]);
  assert.deepEqual(h.commands, []);
  assert.equal(h.phases.at(-1).phase, "failed");
  assert.equal(isSwitchInFlight(), false);
});

test("wake failure prevents every apply operation and releases lock", async (t) => {
  const h = setup(t, { online: [] });
  h.options.wakeNodes = async () => { throw new Error("outlet missing"); };
  await assert.rejects(h.apply(), /outlet missing/);
  assert.deepEqual(h.commands, []);
  assert.equal(isSwitchInFlight(), false);
});

test("wake and check operations themselves share the readiness deadline", async (t) => {
  const h = setup(t, { online: [] });
  h.options.readinessTimeoutMs = 10;
  h.options.wakeNodes = async () => { h.advance(11); };
  await assert.rejects(h.apply(), /did not become online/);
  assert.deepEqual(h.commands, []);
  h.options.checkOnlineNow = async () => new Promise(() => {});
  await assert.rejects(h.apply(), /did not become online/);
  assert.equal(isSwitchInFlight(), false);
});

test("fleet power and concurrent recipe locks reject before additional work", async (t) => {
  const h = setup(t);
  h.options.isPowerActionInFlight = () => true;
  await assert.rejects(h.apply(), /fleet power action/);
  assert.deepEqual(h.checks, []);
  h.options.isPowerActionInFlight = () => false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.options.checkOnlineNow = async () => { await gate; return true; };
  const first = h.apply();
  assert.equal(isSwitchInFlight(), true);
  await assert.rejects(h.apply(), /recipe switch is already/);
  release();
  await first;
  assert.equal(isSwitchInFlight(), false);
});

test("offline dependency discovered just before start fails without a second wake", async (t) => {
  const h = setup(t);
  let checks = 0;
  h.options.checkOnlineNow = async () => ++checks <= 2;
  await assert.rejects(h.apply(), /went offline before start/);
  assert.ok(!h.commands.some(({ command }) => command === "cd ~/recipe && start"));
  assert.deepEqual(h.wakes, []);
});

test("fresh false liveness overrides stale cached online; void result uses cache", async (t) => {
  const h = setup(t);
  h.options.readinessTimeoutMs = 20;
  h.options.checkOnlineNow = async () => false;
  await assert.rejects(h.apply(), /did not become online/);
  assert.deepEqual(h.commands, []);
  h.options.checkOnlineNow = async () => undefined;
  await h.apply();
  assert.equal(h.phases.at(-1).phase, "done");
});

test("missing readiness/wake configuration never reaches apply", async (t) => {
  const h = setup(t, { online: [] });
  h.options.wakeNodes = undefined;
  await assert.rejects(h.apply(), /wake is not configured/);
  h.options.checkOnlineNow = undefined;
  await assert.rejects(h.apply(), /readiness is not configured/);
  assert.deepEqual(h.commands, []);
});

test("metadata rejects missing, ambiguous, duplicate and TP-mismatched dependencies before wake", async (t) => {
  const h = setup(t);
  for (const selectors of [undefined, [], [{ role: "missing" }], [{ role: "head" }, { sparkId: "spark1" }], [{ role: "head" }], [{ role: "head", sparkId: "spark1" }]]) {
    h.recipe.requiredNodes = selectors;
    await assert.rejects(h.apply(), /metadata|no Spark configured|unique required nodes|invalid requiredNodes/);
  }
  h.recipe.requiredNodes = [{ sparkId: "spark1" }, { role: "worker" }];
  await assert.rejects(h.apply(), /ambiguous/);
  assert.deepEqual(h.wakes, []);
  assert.deepEqual(h.commands, []);
});

test("recipe list skips status commands for unrelated offline dependencies", async (t) => {
  const h = setup(t);
  const list = await h.registry.list({ getOnline: h.options.getOnline });
  assert.equal(list.recipes[1].active, false);
  assert.ok(h.commands.every(({ command }) => !command.includes("~/deepseek")));
});

function modelRegistry(verifyFilesOnHost) {
  return {
    registryHost: () => ({ id: "registry", ssh: { user: "op", host: "registry.test" } }),
    getRegistryConfig: () => ({ directory: "/registry" }),
    getModel: () => ({ id: "weights", subfolder: "weights", manifest: [{ path: "weight", sha256: "abc" }] }),
    verifyFilesOnHost,
  };
}

test("Apply model sync skips pre/post SHA but retains rsync quick-check and launcher linking", async (t) => {
  const h = setup(t);
  h.recipe.nodes[0].modelIds = ["weights"];
  h.recipe.nodes[0].startCmd = "./link-registry-weights.sh && start";
  const models = modelRegistry(async () => { assert.fail("Apply must never hash weight files"); });
  await h.apply(models);
  assert.ok(h.commands.some(({ command }) => command.includes("rsync -aL ")));
  assert.ok(h.commands.some(({ command }) => command.includes("./link-registry-weights.sh && start")));
  assert.ok(h.commands.every(({ command }) => !command.includes("--checksum")));
});

test("explicit sync retains pre/post verification and rejects post-copy checksum mismatch", async (t) => {
  const h = setup(t);
  let verifies = 0;
  const models = modelRegistry(async () => { verifies++; return ["weight"]; });
  await assert.rejects(syncModelToSpark(models, models.getModel(), h.sparks[0]), /Post-copy checksum verification failed/);
  assert.equal(verifies, 2);
  assert.ok(h.commands.some(({ command }) => command.includes("rsync -aL ")));
});

test("verify:false skips registry self-sync checksum as well", async (t) => {
  setup(t);
  const models = modelRegistry(async () => { assert.fail("fast self-sync must not hash"); });
  assert.deepEqual(await syncModelToSpark(models, models.getModel(), { id: "registry" }, { verify: false }), { destDir: "/registry/weights" });
});

test("staged GLM weights never contact offline Atom registry, including preflight", async (t) => {
  const h = setup(t);
  h.recipe.nodes[0].modelIds = ["weights"];
  const models = modelRegistry(async () => { assert.fail("Apply must never hash"); });
  models.registryHost = () => ({ id: "atom", ssh: { user: "op", host: "atom.test" } });
  globalThis.recipeTestSsh = async (spark, command) => {
    h.commands.push({ id: spark.id, command });
    assert.notEqual(spark.id, "atom", "no registry file listing");
    assert.ok(!command.includes("atom.test"), "no target-to-registry preflight or transfer");
    if (command.includes("for file in")) return "__PRESENT__";
    return "stopped";
  };
  await h.apply(models);
  assert.deepEqual(h.wakes, []);
  assert.ok(h.commands.some(({ command }) => command.includes("for file in")));
  assert.ok(h.commands.some(({ command }) => command === "cd ~/recipe && start"));
});

test("live recipe conflicts still block apply after readiness", async (t) => {
  const h = setup(t);
  h.registry.list = async () => ({ conflict: true, conflictIds: ["one", "two"] });
  await assert.rejects(h.apply(), /conflicting state.*one, two/);
  assert.deepEqual(h.commands, []);
  assert.equal(isSwitchInFlight(), false);
});

test("explicit sync with an already-verified copy still skips transport", async (t) => {
  const h = setup(t);
  let verified = 0;
  const models = modelRegistry(async () => { verified++; return []; });
  assert.deepEqual(
    await syncModelToSpark(models, models.getModel(), h.sparks[0]),
    { destDir: "/models/weights", skipped: true }
  );
  assert.equal(verified, 1);
  assert.deepEqual(h.commands, []);
});

test("persisted Apply stages include wake and boot wait only for offline dependencies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-dynamic-stages-"));
  try {
    const store = new RecipeSessionStore({ dir });
    for (const needsWake of [false, true]) {
      const h = setup(t, { online: needsWake ? ["spark1"] : ["spark1", "spark2"] });
      h.options.wakeNodes = async (targets) => {
        h.wakes.push(targets.map((spark) => spark.id));
        for (const spark of targets) h.onlineIds.add(spark.id);
      };
      const session = store.start({
        targetId: h.recipe.id, label: h.recipe.label, tp: h.recipe.tp,
        requiredNodes: h.sparks.slice(0, 2).map(({ id, name }) => ({ id, name })),
      });
      await switchRecipe(h.registry, null, h.recipe.id,
        (state) => store.recordProgress(session.id, state), {
          ...h.options, onLog: (line) => store.appendLog(session.id, line),
        });
      const saved = store.get(session.id);
      const phases = saved.stages.map((stage) => stage.phase);
      assert.equal(saved.status, "succeeded");
      assert.equal(phases.includes("powering-on"), needsWake);
      assert.equal(phases.includes("waiting-online"), needsWake);
      assert.ok(phases.indexOf("checking-nodes") < phases.indexOf("starting"));
      if (needsWake) {
        assert.ok(phases.indexOf("waiting-online") < phases.indexOf("starting"));
        assert.deepEqual(saved.stages.find((stage) => stage.phase === "waiting-online").pendingNodes, []);
      }
    }
    store.flush();
    assert.equal(new RecipeSessionStore({ dir }).list().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed launcher session retains node output, exit context and failed stage", async (t) => {
  const h = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-failed-stage-"));
  const store = new RecipeSessionStore({ dir });
  const session = store.start({
    targetId: h.recipe.id, label: h.recipe.label, tp: h.recipe.tp,
    requiredNodes: h.sparks.slice(0, 2).map(({ id, name }) => ({ id, name })),
  });
  const original = globalThis.recipeTestSsh;
  globalThis.recipeTestSsh = async (spark, command, options) => {
    if (command === "cd ~/recipe && start") {
      options.onOutput?.({ stream: "stdout", text: "Loading rank 0" });
      options.onOutput?.({ stream: "stderr", text: "CUDA allocation failed" });
      const err = new Error("CUDA allocation failed");
      err.exitCode = 7;
      throw err;
    }
    return original(spark, command, options);
  };
  try {
    await assert.rejects(switchRecipe(h.registry, null, h.recipe.id,
      (state) => store.recordProgress(session.id, state), {
        ...h.options, onLog: (line) => store.appendLog(session.id, line),
      }), /CUDA allocation failed/);
    const saved = store.get(session.id);
    const stage = saved.stages.find((entry) => entry.phase === "starting");
    assert.equal(saved.status, "failed");
    assert.equal(stage.status, "failed");
    assert.ok(stage.logs.some((line) =>
      line.stream === "stdout" && line.nodeId === "spark1" && line.text.includes("Loading rank 0")));
    assert.ok(stage.logs.some((line) =>
      line.stream === "stderr" && line.nodeId === "spark1" && line.text.includes("CUDA allocation failed")));
    assert.ok(stage.logs.some((line) => line.text.includes("exit 7")));
    assert.equal(saved.stages.some((entry) => entry.phase === "health-checking"), false);
    assert.equal(new RecipeSessionStore({ dir }).get(session.id).status, "failed");
  } finally {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shipped fleet recipes apply with spark2 and Atom both configured as workers", async (t) => {
  const definitions = JSON.parse(fs.readFileSync(new URL("../../config/recipes.json", import.meta.url), "utf8"));
  const expected = {
    "glm53-exl3": { required: ["spark1", "spark2"], launcher: "spark1" },
    "qwen38-flash-next": { required: ["spark1", "spark2"], launcher: "spark1" },
    "minimax-h3": { required: ["spark2"], launcher: "spark2" },
    "deepseek-v41-lakyfx-tp3": { required: ["spark1", "spark2", "atom"], launcher: "spark1" },
  };
  for (const definition of definitions) {
    const h = setup(t, { online: [] });
    h.registry._recipes = [definition];
    h.options.wakeNodes = async (targets) => {
      h.wakes.push(targets.map((spark) => spark.id));
      for (const spark of targets) h.onlineIds.add(spark.id);
    };
    const stagedModels = {
      registryHost: () => h.sparks[0],
      getRegistryConfig: () => ({ directory: "/staged" }),
      getModel: (id) => ({ id, subfolder: id, manifest: [] }),
      verifyFilesOnHost: async () => { assert.fail("Apply must not hash staged weights"); },
    };
    await switchRecipe(h.registry, stagedModels, definition.id,
      (state) => h.phases.push(state), h.options);
    const topology = expected[definition.id];
    assert.deepEqual(h.wakes, [topology.required], definition.id);
    const starts = h.commands.filter(({ command }) => definition.nodes.some(
      (node) => command === `cd ${node.workdir} && ${node.startCmd}`
    ));
    assert.deepEqual(starts.map(({ id }) => id), [topology.launcher], definition.id);
    assert.equal(h.phases.at(-1).phase, "done");
  }
});
