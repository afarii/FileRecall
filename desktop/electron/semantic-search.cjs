"use strict";

const { Worker } = require("node:worker_threads");
const { join } = require("node:path");

function createSemanticSearch(databasePath, modelPath, report) {
  let worker;
  let pending;
  function reset(error) {
    pending?.reject(error);
    pending = null;
    worker = null;
  }
  return {
    search(query, options) {
      if (pending) throw new Error("已有语义搜索正在运行。");
      if (!worker) {
        worker = new Worker(join(__dirname, "semantic-worker.cjs"), { workerData: { databasePath, modelPath } });
        const current = worker;
        current.on("message", (message) => {
          if (worker !== current) return;
          if (message.progress) return report(message.progress);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
          pending = null;
        });
        current.on("error", (error) => { if (worker === current) reset(error); });
        current.on("exit", () => { if (worker === current) reset(new Error("语义搜索已停止，请重试。")); });
      }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage(options ? { query, ...options } : query);
      });
    },
    clear() {
      const current = worker;
      reset(new Error("索引设置已更改，请重新搜索。"));
      if (current) void current.terminate();
    },
  };
}

module.exports = { createSemanticSearch };
