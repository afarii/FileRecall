import test from "node:test";
import assert from "node:assert/strict";

test("background events persist through queued writes, restart, candidates, and failures", async () => {
  const previousChrome = globalThis.chrome;
  const previousLog = console.log;
  const previousError = console.error;
  const handlers = {};
  const data = {};
  const errors = [];
  const openedTabs = [];
  let failWrites = false;
  let writeCount = 0;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstWrite = new Promise((resolve) => { entered = resolve; });
  globalThis.chrome = {
    downloads: {
      onCreated: { addListener(callback) { handlers.create = callback; } },
      onChanged: { addListener(callback) { handlers.change = callback; } },
    },
    action: { onClicked: { addListener(callback) { handlers.openHistory = callback; } } },
    runtime: {
      getURL: (path) => `chrome-extension://filerecall/${path}`,
      onMessage: { addListener(callback) { handlers.message = callback; } },
    },
    tabs: { query: async () => [], create: async (options) => { openedTabs.push(options); } },
    storage: { local: {
      async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
      async set(values) {
        if (++writeCount === 1) { entered(); await gate; }
        if (failWrites) throw new Error("Storage quota exceeded");
        Object.assign(data, structuredClone(values));
      },
    } },
  };
  console.log = () => {};
  console.error = (...args) => errors.push(args);

  try {
    const moduleUrl = new URL("./background.js", import.meta.url);
    await import(`${moduleUrl}?storage-test`);
    await handlers.openHistory();
    assert.deepEqual(openedTabs, [{ url: "chrome-extension://filerecall/history.html" }]);
    const timestamp = new Date(Date.now() - 5_490).toISOString();
    const context = {
      pageUrl: "https://testfile.cc/#files", pageTitle: "TestFile.cc",
      linkUrl: "https://testfile.cc/file.zip", clickedText: "Download", timestamp,
    };
    const item = {
      id: 7, url: context.linkUrl, referrer: "https://testfile.cc/",
      filename: "", state: "in_progress", startTime: new Date().toISOString(),
    };
    handlers.message({ type: "CLICK_CONTEXT", context });
    const creating = handlers.create(item);
    await firstWrite;
    const changing = handlers.change({ id: 7, filename: { current: "final.zip" }, state: { current: "complete" } });
    release();
    await Promise.all([creating, changing]);
    assert.equal(data["download:7"].filename, "final.zip");
    assert.equal(data["download:7"].state, "complete");
    assert.equal(data["download:7"].source.status, "matched");

    // A fresh module has an empty click queue and a fresh write queue, but the same local storage.
    await import(`${moduleUrl}?storage-test-restart`);
    await handlers.change({ id: 7, state: { current: "interrupted" } });
    assert.equal(data["download:7"].source.context.pageTitle, "TestFile.cc");
    assert.equal(data["download:7"].state, "interrupted");

    const button = { ...context, pageUrl: "https://code.visualstudio.com/", pageTitle: "VS Code", linkUrl: null };
    handlers.message({ type: "CLICK_CONTEXT", context: button });
    await handlers.create({ ...item, id: 8, url: "https://code.visualstudio.com/sha/download?os=win", referrer: button.pageUrl });
    await handlers.change({ id: 8, state: { current: "complete" } });
    assert.equal(data["download:8"].source.status, "candidate");
    assert.equal(data["download:8"].source.context, null);
    assert.equal(data["download:8"].source.candidate.linkUrl, null);

    await handlers.create({ ...item, id: 9, url: "https://other.example/file", referrer: "" });
    assert.equal(data["download:9"].source.status, "unknown");
    assert.equal(Object.keys(data).length, 3);

    failWrites = true;
    await handlers.create({ ...item, id: 10 });
    await handlers.change({ id: 7, filename: { current: "not-saved.zip" } });
    assert.equal(data["download:10"], undefined);
    assert.equal(data["download:7"].filename, "final.zip");
    assert.equal(errors[0][0], "Download record creation failed:");
    assert.match(errors[0][1].message, /download 10.*Storage quota exceeded/);
    assert.equal(errors[1][0], "Download record update failed:");
    assert.match(errors[1][1].message, /download 7.*Storage quota exceeded/);
    failWrites = false;
    await handlers.change({ id: 7, state: { current: "complete" } });
    assert.equal(data["download:7"].state, "complete");
  } finally {
    console.log = previousLog;
    console.error = previousError;
    globalThis.chrome = previousChrome;
  }
});
