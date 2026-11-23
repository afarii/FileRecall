"use strict";

const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { mkdir, rename, rm, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const modelBase = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726/";
const assets = [
  ["tokenizer.json", 17082730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"],
  ["tokenizer_config.json", 443, "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"],
  ["model_quantized.onnx", 118308185, "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193", "onnx/"],
];
const total = assets.reduce((sum, [, size]) => sum + size, 0);

async function validAsset(path, size, checksum) {
  try {
    if ((await stat(path)).size !== size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === checksum;
  } catch { return false; }
}

function semanticModel(directory, download, report) {
  let active;
  let downloaded = 0;
  return {
    async status() {
      const files = await Promise.all(assets.map(([name, size]) =>
        stat(join(directory, name)).then((info) => info.isFile() && info.size === size, () => false)));
      return { ready: files.every(Boolean), downloading: Boolean(active), downloaded, total };
    },
    install() {
      if (active) return active;
      active = (async () => {
        await mkdir(directory, { recursive: true });
        downloaded = 0;
        let finished = 0;
        for (const [name, size, checksum, folder = ""] of assets) {
          const path = join(directory, name);
          if (!await validAsset(path, size, checksum)) {
            const response = await download(modelBase + folder + name, { signal: AbortSignal.timeout(15 * 60_000) });
            if (!response.ok || !response.body) throw new Error("模型下载失败，请检查网络后重试。");
            const hash = createHash("sha256");
            let received = 0;
            let lastReport = 0;
            const meter = new Transform({
              transform(chunk, _encoding, done) {
                received += chunk.length;
                if (received > size) return done(new Error("模型文件大小与预期不符。"));
                hash.update(chunk);
                downloaded = finished + received;
                if (Date.now() - lastReport >= 150) {
                  lastReport = Date.now();
                  report({ downloaded, total });
                }
                done(null, chunk);
              },
            });
            try {
              await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path + ".partial"));
              if (received !== size || hash.digest("hex") !== checksum) throw new Error("模型文件校验失败，请重试。");
              await rename(path + ".partial", path);
            } finally {
              await rm(path + ".partial", { force: true }).catch(() => {});
            }
          }
          finished += size;
          downloaded = finished;
          report({ downloaded, total });
        }
      })().finally(() => { active = null; });
      return active;
    },
  };
}

module.exports = { semanticModel, assets, validAsset };
