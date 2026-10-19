import { useEffect, useRef, useState } from "react";
import type { SparkSnapshot } from "../api/types";
import { shutdownAllSparks } from "../api/client";
import { ConfirmShutdownDialog } from "./ConfirmShutdownDialog";
import { shutdownWarnings } from "./OverviewPage/fleetStats";
import { PowerOffIcon } from "./ui/icons";

/**
 * "Shut down all" with its confirmation and result message. Used in the Overview header (desktop)
 * and in the mobile Sparks sheet, so the flow exists once.
 */
export function ShutdownAll({ sparks, className = "" }: { sparks: SparkSnapshot[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onlineCount = sparks.filter((s) => s.online).length;

  async function run() {
    if (onlineCount === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await shutdownAllSparks();
      setMsg({
        text: res.started ? "Shutdown started" : "Shutdown requested",
        tone: "ok",
      });
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : "Batch shutdown failed", tone: "err" });
    } finally {
      setBusy(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 6000);
    }
  }

  return (
    <>
      {msg ? (
        <span className={`ov-batchmsg ${msg.tone === "ok" ? "is-ok" : "is-err"}`} role="status">
          {msg.text}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy || onlineCount === 0}
        title="Shut down all online Sparks"
        className={`btn btn--danger ${className}`}
      >
        <PowerOffIcon className="h-3.5 w-3.5" />
        Shut down all
      </button>
      <ConfirmShutdownDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={run}
        title="Shutdown All"
        description={`Gracefully shut down all ${onlineCount} online Spark${onlineCount === 1 ? "" : "s"}, then power off every node with a configured outlet. The active recipe is remembered and re-activated on Wake all.`}
        confirmLabel="Shut down all"
        warnings={shutdownWarnings(sparks)}
      />
    </>
  );
}
