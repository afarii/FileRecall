"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { NtfsSearch } = require("./ntfs-search.cjs");
const { MotwMemory, createMotwCapture } = require("./motw-memory.cjs");
const { join, win32 } = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");

let service;
let memory, capture, captureTimer, backfillTimer;
let backfillRunning = false;
let nextEventId = 0;
const pendingPaths = new Map();
const lag = monitorEventLoopDelay({ resolution: 40 });
lag.enable();
const metrics = setInterval(() => {
  const p95Ms = Number((lag.percentile(95) / 1e6).toFixed(1));
  const maxMs = Number((lag.max / 1e6).toFixed(1));
  parentPort.postMessage({ type: "metrics", data: {
    ntfsLoopP95Ms: p95Ms, ntfsLoopMaxMs: maxMs,
    scanStates: service?.status().drives.map(({ drive, phase }) => ({ drive, phase })) ?? [],
  } });
  lag.reset();
}, 10000);
metrics.unref();

const read = () => ({
  status: service.status(),
  searchableDrives: service.searchableDrives(),
});
function respond(id, action, args = []) {
  Promise.resolve().then(async () => {
    switch (action) {
      case "startAutomatically": await service.startAutomatically(); return read().status;
      case "retryAutomatically": await service.retryAutomatically(); return read().status;
      case "reconnect": return service.reconnect();
      case "enable": return service.enable(args[0]);
      case "disable": return service.disable(args[0]);
      case "target": return service.target(args[0], args[1]);
      case "sourceTarget": return service.sourceTarget(args[0], args[1]);
      case "captureMotw": {
        const target = service.sourceTarget(args[0], args[1]);
        return target && capture ? capture.capture(target.volume, target.id) : null;
      }
      case "sourceTargetForVolume": return service.sourceTargetForVolume(args[0], args[1]);
      case "sourceStateForVolume": return service.sourceStateForVolume(args[0], args[1]);
      case "sourceSettings": return memory?.status() ?? { available:false, enabled:false,count:0 };
      case "setSourceEnabled":
        if (!memory || typeof args[0] !== "boolean") throw new Error("来源记忆不可用");
        capture.invalidate();
        memory.setSetting("enabled", args[0]);
        parentPort.postMessage({ type:"sources" });
        return memory.status();
      case "forgetSource":
        if (!memory || typeof args[0] !== "string" || !/^motw:[a-f0-9]{64}$/.test(args[0])) return false;
        if (!memory.forget(args[0])) return false;
        parentPort.postMessage({ type:"sources" });
        return true;
      case "clearSources":
        if (!memory) throw new Error("来源记忆不可用");
        capture.invalidate();
        memory.clear();
        parentPort.postMessage({ type:"sources" });
        return memory.status();
      case "recordUse": service.catalog.recordUse(args[0], args[1]); return true;
      case "favorite": return service.catalog.favorite(args[0], args[1], args[2]);
      case "trackedDrives": service.trackedDrives = new Set(args[0]); return true;
      case "status": return read();
      case "close":
        clearInterval(captureTimer);
        clearInterval(backfillTimer);
        capture?.close();
        memory?.close();
        await service.close();
        return true;
      default: throw new Error("未知 NTFS 操作");
    }
  }).then((result) => {
    parentPort.postMessage({ type: "reply", id, result });
    if (action === "close") {
      clearInterval(metrics);
      lag.disable();
    }
  }, (err) => parentPort.postMessage({ type: "reply", id, error: String(err?.message || err) }));
}
try {
  service = new NtfsSearch(workerData.database, workerData.userData, workerData.executable, {
    trackedDrives: workerData.trackedDrives,
    onSourceRows: (volume, rows) => capture?.events(volume, rows),
    onChange: (status) => parentPort.postMessage({
      type: "state", status, searchableDrives: service?.searchableDrives() ?? [],
    }),
    onActiveDrives: (drives) => parentPort.postMessage({ type: "active", drives }),
    onPaths: (drive, paths) => new Promise((resolve, reject) => {
      const id = ++nextEventId;
      pendingPaths.set(id, { resolve, reject });
      parentPort.postMessage({ type: "paths", id, drive, paths });
    }),
  });
  try {
    memory = new MotwMemory(join(workerData.userData, "motw-memory.sqlite"));
    capture = createMotwCapture({ memory, resolve: (volume, id) => service.sourceTargetForVolume(volume, id),
      changed: () => parentPort.postMessage({ type: "sources" }) });
    captureTimer = setInterval(() => void capture.tick().catch(() => {}), 250);
    captureTimer.unref();
    // Existing personal folders only, and always yield to new-download work.
    backfillTimer = setInterval(async () => {
      if (backfillRunning || !capture.idle() || !memory.enabled() || service.polling || service.closed) return;
      backfillRunning = true;
      try {
        for (const root of workerData.sourceRoots ?? []) {
          const drive = /^[a-z]:[\\/]/i.test(root) ? root[0].toUpperCase() : null;
          const volume = service.catalog.activeDrives().find(d => d.drive === drive)?.volume;
          if (!volume || service.sessions.get(drive)?.phase !== "ready") continue;
          const key = "backfill:" + volume.toLowerCase() + ":" + win32.normalize(root).toLowerCase();
          const cursor = memory.setting(key, {});
          if (cursor.done) continue;
          const step = service.catalog.sourceBackfillStep(drive, root, cursor);
          if (step.id) await capture.capture(volume, step.id);
          if (!service.closed && memory.enabled()) memory.setSetting(key, step.done ? { done:true } : step.cursor);
          break;
        }
      } catch {} finally { backfillRunning = false; }
    }, 1000);
    backfillTimer.unref();
  } catch { /* Source storage failure must not disable filename indexing. */ }
  parentPort.postMessage({ type: "ready", ...read() });
} catch (error) {
  parentPort.postMessage({ type: "fatal", error: String(error.message || error) });
}
parentPort.on("message", (msg) => {
  if (msg.type === "paths-reply") {
    const pending = pendingPaths.get(msg.id);
    if (!pending) return;
    pendingPaths.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve();
  } else if (msg.type === "call" && service) {
    respond(msg.id, msg.action, msg.args);
  }
});
