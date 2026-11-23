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
    this.db.exec(`CREATE TABLE IF NOT EXISTS ntfs_usage (
      drive TEXT NOT NULL, id TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (drive, id)
    ) WITHOUT ROWID`);
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
      if (changed && !snapshot && cursor !== undefined) this.checkpoint(drive, journal, cursor);
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

  recordUse(drive, id) {
    if (!this.item(drive, id)) return;
    this.db.prepare(`INSERT INTO ntfs_usage(drive, id, use_count, last_used_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(drive, id) DO UPDATE SET
      use_count = use_count + 1, last_used_at = excluded.last_used_at`)
      .run(drive, id, Date.now());
  }

  search(drive, query) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const rawPrimary = [...terms].sort((a, b) => b.length - a.length)[0];
    // Split explicit path queries so we can still use the indexed filename
    // prefix instead of scanning every path on disk.
    const pathParts = rawPrimary.replaceAll("/", "\\");
    const separator = pathParts.lastIndexOf("\\");
    const directoryHint = separator >= 0 ? pathParts.slice(0, separator) : "";
    const primary = separator >= 0 ? pathParts.slice(separator + 1) : rawPrimary;
    if (!primary) return [];
    const upper = primary + "\uffff";
    const columns = "SELECT i.id, i.parent, i.name, i.folded, i.pinyin, i.initials," +
      " p.path AS directory, i.directory AS isDirectory," +
      " coalesce(u.use_count, 0) AS useCount, coalesce(u.last_used_at, 0) AS lastUsedAt";
    const from = "FROM ntfs_item i LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent" +
      " LEFT JOIN ntfs_usage u ON u.drive = i.drive AND u.id = i.id";

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

    const others = filters(terms.filter((term) => term !== rawPrimary));
    if (directoryHint) {
      others.where += (others.where === "1" ? "" : " AND ") + "instr(p.folded, ?) > 0";
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
        if (results.length === 100) break;
      }
    }

    // Look up the tiny set of files the user has actually used before broad name searches.
    // This keeps familiar files visible even when a short prefix matches thousands of system files.
    const usedFilters = filters(terms);
    const frequent = this.db.prepare(columns +
      " FROM ntfs_usage u JOIN ntfs_item i ON i.drive = u.drive AND i.id = u.id" +
      " LEFT JOIN ntfs_parent p ON p.drive = i.drive AND p.id = i.parent" +
      " WHERE u.drive = ? AND " + usedFilters.where +
      " ORDER BY u.use_count DESC, u.last_used_at DESC LIMIT 40")
      .all(drive, ...usedFilters.args);
    collect(frequent);

    // Very short romanized queries are often Chinese filename initials (e.g. sy -> 实验).
    // Keep indexed prefix scans so typing remains responsive on large volumes.
    const columnsToTry = /^[a-z0-9]+$/u.test(primary)
      ? (primary.length <= 2 ? ["i.initials", "i.folded", "i.pinyin"]
        : ["i.folded", "i.pinyin", "i.initials"]) : ["i.folded"];
    for (const column of columnsToTry) {
      if (results.length >= 100) break;
      const sql = columns + " " + from + " WHERE i.drive = ? AND " +
        column + " >= ? AND " + column + " < ? AND " + others.where +
        " LIMIT ?";
      const matches = this.db.prepare(sql).all(drive, primary, upper,
        ...others.args, 100 - results.length);
      collect(matches);
    }
    // Short initials such as "sy" are handled by indexed prefix scans. Avoid an
    // O(entire disk) infix scan on each keystroke while an input is still changing.
    if (results.length >= 100 || primary.length <= 2 || results.length >= 40) return rank(results);

    // Interactive search stays on indexed prefix paths. A full MFT substring
    // scan on every keystroke can take seconds on a multi-million-file volume.
    // Users can explicitly request a deeper scan separately if needed.
    return rank(results);

    function rank(matches) {
      const systemPath = /\\(?:windows|program files|program files \(x86\)|programdata)\\/i;
      const documentType = /\.(?:pdf|docx?|xlsx?|pptx?|md|txt|csv)$/i;
      for (const row of matches) {
        const name = row.folded || row.name.toLowerCase();
        const chinese = /\p{Script=Han}/u.test(row.name);
        let score = Math.min(900, Math.log2(1 + row.useCount) * 220);
        if (name === query) score += 700;
        else if (name.startsWith(primary)) score += 280;
        else if (chinese && row.initials?.startsWith(primary)) score += 370;
        else if (row.pinyin?.startsWith(primary)) score += 310;
        else score += 80;
        if (documentType.test(row.name)) score += 125;
        if (row.isDirectory) score -= 45;
        if (/\.(?:sys|dll|exe|mui|log)$/i.test(row.name)) score -= 200;
        if (systemPath.test(row.directory || "")) score -= 190;
        row.matchScore = Math.round(score);
      }
      matches.sort((a, b) => b.matchScore - a.matchScore ||
        b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt ||
        a.name.localeCompare(b.name));
      return matches;
    }
  }

  close() { this.db.close(); }
}

module.exports = { NtfsCatalog, fullPath };
