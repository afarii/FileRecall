"use strict";

const { readFile, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { readCompleted } = require("./aria2.cjs");

function createAria2Connection(userData, safeStorage, saveRecords, onChange) {
  const settingsPath = join(userData, "aria2-settings.json");
  const settings = readFile(settingsPath, "utf8").then((raw) => {
    const value = JSON.parse(raw);
    return Number.isInteger(value?.port) && value.port >= 1 && value.port <= 65535 ? value : null;
  }).catch(() => null);
  let configured = settings;
  let running;

  function secretFor(config) {
    if (!config?.token) return "";
    try { return safeStorage.decryptString(Buffer.from(config.token, "base64")); }
    catch { throw new Error("无法读取保存的 RPC 密钥，请重新输入。"); }
  }

  async function sync(config) {
    if (!config) throw new Error("请先连接 Motrix／aria2。");
    const records = await readCompleted(config.port, secretFor(config));
    const changed = saveRecords(records);
    if (changed) onChange();
    return { found: records.length, changed };
  }

  function exclusive(action) {
    if (running) throw new Error("正在读取下载记录，请稍后重试。");
    running = action().finally(() => { running = null; });
    return running;
  }

  const timer = setInterval(() => {
    if (running) return;
    void exclusive(async () => {
      const config = await configured;
      if (config) await sync(config);
    }).catch(() => {});
  }, 30_000);
  timer.unref();

  return {
    async status() {
      const config = await configured;
      return { connected: Boolean(config), port: config?.port ?? 16800, hasSecret: Boolean(config?.token) };
    },
    connect(port, input) {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof input !== "string" || input.length > 512) {
        throw new Error("请输入 1–65535 之间的端口及有效密钥。");
      }
      return exclusive(async () => {
        const previous = await configured;
        const config = { port };
        if (input) {
          if (!safeStorage?.isEncryptionAvailable()) throw new Error("系统无法加密密钥。");
          config.token = safeStorage.encryptString(input).toString("base64");
        } else if (previous?.port === port && previous.token) {
          config.token = previous.token;
        }
        const result = await sync(config);
        try {
          await writeFile(settingsPath + ".tmp", JSON.stringify(config));
          await rename(settingsPath + ".tmp", settingsPath);
        } finally { await rm(settingsPath + ".tmp", { force: true }).catch(() => {}); }
        configured = Promise.resolve(config);
        return result;
      });
    },
    refresh: () => exclusive(async () => sync(await configured)),
    disconnect: () => exclusive(async () => {
      await rm(settingsPath, { force: true });
      configured = Promise.resolve(null);
    }),
    close() { clearInterval(timer); },
  };
}

module.exports = { createAria2Connection };
