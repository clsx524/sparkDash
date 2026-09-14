/**
 * ModelRegistry — a generic, fleet-agnostic model download/verification tracker.
 *
 * Deliberately knows nothing about any specific host, model, or directory layout.
 * Which host holds the canonical files and what directory is entered by the
 * operator through the UI. The tracked model *list*, however, is not purely
 * hand-typed: whenever the registry host/directory is set or changed (and on
 * demand via rescan), reconcileWithDisk() scans the directory's first-level
 * subfolders and auto-tracks any that aren't already tracked (matched by
 * subfolder name) — so files already sitting there under an old convention,
 * or added by hand outside sparkDash, show up without the operator having to
 * retype every subfolder name. A discovered entry has no known Hugging Face
 * repo (repo: null) since that can't be inferred from a directory name alone
 * — download/re-verify stay unavailable for it until the operator edits it
 * in to add one. Reconciliation only ever adds; it never removes a tracked
 * entry just because its folder is briefly missing (a live probe already
 * reports that — see probeStatus/statuses).
 *
 * Two files back this:
 *   - config/model-registry.json — { hostId, directory }: which tracked host
 *     (any host in SparkRegistry — Spark or otherwise) holds the canonical
 *     model files, and where.
 *   - config/models.json — the tracked model list: operator-declared entries
 *     (via Add model, always with a repo) plus reconciled discoveries (repo
 *     null until edited in).
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
// A multi-hundred-GB download can run for hours with the job's phase never changing
// ("running" the whole time) -- without this, the UI has nothing to show moving.
const DOWNLOAD_PROGRESS_POLL_MS = 5_000;

/** Single-quote a value for safe embedding in a remote bash -c command. */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Like shQuote, but a leading "~" or "~/" is left unquoted so the remote
 * shell still expands it to that user's home directory — needed because
 * the default model folder ("~/.cache/huggingface") and any operator-typed
 * registry directory may start with a tilde, and single-quoting it whole
 * would turn that into a literal directory named "~" instead.
 */
export function shQuotePath(value) {
  const str = String(value);
  if (str === "~") return "~";
  if (str.startsWith("~/")) return "~/" + shQuote(str.slice(2));
  return shQuote(str);
}

/** Join a registry directory + model subfolder without doubling slashes. */
function joinRemotePath(dir, subfolder) {
  return `${String(dir).replace(/\/+$/, "")}/${String(subfolder).replace(/^\/+/, "")}`;
}

/**
 * Split a tracked model's stored includePattern into one or more hf-cli --include glob
 * patterns (whitespace-separated). A single glob cannot always express what one model
 * needs to fetch — e.g. Engram's two specific shards (47 of 48, 48 of 48) plus its index
 * file share no common wildcard with the other 46 shards of the same repo they must be
 * excluded from. hf download itself supports passing --include multiple times for exactly
 * this; this just lets one tracked model's single stored field express that instead of
 * requiring a separate tracked model per file.
 * @param {string | null | undefined} includePattern
 * @returns {string[]}
 */
export function splitIncludePatterns(includePattern) {
  if (!includePattern) return [];
  return includePattern.split(/\s+/).filter(Boolean);
}


/** Convert one fnmatch-style glob (the flavor hf download --include accepts: *, ?,
 *  [seq], [!seq]) into a RegExp anchored to a full relative-path match. */
function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      pattern += ".*";
    } else if (c === "?") {
      pattern += ".";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (glob[j] === "!") {
        cls += "^";
        j++;
      }
      for (; j < glob.length && glob[j] !== "]"; j++) cls += glob[j];
      cls += "]";
      pattern += cls;
      i = j;
    } else {
      pattern += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Filter a full-repo manifest (from fetchHfManifest) down to only the entries an
 * includePattern actually selected. Needed because Engram-style partial fetches
 * deliberately pull only a few files out of a much larger repo (e.g. 2 of 48 shards) —
 * verifying the untouched 46 against a host that never fetched them would report every one
 * as a false-positive "missing" mismatch. No includePattern set (a full-repo model) leaves
 * the manifest untouched.
 * @param {Array<{path: string, sha256: string}>} manifest
 * @param {string | null | undefined} includePattern
 */
export function filterManifestToIncluded(manifest, includePattern) {
  const patterns = splitIncludePatterns(includePattern);
  if (patterns.length === 0) return manifest;
  const regexes = patterns.map(globToRegExp);
  return manifest.filter((entry) => regexes.some((re) => re.test(entry.path)));
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
      // Snapshot of includePattern at the moment it was last actually verified against disk —
      // compared to the live includePattern to tell "downloaded and covers everything this
      // model is now supposed to include" from "includePattern was edited since, may be
      // missing newly-added files" (e.g. config.json added to an existing partial fetch).
      // null here (never verified) always reads as stale, same as a mismatch.
      includePatternAtVerify: null,
    };
    this._models = [...this._models, model];
    this._saveModels();
    return { ...model };
  }

  /**
   * Edit an existing tracked model's declared metadata — label, source repo,
   * revision, includePattern. Does not touch id/subfolder (changing either
   * would orphan the directory/manifest this entry already points at) or
   * manifest/verifiedAt (those are only ever set by a real download/verify).
   * This is how an auto-discovered entry (repo: null) gets a real source
   * repo attached, and how a typo in an existing one gets fixed.
   * @param {{label?: string, repo?: string, revision?: string, includePattern?: string|null}} patch
   */
  updateModel(id, patch) {
    const model = this.getModel(id);
    if (!model) throw new Error(`Model ${id} is not tracked`);
    const next = { ...model };
    if (patch.label !== undefined) {
      next.label = typeof patch.label === "string" && patch.label.trim() ? patch.label.trim() : id;
    }
    if (patch.repo !== undefined) {
      const repo = typeof patch.repo === "string" ? patch.repo.trim() : "";
      next.repo = repo || null;
    }
    if (patch.revision !== undefined) {
      const revision = typeof patch.revision === "string" ? patch.revision.trim() : "";
      next.revision = revision || "main";
    }
    if (patch.includePattern !== undefined) {
      const includePattern = typeof patch.includePattern === "string" ? patch.includePattern.trim() : "";
      next.includePattern = includePattern || null;
    }
    this._models = this._models.map((m) => (m.id === id ? next : m));
    this._saveModels();
    return { ...next };
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

  // ─── Disk reconciliation (scan + auto-track new folders) ─────────────
  /**
   * List first-level subdirectory names already present under the registry
   * directory on the registry host. Internal to reconcileWithDisk(); throws
   * (does not swallow) on a real failure, same as any other
   * operator-triggered action in this class.
   * @returns {Promise<string[]>}
   */
  async listRegistryDirectories() {
    const host = this.registryHost();
    if (!host) throw new Error("No Model Registry host configured");
    if (!this._registryConfig.directory) throw new Error("No Model Registry directory configured");
    const dir = this._registryConfig.directory;
    const out = await sshExecDirect(
      host,
      `find ${shQuotePath(dir)} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | xargs -n1 basename 2>/dev/null | sort`,
      { timeoutMs: PROBE_TIMEOUT_MS, noBatch: true }
    );
    return out ? out.split("\n").filter(Boolean) : [];
  }

  /** Sanitize a disk folder name into a valid, unique model id; null if nothing usable remains. */
  _uniqueDiscoveredId(name) {
    const base = String(name).trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128);
    if (!base) return null;
    if (!this.getModel(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = `-${n}`;
      const candidate = base.slice(0, 128 - suffix.length) + suffix;
      if (!this.getModel(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Pure reconciliation core: given a list of on-disk subfolder names,
   * auto-track any not already tracked (matched by subfolder name). A
   * discovered entry has repo: null — a directory name alone doesn't tell
   * us its Hugging Face source, so download/re-verify stay unavailable for
   * it until the operator edits one in (updateModel). Never removes or
   * alters an already-tracked entry; only ever adds. Separated from
   * reconcileWithDisk so this logic is testable without SSH.
   * @param {string[]} names
   * @returns {{discovered: string[]}} ids of newly tracked models
   */
  reconcileNames(names) {
    const trackedSubfolders = new Set(this._models.map((m) => m.subfolder));
    const discovered = [];
    for (const name of names) {
      if (trackedSubfolders.has(name)) continue;
      const id = this._uniqueDiscoveredId(name);
      if (!id) continue; // nothing usable left after sanitizing — skip rather than guess
      this._models = [
        ...this._models,
        {
          id,
          label: name,
          subfolder: name,
          repo: null,
          revision: "main",
          includePattern: null,
          manifest: null,
          verifiedAt: null,
          includePatternAtVerify: null,
        },
      ];
      trackedSubfolders.add(name);
      discovered.push(id);
    }
    if (discovered.length > 0) this._saveModels();
    return { discovered };
  }

  /**
   * Scan the registry directory (live SSH) and reconcile it against the
   * tracked list — see reconcileNames for the actual matching/discovery
   * logic.
   * @returns {Promise<{discovered: string[]}>}
   */
  async reconcileWithDisk() {
    const names = await this.listRegistryDirectories();
    return this.reconcileNames(names);
  }

  // ─── Hugging Face auth on the registry host (never stored here) ──────
  // The token itself lives only on the registry host, in hf-cli's own auth file
  // (~/.cache/huggingface/token on whichever account runs `hf download` there) — never
  // duplicated into this app's own config/secrets store. Matches this class's existing
  // philosophy (probeStatus above, RecipeRegistry's active-state probe): state that can
  // silently drift (a token rotated or revoked by hand outside this UI) must be read live,
  // not trusted from something we wrote once and cached.

  /**
   * Live-probe whether the registry host currently has a working Hugging Face login —
   * distinct from "no login set" (hasToken: false, error: null) vs a real probe failure
   * (hasToken: false, error: message) the same way probeStatus separates "not downloaded"
   * from "couldn't check".
   * @returns {Promise<{hasToken: boolean, username: string|null, error: string|null}>}
   */
  async probeHfToken() {
    const host = this.registryHost();
    if (!host) return { hasToken: false, username: null, error: "No Model Registry host configured" };
    try {
      // --format json: `hf auth whoami`'s default output is rich/ANSI-colored
      // (ansi escape codes + a multi-line human table), meant for a terminal, not for a
      // caller parsing the result -- json gives a stable, colorless {"user": "...", ...}.
      const out = await sshExecDirect(host, "hf auth whoami --format json", {
        timeoutMs: PROBE_TIMEOUT_MS,
        noBatch: true,
      });
      const parsed = JSON.parse(out);
      const username = typeof parsed.user === "string" ? parsed.user : null;
      return { hasToken: Boolean(username), username, error: null };
    } catch (err) {
      if (/not logged in/i.test(err.message)) {
        return { hasToken: false, username: null, error: null };
      }
      return { hasToken: false, username: null, error: err.message };
    }
  }

  /**
   * Set (or replace) the Hugging Face login on the registry host. `hf auth login --token`
   * validates the token against the Hugging Face API itself before persisting it — an
   * invalid token surfaces here as a rejected-login error, never silently saved. Overwrites
   * whatever login (if any) was already there, matching the "paste a new one to update" UI.
   * @param {string} token
   */
  async setHfToken(token) {
    const value = typeof token === "string" ? token.trim() : "";
    if (!value) throw new Error("Token is required");
    const host = this.registryHost();
    if (!host) throw new Error("No Model Registry host configured");
    await sshExecDirect(host, `hf auth login --token ${shQuote(value)} --force`, {
      timeoutMs: PROBE_TIMEOUT_MS,
      noBatch: true,
    });
  }

  // ─── Live availability probe (never a stored flag) ───────
  /** @returns {Promise<{id: string, available: boolean, sizeBytes: number|null, error: string|null}>} */
  async probeStatus(model) {
    const host = this.registryHost();
    if (!host) {
      return { id: model.id, available: false, sizeBytes: null, error: "No Model Registry host configured" };
    }
    if (!this._registryConfig.directory) {
      return { id: model.id, available: false, sizeBytes: null, error: "No Model Registry directory configured" };
    }
    const dir = joinRemotePath(this._registryConfig.directory, model.subfolder);
    try {
      const out = await sshExecDirect(
        host,
        `if [ -d ${shQuotePath(dir)} ] && [ -n "$(ls -A ${shQuotePath(dir)} 2>/dev/null)" ]; then du -sb ${shQuotePath(dir)} | cut -f1; else echo __NONE__; fi`,
        { timeoutMs: PROBE_TIMEOUT_MS, noBatch: true }
      );
      if (!out || out === "__NONE__") return { id: model.id, available: false, sizeBytes: null, error: null };
      const sizeBytes = parseInt(out, 10);
      return {
        id: model.id,
        available: Number.isFinite(sizeBytes) && sizeBytes > 0,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
        error: null,
      };
    } catch (err) {
      // A real probe failure (SSH unreachable, auth rejected, timed out, ...)
      // is NOT the same thing as "genuinely not downloaded yet" — collapsing
      // both into a bare `available: false` leaves an operator staring at
      // "Not downloaded" with no way to tell a broken connection from an
      // empty directory. Surface the underlying error instead.
      return { id: model.id, available: false, sizeBytes: null, error: err.message };
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
        `cd ${shQuotePath(dir)} && sha256sum -- ${fileArgs} 2>&1`,
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
    this._setJob(modelId, {
      kind: "download",
      phase: "running",
      message: "Downloading from Hugging Face",
      bytesDownloaded: null,
      bytesPerSecond: null,
      error: undefined,
    });
    let progressTimer;
    try {
      const model = this.getModel(modelId);
      if (!model) throw new Error(`Model ${modelId} is not tracked`);
      if (!model.repo) {
        throw new Error(`${modelId} has no source repo set — edit it to add one before downloading`);
      }
      const host = this.registryHost();
      if (!host) throw new Error("No Model Registry host configured");
      if (!this._registryConfig.directory) throw new Error("No Model Registry directory configured");

      const dir = joinRemotePath(this._registryConfig.directory, model.subfolder);
      const includeArgs = splitIncludePatterns(model.includePattern)
        .map((pattern) => ` --include ${shQuote(pattern)}`)
        .join("");
      // Same acceleration this fleet's recipe download.sh scripts always set by hand:
      // HF_HUB_ENABLE_HF_TRANSFER opts into the Rust transfer backend (only takes effect
      // if the hf_transfer extra is installed — silently ignored otherwise, never an
      // error), and --max-workers lets multiple files download concurrently. Confirmed
      // live 2026-09-13: 6.3 MB/s without either, 21.3 MB/s with both, same repo/files.
      const downloadCmd = `HF_HUB_ENABLE_HF_TRANSFER=1 hf download ${shQuote(model.repo)} --revision ${shQuote(model.revision)}${includeArgs} --local-dir ${shQuotePath(dir)} --max-workers 8`;

      // The download command above blocks (over SSH) until the whole transfer finishes —
      // for a multi-hundred-GB fetch that's hours with the job's phase never changing.
      // Poll the destination directory's size on the side so the UI has something moving;
      // best-effort only (du failing here must never abort the real download in progress).
      let lastBytes = 0;
      let lastAt = Date.now();
      progressTimer = setInterval(async () => {
        try {
          const out = await sshExecDirect(host, `du -sb ${shQuotePath(dir)} 2>/dev/null | cut -f1`, {
            timeoutMs: PROBE_TIMEOUT_MS,
            noBatch: true,
          });
          const bytes = parseInt(out, 10);
          if (!Number.isFinite(bytes)) return;
          const now = Date.now();
          const elapsedSec = (now - lastAt) / 1000;
          const bytesPerSecond = elapsedSec > 0 ? Math.max(0, (bytes - lastBytes) / elapsedSec) : null;
          lastBytes = bytes;
          lastAt = now;
          this._setJob(modelId, { bytesDownloaded: bytes, bytesPerSecond });
        } catch {
          // transient poll failure — try again next tick, never surfaced as a job error
        }
      }, DOWNLOAD_PROGRESS_POLL_MS);

      try {
        await sshExecDirect(host, downloadCmd, { timeoutMs: MODEL_DOWNLOAD_TIMEOUT_MS, noBatch: true });
      } finally {
        clearInterval(progressTimer);
      }

      this._setJob(modelId, {
        phase: "verifying",
        message: "Verifying checksums against Hugging Face",
        bytesPerSecond: null,
      });
      const fullManifest = await fetchHfManifest(model.repo, model.revision);
      const manifest = filterManifestToIncluded(fullManifest, model.includePattern);

      const mismatches = await this.verifyFilesOnHost(host, dir, manifest);
      if (mismatches.length > 0) {
        throw new Error(
          `Checksum verification failed for ${mismatches.length} file(s): ${mismatches.slice(0, 5).join(", ")}${mismatches.length > 5 ? ", …" : ""}`
        );
      }

      this._updateModel(modelId, {
        manifest,
        verifiedAt: new Date().toISOString(),
        includePatternAtVerify: model.includePattern,
      });
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
      await sshExecDirect(host, `rm -rf -- ${shQuotePath(dir)}`, { timeoutMs: DELETE_TIMEOUT_MS, noBatch: true });
      this._updateModel(modelId, { manifest: null, verifiedAt: null });
      this._setJob(modelId, { phase: "done", message: "Deleted" });
    } catch (err) {
      this._setJob(modelId, { phase: "failed", error: err.message });
      throw err;
    }
  }
}
