import { act } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../testing/render";
import { PowerActionBanner } from "./PowerActionBanner";
import type { PowerActionState } from "../api/types";

function action(patch: Partial<PowerActionState>): PowerActionState {
  return {
    action: "wake-all",
    phase: "powering-on",
    startedAt: 1,
    updatedAt: 2,
    total: 3,
    completed: 1,
    results: [],
    ...patch,
  };
}

describe("PowerActionBanner", () => {
  it("shows the current phase and progress", () => {
    const { container } = render(
      <PowerActionBanner action={action({ current: "Spark 1" })} />
    );
    expect(container.textContent).toContain("Powering on Spark 1");
    expect(container.textContent).toContain("(1/3)");
  });

  it("dismisses a finished action without hiding the next one", () => {
    const { container, root } = render(
      <PowerActionBanner action={action({ phase: "done", message: "All nodes online" })} />
    );
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss power action status"]');
    expect(dismiss).not.toBeNull();
    act(() => dismiss?.click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    act(() => root.render(<PowerActionBanner action={action({ startedAt: 3 })} />));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("shows a failure", () => {
    const { container } = render(
      <PowerActionBanner action={action({ phase: "failed", error: "Nodes did not come online" })} />
    );
    expect(container.textContent).toContain("Failed: Nodes did not come online");
  });
});
