"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { NtfsCatalog } = require("./ntfs-catalog.cjs");
const { NtfsSearch } = require("./ntfs-search.cjs");

const volume = "\\\\?\\Volume{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}\\";
const row = (id, parent, name, attributes = 0) =>
  ({ id: String(id), parent: String(parent), name, directory: "", attributes, reason: 0 });

test("raw MFT snapshot resolves nested and hidden system files, with persisted crash-resume cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "filerecall-mft-fast-"));
  const path = join(dir, "ntfs.sqlite");
  let db;
  try {
    db = new NtfsCatalog(path, "C:\\Users\\Me\\AppData\\Roaming\\filerecall-desktop");
    db.enable("C", volume);
    assert.equal(db.beginBuild("C", "201", "37"), "0");
    db.apply("C", [
      row(100, 5, "Windows", 16), row(101, 100, "System32", 16),
      row(102, 101, "config", 16), row(103, 102, "SAM", 0x2 | 0x4),
      row(104, 5, "pagefile.sys", 0x2 | 0x4),
      row(105, 5, "实验报告.pdf"),
      row(106, 5, "Users", 16), row(107, 106, "Me", 16),
      row(108, 107, "AppData", 16), row(109, 108, "Roaming", 16),
      row(110, 109, "filerecall-desktop", 16),
      row(111, 110, "ntfs-index.sqlite"),
    ], true, undefined, "55");
    assert.equal(db.drives()[0].build_position, "55");
    assert.equal(db.drives()[0].build_usn, "37", "preserve the pre-scan USN checkpoint");
    assert.equal(db.search("C", "pagefile")[0]?.directory, "C:\\", "partial MFT is searchable immediately");
    assert.equal(db.search("C", "sam")[0]?.directory, "C:\\Windows\\System32\\config",
      "nested parent FRNs can be resolved before final materialization");
    db.close();
    db = new NtfsCatalog(path, "C:\\Users\\Me\\AppData\\Roaming\\filerecall-desktop");
    assert.equal(db.beginBuild("C", "201", "999"), "55", "resumes exact committed position");
    assert.equal(db.drives()[0].build_usn, "37", "USN base remains the snapshot-start cursor");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM ntfs_item").get().count, 12);
    db.finishBuild("C");
    db.checkpoint("C", "201", "77");
    assert.equal(db.search("C", "sam")[0]?.directory, "C:\\Windows\\System32\\config");
    assert.equal(db.search("C", "pagefile")[0]?.directory, "C:\\");
    assert.equal(db.search("C", "sybg")[0]?.name, "实验报告.pdf");
    assert.equal(db.search("C", "Windows\\System32\\config\\SAM")[0]?.name, "SAM");
    assert.deepEqual(db.search("C", "ntfs-index.sqlite"), [], "local private DB excluded from results");
    assert.equal(db.drives()[0].build_position, null);
    assert.equal(db.drives()[0].cursor, "77");
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("large initial scans yield to another volume before the first drive finishes", async (t) => {
  const calls = [];
  const reader = {
    closed: false,
    close() { this.closed = true; },
    async request(verb, drive, _volume, _journal, position) {
      calls.push([verb, drive, position]);
      if (verb === "probe") return { volume, journal: "300", first: "0", next: "900" };
      if (verb === "enum") {
        const n = Number(position);
        return n >= 34 ? { end: true } :
          { next: String(n + 1), rows: [row(200 + n, 5, "file-" + drive + "-" + n + ".txt")] };
      }
      return { next: "900", rows: [] };
    },
  };
  const service = new NtfsSearch(":memory:", "C:\\AppData", "", {
    onChange() {}, onPaths: async () => {}, onActiveDrives() {},
    createReader: async () => reader,
  });
  t.after(() => service.close());
  service.reader = reader;
  service.catalog.enable("C", volume);
  service.catalog.enable("D", volume);
  const [c, d] = service.catalog.drives();
  assert.equal(await service.syncDrive(c), true, "C yields after 32 MFT pages");
  assert.equal(service.catalog.drives()[0].build_position, "32");
  assert.equal(await service.syncDrive(d), true, "D can progress before C finishes");
  assert.equal(service.catalog.drives()[1].build_position, "32");
  assert.ok(calls.some(([verb, drive]) => verb === "enum" && drive === "D"));
  assert.equal(await service.syncDrive(service.catalog.drives()[0]), false);
  assert.equal(await service.syncDrive(service.catalog.drives()[1]), false);
  assert.equal(service.status().drives[0].phase, "ready");
  assert.equal(service.status().drives[1].phase, "ready");
  assert.equal(service.search("file-D-2")[0]?.path, "D:\\file-D-2.txt");
});
