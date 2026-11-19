"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { access, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { promisify } = require("node:util");

const hostName = "com.filerecall.desktop";
const registryKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + hostName;
const run = promisify(execFile);

function extensionId(value) {
  if (typeof value !== "string" || !/^[a-p]{32}$/.test(value.trim())) return null;
  return value.trim();
}

function chromeConnection(userData, resourcesPath) {
  const manifestPath = join(userData, "chrome-host.json");
  const launcherPath = join(resourcesPath, "native", "filerecall-host.exe");
  const registry = (args) => run(join(process.env.SystemRoot, "System32", "reg.exe"), args, { windowsHide: true });
  return {
    async status() {
      try {
        await registry(["query", registryKey, "/ve", "/f", manifestPath, "/d", "/e"]);
        await access(launcherPath);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const origin = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(manifest.allowed_origins?.[0]);
        if (manifest.name === hostName && manifest.path === launcherPath && manifest.type === "stdio"
          && manifest.allowed_origins?.length === 1 && origin) return origin[1];
      } catch {
        return null;
      }
      return null;
    },
    async connect(value) {
      const id = extensionId(value);
      if (!id) throw new Error("请输入有效的 Chrome 扩展 ID。");
      await access(launcherPath);
      const manifest = {
        name: hostName,
        description: "FileRecall local download sync",
        path: launcherPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${id}/`],
      };
      const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(manifest), { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, manifestPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
      await registry(["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
      return id;
    },
  };
}

module.exports = { chromeConnection };
