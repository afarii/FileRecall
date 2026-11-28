"use strict";

const { DatabaseSync } = require("node:sqlite");
const { win32 } = require("node:path");
const { nameSearchKeys, queryTerms, termGroups, termCondition } = require("./filename-search.cjs");
const { prepareQuery, scoreFile, compareFiles } = require("./search-relevance.cjs");

const DIRECTORY = 0x10;
const DELETE = 0x200;
const SECURITY_CHANGE = 0x800;
const RENAME_OLD = 0x1000;
const RENAME_NEW = 0x2000;
const REPARSE = 0x400;

const prefix = (path) => path.endsWith("\\") ? path : path + "\\";
const below = (path, root) => path.toLowerCase().startsWith(prefix(root).toLowerCase());
const fullPath = (row) => row && row.directory ? win32.join(row.directory, row.name) : null;
const isRootId = (id) => {
  try { return (BigInt(id) & 0x0000ffffffffffffn) === 5n; }
  catch { return false; }
};

class NtfsCatalog {
  constructor(path, applicationData) {
    this.applicationData = applicationData.toLowerCase();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS ntfs_drive (
        drive TEXT PRIMARY KEY, volume TEXT NOT NULL, journal TEXT, cursor TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ntfs_excluded_drive (drive TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ntfs_parent (
        drive TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, folded TEXT NOT NULL,
        PRIMARY KEY (drive, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ntfs_parent_path ON ntfs_parent (drive, folded);
      CREATE TABLE IF NOT EXISTS ntfs_item (
        drive TEXT NOT NULL, id TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, folded TEXT NOT NULL,
        directory INTEGER NOT NULL, PRIMARY KEY (drive, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ntfs_item_name ON ntfs_item (drive, folded);
      CREATE INDEX IF NOT EXISTS ntfs_item_parent ON ntfs_item (drive, parent);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(ntfs_item)").all().map((entry) => entry.name));
    if (!columns.has("pinyin")) this.db.exec("ALTER TABLE ntfs_item ADD COLUMN pinyin TEXT");
    if (!columns.has("initials")) this.db.exec("ALTER TABLE ntfs_item ADD COLUMN initials TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS ntfs_item_pinyin ON ntfs_item(drive, pinyin)");
    this.db.exec("CREATE INDEX IF NOT EXISTS ntfs_item_initials ON ntfs_item(drive, initials)");
    // A tiny partial index prevents a complete MFT scan on every migration tick.
    this.db.exec("CREATE INDEX IF NOT EXISTS ntfs_missing_keys ON ntfs_item(drive, id) WHERE pinyin IS NULL OR initials IS NULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS ntfs_usage (
      drive TEXT NOT NULL, id TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (drive, id)
    ) WITHOUT ROWID`);
    const usageColumns = new Set(this.db.prepare("PRAGMA table_info(ntfs_usage)").all().map(({ name }) => name));
    if (!usageColumns.has("favorite")) this.db.exec("ALTER TABLE ntfs_usage ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
    const driveColumns = new Set(this.db.prepare("PRAGMA table_info(ntfs_drive)").all().map((entry) => entry.name));
    if (!driveColumns.has("build_position")) this.db.exec("ALTER TABLE ntfs_drive ADD COLUMN build_position TEXT");
    if (!driveColumns.has("build_journal")) this.db.exec("ALTER TABLE ntfs_drive ADD COLUMN build_journal TEXT");
    if (!driveColumns.has("build_usn")) this.db.exec("ALTER TABLE ntfs_drive ADD COLUMN build_usn TEXT");
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  drives() { return this.db.prepare("SELECT * FROM ntfs_drive ORDER BY drive").all(); }

  excluded() { return this.db.prepare("SELECT drive FROM ntfs_excluded_drive").all().map((row) => row.drive); }

  enable(drive, volume) {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO ntfs_drive (drive, volume, journal, cursor) VALUES (?, ?, NULL, NULL)").run(drive, volume);
      this.db.prepare("DELETE FROM ntfs_excluded_drive WHERE drive = ?").run(drive);
    });
  }

  discardRows(drive) {
    this.db.prepare("DELETE FROM ntfs_item WHERE drive = ?").run(drive);
    this.db.prepare("DELETE FROM ntfs_parent WHERE drive = ?").run(drive);
  }

  // Pausing a volume must preserve its persisted MFT snapshot. Users often
  // pause before reinstalling and expect the index to resume immediately.
  disable(drive) {
    this.db.prepare("INSERT OR IGNORE INTO ntfs_excluded_drive VALUES (?)").run(drive);
  }

  activeDrives() {
    return this.db.prepare(`SELECT d.* FROM ntfs_drive d
      WHERE NOT EXISTS (SELECT 1 FROM ntfs_excluded_drive x WHERE x.drive = d.drive)
      ORDER BY d.drive`).all();
  }

  beginBuild(drive, journal, startUsn) {
    const state = this.db.prepare("SELECT build_position, build_journal FROM ntfs_drive WHERE drive = ?").get(drive);
    if (state?.build_journal === journal && state.build_position !== null) return state.build_position;
    this.transaction(() => {
      this.db.prepare("UPDATE ntfs_drive SET cursor = NULL, journal = NULL, build_position = '0', build_journal = ?, build_usn = ? WHERE drive = ?")
        .run(journal, startUsn ?? null, drive);
      this.discardRows(drive);
    });
    return "0";
  }

  // Materialize parent directory paths once per completed volume snapshot.
  // No per-file OpenFileById, ACL call, or Windows path lookup is needed.
  finishBuild(drive) {
    const entries = this.db.prepare(
      "SELECT id, parent, name FROM ntfs_item WHERE drive = ? AND directory = 1"
    ).all(drive);
    const dirs = new Map(entries.map((entry) => [entry.id, entry]));
    const known = new Map();
    const visiting = new Set();
    const root = drive + ":\\";
    const resolve = (id, depth = 0) => {
      if (isRootId(id)) return root;
      if (known.has(id)) return known.get(id);
      if (visiting.has(id) || depth > 256) return null;
      const entry = dirs.get(id);
      if (!entry) return null;
      visiting.add(id);
      const parent = resolve(entry.parent, depth + 1);
      visiting.delete(id);
      const path = parent ? win32.join(parent, entry.name) : null;
      known.set(id, path);
      return path;
    };
    this.transaction(() => {
      const save = this.db.prepare(`
        INSERT INTO ntfs_parent (drive, id, path, folded) VALUES (?, ?, ?, ?)
        ON CONFLICT (drive, id) DO UPDATE SET path = excluded.path, folded = excluded.folded
      `);
      for (const entry of entries) {
        const path = resolve(entry.id);
        if (path) save.run(drive, entry.id, path, path.toLowerCase());
      }
    });
    return entries.length;
  }

  checkpoint(drive, journal, cursor) {
    this.db.prepare(`
      UPDATE ntfs_drive
      SET journal = ?, cursor = ?, build_position = NULL, build_journal = NULL, build_usn = NULL
      WHERE drive = ?
    `).run(journal, cursor, drive);
  }

  // Resolve an unfinished MFT snapshot on demand. Most directory records
  // precede their children, so searches become useful before scanning finishes.
  resolveParent(drive, id) {
    const find = this.db.prepare("SELECT parent, name, directory FROM ntfs_item WHERE drive = ? AND id = ?");
    const names = [];
    const seen = new Set();
    while (!isRootId(id)) {
      if (seen.has(id) || names.length >= 256) return null;
      seen.add(id);
      const item = find.get(drive, id);
      if (!item || !item.directory) return null;
      names.push(item.name);
      id = item.parent;
    }
    return win32.join(drive + ":\\", ...names.reverse());
  }

  hasItem(drive, id) {
    return Boolean(this.db.prepare("SELECT 1 FROM ntfs_item WHERE drive=? AND id=?").get(drive, id));
  }

  item(drive, id) {
    const row = this.db.prepare(`
      SELECT i.name, i.parent, p.path AS directory, i.directory AS isDirectory
      FROM ntfs_item i LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE i.drive = ? AND i.id = ?
    `).get(drive, id);
    if (!row) return null;
    row.directory ??= this.resolveParent(drive, row.parent);
    return row.directory ? row : null;
  }

  visible(drive, row) {
    if (!row.name || /[\\/:\x00-\x1f]/.test(row.name) ||
        [".", ".."].includes(row.name) || row.attributes & REPARSE) return false;
    // Empty parent path is intentional for a raw MFT snapshot. The parent FRN
    // is resolved in bulk after enumeration, rather than opening the directory.
    if (row.directory === "") return true;
    if (!row.directory || !below(win32.normalize(row.directory), drive + ":\\")) return false;
    const path = fullPath(row).toLowerCase();
    return path !== this.applicationData && !below(path, this.applicationData);
  }

  changedPaths(drive, rows) {
    const paths = new Set();
    for (const row of rows) {
      const visible = this.visible(drive, row);
      if (visible) paths.add(fullPath(row));
      if (!visible || row.reason & (RENAME_OLD | RENAME_NEW | DELETE)) {
        const known = fullPath(this.item(drive, row.id));
        if (known) paths.add(known);
      }
    }
    return [...paths];
  }

  apply(drive, rows, snapshot, journal, cursor) {
    if (!rows.length && !(snapshot && cursor !== undefined)) return false;
    return this.transaction(() => {
      const saveParent = this.db.prepare(`
        INSERT INTO ntfs_parent VALUES (?, ?, ?, ?)
        ON CONFLICT (drive, id) DO UPDATE SET path = excluded.path, folded = excluded.folded
        WHERE ntfs_parent.path <> excluded.path
      `);
      const saveItem = this.db.prepare(`
        INSERT INTO ntfs_item(drive, id, parent, name, folded, directory, pinyin, initials)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (drive, id) DO UPDATE SET parent = excluded.parent, name = excluded.name,
          folded = excluded.folded, directory = excluded.directory,
          pinyin = excluded.pinyin, initials = excluded.initials
        WHERE ntfs_item.parent <> excluded.parent OR ntfs_item.name <> excluded.name
          OR ntfs_item.directory <> excluded.directory OR ntfs_item.pinyin IS NOT excluded.pinyin
          OR ntfs_item.initials IS NOT excluded.initials
      `);
      const removeItem = this.db.prepare("DELETE FROM ntfs_item WHERE drive = ? AND id = ?");
      let changed = false;
      for (const row of rows) {
        if (!snapshot && row.reason & RENAME_OLD && !(row.reason & (RENAME_NEW | DELETE))) continue;
        const visible = this.visible(drive, row);
        const old = !snapshot && (!visible || row.reason & (RENAME_NEW | DELETE)) ? this.item(drive, row.id) : null;
        if (!visible || !snapshot && row.reason & DELETE) {
          if (old?.isDirectory) this.updateSubtree(drive, fullPath(old));
          if (old) changed = Boolean(removeItem.run(drive, row.id).changes) || changed;
          continue;
        }
        const directory = Boolean(row.attributes & DIRECTORY);
        if (old?.isDirectory && fullPath(old) !== fullPath(row)) this.updateSubtree(drive, fullPath(old), fullPath(row));
        let parentChanged = 0;
        if (row.directory) {
          const parent = win32.normalize(row.directory);
          parentChanged = saveParent.run(drive, row.parent, parent, parent.toLowerCase()).changes;
        } else if (snapshot && isRootId(row.parent)) {
          // The NTFS root (MFT entry 5) is deliberately omitted from enumeration.
          // Preserve the root path so files immediately below C:\\ remain searchable.
          const root = drive + ":\\";
          parentChanged = saveParent.run(drive, row.parent, root, root.toLowerCase()).changes;
        }
        // ASCII-only filenames already have a fast folded-name index; avoid two
        // redundant phonetic keys and large regex allocations for most MFT rows.
        const keys = /[\u3400-\u9fff\uf900-\ufaff]/u.test(row.name)
          ? nameSearchKeys(row.name) : { pinyin: "", initials: "" };
        const itemChanged = saveItem.run(drive, row.id, row.parent, row.name, row.name.toLowerCase(),
          Number(directory), keys.pinyin, keys.initials).changes;
        changed = Boolean(parentChanged || itemChanged) || changed;
      }
      if (snapshot && cursor !== undefined) {
        // Same transaction as the rows: crash recovery resumes at an exact MFT cursor.
        this.db.prepare("UPDATE ntfs_drive SET build_position = ? WHERE drive = ?").run(cursor, drive);
      }
      if (!snapshot && cursor !== undefined) this.checkpoint(drive, journal, cursor);
      return changed;
    });
  }

  shouldRebuild(_drive, _rows) {
    // The index contains all MFT filenames, including protected directories;
    // ACL changes no longer invalidate an index. Rename and delete events are
    // handled incrementally by apply() and updateSubtree().
    return false;
  }

  updateSubtree(drive, oldPath, newPath) {
    const old = oldPath.toLowerCase();
    const start = prefix(old);
    const end = start.slice(0, -1) + "]";
    if (!newPath) {
      this.db.prepare(`
        DELETE FROM ntfs_item WHERE drive = ? AND parent IN (
          SELECT id FROM ntfs_parent WHERE drive = ? AND (folded = ? OR (folded >= ? AND folded < ?))
        )
      `).run(drive, drive, old, start, end);
      this.db.prepare("DELETE FROM ntfs_parent WHERE drive = ? AND (folded = ? OR (folded >= ? AND folded < ?))")
        .run(drive, old, start, end);
      return;
    }
    const rows = this.db.prepare(`
      SELECT id, path FROM ntfs_parent WHERE drive = ? AND (folded = ? OR (folded >= ? AND folded < ?))
    `).all(drive, old, start, end);
    const update = this.db.prepare("UPDATE ntfs_parent SET path = ?, folded = ? WHERE drive = ? AND id = ?");
    for (const row of rows) {
      const path = newPath + row.path.slice(oldPath.length);
      update.run(path, path.toLowerCase(), drive, row.id);
    }
  }

  backfillSearchKeys(limit = 300) {
    const rows = this.db.prepare(
      "SELECT drive, id, name FROM ntfs_item INDEXED BY ntfs_missing_keys WHERE pinyin IS NULL OR initials IS NULL LIMIT ?"
    ).all(limit);
    if (!rows.length) return 0;
    this.transaction(() => {
      const update = this.db.prepare(
        "UPDATE ntfs_item SET pinyin = ?, initials = ? WHERE drive = ? AND id = ?"
      );
      for (const row of rows) {
        const keys = nameSearchKeys(row.name);
        update.run(keys.pinyin, keys.initials, row.drive, row.id);
      }
    });
    return rows.length;
  }

  recordUse(drive, id) {
    if (!this.item(drive, id)) return;
    this.db.prepare(`INSERT INTO ntfs_usage(drive, id, use_count, last_used_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(drive, id) DO UPDATE SET
      use_count = use_count + 1, last_used_at = excluded.last_used_at`)
      .run(drive, id, Date.now());
  }

  favorite(drive, id, enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("无效的收藏状态");
    if (!this.item(drive, id)) return false;
    this.db.prepare(`INSERT INTO ntfs_usage(drive, id, favorite)
      VALUES (?, ?, ?) ON CONFLICT(drive, id) DO UPDATE SET favorite = excluded.favorite`)
      .run(drive, id, Number(enabled));
    return true;
  }

  favorites(drive, limit = 100) {
    const rows = this.db.prepare(`SELECT i.id, i.parent, i.name, i.folded, i.pinyin, i.initials,
      p.path AS directory, i.directory AS isDirectory, u.use_count AS useCount,
      u.last_used_at AS lastUsedAt, u.favorite AS favorite
      FROM ntfs_usage u CROSS JOIN ntfs_item i ON i.drive = u.drive AND i.id = u.id
      LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE u.drive = ? AND u.favorite = 1
      ORDER BY u.last_used_at DESC LIMIT ?`).all(drive, limit);
    return rows.filter((row) => {
      row.directory ??= this.resolveParent(drive, row.parent);
      const path = fullPath(row)?.toLowerCase();
      return path && path !== this.applicationData && !below(path, this.applicationData);
    });
  }

  recent(drive, limit = 60) {
    const rows = this.db.prepare(`SELECT i.id, i.parent, i.name, i.folded, i.pinyin, i.initials,
      p.path AS directory, i.directory AS isDirectory, u.use_count AS useCount,
      u.last_used_at AS lastUsedAt, u.favorite AS favorite
      FROM ntfs_usage u CROSS JOIN ntfs_item i ON i.drive = u.drive AND i.id = u.id
      LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE u.drive = ? AND (u.use_count > 0 OR u.favorite = 1)
      ORDER BY u.favorite DESC, u.use_count DESC, u.last_used_at DESC LIMIT ?`).all(drive, limit);
    return rows.filter((row) => {
      row.directory ??= this.resolveParent(drive, row.parent);
      const path = fullPath(row)?.toLowerCase();
      return path && path !== this.applicationData && !below(path, this.applicationData);
    });
  }

  search(drive, query, { fastOnly = false } = {}) {
    const prepared = prepareQuery(query);
    const terms = prepared.terms;
    if (!terms.length) return [];
    // File extensions usually occur at the end, so anchor indexed candidates
    // on a filename/phonetic token before filtering by extension.
    const extensions = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "zip", "rar", "7z", "png", "jpg", "jpeg", "gif", "mp3", "mp4", "html", "json", "csv", "exe", "dll", "sys"];
    const isExtension = (term) => term.length >= 2 && extensions.some((ext) => ext.startsWith(term.replace(/^\./, "")));
    const orderedTerms = [...new Set(terms)].sort((a, b) =>
      Number(isExtension(a)) - Number(isExtension(b)) || b.length - a.length || a.localeCompare(b));
    const rawPrimary = orderedTerms[0];
    // Split explicit path queries so we can still use the indexed filename
    // prefix instead of scanning every path on disk.
    const pathParts = rawPrimary.replaceAll("/", "\\");
    const separator = pathParts.lastIndexOf("\\");
    const directoryHint = separator >= 0 ? pathParts.slice(0, separator) : "";
    const primary = separator >= 0 ? pathParts.slice(separator + 1) : rawPrimary;
    if (!primary) return [];
    const anchors = [...new Set(orderedTerms.map((word) =>
      word.replaceAll("/", "\\").split("\\").at(-1)))].filter(Boolean).slice(0, 3);
    const columns = "SELECT i.id, i.parent, i.name, i.folded, i.pinyin, i.initials," +
      " p.path AS directory, i.directory AS isDirectory," +
      " coalesce(u.use_count, 0) AS useCount, coalesce(u.last_used_at, 0) AS lastUsedAt," +
      " coalesce(u.favorite, 0) AS favorite";
    const from = "FROM ntfs_item i LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent" +
      " LEFT JOIN ntfs_usage u ON u.drive = i.drive AND u.id = i.id";

    function filters(words) {
      const clauses = [];
      const args = [];
      for (const { term, count } of termGroups(words)) {
        const path = term.includes("/") || term.includes("\\");
        const keys = path ? ["rtrim(p.folded, char(92)) || char(92) || i.folded"]
          : /^[a-z0-9]+$/u.test(term) ? ["i.folded", "i.pinyin", "i.initials"] : ["i.folded"];
        const condition = termCondition(keys, path ? term.replaceAll("/", "\\") : term, count);
        clauses.push(condition.where);
        args.push(...condition.args);
      }
      return { where: clauses.join(" AND ") || "1", args };
    }

    // Include the primary word too: a prefix match alone does not satisfy repeated words.
    const others = filters(terms);
    if (directoryHint) {
      others.where = (others.where === "1" ? "" : others.where + " AND ") +
        "instr(p.folded, ?) > 0";
      others.args.push(directoryHint);
    }
    const results = [];
    const seen = new Set();
    const applicationData = this.applicationData;
    const resolveParent = (parent) => this.resolveParent(drive, parent);
    function collect(rows) {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        row.directory ??= resolveParent(row.parent);
        const path = fullPath(row)?.toLowerCase();
        if (!path || path === applicationData || below(path, applicationData)) continue;
        seen.add(row.id);
        results.push(row);

      }
    }

    // Look up the tiny set of files the user has actually used before broad name searches.
    // This keeps familiar files visible even when a short prefix matches thousands of system files.
    const usedFilters = filters(terms);
    const frequent = this.db.prepare(columns +
      " FROM ntfs_usage u CROSS JOIN ntfs_item i ON i.drive = u.drive AND i.id = u.id" +
      " LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent" +
      " WHERE u.drive = ? AND " + usedFilters.where +
      " ORDER BY u.favorite DESC, u.use_count DESC, u.last_used_at DESC LIMIT 40")
      .all(drive, ...usedFilters.args);
    collect(frequent);

    // Very short romanized queries are often Chinese filename initials (e.g. sy -> 实验).
    // Keep indexed prefix scans so typing remains responsive on large volumes.
    // Multiple words can occur in either order in the filename. Try bounded
    // indexed ranges for several anchors; every candidate still satisfies all terms.
    for (const anchor of anchors) {
      const columnsToTry = /^[a-z0-9]+$/u.test(anchor)
        ? (anchor.length <= 2 ? ["i.initials", "i.folded", "i.pinyin"]
          : ["i.folded", "i.pinyin", "i.initials"]) : ["i.folded"];
      for (const column of columnsToTry) {
        const index = { "i.folded": "ntfs_item_name", "i.initials": "ntfs_item_initials", "i.pinyin": "ntfs_item_pinyin" }[column];
        // Materialize a bounded indexed range BEFORE joins and secondary filters.
        // Otherwise SQLite can choose a drive-wide scan on a broad prefix,
        // especially when its statistics do not reflect a large MFT catalog.
        const key = column.slice(2);
        const sql = "WITH candidates AS MATERIALIZED (SELECT * FROM ntfs_item INDEXED BY " + index +
          " WHERE drive = ? AND " + key + " >= ? AND " + key + " < ? LIMIT ?) " +
          columns + " " + from.replace("ntfs_item i", "candidates i") +
          " WHERE " + others.where + " LIMIT ?";
        const matches = this.db.prepare(sql).all(drive, anchor, anchor + "\uffff",
          fastOnly ? 768 : 8192, ...others.args, 100);
        collect(matches);
      }
    }
    // Short initials such as "sy" are handled by indexed prefix scans. Avoid an
    // O(entire disk) infix scan on each keystroke while an input is still changing.
    // The UI's fast path never performs an entire-volume substring scan.
    // Keep the complete scan available for explicit deep search and the
    // compatibility API, without putting it on the keystroke hot path.
    if (fastOnly || results.length >= 40) return rank(results);
    const all = filters(terms);
    const infix = this.db.prepare(columns + " " + from +
      " WHERE i.drive = ? AND " + all.where + " LIMIT 200").all(drive, ...all.args);
    collect(infix);
    return rank(results);

    function rank(matches) {
      for (const row of matches) row.matchScore = scoreFile(row, prepared);
      return matches.sort(compareFiles).slice(0, 100);
    }
  }

  close() { this.db.close(); }
}

module.exports = { NtfsCatalog, fullPath };
