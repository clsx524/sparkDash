import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syncModelToSpark, shQuotePath, joinRemotePath } from "../modelSync.js";

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
