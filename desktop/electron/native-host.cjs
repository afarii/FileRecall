"use strict";

const { mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { DownloadSources } = require("./download-sources.cjs");

async function receive(input) {
  const limit = 4 * 1024 * 1024;
  let frame = Buffer.alloc(0);
  for await (const chunk of input) {
    frame = Buffer.concat([frame, chunk]);
    if (frame.length < 4) continue;
    const length = frame.readUInt32LE(0);
    if (length > limit || length === 0) throw Object.assign(new Error("无效的同步消息长度。"), { code: "INVALID_FRAME_LENGTH" });
    if (frame.length >= length + 4) return JSON.parse(frame.subarray(4, length + 4));
  }
  throw Object.assign(new Error("同步消息不完整。"), { code: "INCOMPLETE_FRAME" });
}

async function main() {
  let reply;
  try {
    const request = await receive(process.stdin);
    const path = join(process.env.APPDATA, "filerecall-desktop", "browser-downloads.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const sources = new DownloadSources(path);
    try {
      reply = sources.importBatch(request);
    } finally {
      sources.close();
    }
  } catch (error) {
    process.stderr.write("FileRecall native host: " + (error.code || error.name) + "\n");
    reply = { ok: false, error: "无法保存此批下载记录，请重试。" };
  }
  const body = Buffer.from(JSON.stringify(reply));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

if (require.main === module) main();
module.exports = { receive };
