import { useEffect, useLayoutEffect, useState } from "react";
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

const CANCEL_NOTE = "Cancellation stops remaining Apply work. Completed changes and already-started services are not rolled back; nodes stay powered on and downloaded weights are kept.";

export function RecipesDialog({ open, onClose, recipeSession }: RecipesDialogProps) {
  const sessions = useRecipeSessions(open, recipeSession);
  const { current, history, selectedId, selected, selectionError, loading, ready, error, pendingId, running, cancelPending, cancelling, cancelError } = sessions;
  const { mounted, visible } = useModalPresence(open);
  const [historyOpen, setHistoryOpen] = useState(false);
  const applying = running || pendingId != null;
  const runningId = running ? current?.id : null;
  const pastRuns = current && !running ? [current, ...history] : history;
  useLayoutEffect(() => {
    if (!open || applying) setHistoryOpen(false);
  }, [open, applying, runningId]);
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
        <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 id="recipes-title" className="text-sm font-semibold text-text-strong">Model deployments</h2>
          {current && running && <>
            <button type="button" onClick={() => { void sessions.cancel(current.id); }}
              disabled={cancelPending || cancelling} aria-describedby="cancel-apply-note" title={CANCEL_NOTE}
              className="ml-auto rounded border border-danger/40 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50">
              {cancelling ? "Cancelling…" : "Cancel Apply"}
            </button>
            <span id="cancel-apply-note" className="sr-only">{CANCEL_NOTE}</span>
          </>}
        </header>
        <p className="mb-3 shrink-0 text-[10px] text-muted">
          Plan placements, check host capacity, then apply small services before the selected large model.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {error && <div role="alert" className="mb-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">
            {error} <button type="button" onClick={sessions.retry} className="underline">Retry loading</button>
          </div>}
          <DeploymentPlanner disabled={applying || cancelPending || !ready}
            applying={applying} onApply={sessions.apply} onPrepareImages={sessions.prepareImages} />
          <section id="recipe-apply-panel" aria-label={historyOpen ? "Apply History" : "Current Apply"} className="mt-4 min-w-0 rounded border border-border p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-text-strong">{historyOpen ? "Apply History" : "Current Apply"}</h3>
              <button type="button" aria-controls="recipe-apply-panel" onClick={() => setHistoryOpen((value) => !value)}
                className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-strong hover:bg-surface-hover">
                {historyOpen ? "Back to progress" : "Apply history"}
              </button>
            </div>
            {cancelError && <p role="alert" className="mb-2 text-xs text-danger">Could not cancel Apply: {cancelError}. Try Cancel Apply again, or retry loading to check the server state. <button type="button" className="underline" onClick={sessions.retry}>Retry loading</button></p>}
            {historyOpen ? (
              loading ? <p className="text-xs text-muted">Loading Apply history…</p>
                : pastRuns.length === 0 ? <p className="text-xs text-muted">No finished runs.</p>
                  : <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <ul className="max-h-48 min-w-0 space-y-1 overflow-y-auto md:max-h-80" aria-label="Prior Apply sessions">
                      {pastRuns.map((session) => <li key={session.id}>
                        <button type="button" aria-pressed={selectedId === session.id} onClick={() => sessions.selectHistory(session.id)}
                          className={`w-full rounded border p-2 text-left text-[10px] ${selectedId === session.id ? "border-accent bg-accent-soft" : "border-border bg-surface-elevated"}`}>
                          <strong className="block text-xs text-text-strong">{session.label}{session.targetId !== "model-images" && ` · TP${session.tp}`}</strong>
                          <span className="text-muted">{session.status} · {new Date(session.startedAt).toLocaleString()} · {Math.max(0, Math.round(((session.finishedAt ?? session.updatedAt) - session.startedAt) / 1000))}s</span>
                        </button>
                      </li>)}
                    </ul>
                    <div className="min-w-0 border-t border-border pt-3 md:border-t-0 md:border-l md:pt-0 md:pl-3" data-testid="history-detail">
                      {selectionError && <p role="alert" className="mb-2 text-xs text-danger">Selected session unavailable: {selectionError} <button type="button" className="underline" onClick={sessions.retry}>Retry loading</button></p>}
                      {selected ? <RecipeSessionDetails key={selected.id} session={selected} />
                        : !selectionError && <p className="text-xs text-muted">{selectedId ? "Loading selected session…" : "Select a run to view its details."}</p>}
                    </div>
                  </div>
            ) : running && current ? <RecipeSessionDetails key={current.id} session={current} />
              : pendingId != null ? <p className="text-xs text-muted">Starting Apply…</p>
                : <p className="text-xs text-muted">{loading ? "Loading Apply status…" : "No Apply in progress."}</p>}
          </section>
        </div>
        <div className="mt-3 flex shrink-0 justify-end border-t border-border pt-3">
          <button type="button" onClick={onClose} className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover">Close</button>
        </div>
      </div>
    </div>
  );
}
