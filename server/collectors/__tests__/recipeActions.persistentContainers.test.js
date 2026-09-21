import test from "node:test";
import assert from "node:assert/strict";
import { PERSISTENT_CONTAINER_NAMES } from "../recipeActions.js";

// clearStaleContainers() force-removes every container on a head/worker Spark that
// isn't named here, on every single recipe switch (see recipeActions.js's own doc
// comment on the array). Standalone always-on services that live outside the recipe
// system entirely -- qwen3-embedding and semif, neither of which has a recipes.json
// entry or a start.sh -- were both silently deleted the first time a recipe was
// switched after they were deployed, because sparkDash had no way to know they
// existed. This locks in that regression can't silently recur for either of them.

test("PERSISTENT_CONTAINER_NAMES excludes the fleet's standalone always-on services from the recipe-switch sweep", () => {
  assert.ok(PERSISTENT_CONTAINER_NAMES.includes("qwen3-embedding"));
  assert.ok(PERSISTENT_CONTAINER_NAMES.includes("semif"));
});

test("PERSISTENT_CONTAINER_NAMES still excludes the fleet's own infrastructure and NFS exporters", () => {
  for (const name of ["portainer_agent", "vllm-fn-nfs", "glm53-nfs", "dsv41-nfs", "dsv41-exl3-nfs", "dspark-nfs"]) {
    assert.ok(PERSISTENT_CONTAINER_NAMES.includes(name), `expected ${name} to remain in the allowlist`);
  }
});
