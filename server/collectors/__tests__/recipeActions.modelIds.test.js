import test from "node:test";
import assert from "node:assert/strict";
import { syncModelsForRecipe, RecipeSwitchError } from "../recipeActions.js";

function recipeRegistryStub(sparks) {
  return {
    sparkRegistry: { sparks },
    _sparkForNode(node) {
      return sparks.find((s) => s.role === node.role) || null;
    },
  };
}

// ─── syncModelsForRecipe: modelIds array (Engram-style multi-model nodes) ──────

test("syncModelsForRecipe: a node with no modelIds is left alone, no Model Registry required", async () => {
  const recipeRegistry = recipeRegistryStub([{ id: "spark1", role: "head" }]);
  const recipe = { id: "r", nodes: [{ role: "head" }] };
  // modelRegistry is null — would throw immediately if the node were touched at all.
  await syncModelsForRecipe(recipeRegistry, null, recipe);
});

test("syncModelsForRecipe: an empty modelIds array is treated the same as absent", async () => {
  const recipeRegistry = recipeRegistryStub([{ id: "spark1", role: "head" }]);
  const recipe = { id: "r", nodes: [{ role: "head", modelIds: [] }] };
  await syncModelsForRecipe(recipeRegistry, null, recipe);
});

test("syncModelsForRecipe: modelIds present but no Model Registry configured fails with a clear error", async () => {
  const recipeRegistry = recipeRegistryStub([{ id: "spark1", role: "head" }]);
  const recipe = { id: "r", nodes: [{ role: "head", modelIds: ["weights", "engram"] }] };
  await assert.rejects(
    () => syncModelsForRecipe(recipeRegistry, null, recipe),
    (err) => err instanceof RecipeSwitchError && /weights, engram/.test(err.message) && /no model registry/i.test(err.message)
  );
});

test("syncModelsForRecipe: an unknown model id in the array fails fast, naming that id", async () => {
  const recipeRegistry = recipeRegistryStub([{ id: "spark1", role: "head" }]);
  const modelRegistry = { getModel: (id) => (id === "weights" ? { id: "weights" } : null) };
  // The bad id first — must fail on it before ever reaching a real syncModelToSpark call
  // for a valid one (this test's registry stub deliberately can't complete a real sync).
  const recipe = { id: "r", nodes: [{ role: "head", modelIds: ["engram-typo", "weights"] }] };
  await assert.rejects(
    () => syncModelsForRecipe(recipeRegistry, modelRegistry, recipe),
    /references unknown model engram-typo/i
  );
});

test("syncModelsForRecipe: no Spark configured for the node's role fails before touching any model", async () => {
  const recipeRegistry = recipeRegistryStub([{ id: "spark2", role: "worker" }]);
  const modelRegistry = { getModel: () => ({ id: "weights" }) };
  const recipe = { id: "r", nodes: [{ role: "head", modelIds: ["weights"] }] };
  await assert.rejects(
    () => syncModelsForRecipe(recipeRegistry, modelRegistry, recipe),
    /no spark configured for role head/i
  );
});
