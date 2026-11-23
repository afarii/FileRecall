"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createNtfsService } = require("./ntfs-service.cjs");
const { createPerformanceDiagnostics } = require("./performance-diagnostics.cjs");

test("NTFS catalog initializes and closes in worker without blocking main thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filerecall-ntfs-worker-"));
  let service;
  try {
    service = createNtfsService(join(directory, "ntfs.sqlite"), directory, "unused.exe", {
      onChange() {}, onPaths: async () => {}, onActiveDrives() {},
    });
    assert.equal(await service.target("E", "123"), null);
    assert.equal(service.status().available, true);
    await service.close();
    service = null;
  } finally {
    if (service) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("performance diagnostics persist numeric-only samples and never index private filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filerecall-perf-"));
  const diagnostics = createPerformanceDiagnostics(directory, { intervalMs: 25 });
  try {
    diagnostics.recordRendererLag(421);
    diagnostics.setNtfsMetrics({
      ntfsLoopP95Ms: 12.4, ntfsLoopMaxMs: 30.2,
      scanStates: [{ drive: "C", phase: "building", filename: "SECRET_NOT_IN_LOG.txt" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = diagnostics.snapshot();
    assert.ok(snapshot.recent.length > 0);
    assert.ok(snapshot.recent.some((row) => row.rendererLagMs === 421));
    assert.equal(snapshot.recent.at(-1).ntfsActiveScanCount, 1);
    await diagnostics.close();
    const contents = await readFile(diagnostics.file, "utf8");
    assert.ok(contents.includes("mainLoopMaxMs"));
    assert.ok(!contents.includes("SECRET_NOT_IN_LOG"));
    assert.ok(!contents.includes(directory));
  } finally {
    await diagnostics.close();
    await rm(directory, { recursive: true, force: true });
  }
});
