import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SystemCollector } from "../SystemCollector.js";
import { ROCE_FAST_SCRIPT } from "../roce.js";
import { INTEL_PROBE_SCRIPT } from "../intelGpu.js";

// zsh aborts a whole script when a `for` word-list glob matches nothing (bash
// just hands the literal to the loop guard). Every remote probe script here is
// run against a fixture tree under zsh: no "no matches found" may appear and
// each script must reach its sentinel, with its own glob deliberately unmatched.

const zshAvailable = spawnSync("zsh", ["-c", "true"]).error == null;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zsh-glob-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, w };
}

// Point a probe script's absolute sysfs roots at the fixture tree.
const scoped = (cmd, root) =>
  cmd
    .replaceAll("/sys/class/hwmon", `${root}/sys/class/hwmon`)
    .replaceAll("/sys/class/thermal", `${root}/sys/class/thermal`)
    .replaceAll("/sys/class/net", `${root}/sys/class/net`)
    .replaceAll("/sys/block", `${root}/sys/block`)
    .replaceAll("/sys/class/infiniband", `${root}/sys/class/infiniband`);

const runZsh = (cmd, root) =>
  spawnSync("zsh", ["-c", scoped(cmd, root)], { encoding: "utf8" });

const expectClean = (run, extra) => {
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stderr, /no matches found/);
  if (extra) extra(run);
};

const spark = () => new SystemCollector({ id: "zsh-glob", kind: "spark" });

test("remote CPU temps: hwmon with no temp sensor and no thermal zones still run to the end", { skip: !zshAvailable }, () => {
  const { root, w } = fixture();
  try {
    // sysfs entries are symlinks named hwmonN with the sensor name inside; keep
    // the fixture in that shape.
    fs.mkdirSync(path.join(root, "devices/sensor-coretemp"), { recursive: true });
    fs.mkdirSync(path.join(root, "devices/sensor-acpitz"), { recursive: true });
    fs.mkdirSync(path.join(root, "sys/class/hwmon"), { recursive: true });
    fs.symlinkSync("../../../devices/sensor-coretemp", path.join(root, "sys/class/hwmon/hwmon0"));
    fs.symlinkSync("../../../devices/sensor-acpitz", path.join(root, "sys/class/hwmon/hwmon1"));
    w("devices/sensor-coretemp/name", "coretemp\n");
    w("devices/sensor-coretemp/temp1_input", "45000\n");
    w("devices/sensor-acpitz/name", "acpitz\n"); // no temp*_input: the formerly fatal glob
    const cmd = spark()._buildRemoteCpuCommand();
    expectClean(runZsh(cmd, root), (run) => {
      assert.match(run.stdout, /coretemp 45000/);
      assert.match(run.stdout, /---/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote CPU temps: no hwmon and no thermal class at all completes with exit 0", { skip: !zshAvailable }, () => {
  const { root } = fixture(); // both /sys/class/hwmon/* and thermal_zone* match nothing
  try {
    expectClean(runZsh(spark()._buildRemoteCpuCommand(), root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote storage: block stat lines and the IO marker survive a zsh login shell", { skip: !zshAvailable }, async () => {
  const { root, w } = fixture();
  try {
    w("devices/nvme0n1/stat", "100 0 800 20 0 0 0 0 0 0 0\n");
    fs.mkdirSync(path.join(root, "sys/block"), { recursive: true });
    fs.symlinkSync("../../devices/nvme0n1", path.join(root, "sys/block/nvme0n1"));
    let cmd = "";
    await spark()._getRemoteStorage(async (_s, c) => {
      cmd = c;
      return "";
    });
    assert.match(cmd, /\/sys\/block/);
    expectClean(runZsh(cmd, root), (run) => {
      assert.match(run.stdout, /---sparkdash-block-io---/);
      assert.match(run.stdout, /nvme0n1 100 0 800 20/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote storage: no block devices at all still prints the IO marker", { skip: !zshAvailable }, async () => {
  const { root } = fixture();
  try {
    let cmd = "";
    await spark()._getRemoteStorage(async (_s, c) => {
      cmd = c;
      return "";
    });
    expectClean(runZsh(cmd, root), (run) => assert.match(run.stdout, /---sparkdash-block-io---/));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote network: operstate and speed loops survive an interface with no speed file", { skip: !zshAvailable }, async () => {
  const { root, w } = fixture();
  try {
    w("devices/eth0/operstate", "up\n");
    w("devices/eth0/speed", "200000\n");
    w("devices/wlan0/operstate", "down\n"); // no speed: the formerly fatal glob
    w("devices/wlan1/operstate", "down\n");
    fs.mkdirSync(path.join(root, "sys/class/net"), { recursive: true });
    fs.symlinkSync("../../../devices/eth0", path.join(root, "sys/class/net/eth0"));
    fs.symlinkSync("../../../devices/wlan0", path.join(root, "sys/class/net/wlan0"));
    fs.symlinkSync("../../../devices/wlan1", path.join(root, "sys/class/net/wlan1"));
    let cmd = "";
    await spark()._getRemoteNetwork(async (_s, c) => {
      cmd = c;
      return "";
    });
    assert.match(cmd, /\/sys\/class\/net/);
    expectClean(runZsh(cmd, root), (run) => {
      assert.match(run.stdout, /eth0:up/);
      assert.match(run.stdout, /wlan0:down/);
      // find walks readdir order; globs sorted. The `| sort` keeps that parity —
      // pin it on the operstate loop's lines (the speed loop runs separately).
      const lines = (run.stdout.match(/^(\w[\w.-]*):(?:up|down)$/gm) || []).map((l) => l.split(":")[0]);
      assert.ok(lines.length >= 3, `expected >=3 operstate lines, got ${lines.length}`);
      assert.deepEqual(lines, [...lines].sort());
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("RoCE fast script: three devices print in sorted device order (sort)", { skip: !zshAvailable }, () => {
  const { root, w } = fixture();
  try {
    // Create mlx5_2 first so an unsorted readdir is likely to lead with it.
    for (const n of ["mlx5_2", "mlx5_1", "mlx5_0"]) {
      w(`devices/${n}/ports/1/state`, "4: ACTIVE\n");
      w(`devices/${n}/ports/1/phys_state`, "5: LinkUp\n");
      w(`devices/${n}/ports/1/rate`, "200 Gb/sec\n");
      w(`devices/${n}/ports/1/link_layer`, "Ethernet\n");
      w(`devices/${n}/ports/1/hw_counters/out_of_buffer`, "0\n");
      w(`devices/${n}/device/net/enp1s0f0np0`, "");
    }
    fs.mkdirSync(path.join(root, "sys/class/infiniband"), { recursive: true });
    for (const n of ["mlx5_2", "mlx5_1", "mlx5_0"]) {
      fs.symlinkSync(`../../../devices/${n}`, path.join(root, `sys/class/infiniband/${n}`));
    }
    expectClean(runZsh(ROCE_FAST_SCRIPT, root), (run) => {
      const devs = run.stdout.split("\n").filter((l) => l.startsWith("DEV|")).map((l) => l.split("|")[1]);
      assert.deepEqual(devs, ["mlx5_0", "mlx5_1", "mlx5_2"]);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RoCE fast script: no infiniband devices completes with exit 0", { skip: !zshAvailable }, () => {
  const { root } = fixture();
  try {
    expectClean(runZsh(ROCE_FAST_SCRIPT, root), (run) => assert.equal(run.stdout.trim(), ""));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RoCE fast script: device with hw_counters reads state and counters under zsh", { skip: !zshAvailable }, () => {
  const { root, w } = fixture();
  try {
    w("devices/mlx5_0/ports/1/state", "4: ACTIVE\n");
    w("devices/mlx5_0/ports/1/phys_state", "5: LinkUp\n");
    w("devices/mlx5_0/ports/1/rate", "200 Gb/sec\n");
    w("devices/mlx5_0/ports/1/link_layer", "Ethernet\n");
    w("devices/mlx5_0/ports/1/hw_counters/out_of_buffer", "0\n");
    w("devices/mlx5_0/device/net/enp1s0f0np0", "");
    fs.mkdirSync(path.join(root, "sys/class/infiniband"), { recursive: true });
    fs.symlinkSync("../../../devices/mlx5_0", path.join(root, "sys/class/infiniband/mlx5_0"));
    expectClean(runZsh(ROCE_FAST_SCRIPT, root), (run) => {
      assert.match(run.stdout, /DEV\|mlx5_0\|4: ACTIVE/);
      assert.match(run.stdout, /CNT\|mlx5_0\|out_of_buffer\|0/);
      assert.match(run.stdout, /NET\|enp1s0f0np0\|/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS models listing survives zsh with an unmatched models tree", { skip: !zshAvailable }, async () => {
  const { root, w } = fixture();
  try {
    w("models/alpha/weights.bin", "x");
    w("models/beta/weights.bin", "x");
    w("models/.DS_Store/thing", "x");
    let cmd = "";
    await new SystemCollector({ id: "zsh-glob", kind: "spark", platform: "darwin", isLocal: false }).collectMacModels(
      async (_s, c) => {
        cmd = c;
        return "---";
      },
    );
    const run = spawnSync("zsh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, HOME: root },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /no matches found/);
    assert.match(run.stdout, /models\/alpha/);
    assert.match(run.stdout, /models\/beta/);
    assert.ok(run.stdout.indexOf("models/alpha") < run.stdout.indexOf("models/beta"), "du lines must be sorted");
    assert.doesNotMatch(run.stdout, /\.DS_Store/, "dot-entries the old glob skipped must stay skipped");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

