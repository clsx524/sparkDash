import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateRecipe, fetchRecipes } from "../api/client";
import type { RecipeInfo, RecipeSwitchState } from "../api/types";
import { flush, render } from "../testing/render";
import { RecipesDialog } from "./RecipesDialog";

vi.mock("../api/client", () => ({
  activateRecipe: vi.fn(),
  fetchRecipes: vi.fn(),
}));

const glm: RecipeInfo = {
  id: "glm",
  label: "GLM",
  group: "dual-text-gen",
  tp: 2,
  requiredNodes: [{ role: "head" }, { role: "worker" }],
  nodes: [{ role: "head", workdir: "/recipes/glm" }],
  active: false,
  nodeStatus: [{ role: "head", running: false, detail: "offline" }],
};
const deepseek: RecipeInfo = {
  ...glm,
  id: "deepseek",
  label: "DeepSeek",
  tp: 3,
  requiredNodes: [{ role: "head" }, { role: "worker" }, { sparkId: "atom" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchRecipes).mockResolvedValue({
    recipes: [glm, deepseek],
    activeId: null,
    conflict: false,
    conflictIds: [],
    switch: null,
  });
  vi.mocked(activateRecipe).mockResolvedValue({ started: true, targetId: glm.id });
});

describe("recipe readiness", () => {
  it("shows each recipe's TP and required nodes, and allows applying an offline recipe", async () => {
    const { container } = render(<RecipesDialog open onClose={() => {}} recipeSwitch={null} />);
    await flush();
    const buttons = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Activate");
    expect(buttons).toHaveLength(2);
    const glmCard = buttons[0].closest(".rounded.border");
    const deepseekCard = buttons[1].closest(".rounded.border");
    expect(glmCard?.textContent).toContain("TP2");
    expect(glmCard?.textContent).toContain("Required nodes: head, worker");
    expect(glmCard?.textContent).not.toContain("atom");
    expect(deepseekCard?.textContent).toContain("TP3");
    expect(deepseekCard?.textContent).toContain("Required nodes: head, worker, atom");
    expect(buttons[0].disabled).toBe(false);
    await act(async () => buttons[0].click());
    expect(activateRecipe).toHaveBeenCalledWith(glm.id);
  });

  it("tracks pending wake/online nodes and blocks another activation throughout readiness", async () => {
    const onClose = () => {};
    const progress: RecipeSwitchState = {
      phase: "powering-on",
      targetId: "glm",
      requiredNodes: ["Spark 1", "Spark 2"],
      pendingNodes: ["Spark 1", "Spark 2"],
      updatedAt: 1,
    };
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSwitch={progress} />);
    await flush();
    const activationButtons = () => [...container.querySelectorAll("button")]
      .filter((button) => button.textContent === "Activate");
    expect([...container.querySelectorAll('[role="status"] div')]
      .find((element) => element.textContent?.startsWith("Pending nodes:"))?.textContent)
      .toBe("Pending nodes: Spark 1, Spark 2");
    expect(activationButtons()).toHaveLength(2);
    expect(activationButtons().every((button) => button.disabled)).toBe(true);

    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSwitch={{
      ...progress,
      phase: "waiting-online",
      pendingNodes: ["Spark 2"],
      updatedAt: 2,
    }} />));
    expect([...container.querySelectorAll('[role="status"] div')]
      .find((element) => element.textContent?.startsWith("Pending nodes:"))?.textContent)
      .toBe("Pending nodes: Spark 2");
    expect(activationButtons().every((button) => button.disabled)).toBe(true);
    act(() => activationButtons()[0].click());
    expect(activateRecipe).not.toHaveBeenCalled();
  });
});
