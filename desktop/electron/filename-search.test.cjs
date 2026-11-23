"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { nameSearchKeys, queryTerms } = require("./filename-search.cjs");

test("Chinese file names have full pinyin and every-character initials", () => {
  const name = nameSearchKeys("实验报告.pdf");
  assert.equal(name.pinyin, "shiyanbaogaopdf");
  assert.equal(name.initials, "sybgpdf");
  assert.deepEqual(nameSearchKeys("报告 v2.docx"),
    { pinyin: "baogaov2docx", initials: "bgv2docx" });
  assert.equal(nameSearchKeys("README-v2.PDF").pinyin, "readmev2pdf");
});

test("queries combine terms, retain extension tokens and accept short prefixes", () => {
  assert.deepEqual(queryTerms("  pdf   sybg "), ["pdf", "sybg"]);
  assert.deepEqual(queryTerms("sy "), ["sy"]);
  assert.deepEqual(queryTerms("实验报告.pdf"), ["实验报告.pdf"]);
  assert.deepEqual(queryTerms(""), []);
});
