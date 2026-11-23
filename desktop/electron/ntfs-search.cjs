"use strict";

const { NtfsCatalog, fullPath } = require("./ntfs-catalog.cjs");
const { startNtfsReader } = require("./ntfs-reader.cjs");
const { discoverFixedNtfsDrives } = require("./ntfs-auto.cjs");

function driveLetter(value) {
  if (typeof value !== "string" || !/^[a-z]$/i.test(value)) throw new Error("请输入一个本地磁盘盘符，例如 C。");
  return value.toUpperCase();
}

function validateVolume(info) {
  if (!/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(info.volume ?? "") ||
      [info.journal, info.first, info.next].some((value) => !/^\d+$/.test(value ?? ""))) {
    throw new Error("NTFS 助手返回了无效的卷标识。");
  }
  return info;
}

class NtfsSearch {
  constructor(database, userData, executable, { onChange, onPaths, onActiveDrives,
    createReader = startNtfsReader, discoverDrives = discoverFixedNtfsDrives }) {
    this.catalog = new NtfsCatalog(database, userData);
    this.executable = executable;
    this.createReader = createReader;
    this.discoverDrives = discoverDrives;
    this.autoPhase = "idle";
    this.autoMessage = "";
    this.onChange = onChange;
    this.onPaths = onPaths;
    this.onActiveDrives = onActiveDrives;
    this.sessions = new Map();
    this.tail = Promise.resolve();
    this.interval = setInterval(() => this.schedulePoll(), 3000);
    this.interval.unref();
  }

  status() {
    return {
      available: true,
      autoPhase: this.autoPhase,
      autoMessage: this.autoMessage,
      connected: Boolean(this.reader && !this.reader.closed),
      drives: this.catalog.drives().map(({ drive }) => ({
        drive, ...(this.sessions.get(drive) ?? { phase: "disconnected" }),
      })).map(({ drive, phase, message }) => ({ drive, phase, message })),
    };
  }

  notify() {
    if (this.closed) return;
    const status = this.status();
    this.onActiveDrives(status.connected ? status.drives.filter(({ phase }) => phase === "ready").map(({ drive }) => drive) : []);
    this.onChange(status);
  }

  enqueue(action) {
    if (this.closed) return Promise.reject(new Error("FileRecall 正在关闭。"));
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("FileRecall 正在关闭。");
      return action();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async connect() {
    if (!this.reader || this.reader.closed) {
      this.sessions.clear();
      this.connecting = new AbortController();
      try {
        this.reader = await this.createReader(this.executable, { signal: this.connecting.signal });
      } finally {
        this.connecting = undefined;
      }
      if (this.closed) this.reader.close();
    }
    this.schedulePoll();
    this.notify();
  }

  startAutomatically() {
    if (this.autoTask) return this.autoTask;
    this.autoTask = (async () => {
      this.autoPhase = "discovering";
      this.notify();
      let drives;
      try {
        drives = await this.discoverDrives();
      } catch {
        this.autoPhase = "error";
        this.autoMessage = "自动检测磁盘失败，请在整盘搜索中重试。";
        this.notify();
        return;
      }
      if (this.closed) return;
      const excluded = new Set(this.catalog.excluded());
      const pending = drives.filter((drive) => !excluded.has(drive));
      if (!pending.length) {
        this.autoPhase = "idle";
        this.notify();
        return;
      }
      this.autoPhase = "authorizing";
      this.notify();
      let failed = 0;
      for (const drive of pending) {
        if (this.closed) return;
        try {
          await this.enable(drive);
        } catch (error) {
          failed++;
          if (/授权|UAC/.test(String(error?.message))) {
            this.autoPhase = "permission-required";
            this.autoMessage = "Windows 管理员授权未完成，可在整盘搜索中手动重试。";
            this.notify();
            return;
          }
        }
      }
      this.autoPhase = failed ? "error" : "ready";
      this.autoMessage = failed ? "部分磁盘暂时不可用，可以稍后手动重试。" : "";
      this.notify();
    })();
    return this.autoTask;
  }

  enable(value) {
    const drive = driveLetter(value);
    return this.enqueue(async () => {
      await this.connect();
      const info = validateVolume(await this.reader.request("probe", drive));
      const existing = this.catalog.drives().find((entry) => entry.drive === drive);
      if (existing && existing.volume.toLowerCase() !== info.volume.toLowerCase()) {
        throw new Error("盘符现在指向另一个卷。请先停止旧卷索引，再添加当前卷。");
      }
      this.catalog.enable(drive, info.volume);
      this.notify();
      return this.status();
    });
  }

  reconnect() {
    return this.enqueue(async () => {
      await this.connect();
      return this.status();
    });
  }

  disable(value) {
    const drive = driveLetter(value);
    this.cancelled ??= new Set();
    this.cancelled.add(drive);
    return this.enqueue(() => {
      this.catalog.disable(drive);
      this.sessions.delete(drive);
      this.cancelled.delete(drive);
      if (!this.catalog.drives().length) this.reader?.close();
      this.notify();
      return this.status();
    });
  }

  schedulePoll() {
    if (!this.reader || this.polling || this.closed) return;
    if (this.reader.closed) {
      this.reader = undefined;
      this.sessions.clear();
      this.notify();
      return;
    }
    this.polling = true;
    void this.enqueue(async () => {
      try {
        for (const drive of this.catalog.drives()) {
          if (this.closed || this.reader.closed) break;
          try {
            await this.syncDrive(drive);
          } catch (error) {
            this.sessions.set(drive.drive, { phase: "error",
              message: error.code === 1179 ? "该卷未启用 USN 变更日志。" : error.message });
            this.notify();
          }
        }
      } finally {
        this.polling = false;
      }
    }).catch(() => { this.polling = false; });
  }

  async syncDrive(state) {
    const { drive } = state;
    if (this.cancelled?.has(drive)) return;
    const info = validateVolume(await this.reader.request("probe", drive));
    if (info.volume.toLowerCase() !== state.volume.toLowerCase()) {
      throw new Error("此盘符对应的磁盘已更换，旧索引已暂停。");
    }
    const live = this.sessions.get(drive);
    let cursor = (live?.journal === info.journal ? live.cursor : null) ??
      (state.journal === info.journal ? state.cursor : null);
    if (!cursor || BigInt(cursor) < BigInt(info.first) || BigInt(cursor) > BigInt(info.next) || live?.phase === "rebuild") {
      this.sessions.set(drive, { phase: "building" });
      this.notify();
      this.catalog.beginBuild(drive);
      let position = "0";
      while (!this.closed && !this.cancelled?.has(drive)) {
        const batch = await this.reader.request("enum", drive, info.volume, info.journal, position);
        if (batch.end) break;
        if (!batch.next || BigInt(batch.next) <= BigInt(position)) throw new Error("MFT 枚举进度未前进。");
        this.catalog.apply(drive, batch.rows, true);
        position = batch.next;
      }
      if (this.closed || this.cancelled?.has(drive)) return;
      cursor = info.next;
      this.catalog.checkpoint(drive, info.journal, cursor);
    }
    const latest = info.next;
    // Bound catch-up work so another selected volume can also make progress.
    for (let page = 0; page < 12 && !this.closed && !this.cancelled?.has(drive); page++) {
      if (BigInt(cursor) >= BigInt(latest)) break;
      const batch = await this.reader.request("read", drive, info.volume, info.journal, cursor);
      if (!batch.next || BigInt(batch.next) < BigInt(cursor)) throw new Error("USN 读取进度无效。");
      const paths = this.catalog.changedPaths(drive, batch.rows);
      if (paths.length) await this.onPaths(drive, paths);
      if (this.closed || this.cancelled?.has(drive)) return;
      if (this.catalog.shouldRebuild(drive, batch.rows)) {
        this.sessions.set(drive, { phase: "rebuild" });
        this.notify();
        return;
      }
      this.catalog.apply(drive, batch.rows, false, info.journal, batch.next);
      if (batch.next === cursor) throw new Error("USN 读取进度未前进。");
      cursor = batch.next;
    }
    if (this.closed || this.cancelled?.has(drive)) return;
    const phase = BigInt(cursor) >= BigInt(latest) ? "ready" : "catching-up";
    this.sessions.set(drive, { phase, journal: info.journal, cursor });
    if (phase !== live?.phase) this.notify();
  }

  search(rawQuery) {
    const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 200) : "";
    if (!query || !this.reader || this.reader.closed) return [];
    const matches = [];
    for (const [drive, state] of this.sessions) {
      if (state.phase !== "ready") continue;
      matches.push(...this.catalog.search(drive, query).map((row) => ({
        id: row.id, drive, path: fullPath(row), name: row.name, directory: Boolean(row.isDirectory),
      })));
      if (matches.length >= 100) break;
    }
    return matches.slice(0, 100);
  }

  target(value, id) {
    const drive = driveLetter(value);
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id) || this.reader?.closed !== false ||
        this.sessions.get(drive)?.phase !== "ready") return null;
    return fullPath(this.catalog.item(drive, id)) ?? null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
    this.connecting?.abort();
    this.reader?.close();
    await this.tail;
    try {
      for (const [drive, { phase, journal, cursor }] of this.sessions) {
        if (phase === "ready") this.catalog.checkpoint(drive, journal, cursor);
      }
    } finally {
      this.catalog.close();
    }
  }
}

module.exports = { NtfsSearch };
