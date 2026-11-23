"use strict";

const { DatabaseSync } = require("node:sqlite");
const { win32 } = require("node:path");

const DIRECTORY = 0x10;
const DELETE = 0x200;
const SECURITY_CHANGE = 0x800;
const RENAME_OLD = 0x1000;
const RENAME_NEW = 0x2000;
const REPARSE = 0x400;

const prefix = (path) => path.endsWith("\\") ? path : path + "\\";
const below = (path, root) => path.toLowerCase().startsWith(prefix(root).toLowerCase());
const fullPath = (row) => row && win32.join(row.directory, row.name);

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

  enable(drive, volume) {
    this.db.prepare("INSERT OR IGNORE INTO ntfs_drive VALUES (?, ?, NULL, NULL)").run(drive, volume);
  }

  discardRows(drive) {
    this.db.prepare("DELETE FROM ntfs_item WHERE drive = ?").run(drive);
    this.db.prepare("DELETE FROM ntfs_parent WHERE drive = ?").run(drive);
  }

  disable(drive) {
    this.transaction(() => {
      this.discardRows(drive);
      this.db.prepare("DELETE FROM ntfs_drive WHERE drive = ?").run(drive);
    });
  }

  beginBuild(drive) {
    this.transaction(() => {
      this.db.prepare("UPDATE ntfs_drive SET cursor = NULL, journal = NULL WHERE drive = ?").run(drive);
      this.discardRows(drive);
    });
  }

  checkpoint(drive, journal, cursor) {
    this.db.prepare("UPDATE ntfs_drive SET journal = ?, cursor = ? WHERE drive = ? AND (journal IS NOT ? OR cursor IS NOT ?)")
      .run(journal, cursor, drive, journal, cursor);
  }

  item(drive, id) {
    return this.db.prepare(`
      SELECT i.name, p.path AS directory, i.directory AS isDirectory
      FROM ntfs_item i JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE i.drive = ? AND i.id = ?
    `).get(drive, id);
  }

  visible(drive, row) {
    if (!row.directory || !row.name || !below(win32.normalize(row.directory), drive + ":\\")
      || /[\\/:\x00-\x1f]/.test(row.name) || [".", ".."].includes(row.name) || row.attributes & REPARSE) return false;
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
    if (!rows.length) return;
    this.transaction(() => {
      const saveParent = this.db.prepare(`
        INSERT INTO ntfs_parent VALUES (?, ?, ?, ?)
        ON CONFLICT (drive, id) DO UPDATE SET path = excluded.path, folded = excluded.folded
        WHERE ntfs_parent.path <> excluded.path
      `);
      const saveItem = this.db.prepare(`
        INSERT INTO ntfs_item VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (drive, id) DO UPDATE SET parent = excluded.parent, name = excluded.name,
          folded = excluded.folded, directory = excluded.directory
        WHERE ntfs_item.parent <> excluded.parent OR ntfs_item.name <> excluded.name
          OR ntfs_item.directory <> excluded.directory
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
        const parent = win32.normalize(row.directory);
        const parentChanged = saveParent.run(drive, row.parent, parent, parent.toLowerCase()).changes;
        const itemChanged = saveItem.run(drive, row.id, row.parent, row.name, row.name.toLowerCase(), Number(directory)).changes;
        changed = Boolean(parentChanged || itemChanged) || changed;
      }
      if (changed && !snapshot) this.checkpoint(drive, journal, cursor);
    });
  }

  shouldRebuild(drive, rows) {
    return rows.some((row) => {
      if (!(row.attributes & DIRECTORY) || !(row.reason & (SECURITY_CHANGE | RENAME_NEW))) return false;
      const visible = this.visible(drive, row);
      const existing = this.item(drive, row.id);
      return row.reason & SECURITY_CHANGE ? Boolean(existing || visible) : visible && !existing;
    });
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

  search(drive, query) {
    const text = query.toLowerCase().trim();
    if (!text) return [];
    const needle = text.split(/[/\\]/).at(-1);
    if (!needle) return [];
    if (needle.length < 2) {
      return this.db.prepare(`
        SELECT i.id, i.name, p.path AS directory, i.directory AS isDirectory
        FROM ntfs_item i JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
        WHERE i.drive = ? AND i.folded >= ? AND i.folded < ? LIMIT 100
      `).all(drive, needle, needle + "\uffff");
    }
    return this.db.prepare(`
      SELECT i.id, i.name, p.path AS directory, i.directory AS isDirectory
      FROM ntfs_item i JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent
      WHERE i.drive = ? AND instr(i.folded, ?) > 0
      AND (? = 0 OR instr(rtrim(p.folded, '\\') || '\\' || i.folded, ?) > 0) LIMIT 100
    `).all(drive, needle, /[/\\]/.test(text) ? 1 : 0, text.replaceAll("/", "\\"));
  }

  close() { this.db.close(); }
}

module.exports = { NtfsCatalog, fullPath };
