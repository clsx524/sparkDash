import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("overview");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<
    | { kind: "result"; ok: number; fail: number; skipped: number }
    | { kind: "text"; text: string; tone: "ok" | "err" }
    | { kind: "error"; rawMessage?: string }
    | null
  >(null);
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
        kind: "text",
        text: res.started ? "Shutdown started" : "Shutdown requested",
        tone: "ok",
      });
    } catch (err: unknown) {
      setMsg({ kind: "error", rawMessage: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 6000);
    }
  }

  return (
    <>
      {msg ? (
        <span className={`ov-batchmsg ${msg.kind === "text" ? (msg.tone === "ok" ? "is-ok" : "is-err") : msg.kind === "result" && msg.fail === 0 ? "is-ok" : "is-err"}`} role="status">
          {msg.kind === "error"
            ? msg.rawMessage ?? t("batch.shutdownFailed")
            : msg.kind === "text"
              ? msg.text
              : [
                  t("batch.shutdownComplete", { count: msg.ok }),
                  ...(msg.fail ? [t("batch.failed", { count: msg.fail })] : []),
                  ...(msg.skipped ? [t("batch.skipped", { count: msg.skipped })] : []),
                ].join(", ")}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy || onlineCount === 0}
        title={t("shutdown.buttonTitle")}
        className={`btn btn--danger ${className}`}
      >
        <PowerOffIcon className="h-3.5 w-3.5" />
        {t("shutdown.button")}
      </button>
      <ConfirmShutdownDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={run}
        title={t("shutdown.dialogTitle")}
        description={t("shutdown.description", { count: onlineCount })}
        confirmLabel={t("shutdown.button")}
        warnings={shutdownWarnings(sparks, {
          inFlight: (sparkName, count) => t("shutdown.warningInFlight", { sparkName, count }),
          comfyJob: (sparkName) => t("shutdown.warningComfy", { sparkName }),
          hermesUpdate: (sparkName) => t("shutdown.warningHermes", { sparkName }),
        })}
        warningDetail="Nodes with a configured outlet power off after the graceful stop. The active recipe is remembered and re-activated on Wake all."
      />
    </>
  );
}
