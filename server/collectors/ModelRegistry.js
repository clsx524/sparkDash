/**
 * ModelRegistry — a generic, fleet-agnostic model download/verification tracker.
 *
 * Deliberately knows nothing about any specific host, model, or directory layout.
 * Every value here (which host holds the canonical files, what directory, which
 * models are tracked, their download source) is entered by the operator through
 * the UI and persisted as-is — this class never assumes a default path or
 * pre-seeds a model list.
 *
 * Two files back this:
 *   - config/model-registry.json — { hostId, directory }: which tracked host
 *     (any host in SparkRegistry — Spark or otherwise) holds the canonical
 *     model files, and where.
 *   - config/models.json — the user-entered list of tracked models.
 *
 * Availability is always a live SSH probe against the registry host, never a
 * stored flag, matching RecipeRegistry's philosophy: stored state can drift
 * from reality (a folder deleted by hand, a partial download), a live probe
 * cannot.
 */
import fs from "fs";
import {
  MODEL_REGISTRY_JSON_PATH,
  MODELS_JSON_PATH,
  MODEL_DOWNLOAD_TIMEOUT_MS,
} from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import { sshExecDirect } from "./ssh.js";

const PROBE_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 1_800_000; // sha256sum over many large files can be slow
const DELETE_TIMEOUT_MS = 300_000;

/** Single-quote a value for safe embedding in a remote bash -c command. */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Join a registry directory + model subfolder without doubling slashes. */
function joinRemotePath(dir, subfolder) {
  return `${String(dir).replace(/\/+$/, "")}/${String(subfolder).replace(/^\/+/, "")}`;
}

/**
 * Fetch the Hugging Face Hub file tree for repo@revision and return the
 * subset of entries that carry a directly comparable content hash.
 *
 * HF's tree API reports two different things under the name "oid" depending
 * on whether a file is LFS-tracked:
 *   - LFS files: entry.lfs.oid is the sha256 of the raw file content — this
 *     is exactly what a local `sha256sum` produces, directly comparable.
 *   - Plain git-tracked files: entry.oid is a *git blob SHA-1* (hash of
 *     "blob <size>\0<content>", a different algorithm over different bytes)
 *     — NOT comparable to a content sha256 at all.
 * Model weight shards are always LFS-tracked in practice; small text files
 * (config.json, README.md, tokenizer files) are typically plain-tracked and
 * are silently excluded from the manifest rather than compared incorrectly.
 */
export async function fetchHfManifest(repo, revision) {
  const manifest = [];
  let url = `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
  for (let page = 0; page < 100 && url; page++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Hugging Face tree fetch failed for ${repo}@${revision}: HTTP ${res.status}`);
    }
    const entries = await res.json();
    if (!Array.isArray(entries)) break;
    for (const entry of entries) {
      if (entry?.type === "file" && entry?.lfs?.oid && typeof entry.path === "string") {
        manifest.push({ path: entry.path, sha256: String(entry.lfs.oid).toLowerCase() });
      }
    }
    // RFC5988 Link header pagination, same convention HF uses elsewhere.
    const link = res.headers.get("link") || res.headers.get("Link");
    const next = link?.split(",").find((part) => part.includes('rel="next"'));
    const match = next?.match(/<([^>]+)>/);
    url = match ? match[1] : null;
  }
  return manifest;
}

export class ModelRegistry {
  /** @param {import("../sparks/SparkRegistry.js").SparkRegistry} sparkRegistry */
  constructor(sparkRegistry) {
    this.sparkRegistry = sparkRegistry;
    this._registryConfig = { hostId: null, directory: "" };
    this._models = [];
    /** @type {Map<string, {kind: "download"|"delete", phase: string, message?: string, error?: string, updatedAt: string}>} */
    this._jobs = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(MODEL_REGISTRY_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      this._registryConfig = {
        hostId: typeof data.hostId === "string" && data.hostId ? data.hostId : null,
        directory: typeof data.directory === "string" ? data.directory : "",
      };
    } catch {
      // No config yet — stays at the empty default. Never assume a host/path.
    }
    try {
      const raw = fs.readFileSync(MODELS_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      this._models = Array.isArray(data.models) ? data.models : [];
    } catch {
      this._models = [];
    }
  }

  _saveRegistryConfig() {
    atomicWrite(MODEL_REGISTRY_JSON_PATH, JSON.stringify(this._registryConfig, null, 2) + "\n", 0o644);
  }

  _saveModels() {
    atomicWrite(MODELS_JSON_PATH, JSON.stringify({ models: this._models }, null, 2) + "\n", 0o644);
  }

  // ─── Registry host + directory ───────────────────────────
  getRegistryConfig() {
    return { ...this._registryConfig };
  }

  /** @param {{hostId?: string|null, directory?: string}} patch */
  setRegistryConfig({ hostId, directory }) {
    this._registryConfig = {
      hostId: typeof hostId === "string" && hostId.trim() ? hostId.trim() : null,
      directory: typeof directory === "string" ? directory.trim() : "",
    };
    this._saveRegistryConfig();
    return this.getRegistryConfig();
  }

  /** Resolve the registry host's live SparkConfig (with secrets, for SSH), or null. */
  registryHost() {
    if (!this._registryConfig.hostId) return null;
    return this.sparkRegistry.getSpark(this._registryConfig.hostId);
  }

  // ─── Tracked models CRUD ──────────────────────────────────
  all() {
    return this._models.map((m) => ({ ...m }));
  }

  getModel(id) {
    const m = this._models.find((m) => m.id === id);
    return m ? { ...m } : null;
  }

  /** @param {{id: string, label?: string, subfolder: string, repo: string, revision?: string, includePattern?: string|null}} input */
  addModel(input) {
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) {
      throw new Error(
        "Model id: allowed characters are a-z A-Z 0-9 . _ -, length 1-128"
      );
    }
    if (this.getModel(id)) throw new Error(`Model ${id} is already tracked`);
    const subfolder = typeof input?.subfolder === "string" ? input.subfolder.trim() : "";
    if (!subfolder) throw new Error("subfolder is required");
    const repo = typeof input?.repo === "string" ? input.repo.trim() : "";
    if (!repo) throw new Error("repo is required");
    const model = {
      id,
      label: typeof input?.label === "string" && input.label.trim() ? input.label.trim() : id,
      subfolder,
      repo,
      revision: typeof input?.revision === "string" && input.revision.trim() ? input.revision.trim() : "main",
      includePattern:
        typeof input?.includePattern === "string" && input.includePattern.trim()
          ? input.includePattern.trim()
          : null,
      manifest: null,
      verifiedAt: null,
    };
    this._models = [...this._models, model];
    this._saveModels();
    return { ...model };
  }

  /** Remove a tracked model entry (metadata only — does not touch downloaded files). */
  removeModel(id) {
    const idx = this._models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model ${id} is not tracked`);
    const [removed] = this._models.splice(idx, 1);
    this._saveModels();
    this._jobs.delete(id);
    return { ...removed };
  }

  _updateModel(id, patch) {
    const idx = this._models.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this._models[idx] = { ...this._models[idx], ...patch };
    this._saveModels();
  }

  // ─── Job state (download / delete progress) ──────────────
  getJobState(modelId) {
    return this._jobs.get(modelId) || null;
  }

  _setJob(modelId, patch) {
    const prev = this._jobs.get(modelId) || {};
    this._jobs.set(modelId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
  }

  // ─── Live availability probe (never a stored flag) ───────
  /** @returns {Promise<{id: string, available: boolean, sizeBytes: number|null}>} */
  async probeStatus(model) {
    const host = this.registryHost();
    if (!host || !this._registryConfig.directory) {
      return { id: model.id, available: false, sizeBytes: null };
    }
    const dir = joinRemotePath(this._registryConfig.directory, model.subfolder);
    try {
      const out = await sshExecDirect(
        host,
        `if [ -d ${shQuote(dir)} ] && [ -n "$(ls -A ${shQuote(dir)} 2>/dev/null)" ]; then du -sb ${shQuote(dir)} | cut -f1; else echo __NONE__; fi`,
        { timeoutMs: PROBE_TIMEOUT_MS, noBatch: true }
      );
      if (!out || out === "__NONE__") return { id: model.id, available: false, sizeBytes: null };
      const sizeBytes = parseInt(out, 10);
      return {
        id: model.id,
        available: Number.isFinite(sizeBytes) && sizeBytes > 0,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      };
    } catch {
      // Host unreachable, directory missing, etc. — not available, not an error surfaced here.
      return { id: model.id, available: false, sizeBytes: null };
    }
  }

  async statuses() {
    const results = await Promise.all(this._models.map((m) => this.probeStatus(m)));
    return Object.fromEntries(results.map((r) => [r.id, r]));
  }

  // ─── SHA256 verification on an arbitrary host ─────────────
  /**
   * Compute sha256 for every manifest-listed file under `dir` on `host` and
   * report any that are missing or mismatched. Empty result = fully verified.
   * @returns {Promise<string[]>} list of mismatched/missing relative paths
   */
  async verifyFilesOnHost(host, dir, manifest) {
    if (!manifest || manifest.length === 0) return [];
    const fileArgs = manifest.map((m) => shQuote(m.path)).join(" ");
    let out;
    try {
      out = await sshExecDirect(
        host,
        `cd ${shQuote(dir)} && sha256sum -- ${fileArgs} 2>&1`,
        { timeoutMs: VERIFY_TIMEOUT_MS, noBatch: true }
      );
    } catch (err) {
      // sshExecDirect throws on non-zero exit too (e.g. a missing file) — the
      // partial stdout is folded into the error message by sshExecDirect's
      // stderr/message handling, so fall back to treating everything as
      // unverified rather than silently reporting a clean pass.
      return manifest.map((m) => m.path);
    }
    const actual = new Map();
    for (const line of out.split("\n")) {
      const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (match) actual.set(match[2], match[1]);
    }
    return manifest
      .filter((entry) => (actual.get(entry.path) || "").toLowerCase() !== entry.sha256)
      .map((entry) => entry.path);
  }

  // ─── Download (SSH to registry host, then verify) ────────
  async downloadModel(modelId) {
    this._setJob(modelId, { kind: "download", phase: "running", message: "Downloading from Hugging Face", error: undefined });
    try {
      const model = this.getModel(modelId);
      if (!model) throw new Error(`Model ${modelId} is not tracked`);
      const host = this.registryHost();
      if (!host) throw new Error("No Model Registry host configured");
      if (!this._registryConfig.directory) throw new Error("No Model Registry directory configured");

      const dir = joinRemotePath(this._registryConfig.directory, model.subfolder);
      const includeArg = model.includePattern ? ` --include ${shQuote(model.includePattern)}` : "";
      await sshExecDirect(
        host,
        `hf download ${shQuote(model.repo)} --revision ${shQuote(model.revision)}${includeArg} --local-dir ${shQuote(dir)}`,
        { timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS, noBatch: true }
      );

      this._setJob(modelId, { phase: "verifying", message: "Verifying checksums against Hugging Face" });
      const manifest = await fetchHfManifest(model.repo, model.revision);
      const mismatches = await this.verifyFilesOnHost(host, dir, manifest);
      if (mismatches.length > 0) {
        throw new Error(
          `Checksum verification failed for ${mismatches.length} file(s): ${mismatches.slice(0, 5).join(", ")}${mismatches.length > 5 ? ", …" : ""}`
        );
      }

      this._updateModel(modelId, { manifest, verifiedAt: new Date().toISOString() });
      this._setJob(modelId, { phase: "done", message: "Downloaded and verified" });
    } catch (err) {
      this._setJob(modelId, { phase: "failed", error: err.message });
      throw err;
    }
  }

  // ─── Delete downloaded files (registry host only; entry stays tracked) ───
  async deleteModelFiles(modelId) {
    this._setJob(modelId, { kind: "delete", phase: "running", message: "Deleting files", error: undefined });
    try {
      const model = this.getModel(modelId);
      if (!model) throw new Error(`Model ${modelId} is not tracked`);
      const host = this.registryHost();
      if (!host) throw new Error("No Model Registry host configured");
      if (!this._registryConfig.directory) throw new Error("No Model Registry directory configured");

      const dir = joinRemotePath(this._registryConfig.directory, model.subfolder);
      await sshExecDirect(host, `rm -rf -- ${shQuote(dir)}`, { timeoutMs: DELETE_TIMEOUT_MS, noBatch: true });
      this._updateModel(modelId, { manifest: null, verifiedAt: null });
      this._setJob(modelId, { phase: "done", message: "Deleted" });
    } catch (err) {
      this._setJob(modelId, { phase: "failed", error: err.message });
      throw err;
    }
  }
}
