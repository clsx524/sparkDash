import { act } from "react";
import { expect, it } from "vitest";
import type { RecipeSessionDetail } from "../api/types";
import { render } from "../testing/render";
import { RecipeSessionDetails } from "./RecipeSessionDetails";

function session(version: number): RecipeSessionDetail {
  return {
    id: "follow-output", targetId: "glm", label: "GLM", tp: 2, requiredNodes: [],
    status: "running", phase: "starting", startedAt: Date.now(), updatedAt: Date.now(),
    finishedAt: null, error: null, version, lastSeq: version, firstSeq: 1,
    logsTruncated: false, storageError: null,
    stages: [{
      id: "starting", phase: "starting", status: "running", startedAt: Date.now(),
      updatedAt: Date.now(), finishedAt: null, pendingNodes: [], progress: null, message: null,
      logs: Array.from({ length: version }, (_, index) => ({
        seq: index + 1, ts: Date.now(), stream: "stdout", text: `output ${index + 1}`,
      })),
    }],
  };
}

it("follows new output, pauses when the user scrolls up, and resumes on request", () => {
  const { container, root } = render(<RecipeSessionDetails session={session(1)} />);
  const output = container.querySelector('[aria-label="Starting target recipe logs"]') as HTMLDivElement;
  let height = 1000;
  Object.defineProperty(output, "scrollHeight", { get: () => height });
  Object.defineProperty(output, "clientHeight", { value: 100 });
  act(() => root.render(<RecipeSessionDetails session={session(2)} />));
  expect(output.scrollTop).toBe(height);

  act(() => {
    output.scrollTop = 20;
    output.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  height = 1100;
  act(() => root.render(<RecipeSessionDetails session={session(3)} />));
  expect(output.scrollTop).toBe(20);
  const follow = container.querySelector('button[aria-label="Follow output"]') as HTMLButtonElement;
  expect(follow.getAttribute("aria-pressed")).toBe("false");
  act(() => follow.click());
  expect(output.scrollTop).toBe(height);
  expect(follow.getAttribute("aria-pressed")).toBe("true");
});
