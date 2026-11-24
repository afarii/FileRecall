"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeFileSearch } = require("./unified-search.cjs");

const ntfs = (id, path, favorite = 0) => ({
  id: String(id), drive: "C", path, name: path.split("\\").at(-1),
  directory: false, favorite, useCount: 0, matchScore: 360,
});
const local = (path, favorite = 0, status = "present") => ({
  path, name: path.split("\\").at(-1),
  favorite, status, rootPath: "C:\\Documents", useCount: 0,
  textMatched: 0, annotationMatched: 0,
});

test("NTFS primary index overrides duplicate local filename but retains its metadata", () => {
  const file = "C:\\Documents\\实验报告.pdf";
  const localRecord = local(file, 1);
  localRecord.metadataMarker = "source-confirmed";
  const result = mergeFileSearch({
    query: "sy", drives: [{ drive: "C" }],
    localFiles: [localRecord, local("C:\\Documents\\unrelated.txt")],
    ntfsFiles: [ntfs(42, file), ntfs(43, "C:\\Elsewhere\\system.sys")],
  });
  assert.deepEqual(result.map((row) => row.type), ["local", "ntfs"]);
  assert.equal(result[0].file.metadataMarker, "source-confirmed");
  assert.equal(result[0].file.matchScore, 360);
  assert.equal(result[0].file.favorite, 1);
});

test("fallback preserves non-NTFS, historical paths and annotated metadata matches", () => {
  const missing = local("C:\\Lost\\archived.pdf", 0, "missing");
  const otherDisk = local("F:\\Shared\\experiment.pdf");
  const annotated = local("C:\\Documents\\invoice.docx");
  annotated.annotationMatched = 1;
  const rows = mergeFileSearch({
    query: "report", drives: [{ drive: "C" }],
    localFiles: [missing, otherDisk, annotated],
    ntfsFiles: [],
  });
  assert.deepEqual(rows.map((row) => row.file.path).sort(),
    [missing.path, otherDisk.path, annotated.path].sort());
});

test("favorites on NTFS and existing local metadata are preserved without duplicate rows", () => {
  const file = "C:\\Documents\\saved.pdf";
  const results = mergeFileSearch({
    query: "", favoritesOnly: true,
    drives: [{ drive: "C" }],
    localFiles: [local(file, 1), local("F:\\Shared\\favorite.txt", 1)],
    ntfsFiles: [ntfs(9, file), ntfs(10, "C:\\Users\\new.pdf", 1)],
  });
  assert.equal(results.length, 3);
  assert.equal(results.filter((row) => row.file.path === file).length, 1);
  assert.ok(results.some((row) => row.type === "ntfs" && row.file.favorite));
});
