import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateRecipe, fetchCurrentRecipeSession, fetchRecipeSession, fetchRecipeSessions, fetchRecipes, wakeAllSparks,
  type BatchPowerResult,
} from "../../api/client";
import type { LastActiveRecipe, PowerActionState, RecipeSessionDetail, SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { RecipesDialog } from "../RecipesDialog";
import { OverviewPage } from "./OverviewPage";

vi.mock("../../api/client", () => ({
  activateRecipe: vi.fn(), fetchRecipes: vi.fn(), fetchCurrentRecipeSession: vi.fn(),
  fetchRecipeSession: vi.fn(), fetchRecipeSessions: vi.fn(), wakeAllSparks: vi.fn(),
  shutdownAllSparks: vi.fn(), updateAllHermes: vi.fn(),
}));

const remembered: LastActiveRecipe = { id: "glm", label: "GLM deployment", storageError: null };
const current: RecipeSessionDetail = {
  id: "wake-apply", targetId: "glm", label: remembered.label, tp: 2,
  requiredNodes: [{ id: "spark-1", name: "Spark 1" }, { id: "spark-2", name: "Spark 2" }],
  status: "running", phase: "checking-nodes", startedAt: 1000, updatedAt: 2000,
  finishedAt: null, error: null, version: 1, lastSeq: 0, firstSeq: 1,
  logsTruncated: false, storageError: null, stages: [],
};
const quiet = { showActivityFeed: false, showFleetEnergy: false, showLlmTokenTotals: false };

function wakeButton(scope: ParentNode = document): HTMLButtonElement {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Wake all")!;
}
function confirmation(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(wakeAllSparks).mockResolvedValue({ success: true, started: true, targetId: "glm", sessionId: current.id });
  vi.mocked(fetchRecipes).mockResolvedValue({
    recipes: [], activeId: null, conflict: false, conflictIds: [], session: current, lastActiveRecipe: remembered,
  });
  vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: current });
  vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [current] });
  vi.mocked(fetchRecipeSession).mockResolvedValue({ session: current });
});
afterEach(() => vi.useRealTimers());

describe("Wake all recipe activation", () => {
  it("keeps Wake all available for an all-online fleet without power endpoints and confirms only the remembered recipe", async () => {
    const onOpenRecipes = vi.fn();
    const { container } = render(<OverviewPage {...quiet} sparks={[makeSpark("spark-1")]} lastActiveRecipe={remembered} onOpenRecipes={onOpenRecipes} />);
    expect(wakeButton(container).disabled).toBe(false);
    expect(container.textContent).toContain(remembered.label);
    act(() => wakeButton(container).click());
    expect(wakeAllSparks).not.toHaveBeenCalled();
    const dialog = confirmation();
    expect(dialog.textContent).toContain(remembered.label);
    expect(dialog.textContent).toMatch(/only its required nodes/i);
    expect(dialog.querySelector("input")).toBeNull();
    act(() => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click());
    await flush();
    expect(wakeAllSparks).not.toHaveBeenCalled();
    expect(onOpenRecipes).not.toHaveBeenCalled();
  });

  it("opens the existing Current Apply view using the session accepted by Wake all, without another activation or banner", async () => {
    function AppHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <OverviewPage {...quiet} sparks={[makeSpark("spark-1")]} lastActiveRecipe={remembered} onOpenRecipes={() => setOpen(true)} />
        <RecipesDialog open={open} onClose={() => setOpen(false)} recipeSession={null} />
      </>;
    }
    const { container } = render(<AppHarness />);
    act(() => wakeButton(container).click());
    act(() => wakeButton(confirmation()).click());
    await flush();
    expect(wakeAllSparks).toHaveBeenCalledTimes(1);
    expect(activateRecipe).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Current Apply"] [data-session-id]')?.getAttribute("data-session-id")).toBe(current.id);
    expect(container.querySelector('[aria-label="Apply History"]')).not.toBeNull();
    expect(container.querySelector(".ov-prog")).toBeNull();
    expect(container.querySelector(".ov-batchmsg[role=status]")).toBeNull();
  });

  it("disables the button and confirmation throughout an outstanding wake request and ignores double clicks", async () => {
    const pending = deferred<BatchPowerResult>();
    vi.mocked(wakeAllSparks).mockReturnValue(pending.promise);
    const onOpenRecipes = vi.fn();
    const { container } = render(<OverviewPage {...quiet} sparks={[makeSpark()]} lastActiveRecipe={remembered} onOpenRecipes={onOpenRecipes} />);
    act(() => wakeButton(container).click());
    const confirm = wakeButton(confirmation());
    act(() => { confirm.click(); confirm.click(); });
    expect(wakeAllSparks).toHaveBeenCalledTimes(1);
    expect(wakeButton(container).disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    pending.resolve({ success: true, started: true, targetId: "glm", sessionId: current.id });
    await flush();
    expect(onOpenRecipes).toHaveBeenCalledTimes(1);
  });

  it("locks an already open confirmation when Current Apply starts and unlocks after a terminal session", async () => {
    const sparks = [makeSpark()];
    const { container, root } = render(<OverviewPage {...quiet} sparks={sparks} lastActiveRecipe={remembered} />);
    act(() => wakeButton(container).click());
    act(() => root.render(<OverviewPage {...quiet} sparks={sparks} lastActiveRecipe={remembered} recipeSession={current} />));
    expect(wakeButton(container).disabled).toBe(true);
    expect(wakeButton(confirmation()).disabled).toBe(true);
    act(() => wakeButton(confirmation()).click());
    expect(wakeAllSparks).not.toHaveBeenCalled();
    act(() => root.render(<OverviewPage {...quiet} sparks={sparks} lastActiveRecipe={remembered} recipeSession={{ ...current, status: "succeeded" }} />));
    expect(wakeButton(container).disabled).toBe(false);
    expect(wakeButton(confirmation()).disabled).toBe(false);
  });

  it("blocks Wake all during active power actions but not completed ones", () => {
    const sparks = [makeSpark()];
    const power: PowerActionState = {
      action: "shutdown-all", phase: "waiting-offline", startedAt: 1000, updatedAt: 1000,
      total: 1, completed: 0, results: [],
    };
    const { container, root } = render(<OverviewPage {...quiet} sparks={sparks} lastActiveRecipe={remembered} powerAction={power} />);
    expect(wakeButton(container).disabled).toBe(true);
    act(() => root.render(<OverviewPage {...quiet} sparks={sparks} lastActiveRecipe={remembered} powerAction={{ ...power, phase: "done" }} />));
    expect(wakeButton(container).disabled).toBe(false);
  });

  it.each(["hideOffline", "hideWorkers"] as const)("does not hide remembered recipe activation when %s removes every card", (setting) => {
    const spark = makeSpark("spark-2", false);
    spark.role = "worker";
    const { container } = render(<OverviewPage {...quiet} sparks={[spark]} lastActiveRecipe={remembered} {...{ [setting]: true }} />);
    expect(wakeButton(container).disabled).toBe(false);
  });

  it("describes and invokes only the power-only fleet fallback when no recipe is remembered", async () => {
    vi.mocked(wakeAllSparks).mockResolvedValue({ success: true, started: true });
    const onOpenRecipes = vi.fn();
    const spark: SparkSnapshot = { ...makeSpark("spark-1", false), hasPowerControl: true };
    const { container } = render(<OverviewPage {...quiet} sparks={[spark]} lastActiveRecipe={null} onOpenRecipes={onOpenRecipes} />);
    act(() => wakeButton(container).click());
    expect(confirmation().textContent).toMatch(/no recipe has been remembered/i);
    expect(confirmation().textContent).toMatch(/power-only/i);
    act(() => wakeButton(confirmation()).click());
    await flush();
    expect(wakeAllSparks).toHaveBeenCalledTimes(1);
    expect(activateRecipe).not.toHaveBeenCalled();
    expect(onOpenRecipes).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/power-only fleet wake/i);
  });

  it.each(["Saved recipe glm no longer exists", "Permission denied", "Rate limit exceeded"])("keeps server errors visible without falling back: %s", async (message) => {
    vi.mocked(wakeAllSparks).mockRejectedValue(new Error(message));
    const onOpenRecipes = vi.fn();
    const { container } = render(<OverviewPage {...quiet} sparks={[makeSpark()]} lastActiveRecipe={remembered} onOpenRecipes={onOpenRecipes} />);
    act(() => wakeButton(container).click());
    act(() => wakeButton(confirmation()).click());
    await flush();
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('.ov-batchmsg[role="status"]')?.textContent).toBe(message);
    expect(wakeAllSparks).toHaveBeenCalledTimes(1);
    expect(activateRecipe).not.toHaveBeenCalled();
    expect(onOpenRecipes).not.toHaveBeenCalled();
  });

  it("displays persistence failures without discarding the in-memory remembered recipe", () => {
    const { container } = render(<OverviewPage {...quiet} sparks={[makeSpark()]} lastActiveRecipe={{ ...remembered, storageError: "Disk unavailable" }} />);
    expect(container.textContent).toContain(remembered.label);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Disk unavailable");
    expect(wakeButton(container).disabled).toBe(false);
  });
});
