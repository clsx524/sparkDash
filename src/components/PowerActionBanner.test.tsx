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

  it("shows a done message", () => {
    const { container } = render(
      <PowerActionBanner action={action({ phase: "done", message: "Recipe glm53-exl3 is already active" })} />
    );
    expect(container.textContent).toContain("Done: Recipe glm53-exl3 is already active");
  });

  it("shows a failure", () => {
    const { container } = render(
      <PowerActionBanner action={action({ phase: "failed", error: "Nodes did not come online" })} />
    );
    expect(container.textContent).toContain("Failed: Nodes did not come online");
  });
});
