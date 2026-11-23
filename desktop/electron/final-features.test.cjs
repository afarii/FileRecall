"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rename, writeFile, unlink, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHotkey, normalizeHotkey } = require("./hotkey.cjs");
const { FileIndex } = require("./indexer.cjs");
const { DownloadSources } = require("./download-sources.cjs");
const { createProvenance } = require("./provenance.cjs");

test("a conflicting shortcut leaves the working shortcut intact and a saved shortcut is restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "filerecall-hotkey-"));
  const registered = new Map();
  const api = {
    register(value, callback) {
      if (value === "Ctrl+Alt+F9" || registered.has(value)) return false;
      registered.set(value, callback);
      return true;
    },
    unregister: (value) => registered.delete(value),
  };
  let calls = 0;
  const focus = () => calls++;
  try {
    const hotkey = createHotkey(api, dir, focus);
    assert.equal(normalizeHotkey(" Shift + CTRL + space "), "Ctrl+Shift+Space");
    assert.equal(normalizeHotkey("Ctrl+V"), null);
    assert.equal(hotkey.update("Alt+Ctrl+F9").ok, false);
    registered.get("Ctrl+Shift+Space")();
    assert.equal(calls, 1);
    assert.equal(hotkey.update("Alt+Ctrl+F10").ok, true);
    assert.equal(registered.has("Ctrl+Shift+Space"), false);
    hotkey.close();
    assert.deepEqual(createHotkey(api, dir, focus).status(), { shortcut: "Ctrl+Alt+F10", registered: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("confirmed origin and notes follow the file identity, never a replacement in the old path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "filerecall-origin-"));
  const folder = join(dir, "library");
  const path = join(folder, "contract.txt");
  const moved = join(folder, "renamed.txt");
  const index = new FileIndex(join(dir, "files.sqlite"));
  const sources = new DownloadSources(":memory:");
  const provenance = createProvenance(index, (read) => read(sources));
  try {
    await mkdir(folder);
    await writeFile(path, "original");
    await index.addRoot(folder);
    const url = "https://source.example/contract";
    sources.importBatch({
      version: 1, profile: "12345678-1234-1234-1234-123456789abc",
      records: [{
        key: "download:5", path: /^[a-z]:/i.test(path) ? path : "C:\\Downloads\\contract.txt",
        startedAt: Date.now(), algorithm: { status: "matched", url }, effective: { status: "confirmed", url },
      }],
    });
    const state = await provenance.local(path);
    assert.equal(state.confirmed, null);
    const { id } = state.candidates[0];
    assert.equal((await provenance.decide(path, state.identity, id, "rejected")).candidates.length, 0);
    assert.equal((await provenance.decide(path, state.identity, id, "undo")).candidates.length, 1);
    assert.equal((await provenance.decide(path, state.identity, id, "confirmed")).confirmed.id, id);
    index.annotate(state.identity, { favorite: true, note: "税务资料", tags: ["合同"] });

    await rename(path, moved);
    await index.updatePaths(folder, [path, moved]);
    assert.equal((await index.linkedFile(id)).path, moved);
    assert.equal((await provenance.local(moved)).confirmed.id, id);
    assert.ok(index.search("税务资料").some((item) => item.path === moved && item.favorite === 1));
    await writeFile(path, "unrelated replacement");
    assert.equal((await provenance.local(path)).confirmed.id, id); // This row still represents the missing historical file.
    await index.updatePaths(folder, [path]);
    assert.equal((await provenance.local(path)).confirmed, null);
    assert.equal(index.search("合同").some((item) => item.path === path), false);
    await unlink(moved);
    await index.updatePaths(folder, [moved]);
    assert.equal((await index.linkedFile(id)).status, "missing");
    assert.equal(sources.sourceToOpen(id), url);
    assert.equal((await provenance.decide(moved, state.identity, id, "undo")).confirmed, null);
  } finally {
    index.close();
    sources.close();
    await rm(dir, { recursive: true, force: true });
  }
});
