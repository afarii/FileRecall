"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");

let window;
let index;
let scanning = false;
let quitAfterScan = false;

const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

async function guardedScan(action) {
  if (scanning) throw new Error("正在扫描文件，请稍后重试。");
  scanning = true;
  try {
    return await action();
  } finally {
    scanning = false;
    if (quitAfterScan) app.quit();
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: "FileRecall",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const dev = process.env.FILERECALL_DEV_SERVER;
  if (dev === "http://127.0.0.1:5173") {
    window.loadURL(dev);
  } else {
    window.loadFile(join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  if (!ownsLock) return;
  index = new FileIndex(join(app.getPath("userData"), "files.sqlite"));

  ipcMain.handle("folders:list", () => index.roots());
  ipcMain.handle("history:folders", () => index.historyRoots());
  ipcMain.handle("history:clear", (_event, path) => guardedScan(() => index.clearHistory(path)));
  ipcMain.handle("folders:remove", (_event, path) => guardedScan(() => index.removeRoot(path)));
  ipcMain.handle("folders:add", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择要索引的文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return guardedScan(() => index.addRoot(result.filePaths[0]));
  });
  ipcMain.handle("folders:rescan", () => guardedScan(async () => {
    const results = [];
    for (const root of index.roots()) {
      try {
        results.push(await index.scan(root.path));
      } catch (error) {
        results.push({ folder: root.path, complete: false, error: String(error.message || error) });
      }
    }
    return results;
  }));
  ipcMain.handle("files:search", (_event, query) => index.search(query));
  ipcMain.handle("files:reveal", (_event, path) => {
    if (typeof path !== "string") return { ok: false, message: "无效路径。" };
    const record = index.get(path);
    if (!record || record.status !== "present" || !existsSync(record.path)) {
      return { ok: false, message: "文件已丢失，请重新扫描以更新状态。" };
    }
    shell.showItemInFolder(record.path);
    return { ok: true };
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  dialog.showErrorBox("FileRecall 启动失败", String(error.message || error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (scanning) {
    event.preventDefault();
    quitAfterScan = true;
    return;
  }
  index?.close();
  index = undefined;
});
