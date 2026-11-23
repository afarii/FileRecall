"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { NtfsCatalog } = require("./ntfs-catalog.cjs");

test("pre-v0.4.6 NTFS indexes migrate incrementally without deleting file history", async () => {
  const folder = await mkdtemp(join(tmpdir(), "filerecall-pinyin-migration-"));
  const path = join(folder, "ntfs.sqlite");
  let catalog;
  try {
    const old = new DatabaseSync(path);
    old.exec([
      "CREATE TABLE ntfs_drive (drive TEXT PRIMARY KEY, volume TEXT NOT NULL, journal TEXT, cursor TEXT) WITHOUT ROWID",
      "CREATE TABLE ntfs_parent (drive TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, folded TEXT NOT NULL, PRIMARY KEY (drive, id)) WITHOUT ROWID",
      "CREATE TABLE ntfs_item (drive TEXT NOT NULL, id TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, folded TEXT NOT NULL, directory INTEGER NOT NULL, PRIMARY KEY (drive, id)) WITHOUT ROWID",
    ].join(";\n") + ";");
    old.prepare("INSERT INTO ntfs_drive VALUES (?, ?, ?, ?)").run("C", "volume-synthetic", "1", "10");
    old.prepare("INSERT INTO ntfs_parent VALUES (?, ?, ?, ?)").run("C", "7", "C:\\", "c:\\");
    old.prepare("INSERT INTO ntfs_item VALUES (?, ?, ?, ?, ?, ?)").run(
      "C", "99", "7", "实验报告.pdf", "实验报告.pdf", 0);
    old.close();
    catalog = new NtfsCatalog(path, "C:\\AppData");
    assert.equal(catalog.search("C", "实验报告.pdf").length, 1);
    assert.equal(catalog.search("C", "sybg").length, 0);
    assert.equal(catalog.backfillSearchKeys(2), 1);
    assert.equal(catalog.backfillSearchKeys(2), 0);
    for (const query of ["shiyanbaogao", "sybg", "pdf sybg", "sy "]) {
      assert.equal(catalog.search("C", query)[0]?.name, "实验报告.pdf", query);
    }
    assert.equal(catalog.drives()[0].cursor, "10", "migration retains USN cursor");
    catalog.apply("C", [{ id: "99", parent: "7", directory: "C:\\",
      name: "课程报告.docx", attributes: 0, reason: 0x2000 }], false, "1", "11");
    assert.equal(catalog.search("C", "kcbg")[0]?.name, "课程报告.docx");
    assert.equal(catalog.search("C", "sybg").length, 0);
  } finally {
    catalog?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
