import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RecipeSessionDetail, RecipeSessionStage } from "../api/types";
import { AlertTriangleIcon, CheckIcon, RotateIcon, XIcon } from "./ui/icons";

const PHASE_LABEL: Record<string, string> = {
  "checking-nodes": "Checking required nodes",
  "powering-on": "Waking required nodes",
  "waiting-online": "Waiting for required nodes to come online",
  "checking-current-state": "Checking current state",
  stopping: "Stopping current recipe",
  "confirming-stopped": "Confirming it stopped",
  "clearing-conflicts": "Clearing stray containers",
  "syncing-model": "Syncing model files",
  "rechecking-nodes": "Rechecking required nodes",
  starting: "Starting target recipe",
  "health-checking": "Waiting for health",
  cancelling: "Cancelling Apply",
  cancelled: "Apply cancelled",
};

function StageOutput({ stage }: { stage: RecipeSessionStage }) {
  const output = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const lastSeq = stage.logs.at(-1)?.seq;
  useLayoutEffect(() => {
    if (following && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [following, lastSeq]);
  return <div>
    <div className="mb-1 flex justify-end">
      <button type="button" aria-label="Follow output" aria-pressed={following}
        onClick={() => setFollowing((value) => !value)} className="text-[10px] text-muted underline">
        {following ? "Following output" : "Resume following"}
      </button>
    </div>
    <div ref={output} className="max-h-64 overflow-auto rounded bg-surface p-2 font-mono text-[10px]"
      aria-label={`${PHASE_LABEL[stage.phase] ?? stage.phase} logs`}
      onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= 16);
      }}>
      {stage.logs.map((line) => <div key={line.seq}
        className={line.stream === "stderr" && stage.status === "failed" ? "text-danger" : "text-text"}>
        <span className="text-muted">{new Date(line.ts).toLocaleTimeString()} [{line.stream}]{line.nodeName || line.nodeId ? ` ${line.nodeName ?? line.nodeId}` : ""}{": "}</span>
        <span className="whitespace-pre-wrap break-all">{line.text}</span>
      </div>)}
    </div>
  </div>;
}

export function RecipeSessionDetails({ session }: { session: RecipeSessionDetail }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (session.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.id, session.status]);
  const elapsed = Math.max(0, Math.round(((session.finishedAt ?? now) - session.startedAt) / 1000));
  return (
    <div className="space-y-2 text-xs" data-session-id={session.id}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-text-strong">{session.label}</strong>
        <span>TP{session.tp}</span>
        <span className={`rounded border border-border px-2 py-0.5 ${session.status === "failed" || session.status === "interrupted" ? "text-danger" : session.status === "cancelled" ? "text-muted" : "text-accent"}`} role="status">{session.status === "running" && session.phase === "cancelling" ? "cancelling" : session.status}</span>
      </div>
      <div className="text-[10px] text-muted">
        Started <time dateTime={new Date(session.startedAt).toISOString()}>{new Date(session.startedAt).toLocaleString()}</time>
        {session.finishedAt != null && <> · Finished <time dateTime={new Date(session.finishedAt).toISOString()}>{new Date(session.finishedAt).toLocaleString()}</time></>}
        {" · "}{elapsed}s elapsed
      </div>
      <p className="text-[10px] text-muted">Required nodes: {session.requiredNodes.map((node) => node.name).join(", ")}</p>
      {session.phase === "cancelling" && session.status === "running" && <p className="text-muted">Cancelling remaining Apply work; waiting for the current operation to stop.</p>}
      {session.storageError && <p role="alert" className="text-danger">Session storage error: {session.storageError}</p>}
      {session.logsTruncated && <p className="text-muted">Captured output reached its limit; some log text was truncated.</p>}
      <ol className="space-y-1" aria-label="Apply stages">
        {session.stages.map((stage) => {
          const key = `${session.id}:${stage.id}`;
          const isExpanded = expanded[key] ?? (stage.status === "running" || stage.status === "failed" || stage.status === "interrupted" || stage.status === "cancelled");
          const duration = Math.max(0, Math.round(((stage.finishedAt ?? now) - stage.startedAt) / 1000));
          const percent = stage.progress && Number.isFinite(stage.progress.percent) ? Math.min(100, Math.max(0, stage.progress.percent)) : null;
          const eta = stage.progress?.etaSeconds;
          return (
            <li key={stage.id} className={`rounded border bg-surface-elevated ${stage.status === "running" ? "border-accent" : "border-border"}`} data-stage-phase={stage.phase}>
              <button type="button" aria-expanded={isExpanded} onClick={() => setExpanded((previous) => ({ ...previous, [key]: !isExpanded }))}
                className="flex w-full flex-wrap items-center justify-between gap-2 p-2 text-left">
                <span className="flex items-center gap-2">
                  {stage.status === "running" ? <RotateIcon className="h-3.5 w-3.5 animate-spin text-accent" />
                    : stage.status === "succeeded" ? <CheckIcon className="h-3.5 w-3.5 text-accent" />
                    : stage.status === "failed" ? <XIcon className="h-3.5 w-3.5 text-danger" />
                    : <AlertTriangleIcon className="h-3.5 w-3.5 text-muted" />}
                  {isExpanded ? "▾" : "▸"} {PHASE_LABEL[stage.phase] ?? stage.phase}
                </span>
                <span className={stage.status === "failed" || stage.status === "interrupted" ? "text-danger" : stage.status === "running" ? "text-accent" : "text-muted"}>{stage.status} · {duration}s</span>
              </button>
              {isExpanded && <div className="space-y-2 border-t border-border p-2">
                <div className="text-[10px] text-muted">Started {new Date(stage.startedAt).toLocaleString()}{stage.finishedAt != null && <> · Finished {new Date(stage.finishedAt).toLocaleString()}</>}</div>
                {stage.pendingNodes.length > 0 && <p>Pending nodes: {stage.pendingNodes.join(", ")}</p>}
                {stage.message && <p role={stage.status === "failed" || stage.status === "interrupted" ? "alert" : undefined} className="whitespace-pre-wrap break-words">{stage.message}</p>}
                {percent != null && <div>
                  <div className="mb-1 flex flex-wrap justify-between gap-2 text-[10px] text-muted">
                    <span>{stage.status === "running" ? "" : "Last load reading: "}{Math.round(percent)}% loaded ({stage.progress?.source === "estimate" ? "estimated" : "measured from logs"})</span>
                    {stage.status === "running" && eta != null && Number.isFinite(eta) && eta >= 0 && <span>~{Math.round(eta)}s remaining</span>}
                  </div>
                  <progress aria-label="Model loading" value={percent} max={100} className="h-2 w-full accent-accent" />
                </div>}
                {stage.logs.length ? <StageOutput stage={stage} />
                  : <p className="text-[10px] text-muted">No captured output for this stage.</p>}
              </div>}
            </li>
          );
        })}
      </ol>
      {session.error && !session.stages.some((stage) => stage.message === session.error) && <p role="alert" className="whitespace-pre-wrap break-words text-danger">{session.error}</p>}
      {(session.status === "failed" || session.status === "interrupted") && <p className="text-[10px] text-muted">Apply {session.status}. Only stages entered are shown; subsequent steps were not run. This session will not be replayed automatically.</p>}
      {session.status === "cancelled" && <p className="text-[10px] text-muted">Apply cancelled. Remaining steps were not run. Completed changes and already-started services are not rolled back.</p>}
    </div>
  );
}
