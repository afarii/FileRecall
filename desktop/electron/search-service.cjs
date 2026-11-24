"use strict";

const { Worker } = require("node:worker_threads");
const { join } = require("node:path");

function createSearchService({ localDatabase, ntfsDatabase, applicationData, onMetric = () => {} }) {
  const createChannel = (searchKind) => {
    const worker = new Worker(join(__dirname, "search-worker.cjs"), {
      workerData: { localDatabase, ntfsDatabase, applicationData },
    });
    worker.unref();
    const pending = new Map();
    let sequence = 0;
    let stopped = false;
    let inFlight = null;
    let queued = null;
    const coalesce = searchKind !== "local";

    function dispatch(job) {
      if (coalesce) inFlight = job.id;
      worker.postMessage(job);
    }
    function next() {
      if (!coalesce || inFlight !== null || !queued) return;
      const job = queued;
      queued = null;
      if (pending.has(job.id)) dispatch(job);
    }

    function fail(error) {
      if (stopped) return;
      stopped = true;
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      pending.clear();
      queued = null;
      inFlight = null;
      worker.unref();
    }

    worker.on("message", (reply) => {
      if (inFlight === reply.id) inFlight = null;
      const item = pending.get(reply.id);
      if (!item) { next(); return; }
      clearTimeout(item.timer);
      pending.delete(reply.id);
      if (!pending.size) worker.unref();
      if (reply.error) item.reject(new Error(reply.error));
      else {
        if (searchKind !== "shutdown" && reply.elapsedMs !== undefined) {
          onMetric(searchKind, Date.now() - item.startedAt);
        }
        item.resolve(reply.files);
      }
      next();
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error("搜索线程已退出：" + code)));

    function request(query, drives = [], kind = searchKind, favoritesOnly = false) {
      if (stopped) return Promise.reject(new Error("搜索服务已停止"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (!pending.size) worker.unref();
          reject(new Error("搜索超时，请缩小查询范围"));
        }, 8000);
        timer.unref();
        pending.set(id, { resolve, reject, timer, startedAt: Date.now() });
        worker.ref();
        const job = { id, kind, query, drives, favoritesOnly };
        if (coalesce && inFlight !== null) {
          // At most one waiting query. Old input is never worth a new scan.
          if (queued) {
            const obsolete = pending.get(queued.id);
            if (obsolete) {
              clearTimeout(obsolete.timer);
              pending.delete(queued.id);
              obsolete.resolve([]);
            }
          }
          queued = job;
        } else {
          dispatch(job);
        }
      });
    }

    return {
      request,
      async close() {
        if (!stopped) {
          try { await request("", [], "shutdown"); } catch {}
          fail(new Error("搜索服务正在关闭"));
        }
        await worker.terminate();
      },
    };
  };

  // One slow authorized-folder SQL query must not delay MFT filename results.
  const local = createChannel("local");
  const ntfs = createChannel("ntfs");
  let deep;
  return {
    searchLocal: (query) => local.request(query),
    searchUnified: (query, drives, favoritesOnly = false) => ntfs.request(query, drives, "unified", favoritesOnly),
    searchNtfs: (query, drives) => ntfs.request(query, drives),
    // Spawn only when prefix search has no hits. Slow substring scans stay
    // isolated so that subsequent keystrokes can still return immediately.
    searchNtfsDeep: (query, drives) => {
      deep ??= createChannel("ntfs-deep");
      return deep.request(query, drives);
    },
    async close() {
      await Promise.all([local.close(), ntfs.close(), ...(deep ? [deep.close()] : [])]);
    },
  };
}

module.exports = { createSearchService };
