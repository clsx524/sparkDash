import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { registerHooks } from "node:module";

const exec = promisify(execFile);
const rsyncVersion = spawnSync("rsync", ["--version"], { encoding: "utf8" });
const hasGnuRsync = rsyncVersion.status === 0 && !rsyncVersion.stdout.includes("openrsync");
const modelSyncUrl = new URL("../modelSync.js", import.meta.url).href;
const transport = `
  export const sshExec = (...args) => globalThis.modelSyncRsyncExec(...args);
  export const copyToSpark = async (_host, content, destination) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(destination, content);
  };
`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./ssh.js" && context.parentURL === modelSyncUrl) {
      return { url: `data:text/javascript,${encodeURIComponent(transport)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { syncModelToSpark } = await import("../modelSync.js");
hooks.deregister();

// Only SSH is replaced: both rsync endpoints and their shell/path handling are real.
// Different HOME directories catch accidental expansion on the receiving Spark.
for (const directoryKind of ["home", "default", "cache", "absolute"]) {
  for (const fileCount of [1, 3]) {
    test(`rsync copies ${directoryKind} registry paths with ${fileCount === 1 ? "one stream" : "parallel shards"}`,
      { skip: !hasGnuRsync && "GNU rsync (as installed on the Sparks) is required" }, async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-rsync-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const registryHome = path.join(root, "registry-home");
        const targetHome = path.join(root, "target-home");
        const bin = path.join(root, "bin");
        for (const dir of [registryHome, targetHome, bin]) fs.mkdirSync(dir);
        const special = "registry's $(touch INJECTED) files";
        const directory = directoryKind === "home" ? "~" : directoryKind === "default"
          ? "~/.cache/huggingface/registry" : directoryKind === "cache"
          ? `~/.cache/${special}` : path.join(root, special);
        const registryDir = directory === "~" ? registryHome : directory.startsWith("~/")
          ? path.join(registryHome, directory.slice(2)) : directory;
        const subfolder = directoryKind === "default" ? "model-weights" : "model's weights";
        const source = path.join(registryDir, subfolder);
        fs.mkdirSync(source, { recursive: true });
        const files = ["config.json", "nested dir/weights'$(touch INJECTED).bin", "tokenizer.json"].slice(0, fileCount);
        for (const [index, name] of files.entries()) {
          fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
          fs.writeFileSync(path.join(source, name), `checkpoint-file-${index}\n`);
        }
        fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-c|-l|-p) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
cd "$REGISTRY_HOME"
HOME="$REGISTRY_HOME" exec /bin/sh -c "$*"
`, { mode: 0o755 });
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REGISTRY_HOME: registryHome };
        globalThis.modelSyncRsyncExec = async (host, command) => {
          const home = host.id === "registry" ? registryHome : targetHome;
          const result = await exec("sh", ["-c", command], {
            env: { ...env, HOME: home }, cwd: home, timeout: 15_000,
          });
          return result.stdout.trim();
        };
        t.after(() => { delete globalThis.modelSyncRsyncExec; });
        const registry = { id: "registry", ssh: { user: "op", host: "registry.invalid" } };
        const modelRegistry = {
          registryHost: () => registry,
          getRegistryConfig: () => ({ directory }),
        };
        await syncModelToSpark(modelRegistry,
          { id: path.basename(root), subfolder, manifest: null },
          { id: "target", modelFolder: "~/target models" }, { verify: false });
        for (const [index, name] of files.entries()) {
          assert.equal(fs.readFileSync(path.join(targetHome, "target models", subfolder, name), "utf8"),
            `checkpoint-file-${index}\n`);
        }
        for (const home of [root, registryHome, targetHome]) assert.equal(fs.existsSync(path.join(home, "INJECTED")), false);
      });
  }
}

// NFS itself is the transport fixture boundary: findmnt returns a controlled
// kernel-mount record. All subsequent path checks, listing and rsync run in
// real shells against tiny fixture bytes; no mount/sudo or fleet host is used.
function nfsFixture(t, { fileCount = 3, filesystem = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-nfs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mountpoint = path.join(root, "atom's $(touch INJECTED) registry");
  const targetHome = path.join(root, "target-home");
  const subfolder = "model's weights";
  const source = path.join(mountpoint, subfolder);
  const targetFolder = path.join(targetHome, "models");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(targetHome);
  const files = ["config.json", "nested dir/weights'$(touch INJECTED).bin", "tokenizer.json"].slice(0, fileCount);
  const manifest = files.map((name, index) => {
    const bytes = Buffer.from(`NFS checkpoint ${index}\n`);
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), bytes);
    return { path: name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const mount = { path: mountpoint, source: "10.100.30.2:/home/op/.cache/huggingface/registry" };
  const probe = {
    filesystems: [{ target: mountpoint, source: mount.source, fstype: "nfs4", options: "ro,relatime,vers=4.2,proto=tcp,nconnect=8", ...filesystem }],
  };
  const commands = [];
  const output = [];
  let verifies = 0;
  const target = { id: "spark-1", modelFolder: targetFolder };
  const model = { id: path.basename(root), subfolder, manifest };
  const registry = {
    // No registry SSH address is needed by NFS transfers.
    registryHost: () => ({ id: "atom" }),
    getRegistryConfig: () => ({ hostId: "atom", directory: "~/.cache/huggingface/registry", nfsMounts: { "spark-1": mount } }),
    verifyFilesOnHost: async (host, directory, entries) => {
      assert.equal(host, target);
      verifies++;
      return entries.filter((entry) => {
        try {
          return createHash("sha256").update(fs.readFileSync(path.join(directory, entry.path))).digest("hex") !== entry.sha256;
        } catch {
          return true;
        }
      }).map((entry) => entry.path);
    },
  };
  const execute = async (host, command, options = {}) => {
    assert.equal(host.id, target.id, "NFS must never contact the registry host");
    commands.push({ command, options });
    if (command.startsWith("findmnt ")) return JSON.stringify(probe);
    const result = await exec("sh", ["-c", command], {
      env: { ...process.env, HOME: targetHome }, cwd: targetHome,
      timeout: 15_000, signal: options.signal,
    });
    return result.stdout.trim();
  };
  globalThis.modelSyncRsyncExec = execute;
  t.after(() => { delete globalThis.modelSyncRsyncExec; });
  const sync = (options = {}) => syncModelToSpark(registry, model, target, {
    onOutput: (line) => output.push(line), ...options,
  });
  return {
    root, source, mountpoint, mount, targetHome, targetFolder, files, model, target, registry,
    commands, output, probe, execute, sync, verifies: () => verifies,
  };
}

for (const fileCount of [1, 3]) {
  for (const verify of [true, false]) {
    test(`NFS copies actual bytes with ${fileCount} file(s), verify=${verify}`,
      { skip: !hasGnuRsync && "GNU rsync is required" }, async (t) => {
        const h = nfsFixture(t, { fileCount });
        await h.sync({ verify });
        for (const file of h.files) {
          assert.deepEqual(fs.readFileSync(path.join(h.targetFolder, h.model.subfolder, file)),
            fs.readFileSync(path.join(h.source, file)));
        }
        assert.equal(h.verifies(), verify ? 2 : 0);
        assert.equal(fs.existsSync(path.join(h.targetHome, "INJECTED")), false);
      });
  }
}

for (const [label, filesystem] of [
  ["wrong source", { source: "10.100.30.9:/other" }],
  ["local filesystem", { fstype: "ext4" }],
  ["wrong exact mountpoint", { target: "/mnt/parent" }],
  ["writable mount", { options: "rw,vers=4.2" }],
  ["contradictory writable option", { options: "ro,rw,vers=4.2" }],
  ["no read-only option", { options: "vers=4.2" }],
]) {
  test(`NFS refuses ${label} before copying, without SSH fallback`, async (t) => {
    const h = nfsFixture(t, { filesystem });
    await assert.rejects(h.sync(), /NFS.*mount verification failed.*no SSH fallback/);
    assert.equal(fs.existsSync(h.targetFolder), false);
    assert.equal(h.commands.length, 1, "only the mount probe may execute");
  });
}

for (const response of [JSON.stringify({ filesystems: [] }), "not json"]) {
  test(`NFS refuses missing/malformed mount probe ${response}`, async (t) => {
    const h = nfsFixture(t);
    globalThis.modelSyncRsyncExec = async (host, command) => {
      assert.equal(host.id, h.target.id);
      assert.ok(command.startsWith("findmnt "));
      return response;
    };
    await assert.rejects(h.sync(), /mount verification failed.*no SSH fallback/);
    assert.equal(fs.existsSync(h.targetFolder), false);
  });
}

test("NFS refuses failed mount probe without creating the configured mount", async (t) => {
  const h = nfsFixture(t);
  fs.rmSync(h.mountpoint, { recursive: true });
  globalThis.modelSyncRsyncExec = async (host, command) => {
    assert.equal(host.id, h.target.id);
    assert.ok(command.startsWith("findmnt "));
    throw new Error("findmnt: mount not found");
  };
  await assert.rejects(h.sync(), /mount not found.*no SSH fallback/);
  assert.equal(fs.existsSync(h.mountpoint), false);
  assert.equal(fs.existsSync(h.targetFolder), false);
});

for (const subfolder of ["../outside", "nested/../../outside", "/absolute/outside"]) {
  test(`NFS refuses escaping model path ${subfolder}`, async (t) => {
    const h = nfsFixture(t);
    h.model.subfolder = subfolder;
    await assert.rejects(h.sync({ verify: false }), /model path escapes/);
    assert.equal(fs.existsSync(h.targetFolder), false);
    assert.equal(h.commands.length, 0);
  });
}

for (const linkKind of ["model directory", "weight file"]) {
  test(`NFS refuses ${linkKind} symlink escaping the export`, async (t) => {
    const h = nfsFixture(t);
    const outside = path.join(h.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "weight"), "outside export");
    if (linkKind === "model directory") {
      fs.rmSync(h.source, { recursive: true });
      fs.symlinkSync(outside, h.source);
    } else {
      fs.symlinkSync(path.join(outside, "weight"), path.join(h.source, "escaped.bin"));
    }
    await assert.rejects(h.sync({ verify: false }), /source path verification failed[\s\S]*no SSH fallback/);
    assert.equal(fs.existsSync(h.targetFolder), false);
  });
}

test("NFS supports dereferenced blob links that stay inside the export",
  { skip: !hasGnuRsync && "GNU rsync is required" }, async (t) => {
    const h = nfsFixture(t, { fileCount: 1 });
    const blob = path.join(h.mountpoint, "blob");
    fs.writeFileSync(blob, "linked blob bytes");
    fs.symlinkSync("../blob", path.join(h.source, "weights.bin"));
    await h.sync({ verify: false });
    const copied = path.join(h.targetFolder, h.model.subfolder, "weights.bin");
    assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(copied, "utf8"), "linked blob bytes");
  });

for (const verify of [true, false]) {
  test(`NFS verified/present target skips before mount probe, verify=${verify}`, async (t) => {
    const h = nfsFixture(t);
    const destination = path.join(h.targetFolder, h.model.subfolder);
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(h.source, destination, { recursive: true });
    h.probe.filesystems = [];
    const result = await h.sync({ verify });
    assert.equal(result.skipped, true);
    assert.ok(h.commands.every(({ command }) => !command.startsWith("findmnt ")));
    assert.equal(h.verifies(), verify ? 1 : 0);
  });
}

test("NFS explicit sync still fails a post-copy checksum mismatch",
  { skip: !hasGnuRsync && "GNU rsync is required" }, async (t) => {
    const h = nfsFixture(t, { fileCount: 1 });
    h.model.manifest[0].sha256 = "0".repeat(64);
    await assert.rejects(h.sync(), /Post-copy checksum verification failed/);
    assert.equal(h.verifies(), 2);
    assert.equal(fs.readFileSync(path.join(h.targetFolder, h.model.subfolder, h.files[0]), "utf8"), "NFS checkpoint 0\n");
  });

for (const phase of ["mount probe", "transfer"]) {
  test(`NFS cancellation interrupts ${phase} without SSH fallback or post-copy hashing`, async (t) => {
    const h = nfsFixture(t, { fileCount: 1 });
    const controller = new AbortController();
    let entered;
    const running = new Promise((resolve) => { entered = resolve; });
    globalThis.modelSyncRsyncExec = async (host, command, options) => {
      if ((phase === "mount probe" && command.startsWith("findmnt ")) ||
          (phase === "transfer" && command.includes("rsync -aL "))) {
        assert.equal(host.id, h.target.id);
        const waiting = exec("sh", ["-c", "exec sleep 30"], { signal: options.signal });
        entered();
        return waiting;
      }
      return h.execute(host, command, options);
    };
    const syncing = h.sync({ signal: controller.signal });
    const rejected = assert.rejects(syncing, { name: "AbortError" });
    await running;
    controller.abort();
    await rejected;
    assert.equal(h.verifies(), 1, "post-copy verification must not run");
    assert.equal(fs.existsSync(h.targetFolder), false);
  });
}

test("NFS parallel cancellation drains every shard and removes temporary file lists", async (t) => {
  const h = nfsFixture(t);
  const controller = new AbortController();
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  let started = 0;
  let settled = 0;
  globalThis.modelSyncRsyncExec = async (host, command, options) => {
    if (!command.startsWith("rsync -aL ")) return h.execute(host, command, options);
    assert.equal(host.id, h.target.id);
    const waiting = exec("sh", ["-c", "exec sleep 30"], { signal: options.signal });
    if (++started === 3) entered();
    try {
      return await waiting;
    } finally {
      settled++;
    }
  };
  const syncing = h.sync({ signal: controller.signal });
  const rejected = assert.rejects(syncing, { name: "AbortError" });
  await running;
  controller.abort();
  await rejected;
  assert.equal(started, 3);
  assert.equal(settled, 3);
  assert.equal(h.verifies(), 1);
  for (let index = 0; index < 3; index++) {
    assert.equal(fs.existsSync(`/tmp/sparkdash-modelsync-${h.model.id}-${index}.list`), false);
  }
  assert.deepEqual(fs.readdirSync(path.join(h.targetFolder, h.model.subfolder)), []);
});

test("NFS self-sync skips invalid target mapping and transport entirely", async (t) => {
  const h = nfsFixture(t);
  h.registry.registryHost = () => h.target;
  h.probe.filesystems = [];
  const result = await h.sync({ verify: false });
  assert.equal(result.destDir, `~/.cache/huggingface/registry/${h.model.subfolder}`);
  assert.deepEqual(h.commands, []);
});
