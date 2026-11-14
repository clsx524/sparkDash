import { describe, expect, test } from "vitest";
import { isModelSynced } from "./ModelsDialog";

// isModelSynced drives the Sync button's disabled state — a wrong answer either
// hides a real, needed re-sync (stale includePattern silently never fetched) or
// nags the operator to click a no-op button forever. Both are real regressions.

describe("isModelSynced", () => {
  test("never verified — not synced, regardless of includePattern", () => {
    expect(isModelSynced({ verifiedAt: null, includePattern: null, includePatternAtVerify: null })).toBe(false);
    expect(isModelSynced({ verifiedAt: null, includePattern: "*.json", includePatternAtVerify: null })).toBe(false);
  });

  test("verified with no includePattern ever set — synced", () => {
    expect(
      isModelSynced({ verifiedAt: "2026-09-14T00:00:00Z", includePattern: null, includePatternAtVerify: null })
    ).toBe(true);
  });

  test("verified against the exact includePattern currently set — synced", () => {
    expect(
      isModelSynced({
        verifiedAt: "2026-09-14T00:00:00Z",
        includePattern: "model-0004[78]-of-00048.safetensors *.index.json",
        includePatternAtVerify: "model-0004[78]-of-00048.safetensors *.index.json",
      })
    ).toBe(true);
  });

  test("includePattern edited after the last verify (e.g. config.json appended) — stale, not synced", () => {
    expect(
      isModelSynced({
        verifiedAt: "2026-09-14T00:00:00Z",
        includePattern: "model-0004[78]-of-00048.safetensors *.index.json config.json",
        includePatternAtVerify: "model-0004[78]-of-00048.safetensors *.index.json",
      })
    ).toBe(false);
  });

  test("includePattern cleared back to null after being verified with one set — stale, not synced", () => {
    expect(
      isModelSynced({
        verifiedAt: "2026-09-14T00:00:00Z",
        includePattern: null,
        includePatternAtVerify: "*.safetensors",
      })
    ).toBe(false);
  });

  test("undefined and null are treated the same on both fields (optional ModelEntry props)", () => {
    expect(
      isModelSynced({ verifiedAt: "2026-09-14T00:00:00Z", includePattern: undefined, includePatternAtVerify: null })
    ).toBe(true);
    expect(
      isModelSynced({ verifiedAt: "2026-09-14T00:00:00Z", includePattern: null, includePatternAtVerify: undefined })
    ).toBe(true);
  });
});
