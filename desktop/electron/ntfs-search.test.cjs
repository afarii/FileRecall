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
  let notifications = 0;
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
    onChange() { notifications++; },
    onPaths: async (_drive, paths) => affected.push(...paths),
    onActiveDrives() {},
  });
  t.after(() => service.close());
  await service.enable("e");
  await service.tail;
  assert.equal(service.status().drives[0].phase, "ready");
  service.catalog.apply("E", [row("99", "51", "E:\\Old", "实验报告.pdf")], true);
  for (const query of ["shiyanbaogao", "sybg", "pdf sybg", "sy "]) {
    assert.equal(service.search(query)[0].name, "实验报告.pdf", query);
  }
  service.catalog.apply("E", [row("100", "51", "E:\\Old", "system.sys")], true);
  service.catalog.recordUse("E", "99");
  service.catalog.recordUse("E", "99");
  assert.equal(service.search("sy")[0].name, "实验报告.pdf", "used Chinese initials rank ahead of low-use system files");
  assert.equal(service.search("pdf nonexistent").length, 0);
  assert.equal(service.search("old\\report")[0].path, "E:\\Old\\report中文.txt");
  assert.deepEqual(service.search("ntfs-index"), []);

  // A file created after the initial MFT snapshot must arrive through USN,
  // and an already-open search must be notified while phase remains ready.
  const beforeCreate = notifications;
  metadata = { ...metadata, next: "15" };
  changes = [row("81", "51", "E:\\Old", "new-download-regression.pdf", { reason: 0x100 })];
  service.schedulePoll();
  await service.tail;
  assert.equal(service.status().drives[0].phase, "ready");
  assert.equal(service.catalog.search("E", "new-download-regression", { fastOnly: true })[0].name,
    "new-download-regression.pdf");
  assert.ok(notifications > beforeCreate, "ready-to-ready USN commit must refresh active searches");

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
  assert.equal(service.sourceStateForVolume(testVolume, "53").state, "missing");
  assert.equal(service.sourceStateForVolume(testVolume, "52").state, "present");
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
  assert.equal(service.sourceStateForVolume(testVolume, "53").state, "unknown");
  assert.deepEqual(service.search("listing"), []);
  await service.disable("E");
  assert.equal(service.status().drives[0].phase, "paused");
  assert.deepEqual(service.search("listing"), []);
  assert.ok(service.catalog.drives()[0].cursor, "pausing retains the on-disk cursor");
  assert.equal(reader.closed, true);
});

test("cached NTFS names remain searchable before UAC reconnect, while live file actions remain gated", async (t) => {
  const { mkdtemp, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const home = await mkdtemp(join(tmpdir(), "filerecall-ntfs-cache-test-"));
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
  t.after(async () => { await offline.close(); await rm(home, { recursive: true, force: true }); });
  assert.equal(offline.status().connected, false);
  const [result] = offline.search("report");
  assert.equal(result.cached, true);
  assert.equal(result.path, "D:\\Synthetic\\sample-report.txt");
  assert.equal(offline.target("D", "101"), null);
});

test("persisted MFT snapshot is searchable on restart and avoids a full enumeration", async (t) => {
  const { mkdtemp, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const home = await mkdtemp(join(tmpdir(), "filerecall-reuse-test-"));
  let reopened;
  t.after(async () => {
    await reopened?.close();
    await rm(home, { recursive: true, force: true });
  });
  const database = join(home, "ntfs-index.sqlite");
  const calls = [];
  const makeReader = () => ({
    closed: false,
    close() { this.closed = true; },
    async request(type, _drive, _volume, _journal, cursor) {
      calls.push(type);
      if (type === "probe") return { volume: testVolume, journal: "100", first: "3", next: "20" };
      if (type === "enum") {
        if (cursor === "0") return { next: "10", rows: [
          row("101", "5", "E:\\\\", "实验报告.pdf"),
        ] };
        return { end: true };
      }
      return { next: "20", rows: [] };
    },
  });
  const options = {
    createReader: async () => makeReader(), onChange() {},
    onPaths: async () => {}, onActiveDrives() {},
  };
  const first = new NtfsSearch(database, "E:\\\\AppData", "", options);
  await first.enable("E");
  await first.tail;
  assert.equal(first.status().drives[0].phase, "ready");
  assert.equal(first.search("sy")[0].name, "实验报告.pdf");
  await first.close();

  calls.length = 0;
  reopened = new NtfsSearch(database, "E:\\\\AppData", "", options);
  assert.equal(reopened.status().drives[0].phase, "cached");
  assert.equal(reopened.search("sy")[0].cached, true);
  // Simulate UAC reconnect occurring before journal validation completes:
  // the persisted cache must still appear in live search.
  reopened.reader = makeReader();
  assert.equal(reopened.searchableDrives()[0].cached, true);
  reopened.reader = undefined;
  await reopened.enable("E");
  await reopened.tail;
  assert.equal(reopened.status().drives[0].phase, "ready");
  assert.equal(reopened.search("sy")[0].cached, false);
  assert.ok(!calls.includes("enum"), "reinstall/restart must replay USN without rescanning MFT");

  await reopened.disable("E");
  assert.equal(reopened.status().drives[0].phase, "paused");
  assert.equal(reopened.search("sy").length, 0);
  await reopened.enable("E");
  await reopened.tail;
  assert.equal(reopened.search("sy")[0].name, "实验报告.pdf");
});


test("source backfill is scoped to user folders, paged and resumable", t => {
  const { NtfsCatalog } = require("./ntfs-catalog.cjs");
  const catalog = new NtfsCatalog(":memory:", "C:\\FileRecall-data");
  t.after(()=>catalog.close());
  catalog.enable("C",testVolume);
  catalog.apply("C",[
    row("51","5","C:\\","Downloads",{attributes:16}),
    row("52","5","C:\\","Downloads-other",{attributes:16}),
    row("53","51","C:\\Downloads","sub",{attributes:16}),
    row("61","51","C:\\Downloads","a.pdf"),
    row("62","51","C:\\Downloads","b.pdf"),
    row("63","53","C:\\Downloads\\sub","c.pdf"),
    row("64","52","C:\\Downloads-other","outside.pdf"),
  ],true);
  let cursor={}, ids=[], done=false;
  for(let i=0;i<12;i++){
    const step=catalog.sourceBackfillStep("C","C:\\Downloads",cursor);
    if(step.done){done=true;break;}
    cursor=JSON.parse(JSON.stringify(step.cursor));
    if(step.id)ids.push(step.id);
  }
  assert.equal(done,true);
  assert.deepEqual(ids,["61","62","63"]);
});
