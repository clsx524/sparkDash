import { useEffect, useState } from "react";
import { activateRecipe, fetchRecipes } from "../api/client";
import type { RecipeInfo, RecipeListResponse, RecipeSwitchState } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";

interface RecipesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Live switch progress from the WS snapshot; null when nothing is in flight. */
  recipeSwitch: RecipeSwitchState | null | undefined;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const PHASE_LABEL: Record<RecipeSwitchState["phase"], string> = {
  "checking-current-state": "Checking current state…",
  "already-active": "Already active",
  stopping: "Stopping current recipe…",
  "confirming-stopped": "Confirming it stopped…",
  starting: "Starting target recipe…",
  "health-checking": "Waiting for health…",
  done: "Done",
  failed: "Failed",
};

function formatEtaSeconds(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return `~${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `~${m}m ${s}s` : `~${m}m`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}

const GROUP_LABEL: Record<string, string> = {
  "dual-text-gen": "Dual-node text generation (TP2, one at a time)",
  "h3-plus-single-llm": "Split single-node (one model per Spark)",
};

export function RecipesDialog({ open, onClose, recipeSwitch }: RecipesDialogProps) {
  const [data, setData] = useState<RecipeListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  useEscape(onClose);
  const { mounted, visible } = useModalPresence(open);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchRecipes()
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      setActivatingId(null);
      return;
    }
    load();
  }, [open]);

  // Re-poll the live recipe list whenever a switch finishes (done/failed), so the
  // active badge and per-node status reflect reality instead of the pre-switch snapshot.
  useEffect(() => {
    if (!open) return;
    if (recipeSwitch?.phase === "done" || recipeSwitch?.phase === "failed") {
      load();
      setActivatingId(null);
    }
  }, [open, recipeSwitch?.phase, recipeSwitch?.updatedAt]);

  const switchInFlight = recipeSwitch != null && recipeSwitch.phase !== "done" && recipeSwitch.phase !== "failed";

  const handleActivate = async (recipe: RecipeInfo) => {
    setError(null);
    setActivatingId(recipe.id);
    try {
      await activateRecipe(recipe.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setActivatingId(null);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`settings-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4${
        visible ? " is-open" : ""
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel w-full max-w-lg p-6">
        <h2 className="mb-1 text-sm font-semibold text-text-strong">Deployment recipes</h2>
        <p className="mb-4 text-[10px] text-muted">
          Exactly one of these runs across the pair at a time. Status is probed live over SSH on
          every open — never a stored flag.
        </p>

        {data?.conflict && (
          <div className="mb-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">
            Conflicting state: {data.conflictIds.join(", ")} all report running at once. Stop the
            stray one by hand before switching.
          </div>
        )}

        {recipeSwitch && (
          <div
            className={`mb-3 rounded px-3 py-2 text-xs ${
              recipeSwitch.phase === "failed"
                ? "bg-danger/20 text-danger"
                : recipeSwitch.phase === "done"
                  ? "bg-accent-soft text-accent"
                  : "bg-surface-elevated text-text"
            }`}
          >
            <div className="font-medium">
              {PHASE_LABEL[recipeSwitch.phase]} — target: {recipeSwitch.targetId}
            </div>
            {recipeSwitch.from && (
              <div className="mt-0.5 text-[10px] text-muted">from: {recipeSwitch.from}</div>
            )}
            {recipeSwitch.progress && (
              <div className="mt-2 space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted">
                  <span>
                    {recipeSwitch.progress.percent}% loaded
                    {recipeSwitch.progress.source === "estimate" ? (
                      <span className="ml-1 opacity-70">(estimated)</span>
                    ) : null}
                  </span>
                  {formatEtaSeconds(recipeSwitch.progress.etaSeconds) && (
                    <span>{formatEtaSeconds(recipeSwitch.progress.etaSeconds)} remaining</span>
                  )}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, recipeSwitch.progress.percent))}%` }}
                  />
                </div>
              </div>
            )}
            {recipeSwitch.error && <div className="mt-0.5">{recipeSwitch.error}</div>}
          </div>
        )}

        {loading && <p className="text-xs text-muted">Loading…</p>}

        {data && !loading && (
          <div className="space-y-2">
            {data.recipes.map((recipe) => {
              const isActive = data.activeId === recipe.id;
              const busy = switchInFlight && activatingId === recipe.id;
              return (
                <div
                  key={recipe.id}
                  className="rounded border border-border bg-surface-elevated p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-strong">{recipe.label}</span>
                        {isActive && (
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                            active
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted">
                        {GROUP_LABEL[recipe.group] ?? recipe.group}
                      </div>
                      <div className="mt-1 space-y-0.5">
                        {recipe.nodeStatus.map((n) => (
                          <div key={n.role} className="text-[10px] text-muted">
                            <span className="font-mono">{n.role}</span>:{" "}
                            <span className={n.running ? "text-accent" : "text-muted"}>
                              {n.running ? "running" : "not running"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isActive || switchInFlight}
                      onClick={() => handleActivate(recipe)}
                      className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {busy ? "Switching…" : isActive ? "Active" : "Activate"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
