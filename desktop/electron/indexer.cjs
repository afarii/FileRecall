"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { basename, isAbsolute, join, resolve, sep } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class FileIndex {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS roots (
        path TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at REAL NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        scan_token TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('present', 'missing'))
      );
      CREATE INDEX IF NOT EXISTS files_root ON files(root_path);
      CREATE INDEX IF NOT EXISTS files_name ON files(name);
    `);
  }

  roots() {
    return this.db.prepare("SELECT path, added_at AS addedAt FROM roots ORDER BY path").all();
  }

  removeRoot(rawPath) {
    if (typeof rawPath !== "string" || !isAbsolute(rawPath)) {
      throw new Error("请选择有效的绝对目录路径。");
    }
    this.db.prepare("DELETE FROM roots WHERE path = ?").run(resolve(rawPath));
  }

  historyRoots() {
    return this.db.prepare(`
      SELECT root_path AS path, COUNT(*) AS count FROM files GROUP BY root_path ORDER BY root_path
    `).all();
  }

  clearHistory(rawPath) {
    if (typeof rawPath !== "string" || !isAbsolute(rawPath)) {
      throw new Error("请选择有效的绝对目录路径。");
    }
    const folder = resolve(rawPath);
    const prefix = folder.endsWith(sep) ? folder : folder + sep;
    const parent = this.roots().find((root) => {
      const parentPrefix = root.path.endsWith(sep) ? root.path : root.path + sep;
      return folder.startsWith(parentPrefix);
    });
    if (parent) throw new Error(`请先停止父目录 ${parent.path} 的索引，再清除该目录历史，避免自动重新建立记录。`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM roots WHERE path = ? OR substr(path, 1, length(?)) = ?")
        .run(folder, prefix, prefix);
      const result = this.db.prepare("DELETE FROM files WHERE substr(path, 1, length(?)) = ?")
        .run(prefix, prefix);
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async addRoot(rawPath) {
    if (typeof rawPath !== "string" || !isAbsolute(rawPath)) {
      throw new Error("请选择有效的绝对目录路径。");
    }
    const folder = resolve(rawPath);
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("仅支持普通文件夹。");
    }
    this.db.prepare("INSERT OR IGNORE INTO roots(path, added_at) VALUES (?, ?)").run(folder, Date.now());
    return this.scan(folder);
  }

  async scan(rawPath) {
    const folder = resolve(rawPath);
    if (!this.db.prepare("SELECT 1 FROM roots WHERE path = ?").get(folder)) {
      throw new Error("文件夹尚未获得授权。");
    }
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("扫描目录已不存在或无法访问。");

    const token = randomUUID();
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO files (path, root_path, name, size, modified_at, first_seen_at, last_seen_at, scan_token, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present')
      ON CONFLICT(path) DO UPDATE SET
        root_path = excluded.root_path,
        name = excluded.name,
        size = excluded.size,
        modified_at = excluded.modified_at,
        last_seen_at = excluded.last_seen_at,
        scan_token = excluded.scan_token,
        status = 'present'
    `);
    const stack = [folder];
    let indexed = 0;
    let skipped = 0;

    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          skipped++;
          continue;
        }
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        skipped++;
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          // Links are intentionally outside the scan scope, not a scan failure.
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          let info;
          try {
            info = await fs.lstat(full);
            if (!info.isFile()) {
              skipped++;
              continue;
            }
          } catch {
            skipped++;
            continue;
          }
          // Database failures must reach the caller and prevent missing-file updates.
          upsert.run(full, folder, basename(full), info.size, info.mtimeMs, now, now, token);
          indexed++;
        }
      }
    }

    // A partial scan must never falsely classify an unreadable subtree as deleted.
    let missing = 0;
    if (skipped === 0) {
      const prefix = folder.endsWith(sep) ? folder : folder + sep;
      const result = this.db.prepare(`
        UPDATE files SET status = 'missing'
        WHERE substr(path, 1, length(?)) = ? AND scan_token <> ? AND status = 'present'
      `).run(prefix, prefix, token);
      missing = Number(result.changes);
    }
    return { folder, indexed, skipped, missing, complete: skipped === 0 };
  }

  search(rawQuery = "") {
    const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 200) : "";
    const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
    return this.db.prepare(`
      SELECT path, root_path AS rootPath, name, size, modified_at AS modifiedAt,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status
      FROM files
      WHERE name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
      ORDER BY CASE status WHEN 'present' THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT 500
    `).all(pattern, pattern);
  }

  get(path) {
    return this.db.prepare("SELECT path, status FROM files WHERE path = ?").get(path);
  }

  close() {
    this.db.close();
  }
}

module.exports = { FileIndex };
