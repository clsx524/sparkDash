import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import { RecipeSessionStore, isValidRecipeSessionId } from "../RecipeSessionStore.js";

const input = (targetId = "recipe-a") => ({
  targetId, label: `Recipe ${targetId}`, tp: 2,
  requiredNodes: [{ id: "spark-1", name: "Spark 1" }, { id: "spark-2", name: "Spark 2" }],
});
const logs = (session) => session.stages.flatMap((stage) => stage.logs);

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-session-store-"));
  const dir = path.join(root, "sessions");
  let time = 1_000;
  const changes = [];
  const store = new RecipeSessionStore({ dir, now: () => time, onChange: (value) => changes.push(value), ...options });
  t.after(() => { store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, store, changes, setTime: (value) => { time = value; }, file: (id) => path.join(dir, `${id}.json`) };
}

function enter(store, id, phase, update = {}) {
  return store.recordProgress(id, { phase, ...update });
}

function finish(store, id) {
  return enter(store, id, "done");
}

test("records only entered online-path stages, repeated polls update one stage", (t) => {
  const { store, file, changes, setTime } = harness(t);
  const started = store.start(input());
  assert.deepEqual(started.stages, []);
  assert.equal(store.list().length, 0);
  assert.equal(isValidRecipeSessionId(started.id), true);
  enter(store, started.id, "checking-nodes");
  enter(store, started.id, "checking-current-state");
  enter(store, started.id, "syncing-model", { message: "Copying model" });
  const first = enter(store, started.id, "health-checking", {
    pendingNodes: ["spark-2"], progress: { percent: 10, etaSeconds: 60, source: "log" },
  });
  const notifications = changes.length;
  const duplicate = enter(store, started.id, "health-checking", {
    pendingNodes: ["spark-2"], progress: { percent: 10, etaSeconds: 60, source: "log" },
  });
  assert.equal(duplicate.version, first.version);
  assert.equal(changes.length, notifications);
  setTime(500); // A backwards wall clock cannot move a published timestamp backwards.
  const progress = enter(store, started.id, "health-checking", {
    pendingNodes: [], progress: { percent: 75, etaSeconds: 12, source: "log" },
  });
  assert.ok(progress.updatedAt > first.updatedAt);
  assert.ok(progress.stages.at(-1).updatedAt > first.stages.at(-1).updatedAt);
  const complete = finish(store, started.id);
  assert.equal(complete.status, "succeeded");
  assert.deepEqual(complete.stages.map((stage) => stage.phase), [
    "checking-nodes", "checking-current-state", "syncing-model", "health-checking",
  ]);
  assert.ok(complete.stages.every((stage) => stage.status === "succeeded" && stage.finishedAt !== null));
  assert.equal(complete.stages.some((stage) => ["powering-on", "waiting-online", "done"].includes(stage.phase)), false);
  assert.equal(JSON.parse(fs.readFileSync(file(started.id), "utf8")).status, "succeeded");
  assert.equal(fs.statSync(file(started.id)).mode & 0o777, 0o600);
});

test("offline-path stage failures preserve entered outcomes without future stages", (t) => {
  const { store } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "checking-nodes", { pendingNodes: ["spark-2"] });
  enter(store, id, "powering-on");
  store.appendLog(id, { stream: "action", nodeId: "spark-2", nodeName: "Spark 2", text: "Wake sent" });
  enter(store, id, "waiting-online", { pendingNodes: ["spark-2"] });
  store.appendLog(id, { stream: "stderr", text: "Still offline" });
  const failed = enter(store, id, "failed", { error: "Spark 2 did not become online within 5 minutes" });
  assert.deepEqual(failed.stages.map((stage) => [stage.phase, stage.status]), [
    ["checking-nodes", "succeeded"], ["powering-on", "succeeded"], ["waiting-online", "failed"],
  ]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, failed.stages.at(-1).message);
  assert.deepEqual(failed.stages.at(-1).pendingNodes, []);
  assert.equal(failed.lastSeq, 2);
  assert.equal(logs(failed)[0].nodeId, "spark-2");
});

test("getters restore browser state while a new store interrupts only unfinished work", (t) => {
  const { store, dir, file } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "checking-nodes");
  enter(store, id, "starting", { pendingNodes: ["spark-1"] });
  store.appendLog(id, { stream: "stdout", text: "Loading model" });
  store.flush();
  const refreshed = store.current();
  assert.equal(refreshed.status, "running");
  assert.deepEqual(store.get(id), refreshed);
  assert.equal(store.summary().status, "running");
  const changed = [];
  const restarted = new RecipeSessionStore({ dir, now: () => 5_000, onChange: (value) => changed.push(value) });
  const interrupted = restarted.current();
  assert.equal(interrupted.status, "interrupted");
  assert.ok(interrupted.version > refreshed.version);
  assert.equal(interrupted.stages[0].status, "succeeded");
  assert.equal(interrupted.stages.at(-1).status, "interrupted");
  assert.deepEqual(interrupted.stages.at(-1).pendingNodes, []);
  assert.match(interrupted.error, /restart.*not replayed/i);
  assert.equal(logs(interrupted)[0].text, "Loading model");
  assert.deepEqual(changed, []);
  assert.equal(JSON.parse(fs.readFileSync(file(id), "utf8")).status, "interrupted");
  assert.deepEqual(new RecipeSessionStore({ dir }).current(), interrupted);
});

test("a terminal Current survives restart and history selection never replaces it", (t) => {
  const { store, dir } = harness(t);
  const previous = store.start(input("old"));
  enter(store, previous.id, "starting");
  finish(store, previous.id);
  const current = store.start(input("new"));
  enter(store, current.id, "checking-nodes");
  enter(store, current.id, "failed", { error: "Readiness failed" });
  const terminal = store.current();
  assert.equal(store.get(previous.id).status, "succeeded");
  assert.deepEqual(store.current(), terminal);
  assert.deepEqual(store.list().map((session) => session.id), [current.id, previous.id]);
  assert.equal("stages" in store.list()[0], false);
  assert.deepEqual(new RecipeSessionStore({ dir }).current(), terminal);
});

test("retains the newest terminal sessions plus a running current record", (t) => {
  const { store, dir, file } = harness(t, { maxSessions: 2 });
  const ids = [];
  for (let index = 0; index < 4; index++) {
    const { id } = store.start(input(`recipe-${index}`));
    ids.push(id);
    enter(store, id, "checking-nodes");
    finish(store, id);
  }
  assert.deepEqual(store.list().map((session) => session.id), [ids[3], ids[2]]);
  assert.equal(store.get(ids[0]), null);
  assert.equal(fs.existsSync(file(ids[1])), false);
  const running = store.start(input("running"));
  assert.equal(store.list().length, 2);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length, 3);
  const restarted = new RecipeSessionStore({ dir, maxSessions: 2 });
  assert.equal(restarted.current().id, running.id);
  assert.equal(restarted.list().length, 2);
});

test("redacts supplied secrets and Bearer credentials before output, errors, and disk", (t) => {
  const { store, changes, file } = harness(t);
  const { id } = store.start(input(), { secrets: ["private-password", "secret-token", ""] });
  enter(store, id, "starting", { message: "Using private-password" });
  store.appendLog(id, { stream: "stdout", text: "\x1b[32mgreen\x1b[0m\x00 private-password secret-token" });
  store.appendLog(id, { stream: "stderr", text: 'Authorization: Bearer abc.def-123\n"Authorization":"Bearer other-token"\rBearer third-token' });
  const done = enter(store, id, "failed", { error: "private-password rejected: Authorization=Bearer error-token" });
  const serialized = JSON.stringify(done);
  for (const secret of ["private-password", "secret-token", "abc.def-123", "other-token", "third-token", "error-token"]) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(fs.readFileSync(file(id), "utf8").includes(secret), false);
    assert.equal(JSON.stringify(changes).includes(secret), false);
  }
  assert.match(logs(done)[0].text, /^green \[REDACTED\] \[REDACTED\]$/);
  assert.equal(/[\x00\x1b]/.test(serialized), false);
  assert.match(done.error, /\[REDACTED\]/);
  assert.equal("secrets" in done, false);
});

test("bounds UTF-8 lines and total output, retaining final errors across reload", (t) => {
  const { store, dir } = harness(t, { maxOutputBytes: 20_000 });
  const { id } = store.start(input());
  enter(store, id, "starting");
  store.appendLog(id, { stream: "stdout", text: "😀".repeat(5_000) + "x" });
  const first = logs(store.get(id))[0];
  assert.ok(Buffer.byteLength(first.text) <= 16 * 1024);
  assert.equal(first.text.includes("�"), false);
  store.appendLog(id, { stream: "stdout", text: "older ".repeat(2_000) });
  store.appendLog(id, { stream: "stderr", text: "latest useful output" });
  enter(store, id, "failed", { error: "Final useful error is never evicted with stdout" });
  const bounded = store.current();
  assert.ok(logs(bounded).reduce((total, line) => total + Buffer.byteLength(line.text), 0) <= 20_000);
  assert.equal(bounded.logsTruncated, true);
  assert.equal(logs(bounded).at(-1).text, "latest useful output");
  assert.equal(bounded.lastSeq, 3);
  assert.equal(bounded.firstSeq, 2, "the oldest evicted line is excluded from live caches");
  assert.equal(store.get(id, { afterSeq: 2 }).firstSeq, 2,
    "delta responses retain the server's full retained-output watermark");
  const restored = new RecipeSessionStore({ dir, maxOutputBytes: 20_000 });
  assert.deepEqual(restored.current(), bounded);
  const smaller = new RecipeSessionStore({ dir, maxOutputBytes: 256 });
  assert.equal(smaller.current().error, bounded.error);
  assert.equal(logs(smaller.current()).at(-1).text, "latest useful output");
  assert.ok(logs(smaller.current()).reduce((total, line) => total + Buffer.byteLength(JSON.stringify(line)) + 1, 0) <= 256);
  assert.equal(new RecipeSessionStore({ dir, maxOutputBytes: 256 }).current().logsTruncated, true);
});

test("zero output budget also bounds blank lines and marks dropped output", (t) => {
  const { store } = harness(t, { maxOutputBytes: 0 });
  const { id } = store.start(input());
  enter(store, id, "starting");
  store.appendLog(id, { stream: "stdout", text: "\n\nabc" });
  assert.deepEqual(logs(store.current()), []);
  assert.equal(store.current().logsTruncated, true);
});

test("delta getters retain full metadata and cannot mutate internal or private state", (t) => {
  const { store, changes } = harness(t);
  const originalInput = input();
  const started = store.start(originalInput, { secrets: ["hidden"] });
  originalInput.requiredNodes[0].name = "mutated input";
  started.requiredNodes[0].name = "mutated returned start";
  enter(store, started.id, "starting");
  store.appendLog(started.id, { stream: "stdout", text: "first" });
  store.appendLog(started.id, { stream: "stderr", text: "second" });
  const detail = store.get(started.id, { afterSeq: 1 });
  assert.equal(detail.lastSeq, 2);
  assert.deepEqual(logs(detail).map((line) => line.text), ["second"]);
  assert.equal(detail.stages.length, 1);
  detail.stages[0].logs[0].text = "mutated detail";
  store.current().stages.push({});
  store.summary().requiredNodes[0].name = "mutated summary";
  changes[0].requiredNodes[0].name = "mutated event";
  assert.equal(store.current().requiredNodes[0].name, "Spark 1");
  assert.deepEqual(logs(store.current()).map((line) => line.text), ["first", "second"]);
  assert.equal(store.current().stages.length, 1);
  assert.equal("stages" in store.summary(), false);
  assert.equal("secrets" in detail, false);
});

test("terminal records reject late callbacks and preserve an earlier useful error", (t) => {
  const { store, changes } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "starting", { error: "Useful command error" });
  enter(store, id, "failed", { error: "" });
  const terminal = store.current();
  assert.equal(terminal.error, "Useful command error");
  const count = changes.length;
  enter(store, id, "health-checking", { progress: { percent: 100, etaSeconds: 0, source: "log" } });
  enter(store, id, "done");
  store.appendLog(id, { stream: "stdout", text: "late callback" });
  assert.deepEqual(store.current(), terminal);
  assert.equal(changes.length, count);
  assert.throws(() => {
    const running = store.start(input("next"));
    assert.equal(running.status, "running");
    store.start(input("overlap"));
  }, /already running/);
});

test("invalid IDs never resolve files and malformed records do not destroy good history", (t) => {
  t.mock.method(console, "error", () => {});
  const { store, dir, file } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "checking-nodes");
  finish(store, id);
  const badJson = randomUUID();
  const badSchema = randomUUID();
  fs.writeFileSync(file(badJson), '{"private":"do-not-print",');
  fs.writeFileSync(file(badSchema), JSON.stringify({ id: badSchema, status: "running" }));
  fs.writeFileSync(path.join(dir, "not-a-session.json"), "unrelated");
  fs.writeFileSync(path.join(dir, `${randomUUID()}.json.123.tmp`), "incomplete atomic write");
  const good = JSON.parse(fs.readFileSync(file(id), "utf8"));
  good.secrets = ["private metadata must never leak"];
  good.stages[0].internal = "private stage metadata";
  fs.writeFileSync(file(id), JSON.stringify(good));
  const recovered = new RecipeSessionStore({ dir });
  assert.equal(recovered.list().length, 1);
  assert.equal(recovered.current().id, id);
  assert.equal("secrets" in recovered.current(), false);
  assert.equal("internal" in recovered.current().stages[0], false);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith(`${badJson}.json.corrupt-`)));
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith(`${badSchema}.json.corrupt-`)));
  assert.equal(fs.readFileSync(path.join(dir, "not-a-session.json"), "utf8"), "unrelated");
  for (const value of ["../outside", "", null, `${id}/../file`, id.toUpperCase(), "1".repeat(36)]) {
    assert.equal(isValidRecipeSessionId(value), false);
    assert.equal(recovered.get(value), null);
    assert.equal(recovered.appendLog(value, { stream: "stdout", text: "ignored" }), null);
    assert.equal(recovered.recordProgress(value, { phase: "done" }), null);
  }
  assert.equal(JSON.stringify(console.error.mock.calls).includes("do-not-print"), false);
});

test("subscriber failures are isolated from the Apply operation", (t) => {
  t.mock.method(console, "error", () => {});
  const { store } = harness(t, { onChange: () => { throw new Error("subscriber secret-value"); } });
  const { id } = store.start(input(), { secrets: ["secret-value"] });
  assert.doesNotThrow(() => enter(store, id, "starting"));
  assert.doesNotThrow(() => store.appendLog(id, { stream: "stdout", text: "working" }));
  assert.doesNotThrow(() => finish(store, id));
  assert.equal(store.current().status, "succeeded");
  assert.ok(console.error.mock.calls.length > 0);
  assert.equal(JSON.stringify(console.error.mock.calls).includes("secret-value"), false);
});

test("output and progress persist on the 500ms throttle; stage and terminal transitions flush immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, file } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "starting");
  const read = () => JSON.parse(fs.readFileSync(file(id), "utf8"));
  store.appendLog(id, { stream: "stdout", text: "first" });
  enter(store, id, "starting", { progress: { percent: 50, etaSeconds: 1, source: "log" } });
  assert.equal(read().lastSeq, 0);
  t.mock.timers.tick(499);
  assert.equal(read().lastSeq, 0);
  t.mock.timers.tick(1);
  assert.equal(read().lastSeq, 1);
  assert.equal(read().stages[0].progress.percent, 50);
  store.appendLog(id, { stream: "stderr", text: "second" });
  enter(store, id, "health-checking");
  assert.equal(read().lastSeq, 2);
  store.appendLog(id, { stream: "stdout", text: "third" });
  finish(store, id);
  assert.equal(read().lastSeq, 3);
  assert.equal(read().status, "succeeded");
});

test("shutdown flush persists pending output without terminating the session", (t) => {
  const { store, file } = harness(t);
  const { id } = store.start(input());
  enter(store, id, "starting");
  store.appendLog(id, { stream: "stdout", text: "pending output" });
  store.flush();
  const persisted = JSON.parse(fs.readFileSync(file(id), "utf8"));
  assert.equal(persisted.status, "running");
  assert.equal(logs(persisted)[0].text, "pending output");
});

test("initial write failure throws before publishing a session and preserves existing current", (t) => {
  t.mock.method(console, "error", () => {});
  const { store, file, changes } = harness(t);
  const { id } = store.start(input());
  finish(store, id);
  const prior = store.current();
  const bytes = fs.readFileSync(file(id), "utf8");
  const count = changes.length;
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
  assert.throws(() => store.start(input("not-started")), /Could not persist Apply session/);
  rename.mock.restore();
  assert.deepEqual(store.current(), prior);
  assert.equal(changes.length, count);
  assert.equal(fs.readFileSync(file(id), "utf8"), bytes);
});

test("later atomic-write failures preserve good disk data and expose recoverable storageError", (t) => {
  t.mock.method(console, "error", () => {});
  const { store, file, dir } = harness(t);
  const { id } = store.start(input(), { secrets: ["storage-secret"] });
  enter(store, id, "starting");
  const old = fs.readFileSync(file(id), "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("storage-secret disk unavailable"); });
  const failedWrite = enter(store, id, "health-checking");
  assert.match(failedWrite.storageError, /\[REDACTED\] disk unavailable/);
  assert.equal(fs.readFileSync(file(id), "utf8"), old);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  rename.mock.restore();
  store.flush();
  const recovered = store.current();
  assert.equal(recovered.storageError, null);
  assert.ok(recovered.version > failedWrite.version);
  assert.ok(recovered.updatedAt > failedWrite.updatedAt);
  assert.equal(JSON.parse(fs.readFileSync(file(id), "utf8")).phase, "health-checking");
  assert.equal(JSON.stringify(console.error.mock.calls).includes("storage-secret"), false);
});

test("startup directory errors fail clearly and recovery write errors remain visible without events", (t) => {
  t.mock.method(console, "error", () => {});
  const { store, root, dir, file } = harness(t);
  const notDirectory = path.join(root, "regular-file");
  fs.writeFileSync(notDirectory, "not a directory");
  assert.throws(() => new RecipeSessionStore({ dir: notDirectory }), /Could not read recipe session directory/);
  const { id } = store.start(input());
  enter(store, id, "starting");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("read-only storage"); });
  const changes = [];
  const restarted = new RecipeSessionStore({ dir, onChange: (value) => changes.push(value) });
  assert.equal(restarted.current().status, "interrupted");
  assert.match(restarted.current().storageError, /read-only storage/);
  assert.deepEqual(changes, []);
  assert.equal(JSON.parse(fs.readFileSync(file(id), "utf8")).status, "running");
  rename.mock.restore();
  restarted.flush();
  assert.equal(restarted.current().storageError, null);
  assert.equal(JSON.parse(fs.readFileSync(file(id), "utf8")).status, "interrupted");
});
