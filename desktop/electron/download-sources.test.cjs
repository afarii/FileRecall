"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DownloadSources, downloadPathStatus } = require("./download-sources.cjs");

const profile = "12345678-1234-1234-1234-123456789abc";
const item = {
  key: "download:7", startedAt: 1760000000000, path: "C:\\Download\\notes.txt",
  algorithm: { status: "candidate", url: "https://example.org/notes", title: "示例文档" },
  effective: { status: "confirmed", url: "https://example.org/notes", title: "示例文档" },
};
const message = { version: 1, profile, records: [item] };

test("source search is idempotent, applies source corrections and preserves algorithm evidence", () => {
  const sources = new DownloadSources(":memory:");
  try {
    assert.equal(sources.importBatch(message).saved, 1);
    sources.importBatch(message);
    const [found] = sources.search("EXAMPLE.org");
    assert.equal(sources.search("示例文档").length, 1);
    assert.equal(found.path, item.path);
    assert.equal(sources.sourceToOpen(found.id), item.effective.url);
    sources.importBatch({ ...message, records: [{ ...item, effective: { status: "rejected", url: item.effective.url } }] });
    assert.equal(sources.search("example.org").length, 0);
    assert.equal(sources.search("notes.txt").length, 1);
    assert.equal(sources.sourceToOpen(found.id), null);
    assert.equal(JSON.parse(sources.db.prepare("SELECT algorithm FROM browser_downloads").get().algorithm).status, "candidate");
    sources.importBatch({ ...message, records: [{ ...item, effective: item.algorithm }] });
    assert.equal(sources.search("example.org")[0].canOpenSource, false);
    sources.importBatch({ ...message, records: [{ ...item, effective: { status: "manual", url: "file:///C:/private" } }] });
    assert.equal(sources.sourceToOpen(found.id), null);
    assert.equal(sources.importBatch({ ...message, records: [{ ...item, path: "\\\\machine\\share\\a.txt" }] }).skipped, 1);
  } finally {
    sources.close();
  }
});

test("download presence distinguishes missing paths from unavailable volumes", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const stat = async (path) => {
    if (path === "C:\\") return { isDirectory: () => true };
    throw missing;
  };
  assert.equal(await downloadPathStatus(item.path, stat), "missing");
  assert.equal(await downloadPathStatus("Z:\\notes.txt", stat), "unknown");
});

function checkLauncher(launcher) {
  const workspace = fs.mkdtempSync(join(tmpdir(), "filerecall-host-"));
  try {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    const child = spawnSync(launcher, {
      env: { ...process.env, APPDATA: workspace, Path: "" },
      input: Buffer.concat([header, body]),
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr.toString());
    assert.equal(child.stdout.readUInt32LE(0), child.stdout.length - 4);
    assert.deepEqual(JSON.parse(child.stdout.subarray(4)), { ok: true, saved: 1, skipped: 0 }, child.stderr.toString());
    const sources = new DownloadSources(join(workspace, "filerecall-desktop", "browser-downloads.sqlite"), { readOnly: true });
    try {
      const [found] = sources.search("example.org");
      assert.equal(found.canOpenSource, true);
    } finally {
      sources.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const launcher = join(__dirname, "..", "native", "filerecall-host.exe");
test("Windows development host imports a framed request while the desktop is closed", {
  skip: !fs.existsSync(launcher), timeout: 15000,
}, () => checkLauncher(launcher));

const packagedLauncher = process.env.FILERECALL_PACKAGED_HOST;
test("packaged Windows host imports a framed request using the bundled runtime", {
  skip: !packagedLauncher, timeout: 15000,
}, () => checkLauncher(packagedLauncher));
