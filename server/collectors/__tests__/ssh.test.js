import { beforeEach, test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sshCommandSpec, explainSshFailure, sshExec } from "../ssh.js";
import { decodeClixml } from "../windowsMetrics.js";

beforeEach((t) => {
  for (const name of ["SSH_CONTROL_PERSIST_SECONDS", "SSH_CONTROL_PERSIST", "SSH_IDENTITY_FILE"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});

const controlOptions = (spec) => spec.args.filter((arg) => /^Control/.test(arg));
const controlPath = (spec) => spec.args.find((arg) => arg.startsWith("ControlPath="));

const keySpark = {
  id: "s1",
  lanIp: "192.168.1.143",
  ssh: { host: "192.168.1.143", user: "mia", auth: "key" },
};

test("sshCommandSpec: key auth uses BatchMode and destination after --", () => {
  const spec = sshCommandSpec(keySpark, { remoteArgv: ["echo ok"] });
  assert.equal(spec.file, "ssh");
  assert.equal(spec.targetHost, "192.168.1.143");
  assert.ok(spec.args.includes("BatchMode=yes"));
  const dash = spec.args.indexOf("--");
  assert.ok(dash >= 0);
  assert.equal(spec.args[dash + 1], "mia@192.168.1.143");
  assert.equal(spec.args[dash + 2], "echo ok");
  assert.equal(spec.env.SSHPASS, undefined);
});

test("sshCommandSpec: extraSshArgs land before destination (tunnel flags)", () => {
  const spec = sshCommandSpec(keySpark, {
    extraSshArgs: ["-N", "-L", "127.0.0.1:9:127.0.0.1:8888"],
  });
  const dash = spec.args.indexOf("--");
  const n = spec.args.indexOf("-N");
  const l = spec.args.indexOf("-L");
  assert.ok(n >= 0 && n < dash);
  assert.ok(l >= 0 && l < dash);
  assert.equal(spec.args[l + 1], "127.0.0.1:9:127.0.0.1:8888");
  assert.equal(spec.args[dash + 1], "mia@192.168.1.143");
  assert.equal(spec.args.length, dash + 2);
});

test("sshCommandSpec: missing user throws", () => {
  assert.throws(
    () => sshCommandSpec({ id: "s", lanIp: "192.168.1.1", ssh: { auth: "key" } }),
    /SSH config missing/
  );
});

test("sshCommandSpec: commands use the private socket and persistence from their readiness config", () => {
  const spec = sshCommandSpec(keySpark, { remoteArgv: ["cat /proc/uptime"] });
  const dash = spec.args.indexOf("--");
  const master = spec.args.indexOf("ControlMaster=auto");
  const controlPath = spec.args.find((a) => a.startsWith("ControlPath="));
  const persist = spec.args.find((a) => a.startsWith("ControlPersist="));
  assert.ok(master >= 0 && master < dash);
  // Include OpenSSH's temporary socket suffix and the terminating NUL in
  // macOS's 104-byte limit. A long per-user TMPDIR must not affect this path.
  const cpValue = controlPath?.slice("ControlPath=".length);
  assert.ok(cpValue && cpValue.startsWith("/tmp/sparkdash-"), `controlPath: ${controlPath}`);
  assert.ok(!cpValue.includes("%"));
  assert.ok(Buffer.byteLength(cpValue) + 18 <= 104, `control path too long: ${cpValue.length}`);
  assert.equal(fs.statSync(path.dirname(cpValue)).mode & 0o777, 0o700);
  assert.equal(persist, "ControlPersist=60");
  assert.deepEqual(controlOptions(spec), spec.multiplex.args.filter((arg) => /^Control/.test(arg)));
  const next = sshCommandSpec(keySpark, { remoteArgv: ["cat /proc/meminfo"] });
  assert.deepEqual(controlOptions(next), controlOptions(spec));
});

test("sshCommandSpec: SSH port defaults to 22 and a custom port isolates the master", () => {
  const def = sshCommandSpec(keySpark, { remoteArgv: ["echo ok"] });
  const custom = sshCommandSpec(
    { ...keySpark, ssh: { ...keySpark.ssh, port: 2222 } },
    { remoteArgv: ["echo ok"] }
  );
  const portArg = (spec) => {
    const dash = spec.args.indexOf("--");
    const p = spec.args.indexOf("-p");
    assert.ok(p >= 0 && p < dash);
    return spec.args[p + 1];
  };
  assert.equal(portArg(def), "22");
  assert.equal(portArg(custom), "2222");
  assert.equal(custom.sshPort, 2222);
  const controlPath = (spec) => spec.args.find((arg) => arg.startsWith("ControlPath="));
  assert.notEqual(controlPath(def), controlPath(custom));
});

test("sshCommandSpec: multiplex:false opts out (tunnels own their connection)", () => {
  const spec = sshCommandSpec(keySpark, { multiplex: false, extraSshArgs: ["-N"] });
  assert.ok(spec.args.includes("ControlMaster=no"));
  assert.ok(spec.args.includes("ControlPath=none"));
  assert.ok(!spec.args.includes("ControlMaster=auto"));
  assert.equal(spec.multiplex, null);
});

test("sshCommandSpec: documented zero persistence disables both reuse and the readiness probe", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "0";
  process.env.SSH_CONTROL_PERSIST = "300";
  const spec = sshCommandSpec(keySpark);
  assert.deepEqual(controlOptions(spec), ["ControlMaster=no", "ControlPath=none"]);
  assert.equal(spec.multiplex, null);
});

test("sshCommandSpec: configured persistence reaches the actual SSH command", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "120";
  process.env.SSH_CONTROL_PERSIST = "300";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=120"));
  assert.equal(spec.multiplex.persistSeconds, 120);
});

test("sshCommandSpec: legacy persistence is a fallback for the documented setting", () => {
  process.env.SSH_CONTROL_PERSIST = "180";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=180"));
  assert.equal(spec.multiplex.persistSeconds, 180);
});

test("sshCommandSpec: persistence bounds apply to the command as well as readiness", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "99999";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=3600"));
  assert.equal(spec.multiplex.persistSeconds, 3600);
  process.env.SSH_CONTROL_PERSIST_SECONDS = "invalid";
  assert.ok(sshCommandSpec(keySpark).args.includes("ControlPersist=60"));
});

test("sshCommandSpec: changing the key identity changes the socket passed to SSH", () => {
  process.env.SSH_IDENTITY_FILE = "/example/first-key";
  const first = sshCommandSpec(keySpark);
  process.env.SSH_IDENTITY_FILE = "/example/second-key";
  const second = sshCommandSpec(keySpark);
  assert.notEqual(controlPath(first), controlPath(second));
  assert.ok(first.args.includes("/example/first-key"));
  assert.ok(second.args.includes("/example/second-key"));
});

test("sshCommandSpec: password changes select a different socket without exposing the password", (t) => {
  const existsSync = fs.existsSync;
  const statSync = fs.statSync;
  t.mock.method(fs, "existsSync", (p) => p === "/usr/bin/sshpass" || existsSync(p));
  t.mock.method(fs, "statSync", (p) => p === "/usr/bin/sshpass" ? { isFile: () => true } : statSync(p));
  const spark = { ...keySpark, ssh: { ...keySpark.ssh, auth: "pass", password: "test-password-one" } };
  const first = sshCommandSpec(spark);
  const second = sshCommandSpec({ ...spark, ssh: { ...spark.ssh, password: "test-password-two" } });
  assert.equal(first.file, "sshpass");
  assert.equal(first.env.SSHPASS, "test-password-one");
  assert.equal(second.env.SSHPASS, "test-password-two");
  assert.notEqual(controlPath(first), controlPath(second));
  assert.ok(!first.args.join(" ").includes("test-password-one"));
  assert.ok(!second.args.join(" ").includes("test-password-two"));
});

test("sshCommandSpec: different records and authentication modes do not share a socket", (t) => {
  const existsSync = fs.existsSync;
  const statSync = fs.statSync;
  t.mock.method(fs, "existsSync", (p) => p === "/usr/bin/sshpass" || existsSync(p));
  t.mock.method(fs, "statSync", (p) => p === "/usr/bin/sshpass" ? { isFile: () => true } : statSync(p));
  const key = sshCommandSpec(keySpark);
  const otherRecord = sshCommandSpec({ ...keySpark, id: "other-record" });
  const password = sshCommandSpec({ ...keySpark, ssh: { ...keySpark.ssh, auth: "pass", password: "test-only" } });
  assert.notEqual(controlPath(key), controlPath(otherRecord));
  assert.notEqual(controlPath(key), controlPath(password));
});

test("sshCommandSpec: the legacy global switch still disables reuse", () => {
  const moduleUrl = new URL("../ssh.js", import.meta.url).href;
  const script = `
    import { sshCommandSpec } from ${JSON.stringify(moduleUrl)};
    const spec = sshCommandSpec(${JSON.stringify(keySpark)});
    console.log(JSON.stringify({ args: spec.args, multiplex: spec.multiplex }));
  `;
  const spec = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, SSH_MULTIPLEX: "0", SSH_CONTROL_PERSIST_SECONDS: "60" },
    encoding: "utf8",
  }));
  assert.deepEqual(controlOptions(spec), ["ControlMaster=no", "ControlPath=none"]);
  assert.equal(spec.multiplex, null);
});

test("explainSshFailure points Windows hosts at the Windows unit type and leaves other errors alone", () => {
  const win = explainSshFailure("'true' is not recognized as an internal or external command, operable program or batch file.");
  assert.match(win, /Windows/);
  assert.match(win, /Windows PC with an NVIDIA GPU/);
  assert.equal(explainSshFailure("Permission denied (publickey)."), "Permission denied (publickey).");
});

test("a Windows unit's command is sent as an encoded PowerShell argv, others unchanged", async () => {
  const { remoteArgvFor } = await import("../ssh.js");
  const win = remoteArgvFor({ platform: "windows" }, "echo ok");
  assert.equal(win.length, 1);
  assert.match(win[0], /^powershell .*-EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.deepEqual(remoteArgvFor({ platform: "linux" }, "echo ok"), ["echo ok"]);
  assert.deepEqual(remoteArgvFor({}, "echo ok"), ["echo ok"]);
});

test("explainSshFailure names the administrators_authorized_keys file for a refused key on a Windows unit only", () => {
  const denied = "Permission denied (publickey,password,keyboard-interactive).";
  const win = explainSshFailure(denied, { windows: true });
  assert.match(win, /administrators_authorized_keys/);
  assert.match(win, /Administrators and SYSTEM/);
  assert.equal(explainSshFailure(denied), denied);
});

test("decodeClixml returns the PowerShell stream text, and null for plain stderr", () => {
  const clixml =
    '#< CLIXML\n' +
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<S S="Error">Get-CimInstance : Access is denied. _x000D__x000A_</S>' +
    '<S S="Error">At line:1 char:1_x000D__x000A_</S>' +
    '<S S="Debug">noise</S>' +
    '</Objs>';
  assert.equal(decodeClixml(clixml), "Get-CimInstance : Access is denied. At line:1 char:1");
  // Entities and _xNNNN_ escapes come back as characters; &amp; must not re-expand.
  assert.equal(
    decodeClixml('#< CLIXML\n<Objs><S S="Error">a &lt;b&gt; &amp;amp; c_x0009_d</S></Objs>'),
    "a <b> &amp; c d"
  );
  // CLIXML with no stream text at all is still recognised as CLIXML.
  assert.equal(decodeClixml('#< CLIXML\n<Objs><Obj RefId="0"/></Objs>'), "");
  assert.equal(decodeClixml("Permission denied (publickey)."), null);
  assert.equal(decodeClixml(undefined), null);
});

test("explainSshFailure decodes a CLIXML error instead of showing the raw envelope", () => {
  const denied =
    '#< CLIXML\n<Objs><S S="Error">Get-CimInstance : Access is denied. _x000D__x000A_</S></Objs>';
  const shown = explainSshFailure(denied, { windows: true });
  assert.ok(!shown.includes("CLIXML"), shown);
  assert.ok(!shown.includes("<Objs"), shown);
  assert.match(shown, /Access is denied/);
  // The common cause is not in the message itself, so name it.
  assert.match(shown, /WMI\/CIM/);

  // A CLIXML envelope with no message still says something usable.
  const empty = explainSshFailure('#< CLIXML\n<Objs></Objs>', { windows: true });
  assert.ok(!empty.includes("CLIXML"), empty);
  assert.match(empty, /PowerShell reported a failure/);

  // An unrelated PowerShell error is decoded without the WMI hint.
  const other = explainSshFailure(
    '#< CLIXML\n<Objs><S S="Error">nvidia-smi : The term is not recognized._x000D__x000A_</S></Objs>',
    { windows: true }
  );
  assert.match(other, /nvidia-smi/);
  assert.ok(!other.includes("WMI/CIM"), other);

  // Plain stderr keeps its existing handling on every platform.
  assert.equal(explainSshFailure("Permission denied (publickey)."), "Permission denied (publickey).");
});

test("SSH streams output before command exit and retains stderr tails and exit status", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-ssh-output-"));
  const release = path.join(dir, "release");
  const oldPath = process.env.PATH;
  fs.writeFileSync(path.join(dir, "ssh"), `#!${process.execPath}
const fs = require("node:fs");
process.stdout.write("\\u001b[32mrank loading\\u001b[0m\\n");
process.stderr.write("launcher warning\\n");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  process.stdout.write("final stdout");
  process.stderr.write("fatal diagnostic");
  process.exitCode = 7;
}, 5);
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lines = [];
  await assert.rejects(sshExec({
    id: "fake", lanIp: "127.0.0.1", ssh: { host: "127.0.0.1", user: "smoke", auth: "key" },
  }, "fake launcher", {
    multiplex: false,
    timeoutMs: 2000,
    onOutput: (line) => {
      lines.push(line);
      if (line.text === "rank loading") fs.writeFileSync(release, "");
    },
  }), (err) => err.exitCode === 7 && /fatal diagnostic/.test(err.message));
  assert.ok(lines.some((line) => line.stream === "stdout" && line.text === "rank loading"));
  assert.ok(lines.some((line) => line.stream === "stdout" && line.text === "final stdout"));
  assert.ok(lines.some((line) => line.stream === "stderr" && line.text === "launcher warning"));
  assert.ok(lines.some((line) => line.stream === "stderr" && line.text === "fatal diagnostic"));
});

test("SSH AbortSignal stops an in-flight local transport and preserves AbortError", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-ssh-abort-"));
  const oldPath = process.env.PATH;
  fs.writeFileSync(path.join(dir, "ssh"), `#!${process.execPath}
process.stdout.write("waiting\\n");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
  const controller = new AbortController();
  await assert.rejects(sshExec(keySpark, "status", {
    multiplex: false, signal: controller.signal, timeoutMs: 10_000,
    onOutput: () => controller.abort(),
  }), { name: "AbortError" });
});

test("attached SSH lease kills remote launcher descendants before a future launch", {
  skip: process.platform !== "linux" && "Remote recipe process-group guard requires Linux /proc and setsid",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-ssh-lease-"));
  const marker = path.join(dir, "launched");
  const oldPath = process.env.PATH;
  // A local transport executes precisely the remote argv and forwards SSH's stdin.
  // This exercises the real sshExec lease, not a mocked signal/wiring assertion.
  fs.writeFileSync(path.join(dir, "ssh"), '#!/bin/bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
  const controller = new AbortController();
  await assert.rejects(sshExec(keySpark,
    `printf 'attached\\n'; sleep 2; printf launched > '${marker}'`, {
      multiplex: false, signal: controller.signal, cancelRemote: true, timeoutMs: 10_000,
      onOutput: (line) => { if (line.text === "attached") controller.abort(); },
    }), { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(fs.existsSync(marker), false);
});

test("attached SSH cancellation leaves an already-detached service alone", {
  skip: process.platform !== "linux" && "Remote recipe process-group guard requires Linux /proc and setsid",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-ssh-detached-"));
  const oldPath = process.env.PATH;
  fs.writeFileSync(path.join(dir, "ssh"), '#!/bin/bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  let servicePid;
  t.after(() => {
    if (servicePid) { try { process.kill(servicePid, "SIGKILL"); } catch { /* already stopped */ } }
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  await assert.rejects(sshExec(keySpark,
    'setsid sleep 30 >/dev/null 2>&1 < /dev/null & printf "%s\\n" "$!"; sleep 30', {
      multiplex: false, signal: controller.signal, cancelRemote: true, timeoutMs: 10_000,
      onOutput: (line) => {
        if (/^[0-9]+$/.test(line.text)) {
          servicePid = Number(line.text);
          controller.abort();
        }
      },
    }), { name: "AbortError" });
  assert.ok(servicePid);
  assert.doesNotThrow(() => process.kill(servicePid, 0));
});
