"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { discoverFixedNtfsDrives } = require("./ntfs-auto.cjs");

test("discovers only fixed NTFS drive letters and never returns arbitrary output", async () => {
  const letters = await discoverFixedNtfsDrives({
    platform: "win32", systemRoot: "C:\\Windows",
    run(_file, args, options, callback) {
      assert.ok(args.includes("-NoProfile"));
      assert.equal(options.windowsHide, true);
      callback(null, "c:, E:,c:, \\server\\private, F:\\Users\\Example, d:\r\n");
    },
  });
  assert.deepEqual(letters, ["C", "D", "E"]);
});

test("skips discovery outside Windows and reports a generic error without leaking paths", async () => {
  assert.deepEqual(await discoverFixedNtfsDrives({ platform: "linux",
    run() { throw new Error("unexpected"); } }), []);
  await assert.rejects(discoverFixedNtfsDrives({
    platform: "win32",
    run(_file, _args, _options, callback) {
      callback(new Error("PRIVATE_DATA"), "");
    },
  }), (error) => error.message === "无法检测本地 NTFS 磁盘。");
});
