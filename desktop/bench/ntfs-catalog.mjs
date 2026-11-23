// Synthetic-only benchmark: never reads or uploads real disk names, paths, or user data.
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { NtfsCatalog } = require("../electron/ntfs-catalog.cjs");
const records = 60000;
const catalog = new NtfsCatalog(":memory:", "C:\\SyntheticAppData");
function sample(query, iterations = 35) {
  for (let i = 0; i < 5; i++) catalog.search("C", query);
  const ms = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    catalog.search("C", query);
    ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  return {
    p50Ms: Number(ms[Math.floor(ms.length * 0.5)].toFixed(3)),
    p95Ms: Number(ms[Math.floor(ms.length * 0.95)].toFixed(3)),
  };
}
try {
  const start = performance.now();
  for (let offset = 0; offset < records; offset += 1500) {
    const rows = [];
    for (let i = offset; i < Math.min(records, offset + 1500); i++) {
      const prefix = i < 35000 ? "report-" : "document-";
      const name = i === records - 2 ? "实验报告.pdf" : i === records - 1 ? "unique-search-needle-12345.pdf"
        : i % 97 === 0 ? "课程-报告-" + String(i).padStart(6, "0") + ".pdf"
        : prefix + String(i).padStart(6, "0") + ".pdf";
      rows.push({ id: String(i + 1000), parent: "7", directory: "C:\\SyntheticFiles",
        name, reason: 0, attributes: 0 });
    }
    catalog.apply("C", rows, true);
  }
  const buildMs = Number((performance.now() - start).toFixed(1));
  assert.equal(catalog.search("C", "report-").length, 100);
  assert.equal(catalog.search("C", "unique-search-needle").length, 1);
  assert.equal(catalog.search("C", "pdf sybg")[0]?.name, "实验报告.pdf");
  assert.equal(catalog.search("C", "never-exists-at-all").length, 0);
  assert.ok(catalog.search("C", "课程").length > 0);
  const bytes = Number(catalog.db.prepare("PRAGMA page_count").get().page_count) *
    Number(catalog.db.prepare("PRAGMA page_size").get().page_size);
  const summary = {
    syntheticRecords: records,
    buildMs,
    databaseMiB: Number((bytes / (1024 * 1024)).toFixed(2)),
    queries: {
      frequentPrefix: sample("report-"),
      selectiveSubstring: sample("search-needle"),
      noMatch: sample("never-exists-at-all"),
      chineseSubstring: sample("课程"),
      pathSubstring: sample("SyntheticFiles\\report-"),
    },
  };
  console.log("Synthetic NTFS catalog benchmark (no personal data):");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  catalog.close();
}
