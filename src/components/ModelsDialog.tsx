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
  rescanModelRegistry,
  updateModel,
  updateModelRegistry,
} from "../api/client";
import type {
  ModelEntry,
  ModelJobState,
  ModelRegistryScanResult,
  ModelsListResponse,
  SparkConfig,
} from "../api/types";
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

/**
 * Parse a pasted Hugging Face repo reference into `{ org, name }`. Accepts a
 * bare "org/repo" alias or a full https://huggingface.co/org/repo URL (with
 * an optional /tree/<rev> or /blob/<rev>/... suffix, which is not the repo
 * name and must be dropped). Returns null for anything that isn't
 * recognizably "one slash-separated org/repo pair" — callers should leave
 * the dependent fields alone rather than derive from a fragment while the
 * operator is still mid-paste/mid-type.
 */
function parseRepoAlias(raw: string): { org: string; name: string } | null {
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, "");
  s = s.replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { org: parts[0], name: parts[1] };
}

/** org/repo -> a value usable as both `id` and `subfolder` (id's allowed charset is a superset of every character Hugging Face permits in a repo name). */
function deriveIdFromRepo(raw: string): string | null {
  const parsed = parseRepoAlias(raw);
  if (!parsed) return null;
  const candidate = parsed.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  return MODEL_ID_PATTERN.test(candidate) ? candidate : null;
}

/** Bytes → "1.2 GB" / "512 MB". Dash when unknown. */
function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Summarize a reconciliation scan result for display. */
function describeScan(result: ModelRegistryScanResult): string {
  if (result.scanError) return `Scan failed: ${result.scanError}`;
  if (result.discovered.length === 0) return "Scan found no new folders.";
  return `Discovered ${result.discovered.length} model(s) on disk: ${result.discovered.join(", ")}. Set their source repo to enable download.`;
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

  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRepo, setEditRepo] = useState("");
  const [editRevision, setEditRevision] = useState("");
  const [editSaving, setEditSaving] = useState(false);

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
      setScanMessage(null);
      setEditingId(null);
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
    setScanMessage(null);
    try {
      const result = await updateModelRegistry({ hostId: registryHostId, directory: registryDirectory });
      setRegistryHostId(result.hostId);
      setRegistryDirectory(result.directory);
      setScanMessage(describeScan(result));
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRegistry(false);
    }
  };

  /** Re-scan the registry directory without changing host/directory — for files added on disk after the registry was already configured. */
  const handleRescan = async () => {
    setRescanning(true);
    setError(null);
    setScanMessage(null);
    try {
      const result = await rescanModelRegistry();
      setScanMessage(describeScan(result));
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRescanning(false);
    }
  };

  const startEdit = (model: ModelEntry) => {
    setEditingId(model.id);
    setEditRepo(model.repo ?? "");
    setEditRevision(model.revision || "main");
    setError(null);
  };

  const cancelEdit = () => setEditingId(null);

  const handleSaveEdit = async (model: ModelEntry) => {
    if (!editRepo.trim()) {
      setError("Source repo is required.");
      return;
    }
    setEditSaving(true);
    setError(null);
    try {
      await updateModel(model.id, { repo: editRepo.trim(), revision: editRevision.trim() || "main" });
      setEditingId(null);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
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
    const parsedRepo = parseRepoAlias(form.repo);
    try {
      await addModel({
        id: form.id.trim(),
        label: form.label.trim(),
        subfolder: form.subfolder.trim(),
        // Normalize a pasted https://huggingface.co/org/repo(/tree/...) URL
        // down to "org/repo" — the backend interpolates this straight into
        // huggingface.co/api/models/{repo}/tree/{revision}, so a raw URL
        // would silently 404 instead of downloading.
        repo: parsedRepo ? `${parsedRepo.org}/${parsedRepo.name}` : form.repo.trim(),
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
        <h2 className="mb-1 shrink-0 text-sm font-semibold text-text-strong">Model Registry</h2>
        <p className="mb-4 shrink-0 text-[10px] text-muted">
          One host holds the canonical model weights. Other hosts sync from it directly or via a
          relay hop.
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={handleRescan}
              disabled={rescanning || !registryHostId || !registryDirectory}
              title="Scan the registry directory for folders not yet tracked"
              className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              {rescanning ? "Scanning..." : "Rescan"}
            </button>
            <button
              type="button"
              onClick={handleSaveRegistry}
              disabled={savingRegistry}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {savingRegistry ? "Saving..." : "Save"}
            </button>
          </div>
          {scanMessage && (
            <p className={`text-[10px] ${scanMessage.startsWith("Scan failed") ? "text-danger" : "text-muted"}`}>
              {scanMessage}
            </p>
          )}
        </div>

        {loading && <p className="text-xs text-muted">Loading…</p>}

        {data && !loading && (
          <div className="space-y-2">
            {data.models.length === 0 && (
              <p className="text-xs text-muted">
                No models tracked yet. Saving the registry above (or Rescan) auto-tracks any
                existing folder found on disk — or add one manually below.
              </p>
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
                        {model.repo ? (
                          <>
                            {model.repo}@{model.revision}
                          </>
                        ) : (
                          <span className="text-warning">Source repo not set (found on disk)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted">subfolder: {model.subfolder}</div>
                      <div className="mt-1 text-[10px]">
                        {status?.available ? (
                          <span className="text-success">
                            Available{status.sizeBytes != null ? ` (${formatBytes(status.sizeBytes)})` : ""}
                          </span>
                        ) : status?.error ? (
                          <span className="text-danger" title={status.error}>
                            Probe failed: {status.error}
                          </span>
                        ) : (
                          <span className="text-muted">Not downloaded</span>
                        )}
                      </div>
                    </div>
                    {editingId !== model.id && (
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {model.repo ? (
                          status?.available ? (
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
                          )
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEdit(model)}
                            className="rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent-hover"
                          >
                            Set repo
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
                        {model.repo && (
                          <button
                            type="button"
                            onClick={() => startEdit(model)}
                            className="rounded border border-border bg-surface px-2.5 py-1 text-[10px] text-muted hover:bg-surface-hover"
                          >
                            Edit repo
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {editingId === model.id && (
                    <div className="mt-2 space-y-2 rounded border border-border bg-surface p-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted">Repo</label>
                        <input
                          type="text"
                          value={editRepo}
                          onChange={(e) => setEditRepo(e.target.value)}
                          placeholder="org/repo"
                          className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted">Revision</label>
                        <input
                          type="text"
                          value={editRevision}
                          onChange={(e) => setEditRevision(e.target.value)}
                          placeholder="main"
                          className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                          className="rounded border border-border bg-surface-elevated px-2.5 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(model)}
                          disabled={editSaving}
                          className="rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                        >
                          {editSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  )}
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
              onChange={(e) => {
                const repo = e.target.value;
                const derived = deriveIdFromRepo(repo);
                setForm((prev) => ({
                  ...prev,
                  repo,
                  // Only fill fields the operator hasn't already typed into —
                  // never stomp a manual id/label/subfolder while they're
                  // still refining the repo string.
                  id: !prev.id.trim() && derived ? derived : prev.id,
                  label: !prev.label.trim() && derived ? derived : prev.label,
                  subfolder: !prev.subfolder.trim() && derived ? derived : prev.subfolder,
                }));
              }}
              placeholder="org/repo — id, label, and subfolder auto-fill from this if left blank"
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
            <label className="mb-1 block text-xs text-muted">Include pattern(s) (optional)</label>
            <input
              type="text"
              value={form.includePattern}
              onChange={(e) => setForm((prev) => ({ ...prev, includePattern: e.target.value }))}
              placeholder="space-separated globs, e.g. model-0004[78]-of-00048.safetensors *.index.json"
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
        </div>

        {error && (
          <div className="mt-3 shrink-0 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="mt-3 flex shrink-0 justify-end gap-2 border-t border-border pt-3">
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
