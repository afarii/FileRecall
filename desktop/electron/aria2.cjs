"use strict";

const { request } = require("node:http");
const { randomUUID } = require("node:crypto");

function aria2Rpc(port, secret, offset, size) {
  const id = randomUUID();
  const method = "aria2.tellStopped";
  const params = [offset, size, ["gid", "status", "files"]];
  if (secret) params.unshift("token:" + secret);
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, path: "/jsonrpc", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(6500),
    }, (response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > 12 * 1024 * 1024) {
          req.destroy(new Error("下载器返回的记录太多。"));
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks));
          if (response.statusCode !== 200 || reply?.id !== id || !Array.isArray(reply.result)) {
            reject(new Error("无法读取下载记录，请核对 Motrix／aria2 的 RPC 端口和密钥。"));
          } else {
            resolve(reply.result);
          }
        } catch {
          reject(new Error("这个端口没有返回有效的 aria2 记录。"));
        }
      });
    });
    req.on("error", () => reject(new Error("无法连接本机 Motrix／aria2，请确认下载器正在运行并检查 RPC 端口。")));
    req.end(body);
  });
}

function completedFiles(tasks) {
  const completed = [];
  for (const task of tasks) {
    if (task?.status !== "complete" || typeof task.gid !== "string" || !/^[a-f0-9]{16}$/i.test(task.gid)
      || !Array.isArray(task.files)) continue;
    for (const file of task.files) {
      if ((file?.selected !== "true" && file?.selected !== true)
        || typeof file.index !== "string" || !/^\d{1,8}$/.test(file.index)
        || typeof file.length !== "string" || !/^\d{1,24}$/.test(file.length)
        || typeof file.completedLength !== "string" || !/^\d{1,24}$/.test(file.completedLength)
        || BigInt(file.completedLength) < BigInt(file.length)) continue;
      const used = Array.isArray(file.uris) ? new Set(file.uris
        .filter((entry) => entry?.status === "used" && typeof entry.uri === "string")
        .map((entry) => entry.uri)) : new Set();
      completed.push({ gid: task.gid.toLowerCase(), index: file.index, path: file.path,
        uri: used.size === 1 ? used.values().next().value : null });
    }
  }
  return completed;
}

async function readCompleted(port, secret, rpc = aria2Rpc) {
  const files = [];
  const size = 100;
  for (let offset = 0; offset < 500; offset += size) {
    const records = await rpc(port, secret, -offset - 1, size);
    files.push(...completedFiles(records));
    if (records.length < size) break;
  }
  return files;
}

module.exports = { aria2Rpc, completedFiles, readCompleted };
