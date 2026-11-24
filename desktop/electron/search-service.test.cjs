"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");
const { NtfsCatalog } = require("./ntfs-catalog.cjs");
const { createSearchService } = require("./search-service.cjs");

test("worker searches local and NTFS catalogs while main thread writes usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "filerecall-search-worker-"));

  const folder = join(root, "files");
  await mkdir(folder);
  const report = join(folder, "实验报告.pdf");
  await writeFile(report, "hello");
  const localDatabase = join(root, "files.sqlite");
  const ntfsDatabase = join(root, "ntfs.sqlite");
  const local = new FileIndex(localDatabase);
  const ntfs = new NtfsCatalog(ntfsDatabase, join(root, "app-data"));
  const search = createSearchService({ localDatabase, ntfsDatabase, applicationData: join(root, "app-data") });
  t.after(async () => {
    await search.close();
    local.close();
    ntfs.close();
    await rm(root, { recursive: true, force: true });
  });

  await local.addRoot(folder);
  ntfs.enable("E", "test-volume");
  ntfs.apply("E", [
    { id: "77", parent: "5", directory: "E:\\", name: "实验报告.pdf", attributes: 0, reason: 0 },
    { id: "78", parent: "5", directory: "E:\\", name: "system.sys", attributes: 0, reason: 0 },
    { id: "79", parent: "5", directory: "E:\\", name: "sample-report.txt", attributes: 0, reason: 0 },
  ], true);
  assert.ok((await search.searchLocal("sy")).some((item) => item.name === "实验报告.pdf"));
  local.recordUse(report);
  local.recordUse(report);
  assert.equal((await search.searchLocal("sy"))[0].useCount, 2);
  const matches = await search.searchNtfs("sy", [{ drive: "E", cached: false }]);
  assert.equal(matches[0].name, "实验报告.pdf");
  ntfs.recordUse("E", "77");
  const after = await search.searchNtfs("sy", [{ drive: "E", cached: false }]);
  assert.equal(after[0].useCount, 1);
  assert.equal(after[0].cached, false);
  const unified = await search.searchUnified("sy", [{ drive: "E", cached: false }]);
  assert.equal(unified[0].type, "ntfs");
  assert.equal(unified[0].file.name, "实验报告.pdf");
  ntfs.favorite("E", "77", true);
  const favorites = await search.searchUnified("", [{ drive: "E", cached: false }], true);
  assert.equal(favorites[0].file.name, "实验报告.pdf");
  assert.equal(favorites[0].file.favorite, 1);

  assert.deepEqual(await search.searchNtfs("sy", []), []);
  const quick = await search.searchNtfs("report", [{ drive: "E", cached: false }]);
  assert.deepEqual(quick, [], "indexed hot path skips whole-volume substring scans");
  const deep = await search.searchNtfsDeep("report", [{ drive: "E", cached: false }]);
  assert.equal(deep[0].name, "sample-report.txt", "separate worker preserves substring fallback");
});
