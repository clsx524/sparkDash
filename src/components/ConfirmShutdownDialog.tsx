import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { PowerOffIcon, PowerOnIcon } from "./ui/icons";
import "../styles/dialogs.css";

interface ConfirmShutdownDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  /** Lines naming running work this action will stop; rendered in a warning box. */
  warnings?: string[];
  /** "danger" for shutdown, "default" for wake/power-on. */
  tone?: "danger" | "default";
  warningTitle?: string;
  warningDetail?: string;
}

function useEscape(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}

/**
 * Simple confirmation popup. No typed phrase and no acknowledgement checkbox:
 * the operator asked for a plain confirm/cancel dialog. The warnings box still
 * names the work a shutdown would interrupt.
 */
export function ConfirmShutdownDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Shut down",
  warnings,
  tone = "danger",
  warningTitle,
  warningDetail,
}: ConfirmShutdownDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose, !submitting);

  useEscape(open && !submitting, onClose);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  const canConfirm = !submitting;
  const danger = tone === "danger";
  const Icon = danger ? PowerOffIcon : PowerOnIcon;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div
        ref={trapRef}
        className="modal-sheet modal-sheet--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div
          className={`modal-sheet__header${danger ? " modal-sheet__header--danger" : ""}`}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <h2 className="modal-sheet__title" id={titleId}>
            {danger ? "Danger zone — " : ""}
            {title}
          </h2>
        </div>

        <div className="modal-sheet__body modal-sheet__stack">
          <p className="modal-sheet__lead">{description}</p>

          <div className="danger-box" role="alert">
            <b>
              {warningTitle ||
                (danger ? "This powers off hardware." : "This powers on hardware.")}
            </b>
            {warnings && warnings.length > 0 ? (
              <ul>
                {warnings.map((w, i) => (
                  <li key={`${i}-${w}`}>{w}</li>
                ))}
              </ul>
            ) : null}
            <span>
              {warningDetail ||
                (danger
                  ? "Running containers and sessions will stop. The host powers off after a graceful stop."
                  : "Nodes will boot. No recipes are applied or restored.")}
            </span>
          </div>
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" onClick={onClose} disabled={submitting} className="btn btn--ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {submitting ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
