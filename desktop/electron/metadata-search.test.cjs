"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, unlink, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { FileIndex } = require("./indexer.cjs");

test("metadata-only search keeps notes, favorites, lost history and point lookups", async () => {
  const home = await mkdtemp(join(tmpdir(), "filerecall-metadata-"));
  const folder = join(home, "files");
  const report = join(folder, "实验报告.pdf");
  const ordinary = join(folder, "ordinary.txt");
  let index;
  try {
    await mkdir(folder);
    await writeFile(report, "pdf");
    await writeFile(ordinary, "text");
    index = new FileIndex(join(home, "files.sqlite"), { trackMotw: false });
    await index.addRoot(folder);
    const identity = await index.sourceIdentity(report);
    assert.ok(identity, "historical identity can be used for safe annotation");
    index.annotate(identity, { favorite: true, note: "研究项目", tags: ["课程"] });
    assert.equal(index.metadataAtPath(report).favorite, 1);
    assert.ok(index.searchFavorites("sy").some((file) => file.path === report));
    assert.ok(index.searchAuxiliary("研究项目").some((file) =>
      file.path === report && file.annotationMatched === 1));
    assert.deepEqual(index.searchAuxiliary("ordinary").map((file) => file.path), [],
      "current unannotated file names are no longer a separate search source");
    await unlink(ordinary);
    await index.scan(folder);
    assert.ok(index.searchAuxiliary("ordinary").some((file) => file.status === "missing"));
  } finally {
    index?.close();
    await rm(home, { recursive: true, force: true });
  }
});
