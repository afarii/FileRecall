"use strict";

const { watch } = require("node:fs");
const { lstat } = require("node:fs/promises");
const { resolve } = require("node:path");
const { directoryIdentity, isWithin } = require("./indexer.cjs");

const MAX_PENDING_PATHS = 4096;

class DirectoryMonitor {
  constructor(index, { onChange = () => {}, watchDirectory = watch,
    debounceMs = 500, maxDelayMs = 2000, recoveryMs = 30000, reconcileMs = 30 * 60 * 1000 } = {}) {
    this.index = index;
    this.onChange = onChange;
    this.watchDirectory = watchDirectory;
    this.debounceMs = debounceMs;
    this.maxDelayMs = maxDelayMs;
    this.recoveryMs = recoveryMs;
    this.reconcileMs = reconcileMs;
    this.entries = new Map();
    this.tail = Promise.resolve();
    this.stopped = false;
  }

  // Every database mutation, including manual operations, shares this queue.
  run(action) {
    if (this.stopped) return Promise.reject(new Error("应用正在关闭。"));
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  start() {
    this.syncRoots();
    this.interval = setInterval(() => void this.checkRoots(), this.recoveryMs);
    this.interval.unref();
  }

  async checkRoots() {
    if (this.checkingRoots || this.stopped) return;
    this.checkingRoots = true;
    try {
      for (const entry of this.entries.values()) {
        if (this.stopped) break;
        if (entry.watcher && entry.state !== "scanning" &&
            entry.lastScanAt && Date.now() - entry.lastScanAt >= this.reconcileMs) {
          if (!entry.fullScan) this.requestScan(entry.path, 0);
          continue;
        }
        if (entry.pending || entry.timer) continue;
        if (!entry.watcher || entry.state === "retrying") {
          this.requestScan(entry.path, 0);
          continue;
        }
        const identity = await lstat(entry.path, { bigint: true }).then(directoryIdentity, () => null);
        if (this.entries.get(entry.path) !== entry || this.stopped || entry.pending || entry.timer) continue;
        if (identity !== entry.identity) {
          this.closeWatcher(entry);
          this.requestScan(entry.path, 0);
        }
      }
    } finally {
      this.checkingRoots = false;
    }
  }

  syncRoots() {
    if (this.stopped) return;
    const roots = new Set(this.index.roots().map((root) => root.path));
    for (const [path, entry] of this.entries) {
      if (!roots.has(path)) {
        clearTimeout(entry.timer);
        this.closeWatcher(entry);
        this.entries.delete(path);
      }
    }
    for (const path of roots) {
      if (this.entries.has(path)) continue;
      this.entries.set(path, { path, state: "waiting", error: "", pending: false, paths: new Set() });
      this.requestScan(path, 0);
    }
    this.onChange();
  }

  status(path) {
    const entry = this.entries.get(path);
    return { state: entry?.state ?? "waiting", error: entry?.error ?? "",
      lastScanAt: entry?.lastScanAt ?? null };
  }

  closeWatcher(entry) {
    const watcher = entry.watcher;
    entry.watcher = null;
    watcher?.close();
  }

  async attachWatcher(entry) {
    this.closeWatcher(entry);
    entry.watchError = "";
    try {
      const identity = directoryIdentity(await lstat(entry.path, { bigint: true }));
      if (!identity) throw new Error("目录不可用或已替换为链接。");
      if (this.stopped || this.entries.get(entry.path) !== entry) return;
      const watcher = this.watchDirectory(entry.path, { recursive: true, persistent: false }, (_event, filename) => {
        if (entry.watcher !== watcher || this.stopped) return;
        const path = filename ? resolve(entry.path, String(filename)) : entry.path;
        if (!isWithin(entry.path, path) || entry.paths.size >= MAX_PENDING_PATHS) {
          this.requestScan(entry.path);
        } else if (!this.index.isInternalPath(path) && !entry.fullScan) {
          entry.paths.add(path);
          this.schedule(entry, this.debounceMs);
        }
      });
      entry.watcher = watcher;
      entry.identity = identity;
      const failed = (error) => {
        if (entry.watcher !== watcher || this.stopped) return;
        this.closeWatcher(entry);
        entry.state = "retrying";
        entry.watchError = String(error?.message || "目录监控已断开。");
        entry.error = entry.watchError;
        this.onChange();
        this.requestScan(entry.path);
      };
      watcher.on("error", failed);
      watcher.on("close", () => failed());
    } catch (error) {
      entry.watchError = String(error.message || error);
    }
  }

  requestScan(path, delay = this.debounceMs) {
    const entry = this.entries.get(path);
    if (!entry || this.stopped) return;
    entry.fullScan = true;
    entry.paths.clear();
    this.schedule(entry, delay);
  }

  schedule(entry, delay) {
    if (entry.pending) return;
    entry.burstAt ??= Date.now();
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(delay, entry.burstAt + this.maxDelayMs - Date.now()));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.burstAt = null;
      entry.pending = true;
      this.run(async () => {
        if (this.stopped || this.entries.get(entry.path) !== entry) return;
        const fullScan = entry.fullScan;
        const paths = [...entry.paths];
        entry.fullScan = false;
        entry.paths.clear();
        if (fullScan || !entry.watcher) {
          await this.scanRoot(entry.path);
          return;
        }
        const identity = directoryIdentity(await lstat(entry.path, { bigint: true }));
        if (identity !== entry.identity) throw new Error("授权目录已更换，将重新连接监控。");
        const result = await this.index.updatePaths(entry.path, paths);
        if (!result.complete) throw new Error("变更路径尚未完整读取，将重新扫描授权目录。");
        if (result.changed) this.onChange();
      }).catch((error) => {
        this.closeWatcher(entry);
        entry.state = "retrying";
        entry.error = String(error.message || error);
        this.onChange();
      }).finally(() => {
        entry.pending = false;
        if (!this.stopped && this.entries.get(entry.path) === entry && (entry.fullScan || entry.paths.size)) {
          this.schedule(entry, this.debounceMs);
        }
      });
    }, wait);
    entry.timer.unref();
  }

  async scanRoot(path) {
    const entry = this.entries.get(path);
    if (!entry || this.stopped) return null;
    if (entry.watcher) {
      const identity = await lstat(path, { bigint: true }).then(directoryIdentity, () => null);
      if (identity !== entry.identity) this.closeWatcher(entry);
    }
    if (!entry.watcher) await this.attachWatcher(entry);
    if (this.stopped) return null;
    entry.state = "scanning";
    this.onChange();
    let result;
    try {
      result = await this.index.scan(path);
      entry.error = result.complete ? entry.watchError : "扫描不完整，历史状态已保留，稍后自动重试。";
    } catch (error) {
      result = { folder: path, complete: false, error: String(error.message || error) };
      entry.error = result.error;
      this.closeWatcher(entry);
    }
    entry.lastScanAt = Date.now();
    entry.state = result.complete && entry.watcher ? "watching" : "retrying";
    this.onChange();
    return result;
  }

  close() {
    this.stopped = true;
    clearInterval(this.interval);
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      this.closeWatcher(entry);
    }
    return this.tail;
  }
}

module.exports = { DirectoryMonitor };
