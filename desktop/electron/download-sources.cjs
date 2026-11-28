"use strict";

const { lstat } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { win32 } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { queryTerms, termGroups, termCondition } = require("./query-terms.cjs");

const trusted = new Set(["matched", "confirmed", "manual"]);
const sourceStates = new Set([...trusted, "candidate", "unknown", "rejected"]);
const algorithmStates = new Set(["matched", "candidate", "unknown"]);
const sourceColumns = `id, path, name, started_at AS startedAt, source_status AS sourceStatus,
  source_title AS sourceTitle, domain, source_url AS sourceUrl`;
const direct = "direct";

function publicRecord({ sourceUrl, ...record }) {
  return { ...record, canOpenSource: (trusted.has(record.sourceStatus) || record.sourceStatus === direct)
    && Boolean(webUrl(sourceUrl)) };
}

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
    || !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) return null;
  const path = localPath(record.path);
  if (!path) return null;
  const name = win32.basename(path);
  const algorithm = snapshot(record.algorithm, algorithmStates);
  const effective = snapshot(record.effective, sourceStates);
  const domain = effective.url ? new URL(effective.url).hostname : "";
  return { path, name, algorithm, effective, domain };
}

function localPath(value) {
  if (typeof value !== "string" || value.length > 32767
    || !/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f:*?"<>|]/.test(value.slice(2))) return null;
  const path = win32.normalize(value);
  return win32.basename(path) && !path.endsWith("\\") ? path : null;
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
      CREATE TABLE IF NOT EXISTS aria2_downloads (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        source_status TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT NOT NULL,
        domain TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
    `);
    this.hasAria2 = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aria2_downloads'").get());
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

  search(query, manager) {
    const terms = termGroups(queryTerms(query)).map(({ term, count }) => termCondition(["search_text"], term, count));
    const where = terms.map(({ where }) => where).join(" AND ") || "1";
    const args = terms.flatMap(({ args }) => args);
    const scope = manager === "chrome" || manager === "aria2" ? manager : null;
    return this.db.prepare(`
      SELECT ${sourceColumns}, manager
      FROM (${this.allSources()}) WHERE ${where} AND (? IS NULL OR manager = ?)
      ORDER BY started_at DESC, id LIMIT 200
    `).all(...args, scope, scope).map(publicRecord);
  }

  smartCandidates(plan) {
    const clauses=[], args=[];
    if(plan.range){clauses.push("started_at>=? AND started_at<?");args.push(plan.range.from,plan.range.until);}
    if(plan.domain){
      clauses.push("(lower(domain)=? OR lower(domain) LIKE ?)");
      args.push(plan.domain,"%."+plan.domain);
    }
    if(plan.extensions.length){
      clauses.push("("+plan.extensions.map(()=>"lower(name) LIKE ?").join(" OR ")+")");
      args.push(...plan.extensions.map(ext=>"%."+ext));
    }
    return this.db.prepare("SELECT "+sourceColumns+", manager FROM ("+this.allSources()+") WHERE "+
      (clauses.join(" AND ")||"1")+" ORDER BY started_at DESC,id LIMIT 121").all(...args).map(publicRecord);
  }

  byId(id) {
    const record = this.rawRecord(id);
    return record ? publicRecord(record) : null;
  }

  candidates(aliases) {
    if (!aliases.length) return [];
    const clauses = aliases.map(() => "(path = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)");
    return this.db.prepare(`SELECT ${sourceColumns}, manager FROM (${this.allSources()}) WHERE ${clauses.join(" OR ")}
      ORDER BY started_at DESC, id LIMIT 20`)
      .all(...aliases.flatMap(({ path, name }) => [path, name])).map(publicRecord);
  }

  sourceToOpen(id) {
    const record = this.rawRecord(id);
    return record && publicRecord(record).canOpenSource ? webUrl(record.sourceUrl) : null;
  }

  allSources() {
    const columns = "id, path, name, started_at, source_status, source_url, source_title, domain, search_text";
    return `SELECT ${columns}, 'chrome' AS manager FROM browser_downloads` +
      (this.hasAria2 ? ` UNION ALL SELECT ${columns}, 'aria2' AS manager FROM aria2_downloads` : "");
  }

  rawRecord(id) {
    if (typeof id !== "string" || id.length > 160) return null;
    const aria2 = id.startsWith("aria2:");
    if (aria2 && !this.hasAria2) return null;
    return this.db.prepare(aria2
      ? `SELECT ${sourceColumns}, 'aria2' AS manager FROM aria2_downloads WHERE id = ?`
      : `SELECT ${sourceColumns}, 'chrome' AS manager FROM browser_downloads WHERE id = ?`).get(id);
  }

  importAria2(records) {
    const save = this.db.prepare(`
      INSERT INTO aria2_downloads VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_status=excluded.source_status, source_url=excluded.source_url,
        domain=excluded.domain, search_text=excluded.search_text
      WHERE excluded.source_url IS NOT NULL AND aria2_downloads.source_url IS NULL
    `);
    let changed = 0;
    const observedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { gid, index, path: inputPath, uri } of records) {
        const path = localPath(inputPath);
        if (!path) continue;
        const url = webUrl(uri);
        const domain = url ? new URL(url).hostname : "";
        const name = win32.basename(path);
        const id = "aria2:" + gid + ":" + index + ":" + createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 32);
        changed += Number(save.run(id, path, name, observedAt, url ? direct : "unknown",
          url, domain, [path, domain].join("\n").toLowerCase()).changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return changed;
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
