import { describe, expect, test } from "vitest";
import { activateButtonState } from "./RecipesDialog";

// activateButtonState drives the per-recipe activate/refresh button — a wrong
// answer either strands the active recipe at a dead "Active" button with no
// way to pick up a changed recipe/pin (the exact bug this replaces), or lets
// two switches fire at once while one is already in flight.

describe("activateButtonState", () => {
  test("idle, not active — enabled, labeled Activate", () => {
    expect(activateButtonState(false, false, false)).toEqual({ disabled: false, label: "Activate" });
  });

  test("idle, already active — enabled (not dead-ended), labeled Refresh", () => {
    expect(activateButtonState(true, false, false)).toEqual({ disabled: false, label: "Refresh" });
  });

  test("a different recipe is mid-switch — disabled, label unaffected by this recipe's own active state", () => {
    expect(activateButtonState(false, true, false)).toEqual({ disabled: true, label: "Activate" });
    expect(activateButtonState(true, true, false)).toEqual({ disabled: true, label: "Refresh" });
  });

  test("this recipe is the one currently switching — disabled, labeled Switching…", () => {
    expect(activateButtonState(false, true, true)).toEqual({ disabled: true, label: "Switching…" });
    expect(activateButtonState(true, true, true)).toEqual({ disabled: true, label: "Switching…" });
  });
});
