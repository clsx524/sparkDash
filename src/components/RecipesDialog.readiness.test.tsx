import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateRecipe, cancelRecipeSession, fetchCurrentRecipeSession, fetchRecipeSession, fetchRecipeSessions, fetchRecipes,
} from "../api/client";
import type { RecipeActivateResponse, RecipeInfo, RecipeSessionDetail, RecipeSessionStage } from "../api/types";
import { flush, render } from "../testing/render";
import { RecipesDialog } from "./RecipesDialog";

vi.mock("../api/client", () => ({
  activateRecipe: vi.fn(), cancelRecipeSession: vi.fn(), fetchRecipes: vi.fn(), fetchCurrentRecipeSession: vi.fn(),
  fetchRecipeSession: vi.fn(), fetchRecipeSessions: vi.fn(),
}));

const glm: RecipeInfo = {
  id: "glm", label: "GLM", group: "dual-text-gen", tp: 2,
  requiredNodes: [{ role: "head" }, { role: "worker" }],
  nodes: [{ role: "head", workdir: "/recipes/glm" }], active: false,
  nodeStatus: [{ role: "head", running: false, detail: "offline" }],
};
const deepseek: RecipeInfo = {
  ...glm, id: "deepseek", label: "DeepSeek", tp: 3,
  requiredNodes: [{ role: "head" }, { role: "worker" }, { sparkId: "atom" }],
};
function stage(phase: string, overrides: Partial<RecipeSessionStage> = {}): RecipeSessionStage {
  return {
    id: phase, phase, status: "running", startedAt: 1000, updatedAt: 2000,
    finishedAt: null, pendingNodes: [], progress: null, message: null, logs: [], ...overrides,
  };
}
function session(id: string, overrides: Partial<RecipeSessionDetail> = {}): RecipeSessionDetail {
  return {
    id, targetId: "glm", label: "GLM", tp: 2,
    requiredNodes: [{ id: "one", name: "Spark 1" }, { id: "two", name: "Spark 2" }],
    status: "running", phase: "checking-nodes", startedAt: 1000, updatedAt: 2000,
    finishedAt: null, error: null, version: 1, lastSeq: 0, firstSeq: 1, logsTruncated: false,
    storageError: null, stages: [stage("checking-nodes")], ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(fetchRecipes).mockResolvedValue({
    recipes: [glm, deepseek], activeId: null, conflict: false, conflictIds: [], session: null, lastActiveRecipe: null,
  });
  vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: null });
  vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(fetchRecipeSession).mockImplementation(async (id) => ({ session: session(id) }));
  vi.mocked(activateRecipe).mockResolvedValue({ started: true, targetId: glm.id, sessionId: "new" });
});
afterEach(() => vi.useRealTimers());

const onClose = () => {};
function cancelButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Current Apply"] button')]
    .find((button) => button.textContent === "Cancel Apply" || button.textContent === "Cancelling…");
}

describe("persistent recipe Apply views", () => {
  it("preserves offline activation, TP and dependency display, and guards pending double clicks", async () => {
    const pending = deferred<RecipeActivateResponse>();
    vi.mocked(activateRecipe).mockReturnValue(pending.promise);
    const { container } = render(<RecipesDialog open onClose={onClose} recipeSession={null} />);
    await flush();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].closest(".rounded.border")?.textContent).toContain("TP2");
    expect(buttons[0].closest(".rounded.border")?.textContent).toContain("Required nodes: head, worker");
    expect(buttons[1].closest(".rounded.border")?.textContent).toContain("TP3");
    expect(buttons[1].closest(".rounded.border")?.textContent).toContain("Required nodes: head, worker, atom");
    expect(buttons[0].disabled).toBe(false);
    act(() => { buttons[0].click(); buttons[0].click(); buttons[1].click(); });
    expect(activateRecipe).toHaveBeenCalledTimes(1);
    expect(activateRecipe).toHaveBeenCalledWith("glm");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    pending.resolve({ started: true, targetId: "glm", sessionId: "new" });
    await flush();
  });

  it("hydrates Current and a stored history selection after reload without replaying Apply", async () => {
    const current = session("current", { status: "succeeded", finishedAt: 3000 });
    const old = session("old", { label: "Old model", startedAt: 100, status: "interrupted", finishedAt: 500, error: "Server restarted" });
    localStorage.setItem("recipe-apply-history-selection", old.id);
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: current });
    vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [current, old] });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: old });
    const { container } = render(<RecipesDialog open onClose={onClose} recipeSession={null} />);
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [data-session-id]')?.getAttribute("data-session-id")).toBe("current");
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Old model");
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Server restarted");
    expect(container.querySelectorAll('[aria-label="Prior Apply sessions"] button')).toHaveLength(1);
    expect(activateRecipe).not.toHaveBeenCalled();
  });

  it("keeps live Current independent of selected history, including button authority", async () => {
    const live = session("live", { stages: [stage("waiting-online", { pendingNodes: ["Spark 2"] })] });
    const old = session("old", { label: "Old model", status: "failed", startedAt: 10, finishedAt: 20 });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: live });
    vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [old] });
    vi.mocked(fetchRecipeSession).mockImplementation(async (id) => ({ session: id === old.id ? old : live }));
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={live} />);
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Prior Apply sessions"] button')!.click());
    await flush();
    expect(localStorage.getItem("recipe-apply-history-selection")).toBe("old");
    expect(container.querySelector('[aria-label="Current Apply"]')?.textContent).toContain("Pending nodes: Spark 2");
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Old model");
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')].every((button) => button.disabled)).toBe(true);
    const complete = { ...live, version: 2, status: "succeeded" as const, finishedAt: 4000 };
    vi.mocked(fetchRecipeSession).mockImplementation(async (id) => ({ session: id === old.id ? old : complete }));
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={complete} />));
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("succeeded");
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Old model");
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')].every((button) => !button.disabled)).toBe(true);
  });

  it("cancels only live Current with history selected, locks pending clicks, and refreshes terminal state", async () => {
    const live = session("live", { stages: [stage("waiting-online", { pendingNodes: ["Spark 2"] })] });
    const old = session("old", { label: "Old model", status: "cancelled", phase: "cancelled", startedAt: 10, finishedAt: 20 });
    const post = deferred<{ session: RecipeSessionDetail }>();
    localStorage.setItem("recipe-apply-history-selection", old.id);
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: live });
    vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [live, old] });
    vi.mocked(fetchRecipeSession).mockImplementation(async (id) => ({ session: id === old.id ? old : live }));
    vi.mocked(cancelRecipeSession).mockReturnValue(post.promise);
    const { container } = render(<RecipesDialog open onClose={onClose} recipeSession={live} />);
    await flush();
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Old model");
    expect(container.querySelector('[aria-label="Apply History"]')?.textContent).toContain("cancelled");
    expect([...container.querySelectorAll('[aria-label="Apply History"] button')].some((button) => button.textContent === "Cancel Apply")).toBe(false);
    const button = cancelButton(container)!;
    expect(button.disabled).toBe(false);
    expect(container.textContent).toContain("Completed changes and already-started services are not rolled back");
    act(() => { button.click(); button.click(); });
    expect(cancelRecipeSession).toHaveBeenCalledTimes(1);
    expect(cancelRecipeSession).toHaveBeenCalledWith(live.id);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Cancelling…");
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')].every((entry) => entry.disabled)).toBe(true);

    const cancelled = session(live.id, {
      version: 3, status: "cancelled", phase: "cancelled", finishedAt: 4000,
      stages: [stage("waiting-online", { status: "cancelled", finishedAt: 4000, message: "Cancelled by user", logs: [{ seq: 1, ts: 3000, stream: "action", text: "Waiting stopped" }] })],
    });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: cancelled });
    vi.mocked(fetchRecipeSessions).mockResolvedValue({ sessions: [cancelled, old] });
    vi.mocked(fetchRecipeSession).mockImplementation(async (id) => ({ session: id === old.id ? old : cancelled }));
    const recipeReads = vi.mocked(fetchRecipes).mock.calls.length;
    post.resolve({ session: cancelled });
    await flush();
    expect(cancelButton(container)).toBeUndefined();
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("cancelled");
    expect(container.querySelector('[data-stage-phase="waiting-online"]')?.textContent).toContain("Cancelled by user");
    expect(container.textContent).toContain("Waiting stopped");
    expect(container.querySelector('[data-testid="history-detail"]')?.textContent).toContain("Old model");
    expect(fetchRecipes).toHaveBeenCalledTimes(recipeReads + 1);
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')].every((entry) => !entry.disabled)).toBe(true);
    expect(activateRecipe).not.toHaveBeenCalled();
  });

  it("recovers from a cancellation error and keeps server-reported cancelling disabled after reopening", async () => {
    const live = session("live");
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: live });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: live });
    vi.mocked(cancelRecipeSession).mockRejectedValueOnce(new Error("Connection lost"));
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={null} />);
    await flush();
    act(() => cancelButton(container)!.click());
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [role="alert"]')?.textContent).toContain("Could not cancel Apply: Connection lost");
    expect(cancelButton(container)?.disabled).toBe(false);
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')].every((entry) => entry.disabled)).toBe(true);

    const post = deferred<{ session: RecipeSessionDetail }>();
    vi.mocked(cancelRecipeSession).mockReturnValueOnce(post.promise);
    act(() => cancelButton(container)!.click());
    expect(container.querySelector('[aria-label="Current Apply"] [role="alert"]')).toBeNull();
    expect(cancelButton(container)?.textContent).toBe("Cancelling…");
    const cancelling = { ...live, version: 2, phase: "cancelling" };
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: cancelling });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: cancelling });
    post.resolve({ session: cancelling });
    await flush();
    act(() => root.render(<RecipesDialog open={false} onClose={onClose} recipeSession={null} />));
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={null} />));
    await flush();
    expect(cancelButton(container)?.disabled).toBe(true);
    expect(cancelButton(container)?.textContent).toBe("Cancelling…");
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("cancelling");
    expect(cancelRecipeSession).toHaveBeenCalledTimes(2);
  });

  it("targets newer WS Current rather than an older cached running session while detail catch-up is pending", async () => {
    const previous = session("previous");
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: previous });
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={previous} />);
    await flush();
    const current = session("newer", { label: "New apply", startedAt: 5000 });
    const catchUp = deferred<{ session: RecipeSessionDetail | null }>();
    vi.mocked(fetchCurrentRecipeSession).mockReturnValueOnce(catchUp.promise);
    const post = deferred<{ session: RecipeSessionDetail }>();
    vi.mocked(cancelRecipeSession).mockReturnValue(post.promise);
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={current} />));
    expect(container.querySelector('[aria-label="Current Apply"] [data-session-id]')?.getAttribute("data-session-id")).toBe(current.id);
    act(() => cancelButton(container)!.click());
    expect(cancelRecipeSession).toHaveBeenCalledWith(current.id);
    expect(cancelRecipeSession).not.toHaveBeenCalledWith(previous.id);
    const cancelled = { ...current, version: 2, status: "cancelled" as const, phase: "cancelled", finishedAt: 6000 };
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: cancelled });
    catchUp.resolve({ session: current });
    post.resolve({ session: cancelled });
    await flush();
    expect(cancelButton(container)).toBeUndefined();
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("cancelled");
  });

  it("does not unlock Apply while cancel is pending even when normal completion wins the race", async () => {
    const live = session("live");
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: live });
    const post = deferred<{ session: RecipeSessionDetail }>();
    vi.mocked(cancelRecipeSession).mockReturnValue(post.promise);
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={live} />);
    await flush();
    act(() => cancelButton(container)!.click());
    const done = { ...live, version: 3, status: "succeeded" as const, finishedAt: 4000 };
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: done });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: done });
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={done} />));
    await flush();
    expect(cancelButton(container)).toBeUndefined();
    const applyButtons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Choose recipe"] button')];
    expect(applyButtons.every((entry) => entry.disabled)).toBe(true);
    act(() => applyButtons[0].click());
    expect(activateRecipe).not.toHaveBeenCalled();
    post.resolve({ session: done });
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("succeeded");
    expect(applyButtons.every((entry) => !entry.disabled)).toBe(true);
  });

  it("ignores a late cancellation result after closing and reopening onto a newer Apply", async () => {
    const live = session("live");
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: live });
    const post = deferred<{ session: RecipeSessionDetail }>();
    vi.mocked(cancelRecipeSession).mockReturnValue(post.promise);
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={live} />);
    await flush();
    act(() => cancelButton(container)!.click());
    act(() => root.render(<RecipesDialog open={false} onClose={onClose} recipeSession={null} />));
    const newer = session("newer", { label: "Newer apply", startedAt: 5000 });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: newer });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: newer });
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={newer} />));
    await flush();
    expect(cancelButton(container)?.disabled).toBe(true);
    post.resolve({ session: { ...live, version: 3, status: "cancelled", phase: "cancelled", finishedAt: 4000 } });
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [data-session-id]')?.getAttribute("data-session-id")).toBe(newer.id);
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("running");
    expect(cancelButton(container)?.textContent).toBe("Cancel Apply");
    expect(cancelButton(container)?.disabled).toBe(false);
    expect(cancelRecipeSession).toHaveBeenCalledTimes(1);
  });

  it("renders only entered stages and adds wake/boot rows only when supplied", async () => {
    const online = session("online", { stages: [stage("checking-nodes"), stage("starting")] });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: online });
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={online} />);
    await flush();
    expect([...container.querySelectorAll("[data-stage-phase]")].map((node) => node.getAttribute("data-stage-phase"))).toEqual(["checking-nodes", "starting"]);
    const offline = session("offline", { version: 2, startedAt: 5000, stages: [stage("checking-nodes"), stage("powering-on"), stage("waiting-online", { pendingNodes: ["Spark 2"] })] });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: offline });
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={offline} />));
    await flush();
    expect(container.querySelector('[data-stage-phase="powering-on"]')).not.toBeNull();
    expect(container.querySelector('[data-stage-phase="waiting-online"]')?.textContent).toContain("Spark 2");
    expect(container.querySelector('[data-stage-phase="health-checking"]')).toBeNull();
  });

  it("catches up by sequence after reconnect errors, preserving manual expansion and escaping output", async () => {
    const first = session("live", {
      lastSeq: 1, stages: [stage("health-checking", { logs: [{ seq: 1, ts: 1000, stream: "stdout", text: "first" }], progress: { percent: 10, etaSeconds: 9, source: "estimate" } })],
    });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: first });
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={first} />);
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>('[data-stage-phase="health-checking"] button')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("estimated");
    act(() => toggle.click());
    vi.mocked(fetchRecipeSession).mockRejectedValueOnce(new Error("Disconnected"));
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={{ ...first, version: 2 }} />));
    await flush();
    expect(container.textContent).toContain("Disconnected");
    const next = session("live", { version: 2, lastSeq: 2, stages: [stage("health-checking", {
      logs: [{ seq: 2, ts: 2000, stream: "stderr", text: "<script>not HTML</script>" }], progress: { percent: 25, etaSeconds: 7, source: "log" },
    })] });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: next });
    await act(async () => vi.advanceTimersByTime(1500));
    await flush();
    expect(fetchRecipeSession).toHaveBeenLastCalledWith("live", 1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(container.textContent).toContain("first");
    expect(container.textContent).toContain("<script>not HTML</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("measured from logs");
    expect(container.textContent).not.toContain("Disconnected");
    await act(async () => vi.advanceTimersByTime(1500));
    await flush();
    expect(fetchRecipeSession).toHaveBeenLastCalledWith("live", 2);
    expect(container.querySelectorAll('[aria-label="Waiting for health logs"] > div')).toHaveLength(2);
    expect(activateRecipe).not.toHaveBeenCalled();
  });

  it("handles completion before the POST returns and retains same-target Refresh", async () => {
    vi.mocked(fetchRecipes).mockResolvedValue({ recipes: [glm], activeId: "glm", conflict: false, conflictIds: [], session: null, lastActiveRecipe: null });
    const post = deferred<RecipeActivateResponse>();
    vi.mocked(activateRecipe).mockReturnValue(post.promise);
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={null} />);
    await flush();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Choose recipe"] button')!;
    expect(button.textContent).toBe("Refresh");
    act(() => button.click());
    const done = session("quick", { status: "succeeded", finishedAt: 2000 });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: done });
    vi.mocked(fetchRecipeSession).mockResolvedValue({ session: done });
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={done} />));
    await flush();
    post.resolve({ started: true, targetId: "glm", sessionId: "quick" });
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"] [role="status"]')?.textContent).toBe("succeeded");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Refresh");
    expect(activateRecipe).toHaveBeenCalledTimes(1);
  });

  it("ignores a late hydration response from a closed dialog and restores on reopening", async () => {
    const late = deferred<{ session: RecipeSessionDetail | null }>();
    vi.mocked(fetchCurrentRecipeSession).mockReturnValueOnce(late.promise);
    const { container, root } = render(<RecipesDialog open onClose={onClose} recipeSession={null} />);
    act(() => root.render(<RecipesDialog open={false} onClose={onClose} recipeSession={null} />));
    const fresh = session("fresh", { label: "Fresh session", status: "succeeded", startedAt: 8000, finishedAt: 9000 });
    vi.mocked(fetchCurrentRecipeSession).mockResolvedValue({ session: fresh });
    act(() => root.render(<RecipesDialog open onClose={onClose} recipeSession={null} />));
    await flush();
    late.resolve({ session: session("stale", { label: "Stale session" }) });
    await flush();
    expect(container.querySelector('[aria-label="Current Apply"]')?.textContent).toContain("Fresh session");
    expect(container.textContent).not.toContain("Stale session");
    expect(activateRecipe).not.toHaveBeenCalled();
  });
});
