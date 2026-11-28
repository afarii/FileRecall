"use strict";
const { Worker } = require("node:worker_threads");
const { join } = require("node:path");

function createNtfsService(database, userData, executable, { onChange, onPaths, onActiveDrives, onMetrics = () => {}, onSourcesChanged = () => {}, trackedDrives }) {
  const worker = new Worker(join(__dirname, "ntfs-worker.cjs"), {
    workerData: { database, userData, executable, trackedDrives },
  });
  worker.unref();
  let state = { available: true, autoPhase: "idle", connected: false, drives: [] };
  let drives = [];
  let closed = false;
  let sequence = 0;
  const waiting = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  function finish(error) {
    if (closed) return;
    closed = true;
    readyReject(error);
    for (const item of waiting.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    waiting.clear();
  }
  worker.on("message", (msg) => {
    if (msg.type === "ready") {
      state = msg.status;
      drives = msg.searchableDrives;
      onChange(state);
      readyResolve();
    } else if (msg.type === "state") {
      state = msg.status;
      drives = msg.searchableDrives;
      onChange(state);
    } else if (msg.type === "active") {
      onActiveDrives(msg.drives);
    } else if (msg.type === "sources") {
      onSourcesChanged();
    } else if (msg.type === "metrics") {
      onMetrics(msg.data);
    } else if (msg.type === "paths") {
      Promise.resolve().then(() => onPaths(msg.drive, msg.paths)).then(
        () => worker.postMessage({ type: "paths-reply", id: msg.id }),
        (err) => worker.postMessage({ type: "paths-reply", id: msg.id, error: String(err.message || err) }),
      );
    } else if (msg.type === "reply") {
      const item = waiting.get(msg.id);
      if (!item) return;
      waiting.delete(msg.id);
      clearTimeout(item.timer);
      if (waiting.size === 0) worker.unref();
      if (msg.error) item.reject(new Error(msg.error));
      else item.resolve(msg.result);
    } else if (msg.type === "fatal") {
      finish(new Error(msg.error));
    }
  });
  worker.on("error", finish);
  worker.on("exit", (code) => finish(new Error("NTFS 索引工作线程退出：" + code)));

  async function invoke(action, ...args) {
    await ready;
    if (closed) throw new Error("NTFS 索引工作线程已经停止");
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        if (waiting.size === 0) worker.unref();
        reject(new Error("NTFS 索引操作超时"));
      }, action === "startAutomatically" || action === "retryAutomatically" ? 180000 : 65000);
      timer.unref();
      waiting.set(id, { resolve, reject, timer });
      worker.ref();
      worker.postMessage({ type: "call", id, action, args });
    });
  }
  return {
    status: () => state,
    searchableDrives: () => drives,
    startAutomatically: () => invoke("startAutomatically"),
    retryAutomatically: () => invoke("retryAutomatically"),
    reconnect: () => invoke("reconnect"),
    enable: (drive) => invoke("enable", drive),
    disable: (drive) => invoke("disable", drive),
    target: (drive, id) => invoke("target", drive, id),
    sourceTarget: (drive, id) => invoke("sourceTarget", drive, id),
    captureMotw: (drive, id) => invoke("captureMotw", drive, id),
    sourceTargetForVolume: (volume, id) => invoke("sourceTargetForVolume", volume, id),
    sourceStateForVolume: (volume, id) => invoke("sourceStateForVolume", volume, id),
    recordUse: (drive, id) => invoke("recordUse", drive, id),
    favorite: (drive, id, enabled) => invoke("favorite", drive, id, enabled),
    setTrackedDrives: (drives) => invoke("trackedDrives", drives),
    async close() {
      try { await invoke("close"); } catch {}
      finish(new Error("NTFS 索引工作线程已关闭"));
      await worker.terminate();
    },
  };
}
module.exports = { createNtfsService };
