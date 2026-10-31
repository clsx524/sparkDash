import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-modelregistry-"));
process.env.MODEL_REGISTRY_JSON_PATH = path.join(tmp, "model-registry.json");
process.env.MODELS_JSON_PATH = path.join(tmp, "models.json");

const { ModelRegistry, splitIncludePatterns, filterManifestToIncluded } = await import("../ModelRegistry.js");

const sparkRegistryStub = { getSpark: () => null };

function fresh() {
  fs.rmSync(process.env.MODEL_REGISTRY_JSON_PATH, { force: true });
  fs.rmSync(process.env.MODELS_JSON_PATH, { force: true });
  return new ModelRegistry(sparkRegistryStub);
}

// ─── addModel ──────────────────────────────────────────────

test("addModel: requires a repo — manual tracking is a deliberate declare-to-download action", () => {
  const r = fresh();
  assert.throws(
    () => r.addModel({ id: "m1", subfolder: "m1" }),
    /repo is required/
  );
});

test("addModel: rejects an invalid id", () => {
  const r = fresh();
  assert.throws(
    () => r.addModel({ id: "bad id!", subfolder: "m1", repo: "org/repo" }),
    /allowed characters/
  );
});

test("addModel: rejects a duplicate id", () => {
  const r = fresh();
  r.addModel({ id: "m1", subfolder: "m1", repo: "org/repo" });
  assert.throws(() => r.addModel({ id: "m1", subfolder: "m2", repo: "org/repo2" }), /already tracked/);
});

// ─── updateModel ───────────────────────────────────────────

test("updateModel: sets repo/revision on a discovered stub without touching id/subfolder", () => {
  const r = fresh();
  r.reconcileNames(["llama-4"]);
  const before = r.getModel("llama-4");
  assert.equal(before.repo, null);

  const after = r.updateModel("llama-4", { repo: "meta/llama-4", revision: "v1" });
  assert.equal(after.id, "llama-4");
  assert.equal(after.subfolder, "llama-4");
  assert.equal(after.repo, "meta/llama-4");
  assert.equal(after.revision, "v1");
});

test("updateModel: blank repo collapses to null, blank revision falls back to main", () => {
  const r = fresh();
  r.addModel({ id: "m1", subfolder: "m1", repo: "org/repo", revision: "v2" });
  const after = r.updateModel("m1", { repo: "  ", revision: "  " });
  assert.equal(after.repo, null);
  assert.equal(after.revision, "main");
});

test("updateModel: throws for an untracked id", () => {
  const r = fresh();
  assert.throws(() => r.updateModel("nope", { repo: "org/repo" }), /is not tracked/);
});

test("updateModel: persists across a reload", () => {
  const r = fresh();
  r.addModel({ id: "m1", subfolder: "m1", repo: "org/repo" });
  r.updateModel("m1", { repo: "org/repo2" });
  const r2 = new ModelRegistry(sparkRegistryStub);
  assert.equal(r2.getModel("m1").repo, "org/repo2");
});

// ─── reconcileNames (pure discovery/dedup core) ────────────

test("reconcileNames: tracks every on-disk folder not already tracked", () => {
  const r = fresh();
  const { discovered } = r.reconcileNames(["model-a", "model-b"]);
  assert.deepEqual(discovered.sort(), ["model-a", "model-b"]);
  assert.equal(r.all().length, 2);
  assert.equal(r.getModel("model-a").repo, null);
  assert.equal(r.getModel("model-a").subfolder, "model-a");
});

test("reconcileNames: never re-discovers a folder already tracked by subfolder", () => {
  const r = fresh();
  r.addModel({ id: "custom-id", subfolder: "model-a", repo: "org/repo" });
  const { discovered } = r.reconcileNames(["model-a", "model-b"]);
  assert.deepEqual(discovered, ["model-b"]);
  assert.equal(r.all().length, 2);
  // the manually-tracked entry is untouched, not duplicated or overwritten
  assert.equal(r.getModel("custom-id").repo, "org/repo");
});

test("reconcileNames: never removes a tracked entry whose folder is momentarily absent from the scan", () => {
  const r = fresh();
  r.addModel({ id: "m1", subfolder: "m1", repo: "org/repo" });
  r.reconcileNames([]); // empty scan result — e.g. directory briefly emptied mid-copy
  assert.equal(r.getModel("m1").repo, "org/repo");
});

test("reconcileNames: sanitizes a folder name with disallowed characters into a valid id, keeps the real subfolder", () => {
  const r = fresh();
  const { discovered } = r.reconcileNames(["My Model v2!"]);
  assert.equal(discovered.length, 1);
  const model = r.getModel(discovered[0]);
  assert.match(model.id, /^[a-zA-Z0-9._-]{1,128}$/);
  assert.equal(model.subfolder, "My Model v2!");
});

test("reconcileNames: disambiguates an id collision with a suffix instead of overwriting", () => {
  const r = fresh();
  r.addModel({ id: "model-a", subfolder: "something-else", repo: "org/repo" });
  const { discovered } = r.reconcileNames(["model-a"]);
  assert.equal(discovered.length, 1);
  assert.notEqual(discovered[0], "model-a");
  assert.equal(r.getModel("model-a").subfolder, "something-else"); // original untouched
  assert.equal(r.getModel(discovered[0]).subfolder, "model-a");
});

test("reconcileNames: running it twice in a row is idempotent (no duplicate entries)", () => {
  const r = fresh();
  r.reconcileNames(["model-a"]);
  const { discovered } = r.reconcileNames(["model-a"]);
  assert.deepEqual(discovered, []);
  assert.equal(r.all().length, 1);
});

// ─── downloadModel: repo-required guard reports through job state ──────

test("downloadModel: a discovered model with no repo fails fast with a clear, polled error", async () => {
  const r = fresh();
  r.reconcileNames(["llama-4"]);
  await assert.rejects(() => r.downloadModel("llama-4"), /no source repo set/i);
  const job = r.getJobState("llama-4");
  assert.equal(job.phase, "failed");
  assert.match(job.error, /no source repo set/i);
});

// ─── Hugging Face auth on the registry host ────────────────

test("probeHfToken: no registry host configured reports hasToken false with an error", async () => {
  const r = fresh();
  const status = await r.probeHfToken();
  assert.deepEqual(status, { hasToken: false, username: null, error: "No Model Registry host configured" });
});

test("setHfToken: rejects an empty/whitespace-only token before ever touching the registry host", async () => {
  const r = fresh();
  await assert.rejects(() => r.setHfToken(""), /token is required/i);
  await assert.rejects(() => r.setHfToken("   "), /token is required/i);
  await assert.rejects(() => r.setHfToken(undefined), /token is required/i);
});

test("setHfToken: no registry host configured fails with a clear error even with a real token", async () => {
  const r = fresh();
  await assert.rejects(() => r.setHfToken("hf_realtoken"), /no model registry host configured/i);
});

// ─── registry config round-trip ────────────────────────────

test("setRegistryConfig: trims directory, collapses empty hostId to null, round-trips", () => {
  const r = fresh();
  const saved = r.setRegistryConfig({ hostId: "  beast  ", directory: "  /mnt/models  " });
  assert.deepEqual(saved, { hostId: "beast", directory: "/mnt/models" });
  assert.deepEqual(r.getRegistryConfig(), { hostId: "beast", directory: "/mnt/models" });
});

test("setRegistryConfig: empty hostId clears the registry host", () => {
  const r = fresh();
  r.setRegistryConfig({ hostId: "beast", directory: "/mnt/models" });
  r.setRegistryConfig({ hostId: "", directory: "/mnt/models" });
  assert.equal(r.getRegistryConfig().hostId, null);
});

const nfsConfig = () => ({
  hostId: "atom",
  directory: "/home/op/.cache/huggingface/registry",
  nfsMounts: {
    "spark-1": { path: "/mnt/atom-model-registry", source: "10.100.30.2:/home/op/.cache/huggingface/registry" },
  },
});

test("registry config API preserves NFS mounts on legacy UI saves and reloads", () => {
  const r = fresh();
  const config = nfsConfig();
  assert.deepEqual(r.setRegistryConfig(config), config);
  assert.deepEqual(r.setRegistryConfig({ hostId: " atom ", directory: ` ${config.directory} ` }), config);
  assert.deepEqual(new ModelRegistry(sparkRegistryStub).getRegistryConfig(), config);
});

test("registry config API detaches both supplied mounts and returned nested mounts", () => {
  const r = fresh();
  const input = nfsConfig();
  const saved = r.setRegistryConfig(input);
  input.nfsMounts["spark-1"].path = "/wrong-input";
  saved.nfsMounts["spark-1"].source = "wrong:/saved";
  const fetched = r.getRegistryConfig();
  fetched.nfsMounts["spark-1"].path = "/wrong-get";
  assert.deepEqual(r.getRegistryConfig(), nfsConfig());
});

for (const patch of [{ hostId: "another-host" }, { directory: "/another-directory" }, { hostId: null }]) {
  test(`registry config API clears stale NFS mappings for ${JSON.stringify(patch)}`, () => {
    const r = fresh();
    r.setRegistryConfig(nfsConfig());
    const canonical = { hostId: "atom", directory: nfsConfig().directory, ...patch };
    assert.deepEqual(r.setRegistryConfig(canonical), canonical);
    assert.deepEqual(new ModelRegistry(sparkRegistryStub).getRegistryConfig(), canonical);
  });
}

test("registry config API accepts explicit replacements or an empty mapping", () => {
  const r = fresh();
  r.setRegistryConfig(nfsConfig());
  const replacement = {
    hostId: "new-registry", directory: "/new",
    nfsMounts: { "spark-1": { path: "/mnt/new/", source: "new-registry:/new" } },
  };
  const saved = r.setRegistryConfig(replacement);
  assert.equal(saved.nfsMounts["spark-1"].path, "/mnt/new");
  assert.equal(saved.nfsMounts["spark-1"].source, "new-registry:/new");
  assert.deepEqual(r.setRegistryConfig({ ...saved, nfsMounts: {} }).nfsMounts, {});
});

for (const nfsMounts of [
  null, [], "not-a-map",
  { "spark-1": null },
  { "": { path: "/mnt/models", source: "atom:/registry" } },
  { "spark-1": { path: "relative/models", source: "atom:/registry" } },
  { "spark-1": { path: "~/models", source: "atom:/registry" } },
  { "spark-1": { path: "/mnt/\0models", source: "atom:/registry" } },
  { "spark-1": { path: "/mnt/models", source: "" } },
  { "spark-1": { path: "/mnt/models", source: "atom:relative" } },
  { "spark-1": { path: "/mnt/models", source: "/registry" } },
]) {
  test(`registry config API rejects invalid NFS mapping ${JSON.stringify(nfsMounts)} without saving`, () => {
    const r = fresh();
    r.setRegistryConfig(nfsConfig());
    assert.throws(() => r.setRegistryConfig({ ...nfsConfig(), nfsMounts }), /nfsMounts/);
    assert.deepEqual(r.getRegistryConfig(), nfsConfig());
    assert.deepEqual(new ModelRegistry(sparkRegistryStub).getRegistryConfig(), nfsConfig());
  });
}

test("invalid persisted NFS configuration fails closed rather than loading SSH mode", () => {
  fresh();
  fs.writeFileSync(process.env.MODEL_REGISTRY_JSON_PATH, JSON.stringify({
    ...nfsConfig(), nfsMounts: { "spark-1": { path: "relative", source: "atom:/registry" } },
  }));
  assert.throws(() => new ModelRegistry(sparkRegistryStub), /nfsMounts.*absolute/);
});

test("NFS mappings require a canonical host and directory", () => {
  const r = fresh();
  for (const patch of [{ hostId: null }, { directory: "" }]) {
    assert.throws(() => r.setRegistryConfig({ ...nfsConfig(), ...patch }), /nfsMounts requires/);
  }
});

// ─── splitIncludePatterns / filterManifestToIncluded: multi-file partial fetches ──────
// (e.g. Engram: only 2 of a 48-shard repo's shards plus its index, sharing no single glob)

test("splitIncludePatterns: null/empty/whitespace-only yields no patterns", () => {
  assert.deepEqual(splitIncludePatterns(null), []);
  assert.deepEqual(splitIncludePatterns(undefined), []);
  assert.deepEqual(splitIncludePatterns(""), []);
  assert.deepEqual(splitIncludePatterns("   "), []);
});

test("splitIncludePatterns: splits on whitespace, ignores extra spacing/newlines", () => {
  assert.deepEqual(
    splitIncludePatterns("model-00047-of-00048.safetensors  model-00048-of-00048.safetensors\n*.index.json"),
    ["model-00047-of-00048.safetensors", "model-00048-of-00048.safetensors", "*.index.json"]
  );
});

test("filterManifestToIncluded: no includePattern keeps the full manifest untouched", () => {
  const manifest = [{ path: "a.safetensors", sha256: "1" }, { path: "b.safetensors", sha256: "2" }];
  assert.deepEqual(filterManifestToIncluded(manifest, null), manifest);
});

test("filterManifestToIncluded: keeps only entries matching one of several exact-filename patterns", () => {
  const manifest = [
    { path: "model-00001-of-00048.safetensors", sha256: "1" },
    { path: "model-00047-of-00048.safetensors", sha256: "47" },
    { path: "model-00048-of-00048.safetensors", sha256: "48" },
    { path: "config.json", sha256: "c" },
  ];
  const filtered = filterManifestToIncluded(
    manifest,
    "model-00047-of-00048.safetensors model-00048-of-00048.safetensors"
  );
  assert.deepEqual(filtered.map((e) => e.path), [
    "model-00047-of-00048.safetensors",
    "model-00048-of-00048.safetensors",
  ]);
});

test("filterManifestToIncluded: glob character class matches a numeric range without matching neighbors", () => {
  const manifest = [
    { path: "model-00046-of-00048.safetensors", sha256: "46" },
    { path: "model-00047-of-00048.safetensors", sha256: "47" },
    { path: "model-00048-of-00048.safetensors", sha256: "48" },
  ];
  const filtered = filterManifestToIncluded(manifest, "model-0004[78]-of-00048.safetensors");
  assert.deepEqual(filtered.map((e) => e.path), [
    "model-00047-of-00048.safetensors",
    "model-00048-of-00048.safetensors",
  ]);
});
