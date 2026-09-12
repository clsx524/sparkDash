import { useEffect, useState } from "react";
import {
  addModel,
  deleteModelFiles,
  downloadModel,
  fetchModelJob,
  fetchModelRegistry,
  fetchModels,
  fetchSparks,
  removeModel,
  updateModelRegistry,
} from "../api/client";
import type { ModelEntry, ModelJobState, ModelsListResponse, SparkConfig } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";

interface ModelsDialogProps {
  open: boolean;
  onClose: () => void;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/** Bytes → "1.2 GB" / "512 MB". Dash when unknown. */
function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const EMPTY_FORM = {
  id: "",
  label: "",
  subfolder: "",
  repo: "",
  revision: "",
  includePattern: "",
};

export function ModelsDialog({ open, onClose }: ModelsDialogProps) {
  const [data, setData] = useState<ModelsListResponse | null>(null);
  const [allSparks, setAllSparks] = useState<SparkConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [registryHostId, setRegistryHostId] = useState<string | null>(null);
  const [registryDirectory, setRegistryDirectory] = useState("");
  const [savingRegistry, setSavingRegistry] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [jobs, setJobs] = useState<Record<string, ModelJobState & { phase: "idle" | ModelJobState["phase"] }>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEscape(onClose);
  const { mounted, visible } = useModalPresence(open);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([fetchModelRegistry(), fetchModels(), fetchSparks()])
      .then(([registry, models, sparks]) => {
        setData(models);
        setRegistryHostId(registry.hostId);
        setRegistryDirectory(registry.directory);
        setAllSparks(sparks.sparks);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      setForm(EMPTY_FORM);
      setFormError(null);
      setJobs({});
      setConfirmingId(null);
      return;
    }
    load();
  }, [open]);

  // Poll any in-flight job every 2s until it settles (done/failed).
  useEffect(() => {
    if (!open) return;
    const inFlightIds = Object.entries(jobs)
      .filter(([, j]) => j.phase === "running" || j.phase === "verifying")
      .map(([id]) => id);
    if (inFlightIds.length === 0) return;
    const timer = window.setInterval(() => {
      for (const id of inFlightIds) {
        void fetchModelJob(id)
          .then((job) => {
            setJobs((prev) => ({ ...prev, [id]: job }));
            if (job.phase === "done" || job.phase === "failed") {
              load();
            }
          })
          .catch(() => {
            /* transient poll failure — try again next tick */
          });
      }
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobs]);

  if (!mounted) return null;

  const handleSaveRegistry = async () => {
    setSavingRegistry(true);
    setError(null);
    try {
      const registry = await updateModelRegistry({ hostId: registryHostId, directory: registryDirectory });
      setRegistryHostId(registry.hostId);
      setRegistryDirectory(registry.directory);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRegistry(false);
    }
  };

  const handleDownload = async (model: ModelEntry) => {
    setError(null);
    try {
      await downloadModel(model.id);
      setJobs((prev) => ({
        ...prev,
        [model.id]: { modelId: model.id, kind: "download", phase: "running", updatedAt: new Date().toISOString() },
      }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteFiles = async (model: ModelEntry) => {
    setError(null);
    try {
      await deleteModelFiles(model.id);
      setJobs((prev) => ({
        ...prev,
        [model.id]: { modelId: model.id, kind: "delete", phase: "running", updatedAt: new Date().toISOString() },
      }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUntrack = async (model: ModelEntry) => {
    if (confirmingId !== model.id) {
      setConfirmingId(model.id);
      return;
    }
    setConfirmingId(null);
    setError(null);
    try {
      await removeModel(model.id);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAdd = async () => {
    setFormError(null);
    if (!MODEL_ID_PATTERN.test(form.id)) {
      setFormError("Id must match ^[a-zA-Z0-9._-]{1,128}$ (letters, numbers, dot, underscore, hyphen).");
      return;
    }
    if (!form.label.trim() || !form.subfolder.trim() || !form.repo.trim() || !form.revision.trim()) {
      setFormError("Label, subfolder, repo, and revision are required.");
      return;
    }
    setAdding(true);
    try {
      await addModel({
        id: form.id.trim(),
        label: form.label.trim(),
        subfolder: form.subfolder.trim(),
        repo: form.repo.trim(),
        revision: form.revision.trim(),
        includePattern: form.includePattern.trim() || null,
      });
      setForm(EMPTY_FORM);
      load();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

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
        <h2 className="mb-1 text-sm font-semibold text-text-strong">Model Registry</h2>
        <p className="mb-4 text-[10px] text-muted">
          One host holds the canonical model weights. Other hosts sync from it directly or via a
          relay hop.
        </p>

        <div className="mb-4 space-y-2 rounded border border-border bg-surface-elevated p-3">
          <div>
            <label className="mb-1 block text-xs text-muted">Registry host</label>
            <select
              value={registryHostId ?? ""}
              onChange={(e) => setRegistryHostId(e.target.value || null)}
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            >
              <option value="">None</option>
              {allSparks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Directory</label>
            <input
              type="text"
              value={registryDirectory}
              onChange={(e) => setRegistryDirectory(e.target.value)}
              placeholder="Where model weights land on the registry host"
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveRegistry}
              disabled={savingRegistry}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {savingRegistry ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {loading && <p className="text-xs text-muted">Loading…</p>}

        {data && !loading && (
          <div className="space-y-2">
            {data.models.length === 0 && (
              <p className="text-xs text-muted">No models tracked yet.</p>
            )}
            {data.models.map((model) => {
              const status = data.statuses[model.id];
              const job = jobs[model.id];
              const busy = job?.phase === "running" || job?.phase === "verifying";
              return (
                <div key={model.id} className="rounded border border-border bg-surface-elevated p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-text-strong">{model.label}</div>
                      <div className="mt-0.5 truncate text-[10px] text-muted">
                        {model.repo}@{model.revision}
                      </div>
                      <div className="text-[10px] text-muted">subfolder: {model.subfolder}</div>
                      <div className="mt-1 text-[10px]">
                        {status?.available ? (
                          <span className="text-success">
                            Available{status.sizeBytes != null ? ` (${formatBytes(status.sizeBytes)})` : ""}
                          </span>
                        ) : (
                          <span className="text-muted">Not downloaded</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {status?.available ? (
                        <button
                          type="button"
                          onClick={() => handleDeleteFiles(model)}
                          disabled={busy}
                          className="rounded border border-danger/40 bg-surface px-2.5 py-1 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
                        >
                          {busy && job?.kind === "delete" ? "Deleting…" : "Delete files"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleDownload(model)}
                          disabled={busy}
                          className="rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                        >
                          {busy && job?.kind === "download" ? "Downloading…" : "Download"}
                        </button>
                      )}
                      {confirmingId === model.id ? (
                        <button
                          type="button"
                          onClick={() => handleUntrack(model)}
                          className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1 text-[10px] text-danger hover:bg-danger/20"
                        >
                          Confirm untrack
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleUntrack(model)}
                          className="rounded border border-border bg-surface px-2.5 py-1 text-[10px] text-muted hover:bg-surface-hover"
                        >
                          Untrack
                        </button>
                      )}
                    </div>
                  </div>
                  {job && (job.phase !== "done" || job.error) && (
                    <div
                      className={`mt-2 rounded px-2 py-1 text-[10px] ${
                        job.phase === "failed" ? "bg-danger/20 text-danger" : "bg-surface text-muted"
                      }`}
                    >
                      {job.phase === "failed"
                        ? job.error || "Job failed."
                        : job.message || (job.phase === "verifying" ? "Verifying…" : "Working…")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 space-y-2 rounded border border-border bg-surface-elevated p-3">
          <div className="text-xs font-medium text-text-strong">Add model</div>
          <div>
            <label className="mb-1 block text-xs text-muted">Id</label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
              placeholder="unique-model-id"
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Label</label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Subfolder</label>
            <input
              type="text"
              value={form.subfolder}
              onChange={(e) => setForm((prev) => ({ ...prev, subfolder: e.target.value }))}
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Repo</label>
            <input
              type="text"
              value={form.repo}
              onChange={(e) => setForm((prev) => ({ ...prev, repo: e.target.value }))}
              placeholder="org/repo"
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Revision</label>
            <input
              type="text"
              value={form.revision}
              onChange={(e) => setForm((prev) => ({ ...prev, revision: e.target.value }))}
              placeholder="main"
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">Include pattern (optional)</label>
            <input
              type="text"
              value={form.includePattern}
              onChange={(e) => setForm((prev) => ({ ...prev, includePattern: e.target.value }))}
              className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>
          {formError && (
            <div className="rounded bg-danger/20 px-3 py-2 text-xs text-danger">{formError}</div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {adding ? "Adding..." : "Add model"}
            </button>
          </div>
        </div>

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
