import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LastActiveRecipeStore } from "../LastActiveRecipeStore.js";
import { RecipeSessionStore } from "../RecipeSessionStore.js";

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "last-active-recipe-store-"));
  const dir = path.join(root, "sessions");
  const file = path.join(dir, "last-active-recipe.json");
  let time = 1_000;
  const store = new LastActiveRecipeStore({ file, now: () => time });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, file, store, setTime: (value) => { time = value; } };
}

function completedSession(store, targetId) {
  const session = store.start({ targetId, label: targetId, tp: 1, requiredNodes: [{ id: "spark-1", name: "Spark 1" }] });
  store.recordProgress(session.id, { phase: "checking-nodes" });
  store.recordProgress(session.id, { phase: "done" });
  return session.id;
}

test("missing pointer stays absent until remembered and persists privately across restart", (t) => {
  const { store, file } = harness(t);
  assert.equal(store.get(), null);
  assert.equal(store.flush(), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.remember("recipe-a"), { id: "recipe-a", rememberedAt: 1_000, storageError: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { id: "recipe-a", rememberedAt: 1_000 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new LastActiveRecipeStore({ file }).get(), store.get());
});

test("pointer survives default 50-session retention and is ignored by the session loader", (t) => {
  const { store, dir, file } = harness(t);
  const sessions = new RecipeSessionStore({ dir });
  const oldestId = completedSession(sessions, "remembered-recipe");
  store.remember("remembered-recipe");
  for (let index = 0; index < 50; index++) completedSession(sessions, `history-recipe-${index}`);
  sessions.flush();
  assert.equal(sessions.list().length, 50);
  assert.equal(sessions.get(oldestId), null);
  assert.equal(fs.existsSync(path.join(dir, `${oldestId}.json`)), false);
  assert.equal(fs.existsSync(file), true);
  const restartedSessions = new RecipeSessionStore({ dir });
  assert.equal(restartedSessions.list().length, 50);
  assert.equal(restartedSessions.list().some((session) => session.targetId === "remembered-recipe"), false);
  assert.deepEqual(new LastActiveRecipeStore({ file }).get(), store.get());
});

test("same-id polling deduplicates writes while changed ids persist and replace atomically", (t) => {
  const { store, file, dir, setTime } = harness(t);
  store.remember("recipe-a");
  const originalWrite = fs.writeFileSync;
  const writes = t.mock.method(fs, "writeFileSync", (...args) => originalWrite(...args));
  setTime(2_000);
  assert.deepEqual(store.remember("recipe-a"), { id: "recipe-a", rememberedAt: 1_000, storageError: null });
  store.remember("recipe-a", 3_000);
  store.flush();
  assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(store.remember("recipe-b"), { id: "recipe-b", rememberedAt: 2_000, storageError: null });
  assert.equal(writes.mock.callCount(), 1);
  const [temporary, contents, options] = writes.mock.calls[0].arguments;
  assert.equal(temporary, `${file}.${process.pid}.tmp`);
  assert.equal(options.mode, 0o600);
  assert.deepEqual(JSON.parse(contents), { id: "recipe-b", rememberedAt: 2_000 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  assert.deepEqual(new LastActiveRecipeStore({ file }).get(), store.get());
});

test("initial write failure preserves the in-memory id and dirty flush retries without moving its time", (t) => {
  const { store, file, dir, setTime } = harness(t);
  const write = t.mock.method(fs, "writeFileSync", () => {
    throw Object.assign(new Error("do-not-expose secret filesystem message"), { code: "ENOSPC" });
  });
  assert.doesNotThrow(() => store.remember("recipe-a"));
  const failed = store.get();
  assert.deepEqual(failed, {
    id: "recipe-a", rememberedAt: 1_000, storageError: "Could not persist last active recipe (ENOSPC)",
  });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  setTime(2_000);
  store.remember("recipe-a");
  assert.equal(write.mock.callCount(), 1, "polling does not repeatedly retry a failed write");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  write.mock.restore();
  assert.deepEqual(store.flush(), { id: "recipe-a", rememberedAt: 1_000, storageError: null });
  assert.deepEqual(new LastActiveRecipeStore({ file }).get(), store.get());
});

test("subsequent rename failure retains the previous disk pointer and the latest memory pointer until retry", (t) => {
  const { store, file, dir, setTime } = harness(t);
  store.remember("recipe-a");
  const bytes = fs.readFileSync(file, "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("private rename details"); });
  setTime(2_000);
  assert.doesNotThrow(() => store.remember("recipe-b"));
  assert.equal(store.get().id, "recipe-b");
  assert.equal(store.get().rememberedAt, 2_000);
  assert.match(store.get().storageError, /Could not persist last active recipe/);
  assert.equal(store.get().storageError.includes("private"), false);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  assert.equal(new LastActiveRecipeStore({ file }).get().id, "recipe-a");
  store.flush();
  assert.equal(rename.mock.callCount(), 2, "an explicit flush retries a dirty pointer");
  setTime(3_000);
  store.remember("recipe-c");
  assert.equal(store.get().id, "recipe-c");
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  rename.mock.restore();
  store.flush();
  assert.deepEqual(store.get(), { id: "recipe-c", rememberedAt: 3_000, storageError: null });
  assert.deepEqual(new LastActiveRecipeStore({ file }).get(), store.get());
});

test("directory creation failures are recoverable without losing the remembered recipe", (t) => {
  const { store, file } = harness(t);
  const mkdir = t.mock.method(fs, "mkdirSync", () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
  assert.doesNotThrow(() => store.remember("recipe-a"));
  assert.equal(store.get().id, "recipe-a");
  assert.match(store.get().storageError, /EACCES/);
  mkdir.mock.restore();
  store.flush();
  assert.equal(store.get().storageError, null);
  assert.equal(fs.existsSync(file), true);
});

test("history timestamps seed missing state but older seeds cannot replace a newer pointer", (t) => {
  const { store, file, setTime } = harness(t);
  assert.deepEqual(store.remember("seeded", 100), { id: "seeded", rememberedAt: 100, storageError: null });
  assert.deepEqual(store.remember("older-seed", 99), store.get());
  assert.equal(store.get().id, "seeded");
  store.remember("current");
  const current = store.get();
  const writes = t.mock.method(fs, "writeFileSync", () => { throw new Error("unexpected stale-seed write"); });
  assert.deepEqual(store.remember("old-history", 999), current);
  assert.equal(writes.mock.callCount(), 0);
  writes.mock.restore();
  setTime(10);
  store.remember("observed-after-clock-rollback");
  assert.equal(store.get().rememberedAt, current.rememberedAt);
  const restored = new LastActiveRecipeStore({ file, now: () => 1 });
  restored.remember("observed-after-restart");
  assert.equal(restored.get().rememberedAt, current.rememberedAt);
});

test("corrupt JSON and invalid schema are quarantined without logging file contents", (t) => {
  const { file, dir } = harness(t);
  fs.mkdirSync(dir, { recursive: true });
  const errors = t.mock.method(console, "error", () => {});
  const invalid = [
    '{"secret":"do-not-print",',
    JSON.stringify({ id: "recipe-a", rememberedAt: -1, secret: "do-not-print" }),
    JSON.stringify({ id: "", rememberedAt: 100 }),
    JSON.stringify({ id: "recipe-a", rememberedAt: "100" }),
    "null",
  ];
  for (const [index, contents] of invalid.entries()) {
    const corruptFile = index === 0 ? file : path.join(dir, `invalid-${index}.json`);
    fs.writeFileSync(corruptFile, contents, { mode: 0o600 });
    const recovered = new LastActiveRecipeStore({ file: corruptFile });
    assert.equal(recovered.get(), null);
    assert.equal(fs.existsSync(corruptFile), false);
    const quarantine = fs.readdirSync(dir).find((name) => name.startsWith(`${path.basename(corruptFile)}.corrupt-`));
    assert.ok(quarantine);
    assert.equal(fs.readFileSync(path.join(dir, quarantine), "utf8"), contents);
    recovered.remember("recovered-recipe");
    assert.equal(new LastActiveRecipeStore({ file: corruptFile }).get().id, "recovered-recipe");
  }
  assert.equal(JSON.stringify(errors.mock.calls).includes("do-not-print"), false);
});

test("get and mutation results are defensive snapshots and unknown disk fields never escape", (t) => {
  const { store, file } = harness(t);
  const remembered = store.remember("recipe-a");
  remembered.id = "mutated-return";
  remembered.rememberedAt = 0;
  remembered.storageError = "mutated-error";
  const snapshot = store.get();
  snapshot.id = "mutated-get";
  assert.deepEqual(store.get(), { id: "recipe-a", rememberedAt: 1_000, storageError: null });
  fs.writeFileSync(file, JSON.stringify({ id: "recipe-a", rememberedAt: 1_000, storageError: "stale error", secrets: ["hidden"] }));
  const restored = new LastActiveRecipeStore({ file });
  assert.deepEqual(restored.get(), store.get());
  assert.equal(JSON.stringify(restored.get()).includes("hidden"), false);
});

test("recipe ids are data only and never determine the persistence path", (t) => {
  const { store, file, root } = harness(t);
  const id = "../outside-recipe";
  store.remember(id);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).id, id);
  assert.deepEqual(fs.readdirSync(root), ["sessions"]);
  assert.equal(new LastActiveRecipeStore({ file }).get().id, id);
  for (const invalid of [null, undefined, "", "   ", 123]) {
    assert.throws(() => store.remember(invalid), /Recipe id is required/);
  }
  for (const time of [-1, NaN, Infinity, "100", null]) {
    assert.throws(() => store.remember("recipe-b", time), /Invalid remembered recipe timestamp/);
  }
  assert.equal(store.get().id, id);
});

test("non-missing filesystem read errors fail clearly rather than discarding saved state", (t) => {
  const { file } = harness(t);
  const read = t.mock.method(fs, "readFileSync", () => {
    throw Object.assign(new Error("private filesystem detail"), { code: "EACCES" });
  });
  assert.throws(() => new LastActiveRecipeStore({ file }), /Could not read last active recipe file/);
  read.mock.restore();
});
