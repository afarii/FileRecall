"use strict";

const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");
const { join } = require("node:path");

function unquote(value) {
  return Buffer.from(value, "base64").toString("utf16le");
}

function startNtfsReader(executable, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const session = randomUUID();
    const proxy = spawn(executable, ["proxy", session], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: proxy.stdout });
    let active;
    let ready = false;
    let closed = false;
    const startup = setTimeout(() => finish(new Error("未连接到 NTFS 助手，请确认 UAC 授权。")), 65000);
    function finish(error = new Error("NTFS 助手已断开。")) {
      if (closed) return;
      closed = true;
      clearTimeout(startup);
      if (active) {
        clearTimeout(active.timer);
        active.reject(error);
        active = undefined;
      }
      if (!ready) reject(error);
      proxy.stdin.end();
      proxy.kill();
      lines.close();
    }
    signal?.addEventListener("abort", () => finish(), { once: true });
    if (signal?.aborted) {
      finish();
      return;
    }
    proxy.on("error", finish);
    proxy.stdin.on("error", finish);
    proxy.on("exit", () => finish());
    const reader = {
      get closed() { return closed; },
      close: finish,
      request(...args) {
        if (closed || active) return Promise.reject(new Error("无法向 NTFS 助手发送请求。"));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("NTFS 助手读取超时。")), 60000);
          active = { resolve, reject, timer, result: { rows: [] } };
          proxy.stdin.write(args.join("\t") + "\n");
        });
      },
    };
    lines.on("line", (line) => {
      if (!ready && line === "READY") {
        ready = true;
        clearTimeout(startup);
        resolve(reader);
        return;
      }
      if (!active) return;
      const [kind, ...fields] = line.split("\t");
      if (kind === ".") {
        const { result, resolve, reject, timer, error } = active;
        active = undefined;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      } else if (kind === "V") {
        [active.result.volume, active.result.journal, active.result.first, active.result.next] = fields;
      } else if (kind === "R") {
        const [id, parent, reason, attributes, directory, name] = fields;
        active.result.rows.push({ id, parent, reason: Number(reason), attributes: Number(attributes),
          directory: unquote(directory), name: unquote(name) });
      } else if (kind === "NEXT") {
        [active.result.next] = fields;
      } else if (kind === "END") {
        active.result.end = true;
      } else if (kind === "ERR") {
        const code = Number(fields[0]);
        active.error = Object.assign(new Error(`无法读取 NTFS（Windows 错误 ${code}）。`), { code });
      } else {
        finish(new Error("NTFS 助手协议不匹配。"));
      }
    });
    const safePath = executable.replaceAll("'", "''");
    const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath '${safePath}' -ArgumentList 'serve','${session}' -Verb RunAs -WindowStyle Hidden`;
    const script = Buffer.from(command, "utf16le").toString("base64");
    execFile(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], { windowsHide: true, signal }, (error) => {
        if (error) finish(new Error("NTFS 助手未获管理员授权。"));
      });
  });
}

module.exports = { startNtfsReader };
