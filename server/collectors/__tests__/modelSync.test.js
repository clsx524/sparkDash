import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syncModelToSpark, shQuotePath, joinRemotePath, shardFiles } from "../modelSync.js";

// shQuotePath must preserve a leading "~" unquoted (so the remote shell still
// expands it to that user's home) while still safely quoting everything
// else. Single-quoting a tilde is a real bug this session hit once already:
// the default model folder is "~/.cache/huggingface", and a naive shQuote()
// would turn `mkdir -p '~/.cache/huggingface/foo'` into a literal directory
// named "~" instead of expanding to the user's home.

test("shQuotePath: bare tilde stays unquoted", () => {
  assert.equal(shQuotePath("~"), "~");
});

test("shQuotePath: tilde-prefixed path keeps the tilde bare, quotes the rest", () => {
  assert.equal(shQuotePath("~/.cache/huggingface/my-model"), "~/'.cache/huggingface/my-model'");
});

test("shQuotePath: an absolute path is fully quoted like shQuote", () => {
  assert.equal(shQuotePath("/mnt/models/my-model"), "'/mnt/models/my-model'");
});

test("shQuotePath: single quotes inside a tilde path are escaped in the quoted remainder", () => {
  assert.equal(shQuotePath("~/it's-a-model"), "~/'it'\\''s-a-model'");
});

test("shQuotePath: a path that merely contains a tilde later is fully quoted (only a leading ~/ is special)", () => {
  assert.equal(shQuotePath("/mnt/~cache/model"), "'/mnt/~cache/model'");
});

test("joinRemotePath: no doubled slashes at the seam", () => {
  assert.equal(joinRemotePath("~/.cache/huggingface/", "/my-model"), "~/.cache/huggingface/my-model");
});

// shardFiles: round-robins files into up to maxShards groups. Verified live
// against real hosts that this genuinely parallelizes multi-file transfers
// (measured 717MB/s vs. a ~550-700MB/s single-stream ceiling) — but it is
// still file-count-based, not size-aware, so a model dominated by one huge
// file (e.g. a single model.safetensors beside a few KB of config/readme)
// gets no real parallelism benefit no matter how many shards are requested;
// that limitation is intentional and documented here rather than silently
// assumed away.

test("shardFiles: never produces more shards than files", () => {
  const shards = shardFiles(["a", "b"], 6);
  assert.equal(shards.length, 2);
});

test("shardFiles: round-robins evenly across the requested shard count", () => {
  const shards = shardFiles(["a", "b", "c", "d", "e", "f"], 3);
  assert.equal(shards.length, 3);
  assert.deepEqual(
    shards.map((s) => s.length).sort(),
    [2, 2, 2]
  );
});

test("shardFiles: never returns an empty shard even with an uneven split", () => {
  const shards = shardFiles(["a", "b", "c", "d", "e"], 3);
  assert.equal(shards.length, 3);
  assert.ok(shards.every((s) => s.length > 0));
  assert.equal(shards.flat().length, 5);
});

test("shardFiles: a single file cannot be sharded no matter the cap (the real limitation hit live)", () => {
  const shards = shardFiles(["model.safetensors"], 6);
  assert.equal(shards.length, 1);
  assert.deepEqual(shards[0], ["model.safetensors"]);
});

test("shardFiles: an empty file list yields no shards", () => {
  assert.deepEqual(shardFiles([], 6), []);
});

// syncModelToSpark: registry-host self-sync short-circuit. When the sync
// target *is* the Model Registry host, the files are already there by
// definition — there is nothing to route (direct vs. relay) or rsync.
// Exercised with stub registry/spark objects; the self-host branch never
// touches real SSH unless the model has a manifest to verify.

function makeModelRegistry({ directory = "/data/models", verifyFilesOnHost } = {}) {
  return {
    registryHost: () => ({ id: "registry-host", ssh: { user: "op", host: "registry.lan" } }),
    getRegistryConfig: () => ({ hostId: "registry-host", directory }),
    verifyFilesOnHost: verifyFilesOnHost || (async () => []),
  };
}

const sparkRegistryStub = { getSpark: () => null };

test("syncModelToSpark: target is the registry host itself — no manifest, no SSH needed", async () => {
  const modelRegistry = makeModelRegistry();
  const model = { subfolder: "llama-4", manifest: null };
  const targetSpark = { id: "registry-host", modelFolder: "" }; // even an empty modelFolder is fine here
  const result = await syncModelToSpark(modelRegistry, sparkRegistryStub, model, targetSpark);
  assert.equal(result.destDir, "/data/models/llama-4");
});

test("syncModelToSpark: target is the registry host — manifest verifies clean", async () => {
  let calledWith = null;
  const modelRegistry = makeModelRegistry({
    verifyFilesOnHost: async (host, dir, manifest) => {
      calledWith = { hostId: host.id, dir, manifest };
      return [];
    },
  });
  const model = { subfolder: "llama-4", manifest: [{ path: "model.safetensors", sha256: "abc" }] };
  const targetSpark = { id: "registry-host", modelFolder: "" };
  const result = await syncModelToSpark(modelRegistry, sparkRegistryStub, model, targetSpark);
  assert.equal(result.destDir, "/data/models/llama-4");
  assert.deepEqual(calledWith, {
    hostId: "registry-host",
    dir: "/data/models/llama-4",
    manifest: model.manifest,
  });
});

test("syncModelToSpark: target is the registry host — manifest mismatch throws a clear error", async () => {
  const modelRegistry = makeModelRegistry({
    verifyFilesOnHost: async () => ["model.safetensors"],
  });
  const model = { subfolder: "llama-4", manifest: [{ path: "model.safetensors", sha256: "abc" }] };
  const targetSpark = { id: "registry-host", modelFolder: "" };
  await assert.rejects(
    () => syncModelToSpark(modelRegistry, sparkRegistryStub, model, targetSpark),
    /Checksum verification failed on Model Registry host registry-host.*model\.safetensors/
  );
});

test("syncModelToSpark: no registry host configured throws before touching the target", async () => {
  const modelRegistry = {
    registryHost: () => null,
    getRegistryConfig: () => ({ hostId: null, directory: "" }),
  };
  await assert.rejects(
    () => syncModelToSpark(modelRegistry, sparkRegistryStub, { subfolder: "x" }, { id: "spark1" }),
    /No Model Registry host configured/
  );
});

test("syncModelToSpark: a non-registry target with no model folder gets an actionable error", async () => {
  const modelRegistry = makeModelRegistry();
  await assert.rejects(
    () =>
      syncModelToSpark(modelRegistry, sparkRegistryStub, { subfolder: "x" }, { id: "spark2", modelFolder: "" }),
    /spark2 has no model folder configured/
  );
});

// syncModelToSpark: a non-registry target that already has a verified-
// correct copy must skip the registry host entirely, including its
// reachability preflight (hit live 2026-09-15: spark1 already had
// deepseek-v41-flash-exl3's weights correct, but activation failed anyway
// because the preflight ran unconditionally before this fix). Exercised
// with a stub verifyFilesOnHost — if the short-circuit didn't fire, this
// would fall into modelSync.js's real sshExecDirect against a targetSpark
// with no .ssh config and fail a different way.
test("syncModelToSpark: non-registry target already verified — skips the registry host preflight", async () => {
  let verifyCalledWith = null;
  const modelRegistry = makeModelRegistry({
    verifyFilesOnHost: async (host, dir, manifest) => {
      verifyCalledWith = { hostId: host.id, dir, manifest };
      return [];
    },
  });
  const model = { subfolder: "llama-4", manifest: [{ path: "model.safetensors", sha256: "abc" }] };
  const targetSpark = { id: "spark1", modelFolder: "/mnt/models" };
  const result = await syncModelToSpark(modelRegistry, sparkRegistryStub, model, targetSpark);
  assert.deepEqual(result, { destDir: "/mnt/models/llama-4", skipped: true });
  assert.deepEqual(verifyCalledWith, {
    hostId: "spark1",
    dir: "/mnt/models/llama-4",
    manifest: model.manifest,
  });
});
