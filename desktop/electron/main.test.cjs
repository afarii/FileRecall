"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { DirectoryMonitor } = require("./monitor.cjs");

async function startMain(index, ownsLock = true, withTray = false) {
  const app = new EventEmitter();
  let closed = false;
  app.requestSingleInstanceLock = () => ownsLock;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => __dirname;
  app.setPath = () => {};
  app.quit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    if (!prevented) closed = true;
  };
  const handlers = new Map();
  const windows = [];
  const shortcuts = new Map();
  const messages = [];
  let tray;
  const electron = {
    app,
    BrowserWindow: class extends EventEmitter {
      webContents = new EventEmitter();
      visible = true;
      constructor() {
        super();
        windows.push(this);
        this.webContents.setWindowOpenHandler = () => {};
        this.webContents.send = (channel) => messages.push(channel);
        this.webContents.isLoadingMainFrame = () => false;
      }
      isDestroyed() { return false; }
      isMinimized() { return false; }
      hide() { this.visible = false; }
      show() { this.visible = true; }
      focus() {}
      loadFile() {}
    },
    Tray: withTray ? class extends EventEmitter {
      constructor() { super(); tray = this; }
      setToolTip() {}
      setContextMenu(menu) { this.menu = menu; }
      destroy() { this.destroyed = true; }
    } : undefined,
    Menu: { buildFromTemplate: (template) => template },
    globalShortcut: {
      register(value, callback) { shortcuts.set(value, callback); return true; },
      unregister(value) { shortcuts.delete(value); },
    },
    dialog: { showErrorBox() {} },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    shell: { showItemInFolder() { throw new Error("Unexpected reveal"); } },
  };
  let monitor;
  vm.runInNewContext(readFileSync(join(__dirname, "main.cjs"), "utf8"), {
    __dirname, process,
    require(name) {
      if (name === "electron") return electron;
      if (name === "./indexer.cjs") return { FileIndex: function () { return index; } };
      if (name === "./monitor.cjs") return { DirectoryMonitor: class extends DirectoryMonitor {
        constructor(index, options) {
          super(index, { ...options, watchDirectory() {
            const watcher = new EventEmitter();
            watcher.close = () => {};
            return watcher;
          } });
          monitor = this;
        }
        start() {
          this.syncRoots();
          for (const entry of this.entries.values()) clearTimeout(entry.timer);
        }
      } };
      return require(name);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { app, handlers, monitor, windows, shortcuts, messages, tray, isClosed: () => closed };
}

test("main serializes rescans and waits before closing SQLite", { timeout: 5000 }, async () => {
  let finish;
  let databaseClosed = false;
  const calls = [];
  let roots = [{ path: __dirname }];
  const index = {
    roots: () => roots,
    scan: () => new Promise((resolve) => { calls.push("scan"); finish = resolve; }),
    removeRoot() { calls.push("remove"); roots = []; },
    close() { calls.push("close"); databaseClosed = true; },
  };
  const main = await startMain(index);
  const scan = main.handlers.get("folders:rescan")();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const remove = main.handlers.get("folders:remove")(null, __dirname);
  main.app.quit();
  assert.equal(main.isClosed(), false);
  assert.equal(databaseClosed, false);
  await assert.rejects(main.handlers.get("folders:rescan")(), /关闭/);
  finish({ folder: __dirname, complete: true });
  await scan;
  await remove;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.isClosed(), true);
  assert.equal(databaseClosed, true);
  assert.deepEqual(calls, ["scan", "remove", "close"]);
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
  assert.equal((await main.handlers.get("files:reveal")(null, __filename)).ok, false);
  main.app.quit();
});

test("a second instance exits before opening the database or registering IPC", async () => {
  const main = await startMain(undefined, false);
  assert.equal(main.isClosed(), true);
  assert.equal(main.handlers.size, 0);
});

test("Windows close hides to tray, hotkey and second launch restore, and tray quit closes services", {
  skip: process.platform !== "win32",
}, async () => {
  let databaseClosed = false;
  const main = await startMain({ roots: () => [], close() { databaseClosed = true; } }, true, true);
  const [window] = main.windows;
  let prevented = false;
  function closeWindow() {
    prevented = false;
    window.emit("close", { preventDefault() { prevented = true; } });
  }
  closeWindow();
  assert.equal(prevented, true);
  assert.equal(window.visible, false);
  assert.equal(databaseClosed, false);
  assert.equal(main.isClosed(), false);
  const hotkey = main.shortcuts.values().next().value;
  hotkey();
  assert.equal(window.visible, true);
  assert.equal(main.messages.at(-1), "search:focus");
  closeWindow();
  main.tray.emit("click");
  assert.equal(window.visible, true);
  closeWindow();
  main.app.emit("second-instance");
  assert.equal(window.visible, true);
  assert.equal(main.windows.length, 1);
  main.tray.menu.find(({ label }) => label === "退出 FileRecall").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.isClosed(), true);
  assert.equal(databaseClosed, true);
  assert.equal(main.tray.destroyed, true);
  assert.equal(main.shortcuts.size, 0);
  closeWindow();
  assert.equal(prevented, false);
});
