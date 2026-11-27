"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NtfsSourceLinks, createNtfsProvenance } = require("./ntfs-provenance.cjs");
const { DownloadSources } = require("./download-sources.cjs");

test("confirmed NTFS source survives rename/move and refuses reused paths", async (t) => {
  const links = new NtfsSourceLinks(":memory:");
  const downloads = new DownloadSources(":memory:");
  t.after(() => { links.close(); downloads.close(); });
  const volume = "volume-a";
  const original = "E:\\Downloads\\实验报告.pdf";
  const moved = "E:\\Course\\报告-final.pdf";
  downloads.importBatch({
    version: 1, profile: "12345678-1234-1234-1234-123456789abc",
    records: [{ key: "download:42", startedAt: 1760000000000, path: original,
      algorithm: { status: "candidate", url: "https://example.org/course", title: "课程资料" },
      effective: { status: "confirmed", url: "https://example.org/course", title: "课程资料" } }],
  });
  const [download] = downloads.search("example.org");
  let current = { drive: "E", volume, id: "77", path: original };
  let birth = 100n;
  let inode = 77n;
  const stat = async (path) => {
    if (!current || path !== current.path) throw new Error("ENOENT");
    return { isFile: () => true, isSymbolicLink: () => false, nlink: 1n, dev: 1n, ino: inode, birthtimeNs: birth };
  };
  const service = createNtfsProvenance({ links, stat, readDownloads: (fn) => fn(downloads),
    target: async (drive, id) => current?.drive === drive && current.id === id ? current : null,
    resolve: async (v, id) => current?.volume === v && current.id === id ? current : null });
  const before = await service.details("E", "77");
  assert.equal(before.confirmed, null);
  assert.equal(before.candidates[0].id, download.id);
  assert.equal(await service.linkedFile(download.id), null);
  await assert.rejects(service.decide("E", "77", "wrong-identity", download.id, "confirmed"));
  const after = await service.decide("E", "77", before.identity, download.id, "confirmed");
  assert.equal(after.confirmed.id, download.id);
  assert.equal((await service.linkedFile(download.id)).path, original);
  current = { ...current, path: moved };
  assert.equal((await service.details("E", "77")).confirmed.id, download.id);
  assert.deepEqual(await service.linkedFile(download.id), { path: moved, name: "报告-final.pdf", status: "present" });
  // Replaced file with same path and even simulated same reference but new creation identity.
  birth = 200n;
  assert.equal((await service.details("E", "77")).confirmed, null);
  assert.equal((await service.linkedFile(download.id)).status, "missing");
  birth = 100n;
  current = { ...current, volume: "volume-b" };
  assert.equal((await service.linkedFile(download.id)).status, "missing");
  current = null;
  assert.deepEqual(await service.linkedFile(download.id), { path: moved, name: "报告-final.pdf", status: "missing" });
  assert.equal(downloads.search("example.org")[0].id, download.id);
  assert.equal(downloads.sourceToOpen(download.id), "https://example.org/course");
});

test("MFT identity mismatch never becomes a source association", async (t) => {
  const links = new NtfsSourceLinks(":memory:");
  t.after(() => links.close());
  const service = createNtfsProvenance({ links,
    target: async () => ({ volume: "a", drive: "E", id: "77", path: "E:\\x.pdf" }),
    resolve: async () => null, readDownloads: (_fn, fallback) => fallback,
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1n, dev: 1n, ino: 78n, birthtimeNs: 100n }) });
  assert.deepEqual(await service.details("E", "77"), { identity: null, confirmed: null, candidates: [] });
  await assert.rejects(service.decide("E", "77", "1:77:100", "d", "confirmed"));
});
