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

    function fail(error) {
      if (stopped) return;
      stopped = true;
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      pending.clear();
      worker.unref();
    }

    worker.on("message", (reply) => {
      const item = pending.get(reply.id);
      if (!item) return;
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
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error("搜索线程已退出：" + code)));

    function request(query, drives = [], kind = searchKind) {
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
        worker.postMessage({ id, kind, query, drives });
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
