"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseMotw, readMotw } = require("./motw.cjs");

test("MOTW parses only ZoneTransfer HTTP(S) evidence, retaining unknown trust status", () => {
  assert.deepEqual(parseMotw("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.org/file.pdf\r\nReferrerUrl=https://example.org/page\r\n"), {
    zoneId: 3, hostUrl: "https://example.org/file.pdf", referrerUrl: "https://example.org/page",
  });
  assert.deepEqual(parseMotw("[Other]\nHostUrl=https://bad.example/\n[ZoneTransfer]\nZoneId=3\nHostUrl=file:///C:/private"), {
    zoneId: 3, hostUrl: null, referrerUrl: null,
  });
  assert.equal(parseMotw("[ZoneTransfer]\nHostUrl=https://u:p@example.org/path"), null);
  assert.equal(parseMotw("[ZoneTransfer]\nHostUrl=javascript:alert(1)"), null);
});

test("reads a bounded alternate stream only for an existing regular Windows file", async () => {
  const content = Buffer.from("[ZoneTransfer]\nZoneId=3\nReferrerUrl=https://example.org/article", "utf8");
  let opened;
  let closed = false;
  const value = await readMotw("C:\\sample\\file.pdf", {
    platform: "win32",
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    openFile: async (path, mode) => {
      opened = [path, mode];
      return { async read(buffer) { content.copy(buffer); return { bytesRead: content.length }; },
        async close() { closed = true; } };
    },
  });
  assert.deepEqual(opened, ["C:\\sample\\file.pdf:Zone.Identifier", "r"]);
  assert.equal(value.referrerUrl, "https://example.org/article");
  assert.equal(closed, true);
  assert.equal(await readMotw("C:\\sample\\file.pdf", {
    platform: "win32", stat: async () => ({ isFile: () => false, isSymbolicLink: () => true }),
    openFile: async () => { throw new Error("must not open"); },
  }), null);
  assert.equal(await readMotw("/tmp/synthetic", { platform: "linux" }), null);
});
