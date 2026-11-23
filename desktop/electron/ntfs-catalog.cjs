"use strict";

const { DatabaseSync } = require("node:sqlite");
const { win32 } = require("node:path");
const { nameSearchKeys, queryTerms } = require("./filename-search.cjs");

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
    const driveColumns = new Set(this.db.prepare("PRAGMA table_info(ntfs_drive)").all().map((entry) => entry.name));
    if (!driveColumns.has("build_position")) this.db.exec("ALTER TABLE ntfs_drive ADD COLUMN build_position TEXT");
    if (!driveColumns.has("build_journal")) this.db.exec("ALTER TABLE ntfs_drive ADD COLUMN build_journal TEXT");
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

  disable(drive) {
    this.transaction(() => {
      this.discardRows(drive);
      this.db.prepare("DELETE FROM ntfs_drive WHERE drive = ?").run(drive);
      this.db.prepare("INSERT OR IGNORE INTO ntfs_excluded_drive VALUES (?)").run(drive);
    });
  }

  beginBuild(drive, journal) {
    const state = this.db.prepare("SELECT build_position, build_journal FROM ntfs_drive WHERE drive = ?").get(drive);
    if (state?.build_journal === journal && state.build_position !== null) return state.build_position;
    this.transaction(() => {
      this.db.prepare("UPDATE ntfs_drive SET cursor = NULL, journal = NULL, build_position = '0', build_journal = ? WHERE drive = ?")
        .run(journal, drive);
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
      SET journal = ?, cursor = ?, build_position = NULL, build_journal = NULL
      WHERE drive = ?
    `).run(journal, cursor, drive);
  }

  item(drive, id) {
    return this.db.prepare(`
      SELECT i.name, p.path AS directory, i.directory AS isDirectory
      FROM ntfs_item i JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE i.drive = ? AND i.id = ?
    `).get(drive, id);
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
    if (!rows.length && !(snapshot && cursor !== undefined)) return;
    this.transaction(() => {
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
        const keys = nameSearchKeys(row.name);
        const itemChanged = saveItem.run(drive, row.id, row.parent, row.name, row.name.toLowerCase(),
          Number(directory), keys.pinyin, keys.initials).changes;
        changed = Boolean(parentChanged || itemChanged) || changed;
      }
      if (snapshot && cursor !== undefined) {
        // Same transaction as the rows: crash recovery resumes at an exact MFT cursor.
        this.db.prepare("UPDATE ntfs_drive SET build_position = ? WHERE drive = ?").run(cursor, drive);
      }
      if (changed && !snapshot) this.checkpoint(drive, journal, cursor);
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
      "SELECT drive, id, name FROM ntfs_item WHERE pinyin IS NULL OR initials IS NULL LIMIT ?"
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

  search(drive, query) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const primary = [...terms].sort((a, b) => b.length - a.length)[0];
    const upper = primary + "\uffff";
    const columns = "SELECT i.id, i.name, p.path AS directory, i.directory AS isDirectory";
    const from = "FROM ntfs_item i JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent";

    function filters(words) {
      const clauses = [];
      const args = [];
      for (const term of words) {
        if (term.includes("/") || term.includes("\\")) {
          clauses.push("instr(rtrim(p.folded, char(92)) || char(92) || i.folded, ?) > 0");
          args.push(term.replaceAll("/", "\\"));
        } else if (!/^[a-z0-9]+$/u.test(term)) {
          // Han characters or punctuation can only appear in the literal filename.
          clauses.push("instr(i.folded, ?) > 0");
          args.push(term);
        } else {
          clauses.push("(instr(i.folded, ?) > 0 OR instr(i.pinyin, ?) > 0 OR instr(i.initials, ?) > 0)");
          args.push(term, term, term);
        }
      }
      return { where: clauses.join(" AND ") || "1", args };
    }

    const others = filters(terms.filter((term) => term !== primary));
    const results = [];
    const seen = new Set();
    const applicationData = this.applicationData;
    function collect(rows) {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        const path = fullPath(row)?.toLowerCase();
        if (!path || path === applicationData || below(path, applicationData)) continue;
        seen.add(row.id);
        results.push(row);
        if (results.length === 100) break;
      }
    }

    // Separate indexed range scans avoid sorting huge sets when the prefix is common.
    const columnsToTry = /^[a-z0-9]+$/u.test(primary)
      ? ["i.folded", "i.pinyin", "i.initials"] : ["i.folded"];
    for (const column of columnsToTry) {
      if (results.length >= 100) break;
      const sql = columns + " " + from + " WHERE i.drive = ? AND " +
        column + " >= ? AND " + column + " < ? AND " + others.where +
        " LIMIT ?";
      const matches = this.db.prepare(sql).all(drive, primary, upper,
        ...others.args, 100 - results.length);
      collect(matches);
    }
    if (results.length >= 100) return results;

    // Preserve substring searches; normal filename queries avoid parent-path checks.
    const all = filters(terms);
    const infix = this.db.prepare(columns + " " + from +
      " WHERE i.drive = ? AND " + all.where + " LIMIT 200").all(drive, ...all.args);
    collect(infix);
    return results;
  }

  close() { this.db.close(); }
}

module.exports = { NtfsCatalog, fullPath };
