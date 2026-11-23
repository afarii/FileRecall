"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { canIndexText, textSignature, readText } = require("./text-content.cjs");

function fileIdentity(info) {
  if (!info.isFile() || info.nlink !== 1n || info.dev <= 0n || info.ino <= 0n || info.birthtimeNs <= 0n) return null;
  return [info.dev, info.ino, info.birthtimeNs].join(":");
}

function isWithin(root, path) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

function directoryIdentity(info) {
  return info.isDirectory() && !info.isSymbolicLink()
    ? [info.dev, info.ino, info.birthtimeNs].join(":") : null;
}

async function changedTarget(root, realRoot, path) {
  for (let parent = dirname(path); isWithin(root, parent); parent = dirname(parent)) {
    let info;
    try {
      info = await fs.lstat(parent);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { path, info: null };
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return { path, info: null };
  }
  try {
    const info = await fs.lstat(path, { bigint: true });
    if (info.isSymbolicLink()) return { path, info: null };
    const actual = await fs.realpath(path);
    if (!isWithin(realRoot, actual)) throw new Error("变更路径已离开授权目录。");
    return { path: join(root, relative(realRoot, actual)), info };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { path, info: null };
    throw error;
  }
}

const CURRENT_PATH = `
  CASE WHEN files.status = 'missing' AND files.identity_verified = 1 THEN (
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(current.path) END
    FROM files AS current
    WHERE current.file_identity = files.file_identity AND current.status = 'present'
      AND current.identity_verified = 1
      AND EXISTS (SELECT 1 FROM roots WHERE roots.path = current.root_path)
  ) END
`;

const POSSIBLE_PATH = `
  CASE WHEN files.status = 'missing' AND files.size > 0 AND files.identity_verified = 1 THEN (
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(candidate.path) END
    FROM files AS candidate
    WHERE candidate.name = files.name AND candidate.size = files.size AND candidate.modified_at = files.modified_at
      AND candidate.first_seen_at >= files.last_seen_at
      AND candidate.status = 'present' AND candidate.identity_verified = 1
      AND candidate.file_identity <> files.file_identity
      AND EXISTS (SELECT 1 FROM roots WHERE roots.path = candidate.root_path)
  ) END
`;

class FileIndex {
  constructor(databasePath) {
    this.databasePath = resolve(databasePath);
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
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
      CREATE TABLE IF NOT EXISTS preferences (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_text (
        path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
        signature TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_decisions (
        file_identity TEXT NOT NULL,
        download_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('confirmed', 'rejected')),
        PRIMARY KEY(file_identity, download_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS confirmed_source_by_file
        ON source_decisions(file_identity) WHERE decision = 'confirmed';
      CREATE UNIQUE INDEX IF NOT EXISTS confirmed_file_by_source
        ON source_decisions(download_id) WHERE decision = 'confirmed';
      CREATE TABLE IF NOT EXISTS file_annotations (
        file_identity TEXT PRIMARY KEY,
        favorite INTEGER NOT NULL,
        note TEXT NOT NULL,
        tags TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(files)").all().map((column) => column.name));
    if (!columns.has("file_identity")) this.db.exec("ALTER TABLE files ADD COLUMN file_identity TEXT");
    if (!columns.has("identity_verified")) this.db.exec("ALTER TABLE files ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS files_identity ON files(file_identity, status) WHERE file_identity IS NOT NULL");
  }

  roots() {
    return this.db.prepare("SELECT path, added_at AS addedAt FROM roots ORDER BY path").all();
  }

  textEnabled() {
    return this.db.prepare("SELECT enabled FROM preferences WHERE name = 'file_text'").get()?.enabled === 1;
  }

  setTextEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("无效的正文索引设置。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('file_text', ?)").run(Number(enabled));
      if (!enabled) this.db.exec("DELETE FROM file_text");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isInternalPath(path) {
    const full = resolve(path);
    const downloadsPath = join(dirname(this.databasePath), "browser-downloads.sqlite");
    const internal = [this.databasePath, downloadsPath].flatMap((path) => [path, path + "-wal", path + "-shm"]);
    return internal.some((candidate) => process.platform === "win32"
      ? candidate.toLowerCase() === full.toLowerCase() : candidate === full);
  }

  removeRoot(rawPath) {
    if (typeof rawPath !== "string" || !isAbsolute(rawPath)) {
      throw new Error("请选择有效的绝对目录路径。");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM roots WHERE path = ?").run(resolve(rawPath));
      const collation = process.platform === "win32" ? "COLLATE NOCASE" : "";
      this.db.prepare(`
        DELETE FROM file_text WHERE NOT EXISTS (
          SELECT 1 FROM roots
          WHERE substr(file_text.path, 1, length(rtrim(roots.path, ?) || ?)) =
                rtrim(roots.path, ?) || ? ${collation}
        )
      `).run(sep, sep, sep, sep);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      return process.platform === "win32"
        ? folder.toLowerCase().startsWith(parentPrefix.toLowerCase()) : folder.startsWith(parentPrefix);
    });
    if (parent) throw new Error(`请先停止父目录 ${parent.path} 的索引，再清除该目录历史，避免自动重新建立记录。`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const collation = process.platform === "win32" ? "COLLATE NOCASE" : "";
      this.db.prepare(`DELETE FROM roots WHERE path = ? ${collation} OR substr(path, 1, length(?)) = ? ${collation}`)
        .run(folder, prefix, prefix);
      const result = this.db.prepare(`DELETE FROM files WHERE substr(path, 1, length(?)) = ? ${collation}`)
        .run(prefix, prefix);
      this.db.exec(`DELETE FROM source_decisions WHERE NOT EXISTS (
        SELECT 1 FROM files WHERE files.file_identity = source_decisions.file_identity
      ); DELETE FROM file_annotations WHERE NOT EXISTS (
        SELECT 1 FROM files WHERE files.file_identity = file_annotations.file_identity
      )`);
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
    const context = await this.scanContext(rawPath);
    return this.scanScope(context, context.folder);
  }

  async updatePaths(rawPath, paths) {
    const context = await this.scanContext(rawPath);
    const { folder, realRoot } = context;
    let changed = 0;
    let complete = true;
    const scopedPaths = new Set(paths.map((path) => resolve(path)));
    for (const path of scopedPaths) {
      if (!isWithin(folder, path) || this.isInternalPath(path)) continue;
      let covered = false;
      for (let parent = dirname(path); isWithin(folder, parent); parent = dirname(parent)) {
        if (scopedPaths.has(parent)) { covered = true; break; }
      }
      if (covered) continue;
      const target = await changedTarget(folder, realRoot, path);
      const scope = await this.scanScope(context, target.path, target.info);
      changed += scope.changed;
      complete &&= scope.complete;
      if (process.platform === "win32" && scope.complete &&
          target.path !== path && path.toLowerCase() === target.path.toLowerCase()) {
        const previous = await this.scanScope(context, path, null);
        changed += previous.changed;
      }
    }
    return { changed, complete };
  }

  async scanContext(rawPath) {
    const folder = resolve(rawPath);
    if (!this.db.prepare("SELECT 1 FROM roots WHERE path = ?").get(folder)) {
      throw new Error("文件夹尚未获得授权。");
    }
    const identity = directoryIdentity(await fs.lstat(folder, { bigint: true }));
    if (!identity) throw new Error("扫描目录已不存在或无法访问。");
    const realRoot = await fs.realpath(folder);
    const nested = this.roots().map((root) => root.path).filter((path) => isWithin(folder, path))
      .sort((left, right) => right.length - left.length);
    return { folder, identity, realRoot, textRoot: this.textEnabled() ? realRoot : null, nested };
  }

  async scanScope({ folder, identity, textRoot, nested }, path, target) {
    const token = randomUUID();
    const now = Date.now();
    const lookupText = this.db.prepare("SELECT signature FROM file_text WHERE path = ?");
    const saveText = this.db.prepare("INSERT OR REPLACE INTO file_text VALUES (?, ?, ?)");
    const deleteText = this.db.prepare("DELETE FROM file_text WHERE path = ?");
    const upsert = this.db.prepare(`
      INSERT INTO files (path, root_path, name, size, modified_at, first_seen_at, last_seen_at, scan_token, status, file_identity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?)
      ON CONFLICT(path) DO UPDATE SET
        root_path = excluded.root_path,
        name = excluded.name,
        size = excluded.size,
        modified_at = excluded.modified_at,
        last_seen_at = excluded.last_seen_at,
        scan_token = excluded.scan_token,
        identity_verified = CASE WHEN files.file_identity = excluded.file_identity THEN files.identity_verified ELSE 0 END,
        file_identity = excluded.file_identity,
        status = 'present'
      WHERE files.root_path <> excluded.root_path OR files.name <> excluded.name
        OR files.size <> excluded.size OR files.modified_at <> excluded.modified_at
        OR files.file_identity IS NOT excluded.file_identity OR files.status <> 'present'
    `);
    const stack = target === undefined || target?.isDirectory() ? [path] : [];
    const seen = new Set();
    let changed = 0;
    let skipped = 0;

    const visitFile = async (full, info) => {
      let text;
      let signature;
      if (textRoot) {
        const cached = lookupText.get(full);
        if (canIndexText(full, info.size)) {
          signature = textSignature(info);
          if (cached?.signature !== signature) {
            text = await readText(full, textRoot, signature).catch(() => null);
          }
        } else if (cached) {
          text = null;
        }
        if (text !== undefined && cached) changed += Number(deleteText.run(full).changes);
      }
      const root = nested.find((candidate) => isWithin(candidate, full)) ?? folder;
      changed += Number(upsert.run(full, root, basename(full), Number(info.size), Number(info.mtimeNs) / 1e6,
        now, now, token, fileIdentity(info)).changes);
      if (typeof text === "string") changed += Number(saveText.run(full, signature, text).changes);
      seen.add(full);
    };

    if (target?.isFile() && !this.isInternalPath(path)) await visitFile(path, target);
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
        if (this.isInternalPath(full)) continue;
        if (entry.isSymbolicLink()) {
          // Links are intentionally outside the scan scope, not a scan failure.
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          let info;
          try {
            info = await fs.lstat(full, { bigint: true });
            if (!info.isFile()) {
              skipped++;
              continue;
            }
          } catch {
            skipped++;
            continue;
          }
          await visitFile(full, info);
        }
      }
    }

    // A partial scan must never falsely classify an unreadable subtree as deleted.
    let missing = 0;
    if (skipped === 0) {
      if (directoryIdentity(await fs.lstat(folder, { bigint: true })) !== identity) {
        throw new Error("扫描期间授权目录已更换。");
      }
      // The path index can find an entire subtree as a range on its separator.
      const prefix = path.endsWith(sep) ? path : path + sep;
      const upper = prefix.slice(0, -1) + String.fromCharCode(sep.charCodeAt(0) + 1);
      const removed = [];
      const verify = [];
      const existing = this.db.prepare(`
        SELECT path, identity_verified AS verified, file_identity AS identity FROM files
        WHERE (path = ? OR (path >= ? AND path < ?)) AND status = 'present'
      `);
      for (const record of existing.iterate(path, prefix, upper)) {
        if (!seen.has(record.path)) removed.push(record.path);
        else if (record.identity && !record.verified) verify.push(record.path);
      }
      if (removed.length || verify.length) {
        const markMissing = this.db.prepare("UPDATE files SET status = 'missing' WHERE path = ?");
        const markVerified = this.db.prepare("UPDATE files SET identity_verified = 1 WHERE path = ?");
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const removedPath of removed) markMissing.run(removedPath);
          for (const verifiedPath of verify) markVerified.run(verifiedPath);
          this.db.exec("COMMIT");
          missing = removed.length;
          changed += missing + verify.length;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    }
    return { folder, indexed: seen.size, skipped, missing, complete: skipped === 0, changed };
  }

  search(rawQuery = "") {
    const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 200) : "";
    const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
    const searchText = query.length > 0 && this.textEnabled();
    const textMatch = searchText ? "instr(file_text.content, ?) > 0" : "0";
    return this.db.prepare(`
      SELECT files.path, root_path AS rootPath, name, size, modified_at AS modifiedAt,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status,
             ${CURRENT_PATH} AS currentPath, ${POSSIBLE_PATH} AS possiblePath,
             coalesce(${textMatch}, 0) AS textMatched,
             coalesce(file_annotations.favorite, 0) AS favorite,
             coalesce(instr(file_annotations.search_text, ?), 0) > 0 AND ? <> '' AS annotationMatched
      FROM files
      ${searchText ? "LEFT JOIN file_text ON file_text.path = files.path" : ""}
      LEFT JOIN file_annotations ON file_annotations.file_identity = files.file_identity AND files.identity_verified = 1
      WHERE name LIKE ? ESCAPE '\\' OR files.path LIKE ? ESCAPE '\\' OR textMatched = 1 OR annotationMatched = 1
      ORDER BY favorite DESC, CASE WHEN status = 'present' OR currentPath IS NOT NULL THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT 500
    `).all(...(searchText ? [query.toLowerCase()] : []), query.toLowerCase(), query, pattern, pattern);
  }

  get(path) {
    return this.db.prepare("SELECT path, status, file_identity AS identity FROM files WHERE path = ?").get(path);
  }

  semanticMatch({ path, signature }) {
    return this.db.prepare(`
      SELECT files.path, root_path AS rootPath, name, size, modified_at AS modifiedAt,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status,
             ${CURRENT_PATH} AS currentPath, ${POSSIBLE_PATH} AS possiblePath, 0 AS textMatched,
             coalesce(file_annotations.favorite, 0) AS favorite, 0 AS annotationMatched
      FROM files JOIN file_text ON file_text.path = files.path
      LEFT JOIN file_annotations ON file_annotations.file_identity = files.file_identity AND files.identity_verified = 1
      WHERE files.path = ? AND signature = ?
    `).get(path, signature);
  }

  async sourceIdentity(path) {
    if (typeof path !== "string") return null;
    const lookup = this.db.prepare(`
      SELECT file_identity AS identity, status FROM files WHERE path = ? AND identity_verified = 1
    `);
    const record = lookup.get(path);
    if (!record?.identity || record.status === "missing") return record?.identity ?? null;
    try {
      const identity = fileIdentity(await fs.lstat(path, { bigint: true }));
      return identity === record.identity && lookup.get(path)?.identity === identity ? identity : null;
    } catch { return null; }
  }

  sourceAliases(identity) {
    return this.db.prepare(`
      SELECT path, name, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, status
      FROM files WHERE file_identity = ? AND identity_verified = 1
      ORDER BY first_seen_at, path LIMIT 20
    `).all(identity);
  }

  annotation(identity) {
    const row = this.db.prepare("SELECT favorite, note, tags FROM file_annotations WHERE file_identity = ?").get(identity);
    return row ? { favorite: Boolean(row.favorite), note: row.note, tags: JSON.parse(row.tags) } : { favorite: false, note: "", tags: [] };
  }

  annotate(identity, input) {
    if (typeof input?.favorite !== "boolean" || typeof input.note !== "string" || input.note.length > 1000
      || !Array.isArray(input.tags) || input.tags.length > 10
      || input.tags.some((tag) => typeof tag !== "string" || tag.length > 30)) throw new Error("备注或标签格式无效。");
    const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
    const note = input.note.trim();
    if (!input.favorite && !note && !tags.length) {
      this.db.prepare("DELETE FROM file_annotations WHERE file_identity = ?").run(identity);
    } else {
      this.db.prepare(`
        INSERT INTO file_annotations VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_identity) DO UPDATE SET favorite=excluded.favorite,
          note=excluded.note, tags=excluded.tags, search_text=excluded.search_text
      `).run(identity, Number(input.favorite), note, JSON.stringify(tags), [note, ...tags].join("\n").toLowerCase());
    }
    return this.annotation(identity);
  }

  sourceDecisions(identity) {
    return this.db.prepare("SELECT download_id AS id, decision FROM source_decisions WHERE file_identity = ?").all(identity);
  }

  linkedIdentity(id) {
    return this.db.prepare(`
      SELECT file_identity AS identity FROM source_decisions WHERE download_id = ? AND decision = 'confirmed'
    `).get(id)?.identity ?? null;
  }

  async linkedFile(id) {
    const identity = this.linkedIdentity(id);
    if (!identity) return null;
    const files = this.db.prepare(`
      SELECT path, name, status FROM files WHERE identity_verified = 1 AND file_identity = ?
      ORDER BY status DESC, last_seen_at DESC, path
    `).all(identity);
    for (const file of files) {
      if (await this.sourceIdentity(file.path) === identity) return file;
    }
    return null;
  }

  decideSource(identity, id, decision) {
    if (decision === "undo") {
      this.db.prepare("DELETE FROM source_decisions WHERE file_identity = ? AND download_id = ?")
        .run(identity, id);
      return;
    }
    this.db.prepare(`
      INSERT INTO source_decisions VALUES (?, ?, ?)
      ON CONFLICT(file_identity, download_id) DO UPDATE SET decision = excluded.decision
    `).run(identity, id, decision);
  }

  async movedTarget(path) {
    const lookup = this.db.prepare(`
      SELECT file_identity AS identity, ${CURRENT_PATH} AS currentPath FROM files WHERE path = ?
    `);
    const record = lookup.get(path);
    if (!record?.currentPath) return null;
    try {
      const info = await fs.lstat(record.currentPath, { bigint: true });
      // Resolve again after the filesystem check in case background scanning changed the association.
      const latest = lookup.get(path);
      return latest?.currentPath === record.currentPath && latest.identity === record.identity
        && fileIdentity(info) === record.identity ? record.currentPath : null;
    } catch {
      return null;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { FileIndex, directoryIdentity, isWithin };
