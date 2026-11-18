"use strict";

const { lstat } = require("node:fs/promises");
const { win32 } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const trusted = new Set(["matched", "confirmed", "manual"]);
const sourceStates = new Set([...trusted, "candidate", "unknown", "rejected"]);
const algorithmStates = new Set(["matched", "candidate", "unknown"]);

function webUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Invalid URLs cannot be opened.
  }
  return null;
}

function snapshot(source, states) {
  const status = states.has(source?.status) ? source.status : "unknown";
  if (status === "unknown" || status === "rejected") return { status, url: null, title: "" };
  return {
    status,
    url: webUrl(source.url),
    title: typeof source.title === "string" ? source.title.trim().slice(0, 512) : "",
  };
}

function normalizeRecord(record) {
  if (typeof record?.key !== "string" || !/^download:\d{1,16}$/.test(record.key)
    || !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0
    || typeof record.path !== "string" || record.path.length > 32767
    || !/^[a-z]:[\\/]/i.test(record.path) || /[\x00-\x1f:*?"<>|]/.test(record.path.slice(2))) return null;
  const path = win32.normalize(record.path);
  const name = win32.basename(path);
  if (!name || path.endsWith("\\")) return null;
  const algorithm = snapshot(record.algorithm, algorithmStates);
  const effective = snapshot(record.effective, sourceStates);
  const domain = effective.url ? new URL(effective.url).hostname : "";
  return { path, name, algorithm, effective, domain };
}

class DownloadSources {
  constructor(path, { readOnly = false } = {}) {
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout = 3000");
    if (!readOnly) this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS browser_downloads (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        source_status TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT NOT NULL,
        domain TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
    `);
  }

  importBatch(message) {
    if (message?.version !== 1 || typeof message.profile !== "string"
      || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(message.profile)
      || !Array.isArray(message.records) || message.records.length > 16) {
      throw new Error("同步批次格式无效。");
    }
    const save = this.db.prepare(`
      INSERT INTO browser_downloads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, name=excluded.name,
        algorithm=excluded.algorithm, source_status=excluded.source_status,
        source_url=excluded.source_url, source_title=excluded.source_title, domain=excluded.domain,
        search_text=excluded.search_text
    `);
    let saved = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of message.records) {
        const item = normalizeRecord(record);
        if (!item) continue;
        const id = `${message.profile}:${record.key}:${record.startedAt}`;
        save.run(id, item.path, item.name, record.startedAt, JSON.stringify(item.algorithm),
          item.effective.status, item.effective.url, item.effective.title, item.domain,
          [item.path, item.domain, item.effective.title].join("\n").toLowerCase());
        saved++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, saved, skipped: message.records.length - saved };
  }

  search(query) {
    const needle = typeof query === "string" ? query.trim().slice(0, 200).toLowerCase() : "";
    return this.db.prepare(`
      SELECT id, path, name, started_at AS startedAt, source_status AS sourceStatus,
             source_title AS sourceTitle, domain, source_url AS sourceUrl
      FROM browser_downloads WHERE instr(search_text, ?) > 0
      ORDER BY started_at DESC, id LIMIT 200
    `).all(needle).map(({ sourceUrl, ...record }) => ({
      ...record, canOpenSource: trusted.has(record.sourceStatus) && Boolean(webUrl(sourceUrl)),
    }));
  }

  sourceToOpen(id) {
    if (typeof id !== "string" || id.length > 160) return null;
    const record = this.db.prepare("SELECT source_status, source_url FROM browser_downloads WHERE id = ?").get(id);
    return record && trusted.has(record.source_status) ? webUrl(record.source_url) : null;
  }

  close() {
    this.db.close();
  }
}

async function downloadPathStatus(path, stat = lstat) {
  try {
    return (await stat(path)).isFile() ? "present" : "missing";
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return "unknown";
    try {
      return (await stat(win32.parse(path).root)).isDirectory() ? "missing" : "unknown";
    } catch {
      return "unknown";
    }
  }
}

module.exports = { DownloadSources, downloadPathStatus };
