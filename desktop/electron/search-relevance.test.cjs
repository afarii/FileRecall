"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NtfsCatalog, fullPath } = require("./ntfs-catalog.cjs");
const { prepareQuery, scoreFile } = require("./search-relevance.cjs");

const experiments = [
  "【实验课件】00-大作业-综合实验-程序设计A.pdf",
  "【实验课件】01-上机实验操作指导.pdf",
  "【实验课件】02-C++简单程序设计.pdf",
  "【实验课件】03-函数.pdf",
  "实验报告.pdf",
];
const resources = [
  "pdfmsym-doc.pdf", "pdfsync-doc.pdf", "pdb.asy", "pdfmovie.asy",
  "pdfmsym-doc.tex", "pdfmsym.tex", "pdfmsym.tlpobj", "pdfsync-doc.tex",
];

test("screenshot regression: experimental PDFs rank ahead of TeX Live resources across incremental input", () => {
  const catalog = new NtfsCatalog(":memory:", "D:\\AppData");
  try {
    catalog.enable("D", "test-volume");
    const row = (id, name, dir) => ({ id: String(id), parent: dir === "D:\\Study" ? "51" : "52",
      directory: dir, name, attributes: 0, reason: 0 });
    catalog.apply("D", [
      ...experiments.map((name, i) => row(100+i, name, "D:\\Study")),
      ...resources.map((name, i) => row(200+i, name, "D:\\texlive\\2025\\texmf-dist")),
      // More than a single candidate page of distracting prefix hits.
      ...Array.from({ length: 150 }, (_, i) => row(1000+i, "pdfsy-" + i + ".tex", "D:\\texlive\\2025\\texmf-dist")),
    ], true);
    const search = (q, fastOnly = true) => catalog.search("D", q, { fastOnly }).map(r => r.name);
    for (const query of ["sy pd", "pd sy", "sy pdf", "pdf sy"]) {
      assert.deepEqual(new Set(search(query).slice(0, experiments.length)), new Set(experiments), query);
      assert.deepEqual(new Set(search(query, false).slice(0, experiments.length)), new Set(experiments), query + " deep");
    }
    const partial = search("sy pd");
    const complete = search("sy pdf");
    assert.deepEqual(partial, search("pd sy"));
    assert.deepEqual(complete, search("pdf sy"));
    const common = new Set(complete);
    assert.deepEqual(partial.filter(name => experiments.includes(name) && common.has(name)),
      complete.filter(name => experiments.includes(name)));
    assert.ok(!complete.includes("pdb.asy"));
    // The stable scorer must reward independently matched filename and extension.
    assert.equal(scoreFile({name: "实验报告.pdf"}, prepareQuery("sy pd")),
      scoreFile({name: "实验报告.pdf"}, prepareQuery("sy pdf")));
    assert.ok(scoreFile({name: "实验报告.pdf"}, prepareQuery("sy pd")) >
      scoreFile({name: "pdfmsym-doc.pdf"}, prepareQuery("sy pd")));
  } finally { catalog.close(); }
});

test("all-term score keeps usage and favorite benefits and is independent of query order", () => {
  const base = { name: "实验报告.pdf", path: "D:\\Study\\实验报告.pdf" };
  const score = (row, q) => scoreFile(row, prepareQuery(q));
  assert.equal(score(base, "sy pdf"), score(base, "pdf sy"));
  assert.ok(score({...base, useCount: 3}, "sy pd") > score(base, "sy pd"));
  assert.ok(score({...base, favorite: 1}, "sy pd") > score(base, "sy pd"));
  assert.ok(score({name:"报告.pdf"}, "bg pd") > score({name:"bgpd.asy"}, "bg pd"));
});
