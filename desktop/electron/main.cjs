"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");
const { DirectoryMonitor } = require("./monitor.cjs");

let window;
let index;
let monitor;
let closing = false;
let quitReady = false;

const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

function notifyChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("library:changed");
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
  monitor = new DirectoryMonitor(index, { onChange: notifyChanged });

  ipcMain.handle("folders:list", () => index.roots().map((root) => ({ ...root, ...monitor.status(root.path) })));
  ipcMain.handle("history:folders", () => index.historyRoots());
  ipcMain.handle("history:clear", (_event, path) => monitor.run(() => {
    const removed = index.clearHistory(path);
    monitor.syncRoots();
    return removed;
  }));
  ipcMain.handle("folders:remove", (_event, path) => monitor.run(() => {
    index.removeRoot(path);
    monitor.syncRoots();
  }));
  ipcMain.handle("folders:add", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择要索引的文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return monitor.run(async () => {
      const scan = await index.addRoot(result.filePaths[0]);
      monitor.syncRoots();
      return scan;
    });
  });
  ipcMain.handle("folders:rescan", () => monitor.run(async () => {
    monitor.syncRoots();
    const results = [];
    for (const root of index.roots()) {
      const result = await monitor.scanRoot(root.path);
      if (result) results.push(result);
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
  monitor.start();
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
  if (monitor && !quitReady) {
    event.preventDefault();
    if (closing) return;
    closing = true;
    monitor.close().then(() => {
      index?.close();
      index = undefined;
      quitReady = true;
      app.quit();
    });
    return;
  }
  index?.close();
  index = undefined;
});
