import test from "node:test";
import assert from "node:assert/strict";
import { createDownloadRecordStore } from "./download-record-store.mjs";

// A small DOM substitute runs the real page handlers without a browser or dependencies.
let pageNumber = 0;
async function historyPage(downloads, runtime) {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  const nodes = new Map();
  const document = { activeElement: null, scrollingElement: { scrollTop: 640 } };
  class Node {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.classList = { toggle() {} };
      this.scrollTop = 0;
      this.hidden = false;
      this.open = false;
      this.modalOpenCount = 0;
      this.value = "";
    }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.value = ""; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { this.listeners.click?.({ target: this }); }
    focus(options) {
      document.activeElement = this;
      if (!options?.preventScroll) document.scrollingElement.scrollTop = 0;
    }
    showModal() { this.open = true; this.modalOpenCount++; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  document.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  document.getElementById("detail-content").append(document.getElementById("detail-record"));
  document.createElement = document.createElementNS = document.createDocumentFragment = () => new Node();
  document.createTextNode = (value) => { const node = new Node(); node.textContent = value; return node; };
  const data = Object.fromEntries([1, 2].map((id) => [`download:${id}`, {
    id, filename: `C:/Downloads/file-${id}.zip`, state: "complete",
    startTime: `2026-10-22T10:00:0${id}Z`, source: { status: "unknown" },
  }]));
  let storageChanged;
  globalThis.document = document;
  globalThis.chrome = { downloads, runtime, storage: {
    local: { async get() { return structuredClone(data); } },
    onChanged: { addListener(callback) { storageChanged = callback; } },
  } };
  const restore = () => {
    globalThis.document = previousDocument;
    globalThis.chrome = previousChrome;
  };
  try {
    await import(`./history.js?test=${++pageNumber}`);
  } catch (error) {
    restore();
    throw error;
  }
  const get = document.getElementById;
  const rows = () => get("records").children[0].children.map((row) => row.children[0]);
  return { get, rows, document, restore, data, search(query) {
    get("history-search").value = query;
    get("history-search").focus();
    get("history-search").listeners.input();
  }, filter(id, value) {
    get(id).value = value;
    get(id).focus();
    get(id).listeners.change();
  }, async update() {
    storageChanged({ "download:1": { newValue: data["download:1"] } }, "local");
    await new Promise((resolve) => setImmediate(resolve));
  } };
}

test("history drawer resets only its own scroll when opened, preserving refresh and focus behavior", async (t) => {
  const page = await historyPage();
  t.after(page.restore);
  const content = page.get("detail-content");
  const dialog = page.get("record-detail");
  const list = page.get("records");
  list.scrollTop = 320;
  const assertListPosition = () => {
    assert.equal(page.document.scrollingElement.scrollTop, 640);
    assert.equal(list.scrollTop, 320);
  };

  await t.test("switching to another record starts at the top without reopening the modal", () => {
    const [first, second] = page.rows();
    first.click();
    content.scrollTop = 900;
    second.click();
    assert.equal(content.scrollTop, 0);
    assert.match(content.textContent, /file-1\.zip/);
    assert.equal(dialog.modalOpenCount, 1);
    assert.equal(second.attributes["aria-pressed"], "true");
    assertListPosition();
  });

  await t.test("closing and reopening the same record starts at the top and restores row focus", () => {
    const second = page.rows()[1];
    content.scrollTop = 800;
    dialog.close();
    assert.equal(page.document.activeElement, second);
    assert.equal(second.attributes["aria-pressed"], "false");
    second.click();
    assert.equal(content.scrollTop, 0);
    assert.equal(dialog.open, true);
    assertListPosition();
  });

  await t.test("opening a different record after closing also starts at the top", () => {
    content.scrollTop = 700;
    dialog.close();
    page.rows()[0].click();
    assert.equal(content.scrollTop, 0);
    assert.match(content.textContent, /file-2\.zip/);
    assertListPosition();
  });

  await t.test("storage refresh of the open record preserves the reader's position", async () => {
    content.scrollTop = 600;
    await page.update();
    assert.equal(content.scrollTop, 600);
    assert.equal(dialog.open, true);
    assert.match(content.textContent, /file-2\.zip/);
    dialog.close();
    assert.equal(page.document.activeElement, page.rows()[0]);
    assertListPosition();
  });
});

test("detail file buttons query Chrome, stay independent and preserve search, filters and saved history", async (t) => {
  const calls = [];
  let exists = true;
  let missing = false;
  let changed;
  let erased;
  const page = await historyPage({
    async search({ id }) {
      calls.push(["search", id]);
      return missing ? [] : [{ id, exists, state: "complete" }];
    },
    show(id) { calls.push(["show", id]); },
    open(id) { calls.push(["open", id]); return Promise.reject(new Error("access denied")); },
    onChanged: { addListener(callback) { changed = callback; } },
    onErased: { addListener(callback) { erased = callback; } },
  });
  t.after(page.restore);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const before = structuredClone(page.data);
  page.search("file-2");
  page.filter("source-filter", "unknown");
  page.filter("download-filter", "complete");
  page.rows()[0].click();
  assert.equal(page.get("show-file").disabled, true);
  await flush();
  assert.deepEqual(calls, [["search", 2]]);
  assert.equal(page.get("show-file").disabled, false);
  assert.equal(page.get("open-file").disabled, false);
  page.get("show-file").click();
  assert.deepEqual(calls.at(-1), ["show", 2]);
  assert.match(page.get("file-action-status").textContent, /不提供定位结果/);
  page.get("open-file").click();
  assert.deepEqual(calls.at(-1), ["open", 2]);
  await flush();
  assert.match(page.get("file-action-status").textContent, /操作失败.*access denied/);
  assert.equal(page.get("open-file").disabled, true);
  page.get("check-file").click();
  await flush();
  assert.equal(page.get("show-file").disabled, false);
  exists = false;
  changed({ id: 2, exists: { current: false } });
  await flush();
  assert.equal(page.get("show-file").disabled, true);
  assert.match(page.get("file-action-status").textContent, /移动或删除/);
  missing = true;
  erased(2);
  await flush();
  assert.match(page.get("file-action-status").textContent, /记录已丢失/);
  assert.equal(page.rows().length, 1);
  assert.equal(page.get("record-detail").open, true);
  assert.equal(page.get("history-search").value, "file-2");
  assert.equal(page.get("source-filter").value, "unknown");
  assert.equal(page.get("download-filter").value, "complete");
  assert.deepEqual(page.data, before);
  page.get("record-detail").close();
  assert.equal(page.document.activeElement, page.rows()[0]);
});

test("history search preserves details, candidate labels, ordering and live updates without writing records", async (t) => {
  const page = await historyPage();
  t.after(page.restore);
  page.data["download:2"].source = { status: "candidate", candidate: {
    pageTitle: "Release Guide", pageUrl: "https://Possible.example/files",
  } };
  await page.update();
  const before = structuredClone(page.data);
  page.search("POSSIBLE");
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /file-2.zip.*候选 · 未确认/);
  assert.equal(page.document.activeElement, page.get("history-search"));
  page.get("refresh").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.get("history-search").value, "POSSIBLE");
  assert.equal(page.rows().length, 1);
  page.rows()[0].click();
  const dialog = page.get("record-detail");
  const content = page.get("detail-content");
  assert.match(content.textContent, /候选 · 未确认/);
  content.scrollTop = 400;
  await page.update();
  assert.equal(dialog.open, true);
  assert.equal(content.scrollTop, 400);
  assert.equal(page.rows().length, 1);
  assert.deepEqual(page.data, before);

  page.data["download:2"].filename = "C:/Downloads/renamed.zip";
  page.data["download:2"].state = "interrupted";
  await page.update();
  assert.match(content.textContent, /renamed.zip/);
  assert.match(content.textContent, /已中断/);
  assert.equal(content.scrollTop, 400);
  dialog.close();
  assert.equal(page.document.activeElement, page.rows()[0]);

  page.search("missing");
  assert.equal(page.rows().length, 0);
  assert.equal(page.get("record-list").hidden, true);
  assert.equal(page.get("history-state").hidden, false);
  assert.equal(page.get("state-title").textContent, "没有找到匹配的下载记录");
  assert.match(page.get("announcement").textContent, /找到 0 条/);
  page.data["download:3"] = { id: 3, filename: "/tmp/Missing.zip", state: "in_progress",
    startTime: "2026-10-23T10:00:00Z", source: { status: "unknown" } };
  await page.update();
  assert.equal(page.get("record-list").hidden, false);
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /Missing.zip/);
  page.rows()[0].click();
  page.data["download:3"].filename = "/tmp/finished.zip";
  await page.update();
  assert.equal(page.rows().length, 0);
  assert.equal(dialog.open, true);
  assert.match(content.textContent, /finished.zip/);
  dialog.close();
  assert.equal(page.document.activeElement, page.get("history-search"));
  page.search("");
  assert.equal(page.rows().length, 3);
  assert.match(page.rows()[0].textContent, /finished.zip/);
  assert.match(page.rows()[1].textContent, /renamed.zip/);
  assert.match(page.rows()[2].textContent, /file-1.zip/);
  assert.equal(page.get("history-state").hidden, true);
});

test("filters combine with search and survive refreshes while open details keep updating", async (t) => {
  const page = await historyPage();
  t.after(page.restore);
  page.data["download:1"].source = { status: "matched", context: { pageTitle: "Release Guide" } };
  page.data["download:2"].source = { status: "candidate", candidate: { pageTitle: "Release Guide" } };
  page.data["download:2"].state = "in_progress";
  await page.update();
  const before = structuredClone(page.data);
  page.filter("source-filter", "matched");
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /file-1.zip/);
  page.filter("source-filter", "");
  page.filter("download-filter", "in_progress");
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /file-2.zip/);
  page.filter("source-filter", "candidate");
  page.search("RELEASE");
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /候选 · 未确认/);
  page.get("refresh").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.get("source-filter").value, "candidate");
  assert.equal(page.get("download-filter").value, "in_progress");
  assert.equal(page.get("history-search").value, "RELEASE");
  assert.equal(page.rows().length, 1);
  assert.deepEqual(page.data, before);

  page.rows()[0].click();
  const dialog = page.get("record-detail");
  const content = page.get("detail-content");
  content.scrollTop = 360;
  page.data["download:2"].state = "complete";
  await page.update();
  assert.equal(page.rows().length, 0);
  assert.equal(page.get("record-list").hidden, true);
  assert.equal(page.get("state-title").textContent, "没有找到匹配的下载记录");
  assert.match(page.get("state-description").textContent, /筛选/);
  assert.equal(dialog.open, true);
  assert.match(content.textContent, /已完成/);
  assert.match(content.textContent, /候选 · 未确认/);
  assert.equal(content.scrollTop, 360);
  dialog.close();
  assert.equal(page.document.activeElement, page.get("history-search"));

  page.filter("download-filter", "complete");
  assert.equal(page.rows().length, 1);
  page.search("absent");
  assert.equal(page.rows().length, 0);
  page.search("");
  page.filter("source-filter", "unknown");
  assert.equal(page.rows().length, 0);
  assert.equal(page.get("history-state").hidden, false);
  page.data["download:3"] = { id: 3, filename: "/tmp/new.zip", state: "complete",
    startTime: "2026-10-23T10:00:00Z", source: { status: "unknown" } };
  await page.update();
  assert.equal(page.rows().length, 1);
  assert.match(page.rows()[0].textContent, /new.zip.*来源未知/);
  page.filter("source-filter", "");
  page.filter("download-filter", "");
  assert.equal(page.rows().length, 3);
  assert.match(page.rows()[0].textContent, /new.zip/);
  assert.match(page.rows()[1].textContent, /file-2.zip/);
  assert.match(page.rows()[2].textContent, /file-1.zip/);
  assert.equal(page.get("history-state").hidden, true);
});

test("Chrome import is explicit, reports partial results, supports continuation and keeps the current view", async (t) => {
  const messages = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cursor = { time: 1_700_000_000_000, ids: [3] };
  const page = await historyPage(undefined, { async sendMessage(message) {
    messages.push(message);
    if (messages.length === 1) {
      await gate;
      page.data["download:3"] = { id: 3, filename: "/tmp/imported.zip", state: "complete",
        startTime: "2026-10-23T10:00:00Z", source: { status: "unknown", reason: "history_import" } };
      return { added: 1, skipped: 1, failed: 1, errors: ["下载 4：保存失败"], hasMore: true, cursor };
    }
    if (messages.length === 2) throw new Error("Chrome history unavailable");
    if (messages.length === 3) {
      page.data["download:4"] = { ...page.data["download:3"], id: 4, filename: "/tmp/imported-older.zip",
        startTime: "2026-10-23T09:00:00Z" };
      return { added: 1, skipped: 0, failed: 0, errors: [], hasMore: false, cursor: null };
    }
    return { added: 0, skipped: 4, failed: 0, errors: [], hasMore: false, cursor: null };
  } });
  t.after(page.restore);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, []);
  const existing = structuredClone(page.data);
  page.search("imported");
  page.filter("source-filter", "unknown");
  page.filter("download-filter", "complete");
  page.get("import-history").click();
  assert.equal(page.get("import-history").disabled, true);
  assert.equal(page.get("import-next").disabled, true);
  page.get("import-history").click();
  assert.equal(messages.length, 1);
  release();
  await flush();
  assert.equal(page.get("import-history").disabled, false);
  assert.equal(page.get("import-next").hidden, false);
  assert.match(page.get("import-status").textContent, /新增 1 条，跳过 1 条，失败 1 条/);
  assert.match(page.get("import-status").textContent, /下载 4：保存失败/);
  assert.equal(page.rows().length, 1);
  page.rows()[0].click();
  const content = page.get("detail-content");
  content.scrollTop = 250;
  assert.match(content.textContent, /历史导入.*无法恢复过去的点击上下文/);
  page.get("import-next").click();
  await flush();
  assert.deepEqual(messages[1].cursor, cursor);
  assert.match(page.get("import-status").textContent, /导入未完成.*Chrome history unavailable/);
  assert.equal(page.get("import-next").hidden, false);
  assert.equal(page.get("record-detail").open, true);
  assert.equal(content.scrollTop, 250);
  page.get("import-next").click();
  await flush();
  assert.deepEqual(messages[2].cursor, cursor);
  assert.match(page.get("import-status").textContent, /新增 2 条，跳过 1 条，失败 1 条/);
  assert.equal(page.get("import-next").hidden, true);
  assert.equal(page.rows().length, 2);
  assert.match(page.rows()[0].textContent, /imported.zip/);
  assert.equal(page.get("history-search").value, "imported");
  assert.equal(page.get("source-filter").value, "unknown");
  assert.equal(page.get("download-filter").value, "complete");
  assert.equal(page.get("record-detail").open, true);
  assert.equal(content.scrollTop, 250);
  for (const key of Object.keys(existing)) assert.deepEqual(page.data[key], existing[key]);
  page.get("import-history").click();
  await flush();
  assert.equal(messages[3].cursor, null);
  assert.match(page.get("import-status").textContent, /新增 0 条，跳过 4 条，失败 0 条/);
});

test("detail annotations update labels, search and filters while keeping original evidence and drafts", async (t) => {
  let store;
  const page = await historyPage(undefined, { async sendMessage(message) {
    assert.equal(message.type, "ANNOTATE_DOWNLOAD");
    try {
      await store.annotate(message.id, message.change);
      return { saved: true };
    } catch (error) { return { error: error.message }; }
  } });
  t.after(page.restore);
  store = createDownloadRecordStore({
    async get(key) { return Object.hasOwn(page.data, key) ? { [key]: structuredClone(page.data[key]) } : {}; },
    async set(values) { Object.assign(page.data, structuredClone(values)); },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const input = (id, value) => { page.get(id).value = value; page.get(id).listeners.input(); };
  page.data["download:2"].source = { status: "candidate", reason: "page_and_time", candidate: {
    pageUrl: "https://possible.example/", pageTitle: "Possible page", clickedText: "Download",
  }, evidence: { pageMatch: "exact" } };
  const original = structuredClone(page.data["download:2"].source);
  await page.update();
  assert.equal(page.get("record-detail").open, false);
  assert.equal(page.get("record-detail").modalOpenCount, 0);
  page.filter("source-filter", "candidate");
  page.rows()[0].click();
  assert.equal(page.get("annotation-editor").open, false);
  page.get("annotation-editor").open = true;
  assert.equal(page.get("confirm-source").hidden, false);
  input("record-note", "Draft reminder");
  page.get("detail-content").scrollTop = 240;
  await page.update();
  assert.equal(page.get("record-note").value, "Draft reminder");
  assert.equal(page.get("annotation-editor").open, true);
  page.get("confirm-source").click();
  assert.equal(page.get("confirm-source").disabled, true);
  await flush();
  assert.equal(page.data["download:2"].userSource.type, "confirmed_candidate");
  assert.deepEqual(page.data["download:2"].source, original);
  assert.equal(page.rows().length, 0);
  assert.equal(page.get("record-detail").open, true);
  assert.equal(page.get("detail-content").scrollTop, 240);
  assert.match(page.get("detail-content").textContent, /人工确认候选/);
  assert.match(page.get("detail-content").textContent, /原始算法关联状态候选 · 未确认/);
  assert.equal(page.get("record-note").value, "Draft reminder");
  page.get("save-note").click();
  await flush();
  assert.equal(page.data["download:2"].note, "Draft reminder");
  page.filter("source-filter", "confirmed");
  page.search("REMINDER");
  assert.equal(page.rows().length, 1);
  page.get("undo-source").click();
  await flush();
  assert.equal(page.data["download:2"].userSource, null);
  assert.equal(page.rows().length, 0);
  page.get("reject-source").click();
  await flush();
  assert.equal(page.data["download:2"].userSource.type, "rejected_candidate");
  assert.equal(page.get("manual-source-fields").hidden, false);
  page.filter("source-filter", "rejected");
  page.search("possible.example");
  assert.equal(page.rows().length, 0);
  input("manual-page-url", "javascript:alert(1)");
  input("manual-page-title", "Title");
  page.get("save-source").click();
  await flush();
  assert.match(page.get("annotation-status").textContent, /保存失败/);
  assert.equal(page.get("manual-page-url").value, "javascript:alert(1)");
  assert.equal(page.data["download:2"].userSource.type, "rejected_candidate");
  const hostile = '<img src=x onerror="alert(1)">';
  input("manual-page-url", "https://manual.example/page");
  input("manual-page-title", hostile);
  page.get("save-source").click();
  await flush();
  assert.match(page.get("annotation-status").textContent, /已保存/);
  assert.equal(page.data["download:2"].userSource.type, "manual");
  assert.ok(page.get("detail-content").textContent.includes(hostile));
  page.filter("source-filter", "manual");
  page.search("MANUAL.EXAMPLE");
  assert.equal(page.rows().length, 1);
  input("manual-page-url", "https://edited.example/");
  page.get("save-source").click();
  await flush();
  assert.equal(page.rows().length, 0);
  page.get("undo-source").click();
  await flush();
  assert.equal(page.data["download:2"].userSource, null);
  assert.deepEqual(page.data["download:2"].source, original);
  input("record-note", "");
  page.get("save-note").click();
  await flush();
  assert.equal(page.data["download:2"].note, "");

  page.get("record-detail").close();
  page.search("file-1");
  page.filter("source-filter", "unknown");
  page.rows()[0].click();
  assert.equal(page.get("manual-source-fields").hidden, false);
  assert.equal(page.get("confirm-source").hidden, true);
  input("manual-page-url", "https://known.example/");
  input("manual-page-title", "");
  await store.update({ id: 1, state: { current: "interrupted" } });
  await page.update();
  assert.equal(page.get("manual-page-url").value, "https://known.example/");
  page.get("save-source").click();
  await flush();
  assert.equal(page.data["download:1"].state, "interrupted");
  assert.equal(page.data["download:1"].source.status, "unknown");
  assert.equal(page.data["download:1"].userSource.type, "manual");
});

test("failed saves retain drafts and edits made while saving are not discarded by live refresh", async (t) => {
  let fail = true;
  let release;
  let store;
  const page = await historyPage(undefined, { async sendMessage(message) {
    if (fail) return { error: "storage unavailable" };
    await new Promise((resolve) => { release = resolve; });
    await store.annotate(message.id, message.change);
    return { saved: true };
  } });
  t.after(page.restore);
  store = createDownloadRecordStore({
    async get(key) { return { [key]: structuredClone(page.data[key]) }; },
    async set(values) { Object.assign(page.data, structuredClone(values)); },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  page.rows()[0].click();
  const note = page.get("record-note");
  note.value = "First draft";
  note.listeners.input();
  page.get("save-note").click();
  await flush();
  assert.match(page.get("annotation-status").textContent, /保存失败.*storage unavailable/);
  assert.equal(note.value, "First draft");
  assert.equal(page.get("save-note").disabled, false);
  assert.equal(page.data["download:2"].note, undefined);
  fail = false;
  page.get("save-note").click();
  note.value = "Second draft";
  note.listeners.input();
  await page.update();
  assert.equal(note.value, "Second draft");
  release();
  await flush();
  assert.equal(page.data["download:2"].note, "First draft");
  assert.equal(note.value, "Second draft");
  assert.equal(page.get("save-note").disabled, false);
});
