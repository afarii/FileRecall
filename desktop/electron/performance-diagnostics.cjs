"use strict";
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

function createPerformanceDiagnostics(userData, { intervalMs = 10000 } = {}) {
  const logFile = join(userData, "performance-diagnostics.jsonl");
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastCpu = process.cpuUsage();
  let lastElapsed = performance.now();
  let lastUtil = performance.eventLoopUtilization();
  let recent = [];
  let latestNtfs = {};
  const searchTimes = { local: [], ntfs: [], "ntfs-deep": [] };
  let lastRendererLag = 0;
  let writes = Promise.resolve();
  let stopped = false;

  const safeNumber = (value, max = 1e9) =>
    Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value * 10) / 10) : 0;

  function append(row) {
    const line = JSON.stringify(row) + "\n";
    // Async writes, bounded to ~1 MiB. No file names, paths, search text or URLs.
    writes = writes.then(async () => {
      try {
        const info = await fs.stat(logFile).catch(() => null);
        if (info && info.size > 1_000_000) {
          await fs.rename(logFile, logFile + ".old").catch(() => {});
        }
        await fs.appendFile(logFile, line, "utf8");
      } catch { /* Diagnostics never affect search or indexing. */ }
    });
  }

  function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return safeNumber(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)], 60000);
  }

  function sample() {
    if (stopped) return;
    const elapsed = Math.max(1, performance.now() - lastElapsed);
    lastElapsed = performance.now();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const util = performance.eventLoopUtilization(lastUtil);
    lastUtil = performance.eventLoopUtilization();
    const record = {
      time: new Date().toISOString(),
      mainLoopP95Ms: safeNumber(histogram.percentile(95) / 1e6),
      mainLoopMaxMs: safeNumber(histogram.max / 1e6),
      mainLoopUtilPct: safeNumber(util.utilization * 100, 100),
      processCpuPctOfOneCore: safeNumber(((cpu.user + cpu.system) / 1000) / elapsed * 100, 100000),
      processRssMiB: safeNumber(process.memoryUsage().rss / 1048576),
      rendererLagMs: safeNumber(lastRendererLag, 60000),
      localSearchP95Ms: percentile(searchTimes.local, 0.95),
      ntfsSearchP95Ms: percentile(searchTimes.ntfs, 0.95),
      deepSearchP95Ms: percentile(searchTimes["ntfs-deep"], 0.95),
      localSearchCount: searchTimes.local.length,
      ntfsSearchCount: searchTimes.ntfs.length,
      ntfsLoopP95Ms: safeNumber(latestNtfs.ntfsLoopP95Ms ?? 0, 60000),
      ntfsLoopMaxMs: safeNumber(latestNtfs.ntfsLoopMaxMs ?? 0, 60000),
      ntfsActiveScanCount: Array.isArray(latestNtfs.scanStates)
        ? latestNtfs.scanStates.filter((s) => s.phase === "building" || s.phase === "catching-up").length : 0,
    };
    lastRendererLag = 0;
    for (const times of Object.values(searchTimes)) times.length = 0;
    histogram.reset();
    recent.push(record);
    if (recent.length > 24) recent.shift();
    append(record);
  }
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    file: logFile,
    setNtfsMetrics: (metrics) => { latestNtfs = metrics && typeof metrics === "object" ? metrics : {}; },
    recordSearch: (kind, durationMs) => {
      const times = searchTimes[kind];
      if (!times || !Number.isFinite(durationMs)) return;
      if (times.length >= 1000) times.shift();
      times.push(safeNumber(durationMs, 60000));
    },
    recordRendererLag: (lag) => {
      if (typeof lag === "number") lastRendererLag = Math.max(lastRendererLag, safeNumber(lag, 60000));
    },
    snapshot: () => ({
      format: "FileRecall performance diagnostics v1",
      sampleIntervalSeconds: intervalMs / 1000,
      note: "Local machine measurements only. No paths or filenames are collected.",
      recent: recent.slice(),
    }),
    async close() {
      stopped = true;
      clearInterval(timer);
      histogram.disable();
      await writes;
    },
  };
}
module.exports = { createPerformanceDiagnostics };
