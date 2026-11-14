/**
 * Path safety for Model Registry and model-sync operations.
 *
 * `subfolder` is a relative path under the registry directory or a target's
 * model folder. `modelFolder` is an operator-configured root (absolute or
 * `~`-relative). Both are interpolated into remote shell commands and used as
 * rsync/rm destinations, so neither may escape its configured root.
 */

const CONTROL_RE = /[\0\r\n]/;

/** Validate a model subfolder: relative, no `..` segment, no control characters. */
export function assertSafeSubfolder(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("subfolder is required");
  }
  const subfolder = value.trim();
  if (subfolder.startsWith("/") || subfolder.startsWith("\\")) {
    throw new Error("subfolder must be relative");
  }
  if (CONTROL_RE.test(subfolder)) {
    throw new Error("subfolder contains control characters");
  }
  if (subfolder.split("/").some((segment) => segment === "..")) {
    throw new Error("subfolder must not contain '..'");
  }
  return subfolder;
}

/** Validate a model folder root: absolute or `~`-relative, no `..` segment. */
export function assertSafeModelFolder(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("model folder is required");
  }
  const folder = value.trim();
  if (CONTROL_RE.test(folder)) {
    throw new Error("model folder contains control characters");
  }
  if (folder.split("/").some((segment) => segment === "..")) {
    throw new Error("model folder must not contain '..'");
  }
  return folder;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Validate a Hugging Face repo id: exactly `owner/name`, no path or query syntax. */
export function assertSafeRepo(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("repo is required");
  }
  const repo = value.trim();
  if (!REPO_RE.test(repo)) {
    throw new Error("repo must be in owner/name form");
  }
  return repo;
}
