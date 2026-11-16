"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

async function startMain(index, ownsLock = true) {
  const app = new EventEmitter();
  let closed = false;
  app.requestSingleInstanceLock = () => ownsLock;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => __dirname;
  app.quit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    if (!prevented) closed = true;
  };
  const handlers = new Map();
  const electron = {
    app,
    BrowserWindow: class {
      webContents = new EventEmitter();
      constructor() { this.webContents.setWindowOpenHandler = () => {}; }
      loadFile() {}
    },
    dialog: { showErrorBox() {} },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    shell: { showItemInFolder() { throw new Error("Unexpected reveal"); } },
  };
  vm.runInNewContext(readFileSync(join(__dirname, "main.cjs"), "utf8"), {
    __dirname, process,
    require(name) {
      if (name === "electron") return electron;
      if (name === "./indexer.cjs") return { FileIndex: function () { return index; } };
      return require(name);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { app, handlers, isClosed: () => closed };
}

test("main serializes rescans and waits before closing SQLite", async () => {
  let finish;
  let databaseClosed = false;
  const index = {
    roots: () => [{ path: __dirname }],
    scan: () => new Promise((resolve) => { finish = resolve; }),
    close() { databaseClosed = true; },
  };
  const main = await startMain(index);
  const scan = main.handlers.get("folders:rescan")();
  await assert.rejects(main.handlers.get("folders:rescan")(), /正在扫描/);
  await assert.rejects(main.handlers.get("folders:remove")(null, __dirname), /正在扫描/);
  main.app.quit();
  assert.equal(main.isClosed(), false);
  assert.equal(databaseClosed, false);
  finish({ folder: __dirname, complete: true });
  await scan;
  assert.equal(main.isClosed(), true);
  assert.equal(databaseClosed, true);
});

test("main reports root failures, allows retry and blocks unindexed file actions", async () => {
  let fail = true;
  const main = await startMain({
    roots: () => [{ path: __dirname }],
    async scan() {
      if (fail) throw new Error("offline root");
      return { folder: __dirname, complete: true };
    },
    get: () => undefined,
    close() {},
  });
  const first = await main.handlers.get("folders:rescan")();
  assert.equal(first[0].complete, false);
  assert.equal(first[0].error, "offline root");
  fail = false;
  assert.equal((await main.handlers.get("folders:rescan")())[0].complete, true);
  assert.equal(main.handlers.get("files:reveal")(null, __filename).ok, false);
  main.app.quit();
});

test("a second instance exits before opening the database or registering IPC", async () => {
  const main = await startMain(undefined, false);
  assert.equal(main.isClosed(), true);
  assert.equal(main.handlers.size, 0);
});
