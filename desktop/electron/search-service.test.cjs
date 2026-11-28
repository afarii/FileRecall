"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileIndex } = require("./indexer.cjs");
const { NtfsCatalog } = require("./ntfs-catalog.cjs");
const { createSearchService } = require("./search-service.cjs");
const { DownloadSources } = require("./download-sources.cjs");

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
    { id: "80", parent: "5", directory: "E:\\", name: "md1.txt", attributes: 0, reason: 0 },
    { id: "81", parent: "5", directory: "E:\\", name: "md-md-md-md-md.txt", attributes: 0, reason: 0 },
    { id: "82", parent: "5", directory: "E:\\", name: "实验报告.docx", attributes: 0, reason: 0 },
    { id: "83", parent: "5", directory: "E:\\", name: "alpha-beta.txt", attributes: 0, reason: 0 },
    { id: "84", parent: "5", directory: "E:\\", name: "beta-alpha.txt", attributes: 0, reason: 0 },
  ], true);
  assert.ok((await search.searchLocal("sy")).some((item) => item.name === "实验报告.pdf"));
  local.recordUse(report);
  local.recordUse(report);
  assert.equal((await search.searchLocal("sy"))[0].useCount, 2);
  const matches = await search.searchNtfs("sy", [{ drive: "E", cached: false }]);
  assert.ok(matches.some(({ name }) => name === "实验报告.pdf"));
  assert.ok(matches.some(({ name }) => name === "实验报告.docx"));
  // Test the actual fast unified path before usage ranking can mask a miss.
  const drives = [{ drive: "E", cached: false }];
  for (const query of ["sy pdf", "pdf sy", "sy pd", "pd sy", "sybg pdf", "shiyan pdf", "实验 pdf", "pdf 实验"]) {
    const hits = await search.searchUnified(query, drives);
    assert.ok(hits.some(({ type, file }) => type === "ntfs" && file.name === "实验报告.pdf"), query + " must match NTFS, not the legacy index");
    assert.ok(!hits.some(({ file }) => file.name === "实验报告.docx"), query);
  }
  for (const query of ["alpha beta", "beta alpha"]) {
    const hits = await search.searchUnified(query, drives);
    assert.deepEqual(hits.filter(({ type }) => type === "ntfs").map(({ file }) => file.name).sort(),
      ["alpha-beta.txt", "beta-alpha.txt"], query);
  }
  const repeat = await search.searchUnified("md md md md md", drives);
  assert.ok(repeat.some(({ file }) => file.name === "md-md-md-md-md.txt"));
  assert.ok(!repeat.some(({ file }) => file.name === "md1.txt"));
  ntfs.recordUse("E", "80");
  assert.ok(!(await search.searchUnified("md md md md md", drives)).some(({ file }) => file.name === "md1.txt"),
    "frequent-file ranking must not bypass repeated-word matching");
  ntfs.recordUse("E", "77");
  const after = await search.searchNtfs("sy", [{ drive: "E", cached: false }]);
  assert.equal(after[0].useCount, 1);
  assert.equal(after[0].cached, false);
  const unified = await search.searchUnified("sy", [{ drive: "E", cached: false }]);
  // Both files have the same name, but the independent local file has been
  // used twice versus once for the NTFS file. Unified relevance should honor
  // usage across sources while retaining the separate NTFS hit.
  assert.equal(unified[0].type, "local");
  assert.equal(unified[0].file.path, report);
  assert.equal(unified[0].file.useCount, 2);
  const ntfsHit = unified.find(({ type, file }) => type === "ntfs" && file.id === "77");
  assert.ok(ntfsHit, "unified search retains the separate NTFS file");
  assert.equal(ntfsHit.file.name, "实验报告.pdf");
  assert.equal(ntfsHit.file.useCount, 1);
  assert.ok(unified[0].file.matchScore > ntfsHit.file.matchScore);
  ntfs.favorite("E", "77", true);
  const favorites = await search.searchUnified("", [{ drive: "E", cached: false }], true);
  assert.equal(favorites[0].file.name, "实验报告.pdf");
  assert.equal(favorites[0].file.favorite, 1);

  assert.deepEqual(await search.searchNtfs("sy", []), []);
  const quick = await search.searchNtfs("report", [{ drive: "E", cached: false }]);
  assert.deepEqual(quick, [], "indexed hot path skips whole-volume substring scans");
  const deep = await search.searchNtfsDeep("report", [{ drive: "E", cached: false }]);
  assert.equal(deep[0].name, "sample-report.txt", "separate worker preserves substring fallback");
  assert.ok((await search.searchUnifiedDeep("report", drives)).some(({ file }) => file.name === "sample-report.txt"));
  assert.ok((await search.searchUnifiedDeep("bg pdf", drives)).some(({ file }) => file.name === "实验报告.pdf"));
  assert.ok((await search.searchUnifiedDeep("报告 pdf", drives)).some(({ file }) => file.name === "实验报告.pdf"));
});

test("slow download-source results run in their own worker and are searchable by website", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "filerecall-recovery-"));
  const localDatabase = join(root, "files.sqlite");
  const downloadsDatabase = join(root, "browser-downloads.sqlite");
  const local = new FileIndex(localDatabase);
  const sources = new DownloadSources(downloadsDatabase);
  const item = {
    key: "download:42", startedAt: 1760000000000, path: "D:\\Downloads\\old.pdf",
    algorithm: { status: "candidate", url: "https://example.org/course", title: "课程资料" },
    effective: { status: "confirmed", url: "https://example.org/course", title: "课程资料" },
  };
  sources.importBatch({
    version: 1, profile: "12345678-1234-1234-1234-123456789abc", records: [item],
  });
  const search = createSearchService({
    localDatabase, ntfsDatabase: null, downloadsDatabase, applicationData: root,
  });
  t.after(async () => {
    await search.close();
    sources.close();
    local.close();
    await rm(root, { recursive: true, force: true });
  });
  const bySite = await search.searchDownloads("example.org");
  assert.equal(bySite.length, 1);
  assert.equal(bySite[0].name, "old.pdf");
  assert.equal(bySite[0].canOpenSource, true);
  for (const query of ["old example.org", "example.org old", "课程 pdf"]) {
    assert.equal((await search.searchDownloads(query)).length, 1, query);
  }
  assert.equal((await search.searchDownloads("old old old old old")).length, 0);
  assert.equal((await search.searchDownloads("missingkeyword")).length, 0);
  // The primary filename worker remains independently usable.
  assert.deepEqual(await search.searchUnified("old", []), []);
});


test("MOTW source lookup runs independently of filename search and works without browser extension", async (t) => {
  const { MotwMemory } = require("./motw-memory.cjs");
  const root = await mkdtemp(join(tmpdir(), "filerecall-motw-search-"));
  const localDatabase = join(root, "files.sqlite");
  const motwDatabase = join(root, "motw-memory.sqlite");
  const local = new FileIndex(localDatabase);
  const memory = new MotwMemory(motwDatabase);
  const search = createSearchService({ localDatabase, motwDatabase, applicationData: root });
  t.after(async () => { await search.close(); memory.close(); local.close(); await rm(root, {recursive:true, force:true}); });
  memory.save({ volume:"a", id:"77", identity:"1:77:100", path:"C:\\Downloads\\10mb.dat" },
    { referrerUrl:"https://testfile.cc/" });
  const hits = await search.searchDownloads("testfile.cc");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].manager, "motw");
  assert.equal(hits[0].name, "10mb.dat");
  assert.deepEqual(await search.searchUnified("testfile.cc", []), []);
  memory.markDeleted("a", "77");
  assert.equal((await search.searchDownloads("testfile.cc"))[0].id, hits[0].id);
});


test("smart directory context finds chapter slides while ordinary search stays unchanged",async t=>{
  const root=await mkdtemp(join(tmpdir(),"filerecall-courseware-"));
  const localDatabase=join(root,"files.sqlite"),ntfsDatabase=join(root,"ntfs.sqlite");
  const local=new FileIndex(localDatabase),catalog=new NtfsCatalog(ntfsDatabase,join(root,"app-data"));
  const search=createSearchService({localDatabase,ntfsDatabase,applicationData:join(root,"app-data")});
  t.after(async()=>{await search.close();local.close();catalog.close();await rm(root,{recursive:true,force:true});});
  catalog.enable("E","test-volume");
  const row=(id,parent,directory,name,attributes=0)=>({id,parent,directory,name,attributes,reason:0});
  catalog.apply("E",[
    row("51","5","E:\\","算法设计与分析",16),
    row("52","51","E:\\算法设计与分析","第1讲-算法绪论.pptx"),
    row("53","51","E:\\算法设计与分析","第3讲-分治法.ppt"),
    row("54","51","E:\\算法设计与分析","第4讲-动态规划.pptx"),
    row("55","51","E:\\算法设计与分析","作业.docx"),
    row("56","5","E:\\","计算机网络",16),
    row("57","56","E:\\计算机网络","第3讲.ppt"),
  ],true);
  catalog.finishBuild("E");
  const drives=[{drive:"E",cached:false}];
  const hits=await search.smartContext({topic:"算法",extensions:["ppt","pptx","pdf"],favorites:false},drives);
  assert.deepEqual(hits.map(r=>r.file.id).sort(),["52","53","54"]);
  assert.ok(!(await search.searchUnified("算法",drives)).some(r=>r.file.id==="53"));
  assert.deepEqual(await search.searchUnified("sfkj",drives), []);
  assert.deepEqual(await search.searchUnifiedDeep("sfkj",drives), []);
  catalog.favorite("E","53",true);
  const favorites=await search.smartContext({topic:"算法",extensions:["ppt","pptx"],favorites:true},drives);
  assert.deepEqual(favorites.map(r=>r.file.id),["53"]);
});
