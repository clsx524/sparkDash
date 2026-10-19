import { describe, expect, test } from "vitest";
import { activateButtonState } from "./RecipesDialog";

describe("recipe Apply button safety", () => {
  test("same-target Refresh remains available when idle", () => {
    expect(activateButtonState(true, false, false)).toEqual({ disabled: false, label: "Refresh" });
    expect(activateButtonState(false, false, false).disabled).toBe(false);
  });

  test("an authoritative running session disables every recipe", () => {
    expect(activateButtonState(false, true, false).disabled).toBe(true);
    expect(activateButtonState(true, true, false).disabled).toBe(true);
  });

  test("a pending request disables its button before a live summary arrives", () => {
    expect(activateButtonState(false, false, true).disabled).toBe(true);
    expect(activateButtonState(true, false, true).disabled).toBe(true);
  });
});
