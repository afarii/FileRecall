"use strict";

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, safeStorage, shell, Tray } = require("electron");
const { existsSync } = require("node:fs");
const { lstat } = require("node:fs/promises");
const { join } = require("node:path");
const { setInterval: every, clearInterval: stopEvery } = require("node:timers");
const { setInterval, clearInterval } = require("node:timers");
const { FileIndex } = require("./indexer.cjs");
const { DirectoryMonitor } = require("./monitor.cjs");
const { DownloadSources, downloadPathStatus } = require("./download-sources.cjs");
const { chromeConnection } = require("./chrome-connection.cjs");
const { createHotkey } = require("./hotkey.cjs");
const { semanticModel } = require("./semantic-model.cjs");
const { createSemanticSearch } = require("./semantic-search.cjs");
const { createProvenance } = require("./provenance.cjs");
const { NtfsSourceLinks, createNtfsProvenance, verifiedTarget } = require("./ntfs-provenance.cjs");
const { MotwMemory } = require("./motw-memory.cjs");
const { createAria2Connection } = require("./aria2-connection.cjs");
const { createDesktopUpdates } = require("./desktop-updates.cjs");
const { createNtfsService } = require("./ntfs-service.cjs");
const { createSearchService } = require("./search-service.cjs");
const { createPerformanceDiagnostics } = require("./performance-diagnostics.cjs");
const { safeHttpUrl } = require("./motw.cjs");
const appIconDataURL = require("./app-icon.cjs");
const appIcon = () => nativeImage?.createFromDataURL(appIconDataURL);

let window;
let index;
let monitor;
let hotkey;
let semantic;
let aria2;
let updates;
let ntfs;
let searches;
let diagnostics;
let ntfsClosing;
let lastTrackedDrives = "";
let searchKeyTimer;
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

function trackedDrives() {
  return [...new Set((index?.roots() ?? []).map(({ path }) => /^[a-z]:/i.test(path) ? path[0].toUpperCase() : null).filter(Boolean))].sort();
}

function notifyChanged() {
  if (ntfs && index) {
    const drives = trackedDrives();
    const key = drives.join("");
    if (key !== lastTrackedDrives) {
      lastTrackedDrives = key;
      void ntfs.setTrackedDrives(drives).catch(() => {});
    }
  }
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
    icon = new Tray(appIcon() ?? join(__dirname, "tray-icon.ico"));
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
    backgroundColor: "#ffffff",
    icon: appIcon(),
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#ffffff", symbolColor: "#526175", height: 52 },
    } : {}),
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
  diagnostics = createPerformanceDiagnostics(userData);
  ipcMain.handle("diagnostics:get", () => diagnostics.snapshot());
  ipcMain.handle("diagnostics:copy", () => {
    clipboard.writeText(JSON.stringify(diagnostics.snapshot(), null, 2));
    return true;
  });
  ipcMain.handle("diagnostics:reveal", () => {
    shell.showItemInFolder(diagnostics.file);
    return true;
  });
  ipcMain.handle("diagnostics:renderer-lag", (_event, lag) => {
    diagnostics.recordRendererLag(lag);
  });
  index = new FileIndex(databasePath);
  monitor = new DirectoryMonitor(index, { onChange: notifyChanged });
  const modelPath = join(userData, "models", "multilingual-e5-small");
  const packagedWindows = app.isPackaged && process.platform === "win32";
  if (packagedWindows) app.setAppUserModelId("com.filerecall.desktop");
  if (packagedWindows) {
    const ntfsReader = join(process.resourcesPath, "native", "filerecall-ntfs.exe");
    if (existsSync(ntfsReader)) {
      try {
        ntfs = createNtfsService(join(userData, "ntfs-index.sqlite"), userData, ntfsReader, {
          trackedDrives: trackedDrives(),
          onChange: (state) => send("ntfs:changed", state),
          onPaths: (drive, paths) => monitor.applyJournal(drive, paths),
          onActiveDrives: (drives) => monitor.setJournalDrives(drives),
          onMetrics: (metrics) => diagnostics.setNtfsMetrics(metrics),
          onSourcesChanged: () => send("downloads:changed"),
        });
        lastTrackedDrives = trackedDrives().join("");
      } catch (error) {
        console.warn("NTFS index unavailable:", error.message);
      }
    }
  }
  searches = createSearchService({
    localDatabase: databasePath,
    ntfsDatabase: ntfs ? join(userData, "ntfs-index.sqlite") : null,
    downloadsDatabase: join(userData, "browser-downloads.sqlite"),
    motwDatabase: join(userData, "motw-memory.sqlite"),
    applicationData: userData,
    onMetric: (kind, durationMs) => diagnostics.recordSearch(kind, durationMs),
  });
  const ntfsStatus = () => ntfs?.status() ?? { available: false, connected: false, drives: [] };
  ipcMain.handle("ntfs:status", ntfsStatus);
  ipcMain.handle("ntfs:connect", () => ntfs?.reconnect() ?? ntfsStatus());
  ipcMain.handle("ntfs:retry-auto", async () => { await ntfs?.retryAutomatically(); return ntfsStatus(); });
  ipcMain.handle("ntfs:enable", (_event, drive) => ntfs?.enable(drive) ?? ntfsStatus());
  ipcMain.handle("ntfs:disable", (_event, drive) => ntfs?.disable(drive) ?? ntfsStatus());
  ipcMain.handle("files:search-unified", (_event, query, favoritesOnly, deep) =>
    (deep === true ? searches.searchUnifiedDeep : searches.searchUnified)(
      query, ntfs?.searchableDrives() ?? [], Boolean(favoritesOnly)));
  ipcMain.handle("ntfs:favorite", async (_event, drive, id, enabled) => {
    if (!ntfs || typeof enabled !== "boolean") return false;
    const ok = await ntfs.favorite(drive, id, enabled);
    if (ok) notifyChanged();
    return ok;
  });
  ipcMain.handle("ntfs:search", (_event, query) => ntfs
    ? searches.searchNtfs(query, ntfs.searchableDrives()) : []);
  ipcMain.handle("ntfs:search-deep", (_event, query) => ntfs
    ? searches.searchNtfsDeep(query, ntfs.searchableDrives()) : []);
  ipcMain.handle("ntfs:motw", async (_event, drive, id) => {
    return await ntfs?.captureMotw(drive, id) ?? null;
  });
  ipcMain.handle("ntfs:reveal", async (_event, drive, id) => {
    const path = await ntfs?.target(drive, id);
    if (!path) return false;
    try {
      if ((await lstat(path)).isSymbolicLink() || await ntfs.target(drive, id) !== path) return false;
      shell.showItemInFolder(path);
      void ntfs.recordUse(drive, id).catch(() => {});
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
  // This tiny database is accessed only on source-detail actions, never on
  // the filename keystroke hot path. Open and close each operation explicitly.
  async function withNtfsProvenance(action) {
    const links = new NtfsSourceLinks(join(userData, "ntfs-source-links.sqlite"));
    try {
      return await action(createNtfsProvenance({
        links, target: (drive, id) => ntfs?.sourceTarget(drive, id),
        resolve: (volume, id) => ntfs?.sourceTargetForVolume(volume, id),
        readDownloads, legacyLinked: (id) => Boolean(index.linkedIdentity(id)),
      }), links);
    } finally { links.close(); }
  }
  ipcMain.handle("ntfs:provenance", (_event, drive, id) =>
    withNtfsProvenance((service) => service.details(drive, id)));
  ipcMain.handle("ntfs:decide-source", (_event, drive, id, identity, downloadId, decision) =>
    monitor.run(() => withNtfsProvenance(async (service) => {
      const result = await service.decide(drive, id, identity, downloadId, decision);
      send("downloads:changed");
      return result;
    })));
  const motwPath = join(userData, "motw-memory.sqlite");
  function motwRecord(id) {
    if (typeof id !== "string" || !/^motw:[a-f0-9]{64}$/.test(id) || !existsSync(motwPath)) return null;
    const memory = new MotwMemory(motwPath, { readOnly: true });
    try { return memory.byId(id) ?? null; } finally { memory.close(); }
  }
  async function resolveMotw(row) {
    if (!row) return null;
    if (row.deleted) return { path: row.path, name: row.name, status: "missing" };
    const current = await verifiedTarget(await ntfs?.sourceTargetForVolume(row.volume, row.frn));
    if (current?.identity === row.identity)
      return { path: current.path, name: require("node:path").win32.basename(current.path), status: "present" };
    // Offline, journal catch-up or inaccessible files are unverified, not deleted.
    return null;
  }
  async function linkedDownload(id) {
    if (typeof id !== "string" || id.length > 160) return null;
    if (id.startsWith("motw:")) return resolveMotw(motwRecord(id));
    const linked = await withNtfsProvenance((service) => service.linkedFile(id));
    return linked ?? index.linkedFile(id);
  }
  ipcMain.handle("downloads:reveal-linked", async (_event, id) => {
    const file = await linkedDownload(id);
    if (file?.status !== "present") return false;
    shell.showItemInFolder(file.path);
    return true;
  });
  ipcMain.handle("provenance:local", (_event, path) => provenance.local(path));
  ipcMain.handle("provenance:decide", (_event, path, identity, id, decision) => monitor.run(() =>
    withNtfsProvenance((_service, links) => {
      if (decision === "confirmed" && links.byDownload(id)) throw new Error("此下载已关联其他文件。");
      return provenance.decide(path, identity, id, decision);
    })));
  ipcMain.handle("provenance:download", (_event, id) => linkedDownload(id));
  ipcMain.handle("files:annotate", (_event, path, expectedIdentity, input) => monitor.run(async () => {
    const identity = await index.sourceIdentity(path);
    if (!identity || identity !== expectedIdentity) throw new Error("文件状态已改变，请重新打开详情。");
    const result = index.annotate(identity, input);
    notifyChanged();
    return result;
  }));
  ipcMain.handle("downloads:search", async (_event, query, manager) => {
    // Live typing needs a small, cheap first page; each path status check is disk I/O.
    const rows = await searches.searchDownloads(query);
    const scoped = manager === "chrome" || manager === "aria2"
      ? rows.filter((row) => row.manager === manager) : rows;
    return Promise.all(scoped.map(async (row) => {
      if (row.manager === "motw") {
        const linked = await resolveMotw(motwRecord(row.id));
        return { ...row, path: linked?.path ?? row.path, name: linked?.name ?? row.name,
          pathStatus: linked?.status ?? "unknown" };
      }
      return { ...row, pathStatus: await downloadPathStatus(row.path) };
    }));
  });
  ipcMain.handle("downloads:open-source", async (_event, id) => {
    const memory = typeof id === "string" && id.startsWith("motw:") ? motwRecord(id) : null;
    const url = memory ? safeHttpUrl(memory.referrer) || safeHttpUrl(memory.host)
      : readDownloads((sources) => sources.sourceToOpen(id), null);
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
  ipcMain.handle("files:search", (_event, query) => searches.searchLocal(query));
  ipcMain.handle("files:motw", (_event, path) => index.motwEvidence(path));
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
    index.recordUse(path);
    return { ok: true };
  });
  ipcMain.handle("files:open", async (_event, path) => {
    const target = await fileTarget(path);
    if (!target) return unavailableFile;
    const error = await shell.openPath(target);
    if (!error) index.recordUse(path);
    return error ? { ok: false, message: "系统无法打开此文件。" } : { ok: true };
  });
  ipcMain.handle("files:copy-path", async (_event, kind, key) => {
    if (typeof key !== "string") return false;
    const path = kind === "local" ? (await fileTarget(key) ?? index.get(key)?.path)
      : kind === "download" && key.length <= 160 ? (key.startsWith("motw:") ? motwRecord(key)?.path : readDownloads((sources) => sources.byId(key)?.path, null)) : null;
    if (!path) return false;
    clipboard.writeText(path);
    return true;
  });

  if (process.platform === "win32" && Tray) createTray();
  createWindow();
  monitor.start();
  // Existing authorized-folder indexes migrate in bounded background batches.
  let searchKeyRounds = 0;
  searchKeyTimer = every(() => {
    if (closing || !index) return;
    try {
      const updated = index.backfillSearchKeys(24);
      if (!updated) {
        stopEvery(searchKeyTimer);
        searchKeyTimer = undefined;
      } else if (++searchKeyRounds % 12 === 0) {
        notifyChanged();
      }
    } catch {
      stopEvery(searchKeyTimer);
      searchKeyTimer = undefined;
    }
  }, 350);
  searchKeyTimer.unref();
  // The window stays responsive while the read-only helper requests Windows authorization.
  if (ntfs) void ntfs.startAutomatically().catch(() => {});
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
    stopEvery(searchKeyTimer);
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
    Promise.allSettled([monitor.close(), ntfsClosing, searches?.close(), diagnostics?.close()]).then(() => {
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
