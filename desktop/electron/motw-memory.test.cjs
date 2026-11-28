"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MotwMemory, createMotwCapture } = require("./motw-memory.cjs");

test("delayed MOTW capture survives rename and deletion, distinguishes replacement and keeps URL searchable", async (t) => {
  const memory = new MotwMemory(":memory:");
  t.after(() => memory.close());
  let clock = 0, calls = 0, changes = 0, evidence = null;
  const volume = "volume-a";
  let current = { volume, id: "77", path: "C:\\Downloads\\10mb.dat", identity: "1:77:100" };
  const capture = createMotwCapture({
    memory, now: () => clock, changed: () => changes++,
    resolve: async (v, id) => current?.volume === v && current.id === id ? current : null,
    verify: async (row) => row, read: async () => { calls++; return evidence; },
  });
  t.after(() => capture.close());
  capture.events(volume, [{ id: "77", attributes: 0, reason: 0x100 }]);
  await capture.tick();
  assert.equal(calls, 0);
  clock = 1000;
  await capture.tick();
  assert.equal(calls, 1);
  assert.equal(memory.search("testfile.cc").length, 0);
  evidence = { zoneId: 3, referrerUrl: "https://testfile.cc/", hostUrl: "https://cdn.testfile.cc/10mb.dat" };
  clock = 6000;
  await capture.tick();
  assert.equal(memory.search("testfile.cc")[0].name, "10mb.dat");
  const id = memory.search("testfile.cc")[0].id;
  assert.equal(memory.search("testfile.cc 10mb")[0].id, id);
  assert.equal(memory.search("cdn.testfile.cc")[0].id, id);
  assert.equal(changes, 1);
  current = { ...current, path: "C:\\Course\\renamed.dat" };
  evidence = null; // ADS removed: retain the earlier evidence.
  capture.events(volume, [{ id: "77", attributes: 0, reason: 0x2000 }]);
  clock = 7000;
  await capture.tick();
  assert.equal(memory.search("testfile.cc")[0].name, "renamed.dat");
  assert.equal(memory.byId(id).deleted, 0);
  capture.events(volume, [{ id: "77", attributes: 0, reason: 0x200 }]);
  assert.equal(memory.byId(id).deleted, 1);
  assert.equal(memory.search("testfile.cc")[0].id, id);
  current = { ...current, id: "88", identity: "1:88:200" };
  capture.events(volume, [{ id: "88", attributes: 0, reason: 0x100 }]);
  clock = 8000;
  await capture.tick();
  assert.equal(memory.search("testfile.cc").length, 1);
  assert.equal(memory.byId(id).deleted, 1);
});

test("capture refuses evidence if identity changes while reading; queue remains bounded", async (t) => {
  const memory = new MotwMemory(":memory:");
  t.after(() => memory.close());
  let current = { volume: "volume-a", id: "1", path: "C:\\x.pdf", identity: "old" };
  const capture = createMotwCapture({
    memory, resolve: async () => current, verify: async (row) => row,
    read: async () => { current = { ...current, identity: "replacement" }; return { hostUrl: "https://example.org/x.pdf" }; },
  });
  t.after(() => capture.close());
  assert.equal(await capture.capture("volume-a", "1"), null);
  assert.equal(memory.search("example.org").length, 0);
  capture.events("volume-a", Array.from({ length: 800 }, (_, i) => ({ id: String(i), attributes: 0, reason: 0x100 })));
  assert.equal(capture.size(), 512);
  capture.events("volume-a", [{ id: "799", attributes: 0, reason: 0x100 }]);
  assert.equal(capture.size(), 512);
  capture.events("volume-a", [{ id: "799", attributes: 0, reason: 0x200 }]);
  assert.equal(capture.size(), 511);
});

test("source memory rejects unsafe URL and searches only persisted source observations", (t) => {
  const memory = new MotwMemory(":memory:");
  t.after(() => memory.close());
  const target = { volume: "a", id: "1", identity: "one", path: "C:\\x.pdf" };
  assert.equal(memory.save(target, { hostUrl: "file:///C:/x.pdf", referrerUrl: "https://user:password@example.org/" }), false);
  assert.equal(memory.search("x.pdf").length, 0);
  assert.equal(memory.save(target, { hostUrl: "https://example.org/x.pdf" }), true);
  assert.equal(memory.search("example.org")[0].canOpenSource, true);
  assert.equal(memory.search("other").length, 0);
});


test("Windows capture reads actual Zone.Identifier ADS using real filesystem identity", { skip: process.platform !== "win32" }, async (t) => {
  const { mkdtemp, writeFile, lstat, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const root = await mkdtemp(join(tmpdir(), "filerecall-ads-"));
  const memory = new MotwMemory(":memory:");
  t.after(async () => { memory.close(); await rm(root, { recursive: true, force: true }); });
  const path = join(root, "10mb.dat");
  await writeFile(path, "sample");
  await writeFile(path + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://testfile.cc/\r\n");
  const info = await lstat(path, { bigint: true });
  const target = { volume: "test-volume", id: String(info.ino), path };
  const capture = createMotwCapture({ memory, resolve: async () => target });
  t.after(() => capture.close());
  const evidence = await capture.capture(target.volume, target.id);
  assert.equal(evidence?.referrerUrl, "https://testfile.cc/");
  assert.equal(memory.search("testfile.cc")[0]?.name, "10mb.dat");
});


test("recycle and clear retain last normal name across reopening the database", async (t) => {
  const { mkdtemp, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { isRecyclePath, resolveRememberedFile } = require("./recycle-path.cjs");
  const root = await mkdtemp(join(tmpdir(), "filerecall-recycle-"));
  const database = join(root, "memory.sqlite");
  let memory = new MotwMemory(database);
  t.after(async () => { memory?.close(); await rm(root, { recursive:true, force:true }); });
  const volume = "volume-a";
  const original = "C:\\Downloads\\abc.dat";
  const recycled = "C:\\$Recycle.Bin\\S-1-5-21-123\\$R986WRR.dat";
  let current = { volume, id: "77", identity: "1:77:100", path: original };
  const evidence = { referrerUrl: "https://testfile.cc/" };
  const capture = createMotwCapture({ memory, resolve: async () => current,
    verify: async row => row, read: async () => evidence });
  assert.equal(isRecyclePath(recycled), true);
  assert.equal(isRecyclePath("c:/\$RECYCLE.BIN/SID/\$R1.dat"), true);
  assert.equal(isRecyclePath("C:\\Downloads\\$Report.dat"), false);
  assert.equal(isRecyclePath("C:\\Downloads\\$Recycle.Bin\\foo"), false);
  await capture.capture(volume, "77");
  const id = memory.search("testfile.cc")[0].id;
  current = {...current, path: recycled};
  assert.equal(await capture.capture(volume, "77"), null);
  assert.equal(memory.save(current, evidence), false);
  assert.equal(memory.updatePath(current), false);
  assert.equal(memory.search("testfile.cc")[0].name, "abc.dat");
  const lookup = async () => current ? {state:"present", target:current} : {state:"missing"};
  const verify = async row => row;
  assert.deepEqual(await resolveRememberedFile(memory.byId(id), lookup, verify),
    {path:original,name:"abc.dat",status:"missing",recycled:true});
  current = {...current, path:"C:\\Restored\\abc.dat"};
  await capture.capture(volume, "77");
  assert.equal(memory.search("testfile.cc")[0].path, current.path);
  current = {...current,path:recycled};
  await capture.capture(volume, "77");
  capture.events(volume, [{ id:"77", attributes:0, reason:0x200 }]);
  current = null;
  capture.close();
  memory.close();
  memory = null;
  memory = new MotwMemory(database);
  assert.deepEqual(await resolveRememberedFile(memory.byId(id), lookup, verify),
    {path:"C:\\Restored\\abc.dat",name:"abc.dat",status:"missing"});
  assert.equal(memory.search("testfile.cc").length, 1);
  assert.equal(memory.search("$R986WRR.dat").length, 0);
});

test("legacy recycle pollution hides synthetic names without inventing history; offline is unknown", async t => {
  const { resolveRememberedFile } = require("./recycle-path.cjs");
  const memory = new MotwMemory(":memory:");
  t.after(() => memory.close());
  const row = { volume:"a",id:"77",identity:"original",path:"C:\\Downloads\\abc.dat" };
  memory.save(row,{referrerUrl:"https://testfile.cc/"});
  const id = memory.search("testfile.cc")[0].id;
  memory.db.prepare("UPDATE memory SET path=?,name=? WHERE id=?")
    .run("C:\\$Recycle.Bin\\SID\\$R123.dat","$R123.dat",id);
  assert.equal(memory.search("testfile.cc")[0].name,"原文件名未知");
  assert.equal(memory.search("testfile.cc")[0].path,"");
  const stored = memory.byId(id);
  const verify = async row => row;
  assert.equal(await resolveRememberedFile(stored, async () => ({state:"unknown"}), verify),null);
  assert.equal(await resolveRememberedFile(stored, async () => ({state:"present",target:{...row,identity:"replacement"}}),verify),null);
  assert.deepEqual(await resolveRememberedFile(stored, async () => ({state:"missing"}), verify),
    {path:"",name:"原文件名未知",status:"missing"});
  assert.deepEqual(await resolveRememberedFile(stored, async () => ({state:"present",target:row}), verify),
    {path:row.path,name:"abc.dat",status:"present"});
});
