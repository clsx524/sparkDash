/**
 * modelSync — pulls one tracked model from the Model Registry host onto a
 * target host's own model folder, then verifies the copy's SHA256 against
 * the registry's manifest.
 *
 * PREREQUISITE this module does not and cannot provision: the target host
 * must already have its own SSH trust established to the registry host (and,
 * for a relay route, to the relay host too). This mirrors how any two hosts
 * in this fleet get mutual SSH trust today — it's an operator/ansible-level
 * concern, not something sparkDash sets up on the fly. A missing-trust
 * failure surfaces as a clear, actionable error rather than a bare rsync
 * failure.
 *
 * If the target already has a verified-correct copy (manifest checksums all
 * match), the sync is skipped entirely — including the registry-host
 * reachability preflight below. Registry reachability should never gate a
 * sync that has nothing left to do; hit live 2026-09-15 when spark1 had
 * deepseek-v41-flash-exl3's weights already present and correct but the
 * registry host (beast) was temporarily unreachable, and recipe activation
 * failed on the preflight alone. Only trustworthy with a manifest to check
 * against — no manifest means "already there" can't be told apart from
 * "silently incomplete", so that case still requires a real sync.
 *
 * The sync command always runs FROM the target host, pulling FROM the
 * registry (optionally tunneled through a relay via SSH ProxyJump) — never
 * the reverse. This is a hard-won, fleet-proven constraint: some networks
 * only work in one connection direction (see the session history that led
 * here), so initiating from the target is the only assumption-free choice.
 *
 * Transfer is sharded across up to MAX_SYNC_SHARDS parallel rsync streams
 * (each handling a disjoint subset of the model's files) instead of one
 * single-stream rsync, using a hardware-accelerated cipher
 * (aes128-gcm@openssh.com — every DGX Spark's ARM crypto extensions and any
 * modern x86 host's AES-NI both accelerate it). A single SSH stream tops out
 * around 550-700MB/s even on a 10GbE link because encryption is single-core;
 * splitting file-level work across parallel connections spreads that load
 * across cores and gets close to line rate (~1GB/s+ measured on this fleet's
 * spark1<->beast 10GbE P2P link). Each shard connection explicitly opts out
 * of sparkDash's shared SSH multiplexing (`multiplex: false`) — piling many
 * concurrent sessions onto one multiplexed connection either serializes
 * their crypto through that connection's single process or trips the
 * remote sshd's MaxSessions limit outright, silently defeating the
 * parallelism (both were hit and diagnosed live before landing this
 * shard count). Falls back to a plain whole-directory rsync when the file
 * listing fails (e.g. an unreachable host, still surfaced by the preflight
 * check below in practice) or the model has too few files to shard.
 */
import { sshExecDirect, copyToSpark } from "./ssh.js";

const PREFLIGHT_TIMEOUT_MS = 15_000;
const DEFAULT_SYNC_TIMEOUT_MS = 21_600_000;
const LIST_FILES_TIMEOUT_MS = 30_000;
const FAST_CIPHER = "aes128-gcm@openssh.com";
/** Stays under a default sshd's MaxStartups (~10 concurrent new connections
 *  before probabilistic rejection) on both the target and registry host. */
const MAX_SYNC_SHARDS = 6;

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Like shQuote, but a leading "~" or "~/" is left unquoted so the remote
 * shell still expands it to that user's home directory — a value wholly
 * inside single quotes never undergoes tilde expansion, which would
 * otherwise turn the default "~/.cache/huggingface" model folder into a
 * literal directory named "~" on the target.
 */
export function shQuotePath(value) {
  const str = String(value);
  if (str === "~") return "~";
  if (str.startsWith("~/")) return "~/" + shQuote(str.slice(2));
  return shQuote(str);
}

export function joinRemotePath(dir, subfolder) {
  return `${String(dir).replace(/\/+$/, "")}/${String(subfolder).replace(/^\/+/, "")}`;
}

/**
 * Round-robin a file list into up to maxShards non-empty groups. Never
 * produces more shards than files, and never an empty shard.
 * @param {string[]} files
 * @param {number} maxShards
 * @returns {string[][]}
 */
export function shardFiles(files, maxShards) {
  const n = Math.max(1, Math.min(maxShards, files.length));
  const shards = Array.from({ length: n }, () => []);
  files.forEach((f, i) => shards[i % n].push(f));
  return shards.filter((s) => s.length > 0);
}

/**
 * List every real file (symlinks dereferenced) under `dir` on `host`, as
 * paths relative to `dir`. Empty array on any failure — the caller falls
 * back to a plain whole-directory rsync rather than failing the sync
 * outright over a listing hiccup.
 * @returns {Promise<string[]>}
 */
async function listSyncFiles(host, dir) {
  try {
    const out = await sshExecDirect(
      host,
      `cd ${shQuotePath(dir)} && find -L . -type f | sed 's|^\\./||'`,
      { timeoutMs: LIST_FILES_TIMEOUT_MS, noBatch: true }
    );
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}


/**
 * @param {import("./ModelRegistry.js").ModelRegistry} modelRegistry
 * @param {import("../sparks/SparkRegistry.js").SparkRegistry} sparkRegistry
 * @param {object} model - tracked model entry (id, subfolder, manifest, ...)
 * @param {object} targetSpark - full SparkConfig (with secrets) of the host to sync onto
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{destDir: string, skipped?: boolean}>}
 */
export async function syncModelToSpark(modelRegistry, sparkRegistry, model, targetSpark, options = {}) {
  const registryHost = modelRegistry.registryHost();
  if (!registryHost) throw new Error("No Model Registry host configured");
  const registryConfig = modelRegistry.getRegistryConfig();
  if (!registryConfig.directory) throw new Error("No Model Registry directory configured");
  // The Model Registry host already holds the canonical files at
  // registryConfig.directory — "syncing" a model onto itself is a no-op by
  // definition. Skip the modelFolder requirement, route selection, and
  // rsync entirely; just confirm what's already there is still intact.
  if (targetSpark.id === registryHost.id) {
    const destDir = joinRemotePath(registryConfig.directory, model.subfolder);
    if (Array.isArray(model.manifest) && model.manifest.length > 0) {
      const mismatches = await modelRegistry.verifyFilesOnHost(targetSpark, destDir, model.manifest);
      if (mismatches.length > 0) {
        throw new Error(
          `Checksum verification failed on Model Registry host ${targetSpark.id} for ${mismatches.length} file(s): ` +
            `${mismatches.slice(0, 5).join(", ")}${mismatches.length > 5 ? ", …" : ""}`
        );
      }
    }
    return { destDir };
  }
  if (!targetSpark.modelFolder) {
    throw new Error(`${targetSpark.id} has no model folder configured (Edit host → Model folder)`);
  }

  const sourceDir = joinRemotePath(registryConfig.directory, model.subfolder);
  const destDir = joinRemotePath(targetSpark.modelFolder, model.subfolder);

  // Already correct on the target? Skip the registry host entirely — see
  // the module doc comment above for why this must come before the
  // reachability preflight, not after it.
  if (Array.isArray(model.manifest) && model.manifest.length > 0) {
    const mismatches = await modelRegistry.verifyFilesOnHost(targetSpark, destDir, model.manifest);
    if (mismatches.length === 0) {
      return { destDir, skipped: true };
    }
  }

  const route = targetSpark.modelSyncRoute || { mode: "direct" };
  let proxyJumpArg = "";
  let relay = null;
  if (route.mode === "relay" && route.relayHostId) {
    relay = sparkRegistry.getSpark(route.relayHostId);
    if (!relay) throw new Error(`Relay host ${route.relayHostId} not found`);
    const relayAddr = relay.ssh.host || relay.lanIp;
    if (!relayAddr) throw new Error(`Relay host ${relay.id} has no reachable address configured`);
    proxyJumpArg = ` -J ${shQuote(`${relay.ssh.user}@${relayAddr}`)}`;
  }

  const registryAddr = registryHost.ssh.host || registryHost.lanIp;
  if (!registryAddr) throw new Error(`Model Registry host ${registryHost.id} has no reachable address configured`);
  const rsyncSsh = `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10${proxyJumpArg}`;

  // Preflight: does the target host already trust its way to the registry
  // (through the relay, if any)? Fail with a specific, actionable message
  // rather than a generic rsync error.
  try {
    await sshExecDirect(
      targetSpark,
      `${rsyncSsh} ${shQuote(`${registryHost.ssh.user}@${registryAddr}`)} true`,
      { timeoutMs: PREFLIGHT_TIMEOUT_MS, noBatch: true }
    );
  } catch (err) {
    const via = relay ? ` via relay ${relay.id}` : "";
    throw new Error(
      `${targetSpark.id} cannot reach the Model Registry host ${registryHost.id}${via} over SSH. ` +
        `This host needs its own SSH trust established there first (sparkDash does not provision cross-host SSH keys). ` +
        `Underlying error: ${err.message}`
    );
  }

  // Fast, hardware-accelerated cipher for the actual data-carrying
  // connection(s) — see the module doc comment for the measured impact.
  const fastRsyncSsh = `${rsyncSsh} -c ${FAST_CIPHER}`;
  const remoteSpec = shQuote(`${registryHost.ssh.user}@${registryAddr}:${sourceDir}/`);
  const mkdirCmd = `mkdir -p ${shQuotePath(destDir)}`;
  const syncTimeout = options.timeoutMs || DEFAULT_SYNC_TIMEOUT_MS;

  const files = await listSyncFiles(registryHost, sourceDir);
  const shards = shardFiles(files, MAX_SYNC_SHARDS);

  if (shards.length <= 1) {
    // Too few files to shard (or listing failed) — one plain whole-directory
    // rsync still benefits from the fast cipher even without parallelism.
    await sshExecDirect(
      targetSpark,
      `${mkdirCmd} && rsync -aL -e ${shQuote(fastRsyncSsh)} ${remoteSpec} ${shQuotePath(destDir + "/")}`,
      { timeoutMs: syncTimeout, noBatch: true, multiplex: false }
    );
  } else {
    await sshExecDirect(targetSpark, mkdirCmd, { timeoutMs: PREFLIGHT_TIMEOUT_MS, noBatch: true });
    const listPaths = shards.map((_, idx) => `/tmp/sparkdash-modelsync-${model.id}-${idx}.list`);
    try {
      await Promise.all(
        shards.map((shard, idx) => copyToSpark(targetSpark, shard.join("\n") + "\n", listPaths[idx]))
      );
      // Each shard opts out of sparkDash's shared multiplexed connection
      // (see the module doc comment) so the N streams actually parallelize
      // instead of colliding on one connection's session cap or crypto core.
      await Promise.all(
        shards.map((_, idx) =>
          sshExecDirect(
            targetSpark,
            `rsync -aL --files-from=${shQuotePath(listPaths[idx])} -e ${shQuote(fastRsyncSsh)} ${remoteSpec} ${shQuotePath(destDir + "/")}`,
            { timeoutMs: syncTimeout, noBatch: true, multiplex: false }
          )
        )
      );
    } finally {
      const cleanupList = listPaths.map((p) => shQuotePath(p)).join(" ");
      await sshExecDirect(targetSpark, `rm -f -- ${cleanupList}`, {
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
        noBatch: true,
      }).catch(() => {}); // best-effort; leftover list files are harmless
    }
  }

  if (Array.isArray(model.manifest) && model.manifest.length > 0) {
    const mismatches = await modelRegistry.verifyFilesOnHost(targetSpark, destDir, model.manifest);
    if (mismatches.length > 0) {
      throw new Error(
        `Post-copy checksum verification failed on ${targetSpark.id} for ${mismatches.length} file(s): ` +
          `${mismatches.slice(0, 5).join(", ")}${mismatches.length > 5 ? ", …" : ""}`
      );
    }
  }

  return { destDir };
}
