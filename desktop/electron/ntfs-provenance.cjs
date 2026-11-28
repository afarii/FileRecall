"use strict";

const { DatabaseSync } = require("node:sqlite");
const { lstat } = require("node:fs/promises");
const { win32 } = require("node:path");
const { isRecyclePath, historicalLocation } = require("./recycle-path.cjs");

// The path is never an identity. NTFS file reference (including its sequence
// number), volume GUID and live file birth time must all agree.
async function verifiedTarget(target, stat = lstat) {
  if (!target?.path || typeof target.id !== "string" || !/^\d{1,20}$/.test(target.id)) return null;
  try {
    const info = await stat(target.path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
        info.ino !== BigInt(target.id) || info.birthtimeNs <= 0n || info.dev <= 0n) return null;
    return { ...target, identity: [info.dev, info.ino, info.birthtimeNs].join(":") };
  } catch { return null; }
}

class NtfsSourceLinks {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS links (download_id TEXT PRIMARY KEY, volume TEXT NOT NULL, frn TEXT NOT NULL, identity TEXT NOT NULL, last_path TEXT NOT NULL, UNIQUE(volume, frn, identity))");
  }
  byDownload(id) {
    return this.db.prepare("SELECT download_id AS id, volume, frn, identity, last_path AS path FROM links WHERE download_id = ?").get(id);
  }
  byTarget(target) {
    return this.db.prepare("SELECT download_id AS id, volume, frn, identity, last_path AS path FROM links WHERE volume = ? AND frn = ? AND identity = ?").get(target.volume, target.id, target.identity);
  }
  save(id, target) {
    this.db.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)").run(id, target.volume, target.id, target.identity, target.path);
  }
  updatePath(id, target) {
    this.db.prepare("UPDATE links SET last_path = ? WHERE download_id = ? AND identity = ?").run(target.path, id, target.identity);
  }
  remove(id, target) {
    return Boolean(this.db.prepare("DELETE FROM links WHERE download_id = ? AND volume = ? AND frn = ? AND identity = ?").run(id, target.volume, target.id, target.identity).changes);
  }
  close() { this.db.close(); }
}

function createNtfsProvenance({ links, target, resolve, readDownloads, legacyLinked = () => false, stat = lstat }) {
  async function live(drive, id) { return verifiedTarget(await target(drive, id), stat); }
  async function details(drive, id) {
    const current = await live(drive, id);
    if (!current || isRecyclePath(current.path)) return { identity: null, confirmed: null, candidates: [] };
    const link = links.byTarget(current);
    return readDownloads((sources) => ({
      identity: current.identity,
      confirmed: link ? sources.byId(link.id) : null,
      candidates: link ? [] : sources.candidates([{ path: current.path, name: win32.basename(current.path) }])
        .filter((row) => !links.byDownload(row.id) && !legacyLinked(row.id))
        .slice(0, 6).map((row) => ({ ...row, evidence: row.path.toLowerCase() === current.path.toLowerCase() ? "路径一致" : "文件名一致" })),
    }), { identity: current.identity, confirmed: null, candidates: [] });
  }
  async function decide(drive, id, identity, downloadId, decision) {
    if (typeof downloadId !== "string" || downloadId.length > 160 ||
        !["confirmed", "undo"].includes(decision)) throw new Error("无效的文件关联操作。");
    const state = await details(drive, id);
    const current = await live(drive, id);
    if (!current || isRecyclePath(current.path) || !identity || current.identity !== identity || state.identity !== identity)
      throw new Error("文件身份已改变，请重新打开详情。");
    if (decision === "confirmed") {
      if (state.confirmed || !state.candidates.some((row) => row.id === downloadId))
        throw new Error("候选已改变，请重新核对。");
      links.save(downloadId, current);
    } else if (!links.remove(downloadId, current)) {
      throw new Error("关联已改变。");
    }
    return details(drive, id);
  }
  async function linkedFile(id) {
    const link = links.byDownload(id);
    if (!link) return null;
    const current = await verifiedTarget(await resolve(link.volume, link.frn), stat);
    if (current?.identity === link.identity && !isRecyclePath(current.path)) {
      links.updatePath(id, current);
      return { path: current.path, name: win32.basename(current.path), status: "present" };
    }
    // Keep historical evidence after deletion or disconnection; never open an
    // unrelated replacement at the original pathname.
    return { ...historicalLocation(link), status: "missing" };
  }
  return { details, decide, linkedFile };
}

module.exports = { NtfsSourceLinks, createNtfsProvenance, verifiedTarget };
