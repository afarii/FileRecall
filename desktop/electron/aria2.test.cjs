"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DownloadSources } = require("./download-sources.cjs");

test("retired downloader records remain searchable after database reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "filerecall-legacy-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const path = join(dir, "legacy.sqlite");
  let sources = new DownloadSources(path);
  sources.importAria2([{gid:"123abc123abc123a",index:"1",path:"E:\\Downloads\\handbook.pdf",uri:"https://cdn.example/handbook.pdf"}]);
  sources.close();
  sources = new DownloadSources(path,{readOnly:true});
  try {
    const [record] = sources.search("cdn.example");
    assert.equal(record.manager,"aria2");
    assert.equal(record.sourceStatus,"direct");
    assert.equal(sources.sourceToOpen(record.id),"https://cdn.example/handbook.pdf");
  } finally { sources.close(); }
});
