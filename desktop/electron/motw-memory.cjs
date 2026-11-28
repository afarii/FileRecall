"use strict";
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const { win32 } = require("node:path");
const { queryTerms, termGroups, termCondition } = require("./query-terms.cjs");
const { readMotw, safeHttpUrl } = require("./motw.cjs");
const { verifiedTarget } = require("./ntfs-provenance.cjs");
const { isRecyclePath, historicalLocation } = require("./recycle-path.cjs");

const CREATE = 0x100, DELETE = 0x200, RENAME_NEW = 0x2000;
const STREAM = 0x200000 | 0x70;
const RETRIES = [1000, 5000, 15000];
const MAX_PENDING = 512;
const keyOf = (volume, frn) => volume.toLowerCase() + ":" + frn;

class MotwMemory {
  constructor(path, { readOnly = false } = {}) {
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout=1000");
    if (!readOnly) this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, volume TEXT NOT NULL, frn TEXT NOT NULL, identity TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, host TEXT, referrer TEXT, zone INTEGER, observed INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS motw_ref ON memory(volume, frn);");
  }
  save(target, evidence, now = Date.now()) {
    if (isRecyclePath(target.path)) return false;
    const host = safeHttpUrl(evidence?.hostUrl);
    const referrer = safeHttpUrl(evidence?.referrerUrl);
    if (!host && !referrer) return false;
    const id = "motw:" + createHash("sha256").update(keyOf(target.volume, target.id) + ":" + target.identity).digest("hex");
    return Boolean(this.db.prepare(
      "INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name,host=excluded.host,referrer=excluded.referrer,zone=excluded.zone,deleted=0 WHERE memory.path<>excluded.path OR memory.host IS NOT excluded.host OR memory.referrer IS NOT excluded.referrer OR memory.zone IS NOT excluded.zone OR memory.deleted<>0"
    ).run(id, target.volume.toLowerCase(), target.id, target.identity, target.path,
      win32.basename(target.path), host, referrer, evidence.zoneId ?? null, now).changes);
  }
  updatePath(target) {
    if (isRecyclePath(target.path)) return false;
    return Boolean(this.db.prepare("UPDATE memory SET path=?, name=? WHERE volume=? AND frn=? AND identity=? AND deleted=0 AND path<>?")
      .run(target.path, win32.basename(target.path), target.volume.toLowerCase(), target.id, target.identity, target.path).changes);
  }
  markDeleted(volume, id) {
    return Boolean(this.db.prepare("UPDATE memory SET deleted=1 WHERE volume=? AND frn=? AND deleted=0").run(volume.toLowerCase(), id).changes);
  }
  byId(id) { return this.db.prepare("SELECT * FROM memory WHERE id=?").get(id); }
  search(query) {
    const terms = termGroups(queryTerms(query));
    if (!terms.length) return [];
    const matches = terms.map(({term,count}) => termCondition(
      ["lower(name)", "lower(path)", "lower(coalesce(host,''))", "lower(coalesce(referrer,''))"], term, count));
    const rows = this.db.prepare("SELECT * FROM memory WHERE " + matches.map(x=>x.where).join(" AND ") +
      " ORDER BY observed DESC,id LIMIT 40").all(...matches.flatMap(x=>x.args));
    return rows.map(row => ({
      id: row.id, ...historicalLocation(row), startedAt: row.observed,
      sourceStatus: "candidate", sourceTitle: row.referrer || row.host,
      domain: new URL(row.referrer || row.host).hostname,
      manager: "motw", canOpenSource: Boolean(safeHttpUrl(row.referrer) || safeHttpUrl(row.host)),
    }));
  }
  close() { this.db.close(); }
}

function createMotwCapture({ memory, resolve, read = readMotw, verify = verifiedTarget, now = Date.now, changed = () => {} }) {
  const pending = new Map();
  let running = false, closed = false;
  function queue(volume, id, attempt = 0) {
    const key = keyOf(volume, id);
    if (pending.has(key)) pending.delete(key);
    else if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(key, { volume, id, attempt, due: now() + RETRIES[attempt] });
  }
  function events(volume, rows) {
    if (closed) return;
    let updated = false;
    for (const row of rows) {
      if (row.attributes & (0x10 | 0x400)) continue;
      if (row.reason & DELETE) {
        pending.delete(keyOf(volume, row.id));
        updated = memory.markDeleted(volume, row.id) || updated;
      } else if (row.directory && isRecyclePath(win32.join(row.directory, row.name || ""))) {
        pending.delete(keyOf(volume, row.id));
        if (row.reason & RENAME_NEW) updated = true;
      } else if (row.reason & (CREATE | RENAME_NEW | STREAM)) queue(volume, row.id);
    }
    if (updated) changed();
  }
  async function capture(volume, id) {
    const before = await verify(await resolve(volume, id));
    if (!before || isRecyclePath(before.path)) return null;
    const evidence = await read(before.path);
    const after = await verify(await resolve(volume, id));
    if (!after || isRecyclePath(after.path) || before.identity !== after.identity || before.path !== after.path || closed) return null;
    const updatedPath = memory.updatePath(after);
    const saved = evidence && memory.save(after, evidence);
    if (saved || updatedPath) changed();
    return evidence;
  }
  async function tick() {
    if (running || closed) return;
    running = true;
    try {
      for (const [key, item] of [...pending]) {
        if (closed) break;
        if (item.due > now()) continue;
        pending.delete(key);
        let evidence = null;
        try { evidence = await capture(item.volume, item.id); } catch {}
        if (!closed && !evidence?.hostUrl && !evidence?.referrerUrl &&
            item.attempt + 1 < RETRIES.length && !pending.has(key))
          queue(item.volume, item.id, item.attempt + 1);
        // One file per tick bounds filesystem IO even during install storms.
        break;
      }
    } finally { running = false; }
  }
  return { events, capture, tick, size: () => pending.size,
    close() { closed = true; pending.clear(); } };
}

module.exports = { MotwMemory, createMotwCapture };
