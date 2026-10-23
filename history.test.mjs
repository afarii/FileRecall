import test from "node:test";
import assert from "node:assert/strict";

// A small DOM substitute runs the real page handlers without a browser or dependencies.
let pageNumber = 0;
async function historyPage() {
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
  document.createElement = document.createElementNS = document.createDocumentFragment = () => new Node();
  document.createTextNode = (value) => { const node = new Node(); node.textContent = value; return node; };
  const data = Object.fromEntries([1, 2].map((id) => [`download:${id}`, {
    id, filename: `C:/Downloads/file-${id}.zip`, state: "complete",
    startTime: `2026-10-22T10:00:0${id}Z`, source: { status: "unknown" },
  }]));
  let storageChanged;
  globalThis.document = document;
  globalThis.chrome = { storage: {
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
