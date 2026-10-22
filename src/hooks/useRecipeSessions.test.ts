import { describe, expect, it } from "vitest";
import type { RecipeSessionDetail, RecipeSessionLog, RecipeSessionStage } from "../api/types";
import { mergeRecipeSession } from "./useRecipeSessions";

const line = (seq: number): RecipeSessionLog => ({ seq, ts: seq, stream: "stdout", text: `line ${seq}` });
const stage: RecipeSessionStage = {
  id: "stage-a", phase: "starting", status: "running", startedAt: 1, updatedAt: 2,
  finishedAt: null, pendingNodes: [], progress: null, message: null, logs: [line(1)],
};
const first: RecipeSessionDetail = {
  id: "apply-a", targetId: "glm", label: "GLM", tp: 2, requiredNodes: [], status: "running",
  phase: "starting", startedAt: 1, updatedAt: 2, finishedAt: null, error: null,
  version: 1, lastSeq: 1, firstSeq: 1, logsTruncated: false, storageError: null, stages: [stage],
};

describe("recipe session incremental merge", () => {
  it("merges stage IDs and global sequences without duplicate log lines", () => {
    const response: RecipeSessionDetail = {
      ...first, version: 2, lastSeq: 3,
      stages: [
        { ...stage, status: "succeeded", finishedAt: 3, logs: [line(1), line(2)] },
        { ...stage, id: "stage-b", phase: "health-checking", logs: [line(3)] },
      ],
    };
    const result = mergeRecipeSession(first, response);
    expect(result.stages.map((entry) => entry.id)).toEqual(["stage-a", "stage-b"]);
    expect(result.stages[0].logs.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(result.stages[1].logs.map((entry) => entry.seq)).toEqual([3]);
    expect(mergeRecipeSession(result, response)).toEqual(result);
  });

  it("keeps terminal metadata when older responses arrive late, while recovering missing output", () => {
    const done: RecipeSessionDetail = {
      ...first, version: 3, status: "failed", error: "health failed", lastSeq: 3, finishedAt: 10,
      stages: [{ ...stage, status: "failed", finishedAt: 10, logs: [line(3)] }],
    };
    const merged = mergeRecipeSession(done, first);
    expect(merged.status).toBe("failed");
    expect(merged.error).toBe("health failed");
    expect(merged.version).toBe(3);
    expect(merged.stages[0].logs.map((entry) => entry.seq)).toEqual([1, 3]);
  });

  it("keeps cancellation terminal when pre-cancel progress arrives late and retains captured logs", () => {
    const cancelled: RecipeSessionDetail = {
      ...first, version: 3, status: "cancelled", phase: "cancelled", finishedAt: 10,
      stages: [{ ...stage, status: "cancelled", finishedAt: 10, message: "Cancelled by user", logs: [line(2)] }],
    };
    const merged = mergeRecipeSession(cancelled, first);
    expect(merged.status).toBe("cancelled");
    expect(merged.phase).toBe("cancelled");
    expect(merged.stages[0].status).toBe("cancelled");
    expect(merged.stages[0].logs.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("never merges output between distinct Apply sessions", () => {
    const next = { ...first, id: "apply-b", stages: [] };
    expect(mergeRecipeSession(first, next)).toEqual(next);
  });

  it("drops evicted output and does not resurrect it from late responses", () => {
    const evicted: RecipeSessionDetail = {
      ...first, version: 3, firstSeq: 3, lastSeq: 3, logsTruncated: true,
      stages: [{ ...stage, logs: [line(3)] }],
    };
    const merged = mergeRecipeSession(first, evicted);
    expect(merged.stages[0].logs.map((entry) => entry.seq)).toEqual([3]);
    expect(mergeRecipeSession(merged, first).stages[0].logs.map((entry) => entry.seq)).toEqual([3]);
  });
});
