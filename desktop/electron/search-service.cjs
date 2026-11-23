"use strict";

const { Worker } = require("node:worker_threads");
const { join } = require("node:path");

function createSearchService({ localDatabase, ntfsDatabase, applicationData }) {
  const worker = new Worker(join(__dirname, "search-worker.cjs"), {
    workerData: { localDatabase, ntfsDatabase, applicationData },
  });
  worker.unref();
  const requests = new Map();
  let nextId = 0;
  let stopped = false;

  function fail(error) {
    if (stopped) return;
    stopped = true;
    for (const { reject, timer } of requests.values()) {
      clearTimeout(timer);
      reject(error);
    }
    requests.clear();
  }
  worker.on("message", (reply) => {
    const pending = requests.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    requests.delete(reply.id);
    if (reply.error) pending.reject(new Error(reply.error));
    else pending.resolve(reply.files);
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error("搜索工作线程已退出（" + code + "）")));

  function request(kind, query, drives = []) {
    if (stopped) return Promise.reject(new Error("搜索服务已停止"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("搜索超时，请缩小查询范围"));
      }, 8000);
      timer.unref();
      requests.set(id, { resolve, reject, timer });
      worker.postMessage({ id, kind, query, drives });
    });
  }
  return {
    searchLocal: (query) => request("local", query),
    searchNtfs: (query, drives) => request("ntfs", query, drives),
    async close() {
      if (!stopped) fail(new Error("搜索服务正在关闭"));
      await worker.terminate();
    },
  };
}

module.exports = { createSearchService };
