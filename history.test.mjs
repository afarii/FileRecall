import test from "node:test";
import assert from "node:assert/strict";

// A small DOM substitute runs the real page handlers without a browser or dependencies.
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
    await import(`./history.js?drawer-scroll-test`);
  } catch (error) {
    restore();
    throw error;
  }
  const get = document.getElementById;
  const rows = () => get("records").children[0].children.map((row) => row.children[0]);
  return { get, rows, document, restore, async update() {
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
