import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
