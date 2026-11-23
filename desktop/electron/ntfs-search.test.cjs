"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NtfsSearch } = require("./ntfs-search.cjs");

const testVolume = "\\\\?\\Volume{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}\\";
const row = (id, parent, directory, name, { attributes = 0, reason = 0 } = {}) => (
  { id, parent, directory, name, attributes, reason });

test("NTFS resumes changes, moves directory descendants and rebuilds if the journal rolls over", async (t) => {
  const requests = [];
  const affected = [];
  let metadata = { volume: testVolume, journal: "42", first: "5", next: "10" };
  let snapshot = [
    row("51", "5", "E:\\", "Old", { attributes: 16 }),
    row("52", "51", "E:\\Old", "report中文.txt"),
    row("53", "51", "E:\\Old", "notes.txt"),
    row("54", "5", "E:\\", "FileRecall-data", { attributes: 16 }),
    row("55", "54", "E:\\FileRecall-data", "ntfs-index.sqlite"),
  ];
  let changes = [];
  const reader = {
    closed: false,
    close() { this.closed = true; },
    async request(verb, drive, volume, journal, cursor) {
      requests.push([verb, drive, cursor]);
      if (verb === "probe") return metadata;
      assert.equal(volume, metadata.volume);
      assert.equal(journal, metadata.journal);
      if (verb === "enum") return cursor === "0" ? { next: "99", rows: snapshot } : { end: true };
      return { next: metadata.next, rows: changes };
    },
  };
  const service = new NtfsSearch(":memory:", "E:\\FileRecall-data", "", {
    createReader: async () => reader,
    onChange() {},
    onPaths: async (_drive, paths) => affected.push(...paths),
    onActiveDrives() {},
  });
  t.after(() => service.close());
  await service.enable("e");
  await service.tail;
  assert.equal(service.status().drives[0].phase, "ready");
  assert.equal(service.search("old\\report")[0].path, "E:\\Old\\report中文.txt");
  assert.deepEqual(service.search("ntfs-index"), []);

  metadata = { ...metadata, next: "25" };
  changes = [
    row("51", "5", "E:\\", "Old", { attributes: 16, reason: 0x1000 }),
    row("51", "5", "E:\\", "New", { attributes: 16, reason: 0x2000 }),
    row("53", "51", "E:\\New", "notes.txt", { reason: 0x200 }),
  ];
  service.schedulePoll();
  await service.tail;
  assert.equal(service.search("new\\report")[0].path, "E:\\New\\report中文.txt");
  assert.deepEqual(service.search("old\\report"), []);
  assert.deepEqual(service.search("notes"), []);
  assert.ok(affected.includes("E:\\Old") && affected.includes("E:\\New"));
  assert.equal(service.catalog.drives()[0].cursor, "25");
  assert.ok(requests.some(([verb, drive, cursor]) => verb === "read" && drive === "E" && cursor === "10"));

  metadata = { ...metadata, journal: "43", first: "100", next: "150" };
  snapshot = [row("90", "5", "E:\\", "new-listing.txt")];
  service.schedulePoll();
  await service.tail;
  assert.deepEqual(service.search("report"), []);
  assert.equal(service.search("listing")[0].path, "E:\\new-listing.txt");
  assert.equal(service.search("E:\\new-listing")[0].path, "E:\\new-listing.txt");
  assert.equal(service.catalog.drives()[0].cursor, "150");

  metadata = { ...metadata, volume: "\\\\?\\Volume{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}\\" };
  service.schedulePoll();
  await service.tail;
  assert.equal(service.status().drives[0].phase, "error");
  assert.deepEqual(service.search("listing"), []);
  await service.disable("E");
  assert.deepEqual(service.status().drives, []);
  assert.equal(reader.closed, true);
});

test("cached NTFS names remain searchable before UAC reconnect, while live file actions remain gated", async (t) => {
  const { mkdtemp, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const home = await mkdtemp(join(tmpdir(), "filerecall-ntfs-cache-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const database = join(home, "ntfs.sqlite");
  const reader = {
    closed: false,
    close() { this.closed = true; },
    async request(type, _drive, _volume, _journal, cursor) {
      if (type === "probe") return { volume: testVolume, journal: "77", first: "0", next: "9" };
      if (type === "enum") return cursor === "0"
        ? { next: "9", rows: [row("101", "5", "D:\\Synthetic", "sample-report.txt")] }
        : { end: true };
      return { next: "9", rows: [] };
    },
  };
  const options = {
    createReader: async () => reader, onChange() {}, onPaths: async () => {},
    onActiveDrives() {},
  };
  const first = new NtfsSearch(database, "D:\\AppData", "", options);
  await first.enable("D");
  await first.tail;
  assert.equal(first.search("report")[0].cached, false);
  await first.close();
  const offline = new NtfsSearch(database, "D:\\AppData", "", {
    ...options, createReader: async () => { throw new Error("should not launch UAC for cached search"); },
  });
  t.after(() => offline.close());
  assert.equal(offline.status().connected, false);
  const [result] = offline.search("report");
  assert.equal(result.cached, true);
  assert.equal(result.path, "D:\\Synthetic\\sample-report.txt");
  assert.equal(offline.target("D", "101"), null);
});
