import { useEffect } from "react";
import type { RecipeSessionSummary } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useRecipeSessions } from "../hooks/useRecipeSessions";
import { RecipeSessionDetails } from "./RecipeSessionDetails";

interface RecipesDialogProps {
  open: boolean;
  onClose: () => void;
  recipeSession: RecipeSessionSummary | null | undefined;
}

const GROUP_LABEL: Record<string, string> = {
  "dual-text-gen": "Distributed text generation",
  "single-node": "Single-node",
};

/** Same-target activation refreshes the deployment; pending requests also lock the button. */
export function activateButtonState(
  isActive: boolean,
  sessionRunning: boolean,
  busy: boolean,
): { disabled: boolean; label: string } {
  return {
    disabled: sessionRunning || busy,
    label: busy ? "Applying…" : isActive ? "Refresh" : "Activate",
  };
}

export function RecipesDialog({ open, onClose, recipeSession }: RecipesDialogProps) {
  const sessions = useRecipeSessions(open, recipeSession);
  const { data, current, history, selectedId, selected, selectionError, loading, ready, error, pendingId, running } = sessions;
  const { mounted, visible } = useModalPresence(open);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);
  if (!mounted) return null;

  return (
    <div className={`settings-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-4${visible ? " is-open" : ""}`}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="recipes-title" className="settings-panel recipes-panel w-full p-4 sm:p-6">
        <h2 id="recipes-title" className="mb-1 shrink-0 text-sm font-semibold text-text-strong">Deployment recipes</h2>
        <p className="mb-4 shrink-0 text-[10px] text-muted">
          One recipe runs at a time. Applying wakes only its required offline nodes and waits up to five minutes for all required nodes to come online before deployment.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error && <div role="alert" className="mb-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">
            {error} <button type="button" onClick={sessions.retry} className="underline">Retry loading</button>
          </div>}
          {loading && <p className="mb-3 text-xs text-muted">Loading persisted Apply sessions…</p>}
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <section aria-label="Current Apply" className="min-w-0 rounded border border-border p-3">
              <h3 className="mb-2 text-xs font-semibold text-text-strong">Current Apply</h3>
              <p className="mb-2 text-[10px] text-muted">Latest session; stays here until the next Apply.</p>
              {current ? <RecipeSessionDetails key={current.id} session={current} /> : <p className="text-xs text-muted">No Apply session recorded.</p>}
            </section>
            <section aria-label="Apply History" className="min-w-0 rounded border border-border p-3">
              <h3 className="mb-2 text-xs font-semibold text-text-strong">Apply History</h3>
              <p className="mb-2 text-[10px] text-muted">Prior completed, failed, and interrupted sessions. Details are read-only.</p>
              {history.length === 0 && <p className="text-xs text-muted">No prior sessions.</p>}
              <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto" aria-label="Prior Apply sessions">
                {history.map((session) => <li key={session.id}>
                  <button type="button" aria-pressed={selectedId === session.id} onClick={() => sessions.selectHistory(session.id)}
                    className={`flex w-full flex-wrap justify-between gap-1 rounded border p-2 text-left text-[10px] ${selectedId === session.id ? "border-accent bg-accent-soft" : "border-border bg-surface-elevated"}`}>
                    <span>{session.label} · TP{session.tp}</span>
                    <span>{session.status} · {new Date(session.startedAt).toLocaleString()} · {Math.max(0, Math.round(((session.finishedAt ?? session.updatedAt) - session.startedAt) / 1000))}s</span>
                  </button>
                </li>)}
              </ul>
              {selectedId && <div className="border-t border-border pt-3" data-testid="history-detail">
                {selectionError && <p role="alert" className="mb-2 text-xs text-danger">Selected session unavailable: {selectionError} <button type="button" className="underline" onClick={sessions.retry}>Retry loading</button></p>}
                {selected ? <RecipeSessionDetails key={selected.id} session={selected} /> : !selectionError && <p className="text-xs text-muted">Loading selected session…</p>}
              </div>}
            </section>
          </div>
          <section aria-label="Choose recipe" className="mt-4">
            <h3 className="mb-2 text-xs font-semibold text-text-strong">Choose recipe</h3>
            {data?.conflict && <div className="mb-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">
              Conflicting state: {data.conflictIds.join(", ")} all report running at once. Stop the stray one by hand before switching.
            </div>}
            <div className="grid gap-2 md:grid-cols-2">
              {data?.recipes.map((recipe) => {
                const isActive = data.activeId === recipe.id;
                const { disabled, label } = activateButtonState(isActive, running || pendingId != null || !ready, pendingId === recipe.id);
                return <div key={recipe.id} className="rounded border border-border bg-surface-elevated p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-text-strong">{recipe.label}</span>
                        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">TP{recipe.tp}</span>
                        {isActive && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">active</span>}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted">{GROUP_LABEL[recipe.group] ?? recipe.group}</div>
                      <div className="mt-0.5 text-[10px] text-muted">Required nodes: {recipe.requiredNodes.map((node) => "sparkId" in node ? node.sparkId : node.role).join(", ")}</div>
                      <div className="mt-1 space-y-0.5">{recipe.nodeStatus.map((node) => <div key={node.role} className="text-[10px] text-muted">
                        <span className="font-mono">{node.role}</span>: <span className={node.running ? "text-accent" : "text-muted"}>{node.running ? "running" : "not running"}</span>
                      </div>)}</div>
                    </div>
                    <button type="button" disabled={disabled} onClick={() => { void sessions.apply(recipe.id); }}
                      title={isActive ? "Stop and restart this recipe with the latest recipe/config files" : undefined}
                      className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">{label}</button>
                  </div>
                </div>;
              })}
            </div>
          </section>
        </div>
        <div className="mt-3 flex shrink-0 justify-end border-t border-border pt-3">
          <button type="button" onClick={onClose} className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">Close</button>
        </div>
      </div>
    </div>
  );
}
