import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-registry-modelfields-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { SparkRegistry } = await import("../SparkRegistry.js");

function registry() {
  fs.writeFileSync(process.env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  return new SparkRegistry();
}

test("modelFolder defaults to the standard Hugging Face cache dir when unset", () => {
  const r = registry();
  const spark = r.addSpark({ id: "s1", name: "Spark 1", lanIp: "127.0.0.1" });
  assert.equal(spark.modelFolder, "~/.cache/huggingface");
});

test("modelFolder defaults the same way for an explicitly empty string", () => {
  const r = registry();
  const spark = r.addSpark({ id: "s1", name: "Spark 1", lanIp: "127.0.0.1", modelFolder: "   " });
  assert.equal(spark.modelFolder, "~/.cache/huggingface");
});

test("modelFolder keeps an operator-provided value verbatim (trimmed)", () => {
  const r = registry();
  const spark = r.addSpark({
    id: "s1",
    name: "Spark 1",
    lanIp: "127.0.0.1",
    modelFolder: "  /mnt/nvme/models  ",
  });
  assert.equal(spark.modelFolder, "/mnt/nvme/models");
});

test("canActAsModelRelay defaults false; modelSyncRoute defaults to direct", () => {
  const r = registry();
  const spark = r.addSpark({ id: "s1", name: "Spark 1", lanIp: "127.0.0.1" });
  assert.equal(spark.canActAsModelRelay, false);
  assert.deepEqual(spark.modelSyncRoute, { mode: "direct", relayHostId: null });
});

test("modelSyncRoute cannot relay through itself", () => {
  const r = registry();
  const spark = r.addSpark({
    id: "s1",
    name: "Spark 1",
    lanIp: "127.0.0.1",
    modelSyncRoute: { mode: "relay", relayHostId: "s1" },
  });
  assert.deepEqual(spark.modelSyncRoute, { mode: "direct", relayHostId: null });
});

test("modelSyncRoute keeps a relay to a different host", () => {
  const r = registry();
  const spark = r.addSpark({
    id: "s1",
    name: "Spark 1",
    lanIp: "127.0.0.1",
    modelSyncRoute: { mode: "relay", relayHostId: "s2" },
  });
  assert.deepEqual(spark.modelSyncRoute, { mode: "relay", relayHostId: "s2" });
});
