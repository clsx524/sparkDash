import { useState } from "react";
import type { PowerActionState } from "../api/types";
import { RotateIcon } from "./ui/icons";

interface PowerActionBannerProps {
  action: PowerActionState | null;
}

function phaseLabel(action: PowerActionState): string {
  const current = action.current ? ` ${action.current}` : "";
  switch (action.phase) {
    case "starting":
      return "Starting…";
    case "shutting-down":
      return `Shutting down${current || " nodes"}…`;
    case "waiting-offline":
      return `Waiting for${current || " a node"} to power off…`;
    case "powering-off":
      return `Powering off${current || " nodes"}…`;
    case "powering-on":
      return `Powering on${current || " nodes"}…`;
    case "waiting-online":
      return "Waiting for nodes to come online…";
    case "done":
      return action.message ? `Done: ${action.message}` : "Done";
    case "failed":
      return `Failed: ${action.error || "unknown error"}`;
    default:
      return action.phase;
  }
}

/**
 * Progress banner for shutdown-all / wake-all. The batch endpoints return
 * immediately; the long-running work (graceful shutdown, outlet power-off,
 * boot wait) arrives on the WS `powerAction` state.
 */
export function PowerActionBanner({ action }: PowerActionBannerProps) {
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  if (!action || dismissedFor === action.startedAt) return null;

  const finished = action.phase === "done" || action.phase === "failed";
  const pct =
    action.total > 0 ? Math.min(100, Math.round((action.completed / action.total) * 100)) : 0;

  return (
    <div className={`ov-prog${action.phase === "failed" ? " is-err" : ""}`} role="status">
      <span className="ov-prog__label">
        {!finished && <RotateIcon className="h-3 w-3 animate-spin" />}
        {phaseLabel(action)}
        {action.total > 0 && !finished && (
          <span className="text-muted">
            {" "}
            ({action.completed}/{action.total})
          </span>
        )}
        {finished && (
          <button
            type="button"
            onClick={() => setDismissedFor(action.startedAt)}
            aria-label="Dismiss power action status"
            title="Dismiss"
            className="ov-prog__x"
          >
            {"\u2715"}
          </button>
        )}
      </span>
      {!finished && (
        <div className="ov-prog__track">
          <div
            className={`ov-prog__fill${action.phase === "failed" ? " is-err" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
