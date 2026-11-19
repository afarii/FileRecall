"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rename, unlink, rm, symlink, copyFile, utimes } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { FileIndex } = require("./indexer.cjs");

test("scan persists entries; rescans retain vanished files as history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const database = join(workspace, "index.sqlite");
  let index;
  try {
    await mkdir(folder);
    await writeFile(join(folder, "original.txt"), "hello");
    index = new FileIndex(database);
    const first = await index.addRoot(folder);
    assert.equal(first.indexed, 1);
    assert.equal(first.complete, true);
    assert.equal(index.search("original")[0].status, "present");

    await rename(join(folder, "original.txt"), join(folder, "renamed.txt"));
    const second = await index.scan(folder);
    assert.equal(second.missing, 1);
    assert.equal(index.search("original")[0].status, "missing");
    assert.equal(index.search("renamed")[0].status, "present");

    await unlink(join(folder, "renamed.txt"));
    await index.scan(folder);
    assert.equal(index.search("renamed")[0].status, "missing");
    index.close();
    index = new FileIndex(database);
    assert.equal(index.roots().length, 1);
    assert.equal(index.search("renamed")[0].status, "missing");
  } finally {
    index?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("old paths follow a file across authorized roots after restart and refuse a replacement", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const source = join(workspace, "source");
  const destination = join(workspace, "destination");
  const original = join(source, "original.txt");
  const intermediate = join(destination, "intermediate.txt");
  const current = join(destination, "current.txt");
  const database = join(workspace, "index.sqlite");
  let index = new FileIndex(database);
  try {
    await mkdir(source);
    await mkdir(destination);
    await writeFile(original, "same bytes");
    await writeFile(join(destination, "independent.txt"), "same bytes");
    await index.addRoot(source);
    await index.addRoot(destination);
    index.close();
    await rename(original, intermediate);
    index = new FileIndex(database);

    await index.scan(destination);
    assert.equal(index.search("original.txt")[0].currentPath, null);
    await index.scan(source);
    assert.equal(index.search("original.txt")[0].currentPath, intermediate);
    assert.equal(await index.movedTarget(original), intermediate);

    await rename(intermediate, current);
    await index.scan(destination);
    assert.equal(index.search("original.txt")[0].currentPath, current);
    assert.equal(index.search("intermediate.txt")[0].currentPath, current);
    index.removeRoot(destination);
    assert.equal(index.search("original.txt")[0].currentPath, null);
    await index.addRoot(destination);
    assert.equal(await index.movedTarget(original), current);

    await rename(current, join(workspace, "outside.txt"));
    await writeFile(current, "same bytes");
    assert.equal(await index.movedTarget(original), null);
    await index.scan(destination);
    assert.equal(index.search("original.txt")[0].currentPath, null);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a metadata match is a candidate and competing copies suppress the suggestion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    const firstDirectory = join(folder, "first");
    const secondDirectory = join(folder, "second");
    await mkdir(firstDirectory, { recursive: true });
    await mkdir(secondDirectory);
    const oldPath = join(folder, "report.txt");
    const copy = join(firstDirectory, "report.txt");
    const otherCopy = join(secondDirectory, "report.txt");
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(oldPath, "document");
    await utimes(oldPath, timestamp, timestamp);
    await index.addRoot(folder);
    await copyFile(oldPath, copy);
    await utimes(copy, timestamp, timestamp);
    await unlink(oldPath);
    await index.scan(folder);
    const old = () => index.search(oldPath).find(({ path }) => path === oldPath);
    assert.equal(old().currentPath, null);
    assert.equal(old().possiblePath, copy);
    assert.equal(await index.movedTarget(oldPath), null);
    await copyFile(copy, otherCopy);
    await utimes(otherCopy, timestamp, timestamp);
    await index.scan(folder);
    assert.equal(old().possiblePath, null);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("older path-only records remain searchable and gain identity after reindexing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const database = join(workspace, "index.sqlite");
  const original = join(folder, "legacy.txt");
  const current = join(folder, "modern.txt");
  let index;
  try {
    await mkdir(folder);
    await writeFile(original, "legacy");
    const legacy = new DatabaseSync(database);
    legacy.exec("CREATE TABLE files (path TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, modified_at REAL NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, scan_token TEXT NOT NULL, status TEXT NOT NULL)");
    legacy.prepare("INSERT INTO files VALUES (?, ?, 'legacy.txt', 6, 0, 1, 1, 'legacy', 'present')").run(original, folder);
    legacy.close();
    index = new FileIndex(database);
    assert.equal(index.search("legacy")[0].currentPath, null);
    await index.addRoot(folder);
    assert.equal(index.search("legacy")[0].firstSeenAt, 1);
    await rename(original, current);
    await index.scan(folder);
    assert.equal(index.search("legacy")[0].currentPath, current);
  } finally {
    index?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search treats wildcards literally", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  let index;
  try {
    await mkdir(folder);
    await writeFile(join(folder, "100%report.txt"), "x");
    await writeFile(join(folder, "unrelated.txt"), "y");
    index = new FileIndex(join(workspace, "index.sqlite"));
    await index.addRoot(folder);
    assert.deepEqual(index.search("%").map((record) => record.name), ["100%report.txt"]);
    assert.equal(index.search("____").length, 0);
  } finally {
    index?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("opt-in literal text search persists, follows edits and retains missing history until cleared", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-text-"));
  const folder = join(workspace, "files");
  const database = join(workspace, "index.sqlite");
  const note = join(folder, "notes.MD");
  let index;
  try {
    await mkdir(folder);
    await writeFile(note, "冬季预算草案 Alpha%_");
    await writeFile(join(folder, "large.txt"), "Oversized secret".padEnd(128 * 1024 + 1));
    await writeFile(join(folder, "binary.txt"), Buffer.from([0xff, ...Buffer.from("binary marker")]));
    index = new FileIndex(database);
    await index.addRoot(folder);
    assert.equal(index.textEnabled(), false);
    assert.deepEqual(index.search("预算草案"), []);
    assert.throws(() => index.setTextEnabled("true"), /正文索引设置/);
    index.setTextEnabled(true);
    await index.scan(folder);
    assert.equal(index.search("预算草案")[0].textMatched, 1);
    assert.equal(index.search("ALPHA%_")[0].path, note);
    assert.deepEqual(index.search("ALPHA__"), []);
    assert.deepEqual(index.search("Oversized secret"), []);
    assert.deepEqual(index.search("binary marker"), []);
    index.close();
    index = new FileIndex(database);
    assert.equal(index.textEnabled(), true);
    assert.equal(index.search("预算草案")[0].path, note);
    await writeFile(note, "春季采购清单");
    await index.scan(folder);
    assert.deepEqual(index.search("预算草案"), []);
    assert.equal(index.search("采购清单")[0].status, "present");
    await unlink(note);
    await index.scan(folder);
    assert.equal(index.search("采购清单")[0].status, "missing");
    index.setTextEnabled(false);
    assert.deepEqual(index.search("采购清单"), []);
    assert.equal(index.search("notes.MD")[0].status, "missing");
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM file_text").get().count, 0);
  } finally {
    index?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("revoking a root clears its text unless a child is still authorized; clearing history cascades", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-text-roots-"));
  const folder = join(workspace, "files");
  const child = join(folder, "child");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(child, { recursive: true });
    await writeFile(join(folder, "outside.txt"), "outside scope");
    await writeFile(join(child, "inside.txt"), "inside scope");
    index.setTextEnabled(true);
    await index.addRoot(folder);
    await index.addRoot(child);
    assert.equal(index.search("scope").length, 2);
    index.removeRoot(folder);
    assert.equal(index.search("outside.txt").length, 1);
    assert.equal(index.search("outside scope").length, 0);
    assert.equal(index.search("inside scope").length, 1);
    index.clearHistory(child);
    assert.equal(index.search("inside scope").length, 0);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS count FROM file_text").get().count, 0);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("overlapping roots detect missing files regardless of the last scanning root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const nested = join(folder, "nested");
  const path = join(nested, "nested.txt");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path, "hello");
    await index.addRoot(nested);
    await index.addRoot(folder);
    await unlink(path);
    assert.equal((await index.scan(nested)).missing, 1);
    assert.equal(index.get(path).status, "missing");
    assert.equal((await index.scan(folder)).missing, 0);
    await writeFile(path, "restored");
    await index.scan(folder);
    assert.equal(index.get(path).status, "present");
    assert.equal(index.search("nested.txt").length, 1);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("database write failures reject the scan and preserve missing-file history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const path = join(folder, "old.txt");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(folder);
    await writeFile(path, "hello");
    await index.addRoot(folder);
    await unlink(path);
    await writeFile(join(folder, "new.txt"), "new");
    index.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON files
      BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
    await assert.rejects(index.scan(folder), /simulated disk failure/);
    assert.equal(index.get(path).status, "present");
    index.db.exec("DROP TRIGGER fail_write");
    assert.equal((await index.scan(folder)).missing, 1);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("directory links are skipped and unavailable roots retain records until recovery", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const outside = join(workspace, "outside");
  const moved = join(workspace, "offline");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(folder);
    await mkdir(outside);
    await writeFile(join(folder, "known.txt"), "hello");
    await writeFile(join(outside, "private.txt"), "outside scope");
    await symlink(outside, join(folder, "link"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await index.addRoot(folder)).complete, true);
    assert.equal(index.search("private").length, 0);
    await rename(folder, moved);
    await assert.rejects(index.scan(folder));
    assert.equal(index.search("known")[0].status, "present");
    await rename(moved, folder);
    assert.equal((await index.scan(folder)).complete, true);
    assert.equal(index.search("known").length, 1);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unknown directory is rejected before scanning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await assert.rejects(index.scan(join(workspace, "other")), /授权/);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("partial reads preserve history and a later complete scan recovers", async (t) => {
  const fs = require("node:fs/promises");
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const nested = join(folder, "nested");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(nested, { recursive: true });
    const path = join(nested, "history.txt");
    await writeFile(path, "hello");
    await index.addRoot(folder);
    await unlink(path);
    const read = fs.readdir;
    const mocked = t.mock.method(fs, "readdir", async (dir, options) => {
      if (dir === nested) throw new Error("simulated unreadable subtree");
      return read(dir, options);
    });
    const result = await index.scan(folder);
    assert.equal(result.complete, false);
    assert.equal(result.skipped, 1);
    assert.equal(result.missing, 0);
    assert.equal(index.get(path).status, "present");
    mocked.mock.restore();
    assert.equal((await index.scan(folder)).missing, 1);
    assert.equal(index.get(path).status, "missing");
  } finally {
    t.mock.restoreAll();
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("stopping a root preserves history and requires reauthorization to scan", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const database = join(workspace, "index.sqlite");
  let index = new FileIndex(database);
  try {
    await mkdir(folder);
    await writeFile(join(folder, "history.txt"), "hello");
    await index.addRoot(folder);
    index.removeRoot(folder);
    index.removeRoot(folder);
    index.close();
    index = new FileIndex(database);
    assert.equal(index.roots().length, 0);
    assert.equal(index.search("history").length, 1);
    await assert.rejects(index.scan(folder), /授权/);
    await index.addRoot(folder);
    assert.equal(index.search("history").length, 1);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("clearing directory history removes active and missing records while preserving files and siblings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const nested = join(folder, "nested");
  const sibling = join(workspace, "files-other");
  const database = join(workspace, "index.sqlite");
  let index = new FileIndex(database);
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);
    await writeFile(join(nested, "present.txt"), "preserve disk file");
    await writeFile(join(folder, "missing.txt"), "history");
    await writeFile(join(sibling, "other.txt"), "other");
    await index.addRoot(folder);
    await index.addRoot(nested);
    await index.addRoot(sibling);
    await unlink(join(folder, "missing.txt"));
    await index.scan(folder);
    assert.equal(index.clearHistory(folder), 2);
    assert.equal(index.clearHistory(folder), 0);
    assert.deepEqual(index.roots().map((root) => root.path), [sibling]);
    assert.deepEqual(index.search().map((file) => file.name), ["other.txt"]);
    assert.equal(await require("node:fs/promises").readFile(join(nested, "present.txt"), "utf8"), "preserve disk file");
    index.close();
    index = new FileIndex(database);
    assert.equal(index.historyRoots().length, 1);
    await assert.rejects(index.scan(folder), /授权/);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("history clearing rolls back on failure and prevents reindexing by an authorized parent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "filerecall-"));
  const folder = join(workspace, "files");
  const nested = join(folder, "nested");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "file.txt"), "hello");
    await index.addRoot(folder);
    assert.throws(() => index.clearHistory(nested), /父目录/);
    index.db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON files
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;`);
    assert.throws(() => index.clearHistory(folder), /simulated delete failure/);
    assert.equal(index.roots().length, 1);
    assert.equal(index.search().length, 1);
    index.db.exec("DROP TRIGGER fail_delete");
    index.removeRoot(folder);
    assert.equal(index.historyRoots()[0].count, 1);
    assert.equal(index.clearHistory(folder), 1);
  } finally {
    index.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
