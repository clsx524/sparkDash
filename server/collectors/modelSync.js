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
 * The sync command always runs FROM the target host, pulling FROM the
 * registry (optionally tunneled through a relay via SSH ProxyJump) — never
 * the reverse. This is a hard-won, fleet-proven constraint: some networks
 * only work in one connection direction (see the session history that led
 * here), so initiating from the target is the only assumption-free choice.
 */
import { sshExecDirect } from "./ssh.js";

const PREFLIGHT_TIMEOUT_MS = 15_000;
const DEFAULT_SYNC_TIMEOUT_MS = 21_600_000;

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function joinRemotePath(dir, subfolder) {
  return `${String(dir).replace(/\/+$/, "")}/${String(subfolder).replace(/^\/+/, "")}`;
}

/**
 * @param {import("./ModelRegistry.js").ModelRegistry} modelRegistry
 * @param {import("../sparks/SparkRegistry.js").SparkRegistry} sparkRegistry
 * @param {object} model - tracked model entry (id, subfolder, manifest, ...)
 * @param {object} targetSpark - full SparkConfig (with secrets) of the host to sync onto
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{destDir: string}>}
 */
export async function syncModelToSpark(modelRegistry, sparkRegistry, model, targetSpark, options = {}) {
  const registryHost = modelRegistry.registryHost();
  if (!registryHost) throw new Error("No Model Registry host configured");
  const registryConfig = modelRegistry.getRegistryConfig();
  if (!registryConfig.directory) throw new Error("No Model Registry directory configured");
  if (!targetSpark.modelFolder) {
    throw new Error(`${targetSpark.id} has no model folder configured (Edit host → Model folder)`);
  }

  const sourceDir = joinRemotePath(registryConfig.directory, model.subfolder);
  const destDir = joinRemotePath(targetSpark.modelFolder, model.subfolder);

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

  const rsyncCmd =
    `mkdir -p ${shQuote(destDir)} && ` +
    `rsync -a -e ${shQuote(rsyncSsh)} ` +
    `${shQuote(`${registryHost.ssh.user}@${registryAddr}:${sourceDir}/`)} ` +
    `${shQuote(destDir + "/")}`;

  await sshExecDirect(targetSpark, rsyncCmd, {
    timeoutMs: options.timeoutMs || DEFAULT_SYNC_TIMEOUT_MS,
    noBatch: true,
  });

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
