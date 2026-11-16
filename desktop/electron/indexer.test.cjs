"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rename, unlink, rm, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
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
