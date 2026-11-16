"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");
const { DirectoryMonitor } = require("./monitor.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for monitor result");
    await delay(20);
  }
}

function fakeWatchers() {
  const watchers = [];
  return {
    watchers,
    watchDirectory(path, options, callback) {
      assert.equal(options.recursive, true);
      const watcher = new EventEmitter();
      watcher.change = (name) => callback("rename", name);
      watcher.close = () => { watcher.closed = true; watcher.emit("close"); };
      watchers.push(watcher);
      return watcher;
    },
  };
}

test("native recursive events update additions, modifications and tombstones, and stop on revocation", { timeout: 12000 }, async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "filerecall-watch-"));
  const folder = join(workspace, "files");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  const monitor = new DirectoryMonitor(index, { debounceMs: 20, recoveryMs: 60000 });
  try {
    await fs.mkdir(folder);
    await index.addRoot(folder);
    monitor.start();
    await until(() => monitor.status(folder).state === "watching");
    await fs.mkdir(join(folder, "nested"));
    const path = join(folder, "nested", "auto.txt");
    await fs.writeFile(path, "new");
    await until(() => index.get(path)?.status === "present");
    await fs.writeFile(path, "modified contents");
    await until(() => index.search("auto.txt")[0]?.size === 17);
    await fs.unlink(path);
    await until(() => index.get(path)?.status === "missing");
    await monitor.run(() => { index.removeRoot(folder); monitor.syncRoots(); });
    await fs.writeFile(path, "after revocation");
    await delay(100);
    assert.equal(index.get(path).status, "missing");
    assert.equal(monitor.entries.size, 0);
  } finally {
    await monitor.close();
    index.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("events coalesce and clearing history waits for an in-flight scan without resurrecting records", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "filerecall-watch-"));
  const folder = join(workspace, "files");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  const fake = fakeWatchers();
  const monitor = new DirectoryMonitor(index, { watchDirectory: fake.watchDirectory, debounceMs: 20, recoveryMs: 60000 });
  let release;
  try {
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, "file.txt"), "hello");
    await index.addRoot(folder);
    let scans = 0;
    const scan = index.scan.bind(index);
    index.scan = async (path) => { scans++; return scan(path); };
    monitor.start();
    await until(() => monitor.status(folder).state === "watching");
    for (let i = 0; i < 20; i++) fake.watchers[0].change("file.txt");
    await until(() => scans === 2);
    await monitor.tail;
    await delay(60);
    assert.equal(scans, 2);
    index.scan = async (path) => {
      await new Promise((resolve) => { release = resolve; });
      return scan(path);
    };
    fake.watchers[0].change("file.txt");
    await until(() => Boolean(release));
    const clear = monitor.run(() => { const count = index.clearHistory(folder); monitor.syncRoots(); return count; });
    fake.watchers[0].change("file.txt");
    release();
    assert.equal(await clear, 1);
    await delay(80);
    assert.equal(index.search().length, 0);
    assert.equal(index.roots().length, 0);
    assert.equal(fake.watchers[0].closed, true);
    assert.equal(await fs.readFile(join(folder, "file.txt"), "utf8"), "hello");
  } finally {
    release?.();
    await monitor.close();
    index.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("periodic reconciliation recovers offline roots, failed watchers and missed events", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "filerecall-watch-"));
  const folder = join(workspace, "files");
  const offline = join(workspace, "offline");
  const index = new FileIndex(join(workspace, "index.sqlite"));
  const fake = fakeWatchers();
  let failWatch = true;
  const monitor = new DirectoryMonitor(index, {
    debounceMs: 10, recoveryMs: 150,
    watchDirectory(...args) {
      if (failWatch) throw new Error("simulated watch failure");
      return fake.watchDirectory(...args);
    },
  });
  try {
    await fs.mkdir(folder);
    const path = join(folder, "known.txt");
    await fs.writeFile(path, "hello");
    await index.addRoot(folder);
    monitor.start();
    await until(() => monitor.status(folder).error.includes("simulated watch failure"));
    failWatch = false;
    await until(() => monitor.status(folder).state === "watching");
    fake.watchers.at(-1).emit("error", new Error("simulated overflow"));
    await until(() => monitor.status(folder).state === "watching");
    await fs.rename(folder, offline);
    await until(() => monitor.status(folder).error.includes("ENOENT"));
    assert.equal(index.get(path).status, "present");
    await fs.rename(offline, folder);
    await fs.writeFile(join(folder, "missed.txt"), "event deliberately omitted");
    await until(() => index.search("missed.txt").length === 1 && monitor.status(folder).state === "watching");
    assert.equal(index.get(path).status, "present");
  } finally {
    await monitor.close();
    assert.equal(fake.watchers.every((watcher) => watcher.closed), true);
    index.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("the SQLite database is excluded from its own index and watch feedback", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "filerecall-watch-"));
  const index = new FileIndex(join(workspace, "index.sqlite"));
  const fake = fakeWatchers();
  const monitor = new DirectoryMonitor(index, { watchDirectory: fake.watchDirectory, debounceMs: 10, recoveryMs: 60000 });
  try {
    await fs.writeFile(join(workspace, "user.txt"), "hello");
    await index.addRoot(workspace);
    assert.deepEqual(index.search().map((file) => file.name), ["user.txt"]);
    let scans = 0;
    const scan = index.scan.bind(index);
    index.scan = (path) => { scans++; return scan(path); };
    monitor.start();
    await until(() => monitor.status(workspace).state === "watching");
    fake.watchers[0].change("index.sqlite");
    fake.watchers[0].change("index.sqlite-wal");
    fake.watchers[0].change("index.sqlite-shm");
    await delay(60);
    assert.equal(scans, 1);
    await monitor.close();
    await assert.rejects(monitor.run(() => index.scan(workspace)), /关闭/);
  } finally {
    await monitor.close();
    index.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
