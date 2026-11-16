"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rename, unlink, rm } = require("node:fs/promises");
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

test("search treats wildcards literally and never follows symlink entries", async () => {
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
