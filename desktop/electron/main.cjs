"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, net, Notification, safeStorage, shell, Tray } = require("electron");
const { existsSync } = require("node:fs");
const { lstat } = require("node:fs/promises");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");
const { DirectoryMonitor } = require("./monitor.cjs");
const { DownloadSources, downloadPathStatus } = require("./download-sources.cjs");
const { chromeConnection } = require("./chrome-connection.cjs");
const { createHotkey } = require("./hotkey.cjs");
const { semanticModel } = require("./semantic-model.cjs");
const { createSemanticSearch } = require("./semantic-search.cjs");
const { createProvenance } = require("./provenance.cjs");
const { createAria2Connection } = require("./aria2-connection.cjs");
const { createDesktopUpdates } = require("./desktop-updates.cjs");
const { NtfsSearch } = require("./ntfs-search.cjs");

let window;
let index;
let monitor;
let hotkey;
let semantic;
let aria2;
let updates;
let ntfs;
let ntfsClosing;
let updateNotification;
let tray;
let closing = false;
let quitReady = false;

// Keep the development and installed builds on the same Windows library.
if (process.platform === "win32") {
  app.setPath("userData", join(process.env.APPDATA || app.getPath("appData"), "filerecall-desktop"));
}
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on("second-instance", showWindow);

function notifyChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("library:changed");
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function showWindow() {
  if (closing || !index) return null;
  if (!window || window.isDestroyed()) createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function focusSearch() {
  const target = showWindow();
  if (!target) return;
  if (target.webContents.isLoadingMainFrame()) {
    target.webContents.once("did-finish-load", () => send("search:focus"));
  } else {
    send("search:focus");
  }
}

function createTray() {
  let icon;
  try {
    icon = new Tray(join(__dirname, "tray-icon.ico"));
    icon.setToolTip("FileRecall");
    icon.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 FileRecall", click: showWindow },
      { label: "搜索文件", click: focusSearch },
      { type: "separator" },
      { label: "退出 FileRecall", click: () => app.quit() },
    ]));
    icon.on("click", showWindow);
    tray = icon;
  } catch (error) {
    icon?.destroy();
    console.warn("FileRecall system tray unavailable:", error.message);
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
  const current = window;
  current.on("close", (event) => {
    if (tray && !closing) {
      event.preventDefault();
      current.hide();
    }
  });
  current.on("closed", () => { if (window === current) window = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const dev = process.env.FILERECALL_DEV_SERVER;
  if (!app.isPackaged && dev === "http://127.0.0.1:5173") {
    window.loadURL(dev);
  } else {
    window.loadFile(join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  if (!ownsLock) return;
  const userData = app.getPath("userData");
  const databasePath = join(userData, "files.sqlite");
  index = new FileIndex(databasePath);
  monitor = new DirectoryMonitor(index, { onChange: notifyChanged });
  const modelPath = join(userData, "models", "multilingual-e5-small");
  const packagedWindows = app.isPackaged && process.platform === "win32";
  if (packagedWindows) app.setAppUserModelId("com.filerecall.desktop");
  if (packagedWindows) {
    const ntfsReader = join(process.resourcesPath, "native", "filerecall-ntfs.exe");
    if (existsSync(ntfsReader)) {
      try {
        ntfs = new NtfsSearch(join(userData, "ntfs-index.sqlite"), userData, ntfsReader, {
          onChange: (state) => send("ntfs:changed", state),
          onPaths: (drive, paths) => monitor.applyJournal(drive, paths),
          onActiveDrives: (drives) => monitor.setJournalDrives(drives),
        });
      } catch (error) {
        console.warn("NTFS index unavailable:", error.message);
      }
    }
  }
  const ntfsStatus = () => ntfs?.status() ?? { available: false, connected: false, drives: [] };
  ipcMain.handle("ntfs:status", ntfsStatus);
  ipcMain.handle("ntfs:connect", () => ntfs?.reconnect() ?? ntfsStatus());
  ipcMain.handle("ntfs:enable", (_event, drive) => ntfs?.enable(drive) ?? ntfsStatus());
  ipcMain.handle("ntfs:disable", (_event, drive) => ntfs?.disable(drive) ?? ntfsStatus());
  ipcMain.handle("ntfs:search", (_event, query) => ntfs?.search(query) ?? []);
  ipcMain.handle("ntfs:reveal", async (_event, drive, id) => {
    const path = ntfs?.target(drive, id);
    if (!path) return false;
    try {
      if ((await lstat(path)).isSymbolicLink() || ntfs.target(drive, id) !== path) return false;
      shell.showItemInFolder(path);
      return true;
    } catch {
      return false;
    }
  });
  updates = createDesktopUpdates({
    currentVersion: app.getVersion?.() ?? "",
    updater: packagedWindows ? require("electron-updater").autoUpdater : null,
    onChange: (status) => send("updates:changed", status),
    onAvailable: (version) => {
      if (!Notification?.isSupported()) return;
      updateNotification?.close();
      const notification = new Notification({
        title: "FileRecall 有新版",
        body: `版本 ${version} 已可下载。打开 FileRecall，在「软件更新」中继续。`,
      });
      updateNotification = notification;
      notification.on("click", showWindow);
      try {
        notification.show();
      } catch (error) {
        console.warn("FileRecall update notification unavailable:", error.message);
      }
    },
  });
  ipcMain.handle("updates:status", updates.status);
  ipcMain.handle("updates:check", updates.check);
  ipcMain.handle("updates:download", updates.download);
  ipcMain.handle("updates:install", () => monitor.run(updates.install));
  const model = semanticModel(modelPath, (url, options) => net.fetch(url, options), (progress) => send("semantic:download-progress", progress));
  semantic = createSemanticSearch(databasePath, modelPath, (progress) => send("semantic:search-progress", progress));
  hotkey = createHotkey(globalShortcut, userData, focusSearch);
  ipcMain.handle("hotkey:status", () => hotkey.status());
  ipcMain.handle("hotkey:update", (_event, value) => hotkey.update(value));
  ipcMain.handle("semantic:status", () => model.status());
  ipcMain.handle("semantic:install", async () => {
    semantic.clear();
    await model.install();
    return model.status();
  });
  ipcMain.handle("semantic:search", async (_event, rawQuery) => {
    if (closing || !index) throw new Error("应用正在关闭。");
    const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 200) : "";
    if (!query) return { files: [], indexed: 0, truncated: false };
    if (!index.textEnabled()) throw new Error("请先启用正文索引。");
    if (!(await model.status()).ready) throw new Error("请先下载语义模型。");
    if (closing || !index?.textEnabled()) throw new Error("正文索引已关闭或应用正在退出。");
    const { matches, indexed, truncated } = await semantic.search(query);
    const files = matches.map((match) => index?.semanticMatch(match)).filter(Boolean);
    return { files, indexed, truncated };
  });
  const downloadsPath = join(userData, "browser-downloads.sqlite");
  aria2 = createAria2Connection(userData, safeStorage, (records) => {
    if (!records.length) return 0;
    const sources = new DownloadSources(downloadsPath);
    try { return sources.importAria2(records); }
    finally { sources.close(); }
  }, () => send("downloads:changed"));
  ipcMain.handle("aria2:status", () => aria2.status());
  ipcMain.handle("aria2:connect", (_event, port, secret) => aria2.connect(port, secret));
  ipcMain.handle("aria2:refresh", () => aria2.refresh());
  ipcMain.handle("aria2:disconnect", () => aria2.disconnect());
  const connection = app.isPackaged && process.platform === "win32"
    ? chromeConnection(app.getPath("userData"), process.resourcesPath)
    : null;
  ipcMain.handle("chrome:status", async () => ({
    available: Boolean(connection),
    extensionId: await connection?.status() ?? null,
  }));
  ipcMain.handle("chrome:connect", (_event, id) => connection?.connect(id) ?? null);
  function readDownloads(action, fallback) {
    if (!existsSync(downloadsPath)) return fallback;
    const sources = new DownloadSources(downloadsPath, { readOnly: true });
    try {
      return action(sources);
    } finally {
      sources.close();
    }
  }
  const provenance = createProvenance(index, readDownloads);
  ipcMain.handle("provenance:local", (_event, path) => provenance.local(path));
  ipcMain.handle("provenance:decide", (_event, path, identity, id, decision) => monitor.run(() =>
    provenance.decide(path, identity, id, decision)));
  ipcMain.handle("provenance:download", (_event, id) =>
    typeof id === "string" && id.length <= 160 ? index.linkedFile(id) : null);
  ipcMain.handle("files:annotate", (_event, path, expectedIdentity, input) => monitor.run(async () => {
    const identity = await index.sourceIdentity(path);
    if (!identity || identity !== expectedIdentity) throw new Error("文件状态已改变，请重新打开详情。");
    const result = index.annotate(identity, input);
    notifyChanged();
    return result;
  }));
  ipcMain.handle("downloads:search", async (_event, query, manager) => {
    const rows = readDownloads((sources) => sources.search(query, manager), []);
    return Promise.all(rows.map(async (row) => ({ ...row, pathStatus: await downloadPathStatus(row.path) })));
  });
  ipcMain.handle("downloads:open-source", async (_event, id) => {
    const url = readDownloads((sources) => sources.sourceToOpen(id), null);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle("provenance:open-source", async (_event, path, id) => {
    if (typeof id !== "string" || id.length > 160) return false;
    const identity = await index.sourceIdentity(path);
    if (!identity || index.linkedIdentity(id) !== identity) return false;
    const url = readDownloads((sources) => sources.sourceToOpen(id), null);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("folders:list", () => index.roots().map((root) => ({ ...root, ...monitor.status(root.path) })));
  ipcMain.handle("history:folders", () => index.historyRoots());
  ipcMain.handle("history:clear", (_event, path) => monitor.run(() => {
    const removed = index.clearHistory(path);
    semantic.clear();
    monitor.syncRoots();
    return removed;
  }));
  ipcMain.handle("folders:remove", (_event, path) => monitor.run(() => {
    index.removeRoot(path);
    semantic.clear();
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
  ipcMain.handle("files:text-enabled", () => index.textEnabled());
  ipcMain.handle("files:set-text-enabled", (_event, enabled) => monitor.run(() => {
    index.setTextEnabled(enabled);
    if (!enabled) semantic.clear();
    if (enabled) {
      for (const root of index.roots()) monitor.requestScan(root.path, 0);
    }
    notifyChanged();
  }));
  async function fileTarget(path) {
    if (typeof path !== "string") return null;
    const record = index.get(path);
    if (!record) return null;
    if (record.status === "missing") return index.movedTarget(path);
    if (record.identity) return await index.sourceIdentity(path) === record.identity ? path : null;
    return await lstat(path).then((info) => info.isFile() ? path : null, () => null);
  }
  const unavailableFile = { ok: false, message: "文件已丢失或发生变化，请重新扫描。" };
  ipcMain.handle("files:reveal", async (_event, path) => {
    const target = await fileTarget(path);
    if (!target) return unavailableFile;
    shell.showItemInFolder(target);
    return { ok: true };
  });
  ipcMain.handle("files:open", async (_event, path) => {
    const target = await fileTarget(path);
    if (!target) return unavailableFile;
    const error = await shell.openPath(target);
    return error ? { ok: false, message: "系统无法打开此文件。" } : { ok: true };
  });
  ipcMain.handle("files:copy-path", async (_event, kind, key) => {
    if (typeof key !== "string") return false;
    const path = kind === "local" ? (await fileTarget(key) ?? index.get(key)?.path)
      : kind === "download" && key.length <= 160 ? readDownloads((sources) => sources.byId(key)?.path, null) : null;
    if (!path) return false;
    clipboard.writeText(path);
    return true;
  });

  if (process.platform === "win32" && Tray) createTray();
  createWindow();
  monitor.start();
  app.on("activate", showWindow);
}).catch((error) => {
  dialog.showErrorBox("FileRecall 启动失败", String(error.message || error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray && !closing) app.quit();
});

app.on("before-quit", (event) => {
  if (!closing) {
    hotkey?.close();
    semantic?.clear();
    aria2?.close();
    updates?.close();
    updateNotification?.close();
    ntfsClosing = ntfs?.close();
  }
  if (monitor && !quitReady) {
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.allSettled([monitor.close(), ntfsClosing]).then(() => {
      index?.close();
      index = undefined;
      quitReady = true;
      app.quit();
    });
    return;
  }
  closing = true;
  tray?.destroy();
  tray = undefined;
  index?.close();
  index = undefined;
});
