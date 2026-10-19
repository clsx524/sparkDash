/**
 * SparkRegistry power-control config + encrypted token handling.
 *
 * The token is write-only: it must never appear in the public API shape, and
 * it must be removed when the power config or the Spark itself is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-power-config-"));
process.env.SPARKS_JSON_PATH = path.join(TMPDIR, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
process.env.POWER_STATE_JSON_PATH = path.join(TMPDIR, "power-state.json");

const { SparkRegistry } = await import("../SparkRegistry.js");
const { loadSecrets } = await import("../../secretsStore.js");

function freshRegistry() {
  fs.rmSync(process.env.SPARKS_JSON_PATH, { force: true });
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  return new SparkRegistry();
}

const POWER = {
  onUrl: "http://kasa-mcp:8812/outlets/on",
  offUrl: "http://kasa-mcp:8812/outlets/off",
  target: "1",
  method: "post",
  timeoutMs: 5000,
};

test("powerControl is normalized and the token is redacted from the public shape", () => {
  const registry = freshRegistry();
  registry.addSpark({
    id: "spark1",
    name: "Spark 1",
    lanIp: "192.168.1.10",
    powerControl: POWER,
    powerToken: "secret-token",
  });

  const publicSpark = registry.publicSparks[0];
  assert.equal(publicSpark.powerControl.method, "POST");
  assert.equal(publicSpark.powerControl.target, "1");
  assert.equal(publicSpark.powerControl.timeoutMs, 5000);
  assert.equal(publicSpark.hasPowerToken, true);
  assert.equal("powerToken" in publicSpark, false);

  const internal = registry.getSpark("spark1");
  assert.equal(internal.powerToken, "secret-token");
});

test("updating the token keeps it encrypted and clearing it removes it", () => {
  const registry = freshRegistry();
  registry.addSpark({
    id: "spark1",
    name: "Spark 1",
    lanIp: "192.168.1.10",
    powerControl: POWER,
    powerToken: "first-token",
  });

  registry.updateSpark("spark1", { powerToken: "second-token" });
  assert.equal(registry.getSpark("spark1").powerToken, "second-token");
  assert.equal(registry.publicSparks[0].hasPowerToken, true);

  registry.updateSpark("spark1", { powerToken: "" });
  assert.equal(registry.getSpark("spark1").powerToken, undefined);
  assert.equal(registry.publicSparks[0].hasPowerToken, false);
});

test("removing the power config clears the token", () => {
  const registry = freshRegistry();
  registry.addSpark({
    id: "spark1",
    name: "Spark 1",
    lanIp: "192.168.1.10",
    powerControl: POWER,
    powerToken: "secret-token",
  });

  registry.updateSpark("spark1", { powerControl: null });
  assert.equal(registry.publicSparks[0].powerControl, null);
  assert.equal(registry.publicSparks[0].hasPowerToken, false);
  assert.equal(loadSecrets().powerTokens.has("spark1"), false);
});

test("removing the Spark removes its power token", () => {
  const registry = freshRegistry();
  registry.addSpark({
    id: "spark1",
    name: "Spark 1",
    lanIp: "192.168.1.10",
    powerControl: POWER,
    powerToken: "secret-token",
  });

  registry.removeSpark("spark1");
  assert.equal(loadSecrets().powerTokens.has("spark1"), false);
});

test("a power config with no URL is dropped", () => {
  const registry = freshRegistry();
  registry.addSpark({
    id: "spark1",
    name: "Spark 1",
    lanIp: "192.168.1.10",
    powerControl: { target: "1" },
  });
  assert.equal(registry.publicSparks[0].powerControl, null);
});
