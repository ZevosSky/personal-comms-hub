import assert from "node:assert/strict";
import test from "node:test";
import { memoryKBOf, summarizeServiceMetrics } from "../electron/serviceMetrics.js";
import { compareVersions, getPlatformAsset, normalizeVersion } from "../electron/updates.js";

const metric = (pid, type, memory, cpu = 0) => ({ pid, type, memory, cpu: { percentCPUUsage: cpu } });

test("memory prefers Windows private bytes over the working set", () => {
  assert.equal(memoryKBOf({ memory: { privateBytes: 1200, workingSetSize: 5000 } }), 1200);
  assert.equal(memoryKBOf({ memory: { workingSetSize: 5000 } }), 5000);
  assert.equal(memoryKBOf({}), 0);
});

test("per-service memory and CPU, shared processes flagged and counted once in the total", () => {
  const metrics = [
    metric(1, "Browser", { workingSetSize: 100000 }, 1),
    metric(2, "GPU", { workingSetSize: 50000 }),
    metric(10, "Tab", { privateBytes: 200000, workingSetSize: 300000 }, 2.25),
    metric(11, "Tab", { workingSetSize: 40000 }, 0.5),
    metric(20, "Tab", { workingSetSize: 70000 }, 1),
    metric(30, "Tab", { workingSetSize: 10000 })
  ];
  const summary = summarizeServiceMetrics({
    metrics,
    servicePids: { gmail: [10, 11, 10], wechat: [20], other: [20], gone: [99] },
    sampledAt: 42
  });
  assert.deepEqual(summary, {
    sampledAt: 42,
    totalMemoryKB: 470000,
    shellMemoryKB: 160000,
    services: {
      gmail: { memoryKB: 240000, cpuPercent: 2.8, processCount: 2, shared: false },
      wechat: { memoryKB: 70000, cpuPercent: 1, processCount: 1, shared: true },
      other: { memoryKB: 70000, cpuPercent: 1, processCount: 1, shared: true },
      gone: { memoryKB: 0, cpuPercent: 0, processCount: 0, shared: false }
    }
  });
  assert.deepEqual(summarizeServiceMetrics({ sampledAt: 1 }), { sampledAt: 1, totalMemoryKB: 0, shellMemoryKB: 0, services: {} });
});

test("update checks compare versions numerically and pick the platform installer", () => {
  assert.equal(normalizeVersion("v1.2.3-beta.1"), "1.2.3");
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.3", "1.3.0"), 0);
  assert.equal(compareVersions("1.2.9", "v1.3.0"), -1);
  const assets = [
    { name: "Comms-Hub-Setup-1.3.0.exe.blockmap" },
    { name: "Uninstaller-1.3.0.exe" },
    { name: "Comms-Hub-Setup-1.3.0.exe" },
    { name: "Comms-Hub-1.3.0.AppImage" },
    { nope: true }
  ];
  assert.equal(getPlatformAsset(assets, "win32").name, "Comms-Hub-Setup-1.3.0.exe");
  assert.equal(getPlatformAsset(assets, "linux").name, "Comms-Hub-1.3.0.AppImage");
  assert.equal(getPlatformAsset(assets, "darwin"), null);
  assert.equal(getPlatformAsset(undefined, "win32"), null);
});
