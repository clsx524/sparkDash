import { useEffect } from "react";
import type { RecipeSessionSummary } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useRecipeSessions } from "../hooks/useRecipeSessions";
import { RecipeSessionDetails } from "./RecipeSessionDetails";
import { DeploymentPlanner } from "./DeploymentPlanner";

interface RecipesDialogProps {
  open: boolean;
  onClose: () => void;
  recipeSession: RecipeSessionSummary | null | undefined;
}


export function RecipesDialog({ open, onClose, recipeSession }: RecipesDialogProps) {
  const sessions = useRecipeSessions(open, recipeSession);
  const { current, history, selectedId, selected, selectionError, loading, ready, error, pendingId, running, cancelPending, cancelling, cancelError } = sessions;
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
        <h2 id="recipes-title" className="mb-1 shrink-0 text-sm font-semibold text-text-strong">Model deployments</h2>
        <p className="mb-4 shrink-0 text-[10px] text-muted">
          Plan placements, check host capacity, then apply small services before the selected large model.
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
              {current && running && <div className="mb-3 rounded border border-danger/40 bg-danger/10 p-3">
                <button type="button" onClick={() => { void sessions.cancel(current.id); }}
                  disabled={cancelPending || cancelling}
                  className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {cancelling ? "Cancelling…" : "Cancel Apply"}
                </button>
                <p className="mt-2 text-[10px] text-muted">Cancellation stops remaining Apply work. Completed changes and already-started services are not rolled back; nodes stay powered on and downloaded weights are kept.</p>
              </div>}
              {cancelError && <p role="alert" className="mb-2 text-xs text-danger">Could not cancel Apply: {cancelError}. Try Cancel Apply again, or retry loading to check the server state. <button type="button" className="underline" onClick={sessions.retry}>Retry loading</button></p>}
              {current ? <RecipeSessionDetails key={current.id} session={current} /> : <p className="text-xs text-muted">No Apply session recorded.</p>}
            </section>
            <section aria-label="Apply History" className="min-w-0 rounded border border-border p-3">
              <h3 className="mb-2 text-xs font-semibold text-text-strong">Apply History</h3>
              <p className="mb-2 text-[10px] text-muted">Prior completed, failed, interrupted, and cancelled sessions. Details are read-only.</p>
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
          <DeploymentPlanner disabled={running || cancelPending || pendingId != null || !ready}
            applying={running || pendingId != null} onApply={sessions.apply} />
        </div>
        <div className="mt-3 flex shrink-0 justify-end border-t border-border pt-3">
          <button type="button" onClick={onClose} className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">Close</button>
        </div>
      </div>
    </div>
  );
}
