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
