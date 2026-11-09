// Per-service memory and CPU for `services:get-metrics` (D16). Electron-free: main passes in
// app.getAppMetrics() and the OS process ids each loaded service page uses.

/** Windows private bytes when available, else the working set (both in KB). */
export const memoryKBOf = (metric) => {
  const memory = metric?.memory;
  const value = Number(memory?.privateBytes ?? memory?.workingSetSize);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
};

const cpuOf = (metric) => {
  const value = Number(metric?.cpu?.percentCPUUsage);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const round = (value) => Math.round(value * 10) / 10;

/**
 * `{ sampledAt, totalMemoryKB, shellMemoryKB, services: { [id]: { memoryKB, cpuPercent, processCount, shared } } }`.
 * A process used by two services (same session or site) counts for both and is flagged `shared`;
 * the total counts it once. Everything not attributed to a service is shell overhead.
 */
export const summarizeServiceMetrics = ({ metrics = [], servicePids = {}, sampledAt = Date.now() } = {}) => {
  const byPid = new Map();
  for (const metric of metrics) if (Number.isInteger(metric?.pid)) byPid.set(metric.pid, metric);
  const pidsById = Object.entries(servicePids).map(([id, pids]) => [
    id,
    [...new Set(Array.isArray(pids) ? pids : [])].filter((pid) => byPid.has(pid))
  ]);
  const owners = new Map();
  for (const [, pids] of pidsById) for (const pid of pids) owners.set(pid, (owners.get(pid) ?? 0) + 1);

  const services = {};
  for (const [id, pids] of pidsById) {
    services[id] = {
      memoryKB: pids.reduce((sum, pid) => sum + memoryKBOf(byPid.get(pid)), 0),
      cpuPercent: round(pids.reduce((sum, pid) => sum + cpuOf(byPid.get(pid)), 0)),
      processCount: pids.length,
      shared: pids.some((pid) => owners.get(pid) > 1)
    };
  }
  const totalMemoryKB = [...byPid.values()].reduce((sum, metric) => sum + memoryKBOf(metric), 0);
  const serviceMemoryKB = [...owners.keys()].reduce((sum, pid) => sum + memoryKBOf(byPid.get(pid)), 0);
  return { sampledAt, totalMemoryKB, shellMemoryKB: Math.max(0, totalMemoryKB - serviceMemoryKB), services };
};
