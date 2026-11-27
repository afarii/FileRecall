"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { NtfsSearch } = require("./ntfs-search.cjs");
const { monitorEventLoopDelay } = require("node:perf_hooks");

let service;
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
      case "sourceTargetForVolume": return service.sourceTargetForVolume(args[0], args[1]);
      case "recordUse": service.catalog.recordUse(args[0], args[1]); return true;
      case "favorite": return service.catalog.favorite(args[0], args[1], args[2]);
      case "trackedDrives": service.trackedDrives = new Set(args[0]); return true;
      case "status": return read();
      case "close":
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
