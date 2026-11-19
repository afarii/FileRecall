"use strict";

const { watch } = require("node:fs");
const { lstat } = require("node:fs/promises");
const { join } = require("node:path");

class DirectoryMonitor {
  constructor(index, { onChange = () => {}, watchDirectory = watch,
    debounceMs = 500, maxDelayMs = 2000, recoveryMs = 30000 } = {}) {
    this.index = index;
    this.onChange = onChange;
    this.watchDirectory = watchDirectory;
    this.debounceMs = debounceMs;
    this.maxDelayMs = maxDelayMs;
    this.recoveryMs = recoveryMs;
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
    this.interval = setInterval(() => {
      this.syncRoots();
      for (const entry of this.entries.values()) {
        entry.refreshWatcher = true;
        this.requestScan(entry.path, 0);
      }
    }, this.recoveryMs);
    this.interval.unref();
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
      this.entries.set(path, { path, state: "waiting", error: "", pending: false });
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
    entry.refreshWatcher = false;
    entry.watchError = "";
    try {
      const info = await lstat(entry.path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("目录不可用或已替换为链接。");
      if (this.stopped || this.entries.get(entry.path) !== entry) return;
      const watcher = this.watchDirectory(entry.path, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename && this.index.isInternalPath(join(entry.path, String(filename)))) return;
        this.requestScan(entry.path);
      });
      entry.watcher = watcher;
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
    if (entry.pending) {
      entry.dirty = true;
      return;
    }
    entry.burstAt ??= Date.now();
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(delay, entry.burstAt + this.maxDelayMs - Date.now()));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.burstAt = null;
      entry.pending = true;
      this.run(async () => {
        if (this.stopped || this.entries.get(path) !== entry) return;
        await this.scanRoot(path);
      }).catch((error) => {
        entry.state = "retrying";
        entry.error = String(error.message || error);
        this.onChange();
      }).finally(() => {
        entry.pending = false;
        if (entry.dirty) {
          entry.dirty = false;
          this.requestScan(path);
        }
      });
    }, wait);
    entry.timer.unref();
  }

  async scanRoot(path) {
    const entry = this.entries.get(path);
    if (!entry || this.stopped) return null;
    if (!entry.watcher || entry.refreshWatcher) await this.attachWatcher(entry);
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
