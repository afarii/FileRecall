"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DownloadSources } = require("./download-sources.cjs");
const { createAria2Connection } = require("./aria2-connection.cjs");

test("loopback aria2 sync authenticates, deduplicates completed files and preserves direct-link provenance", async () => {
  const tasks = [{
    status: "complete", gid: "123abc123abc123a",
    files: [
      { index: "1", selected: "true", length: "52", completedLength: "52", path: "E:\\Downloads\\handbook.pdf",
        uris: [{ status: "used", uri: "https://cdn.example/handbook.pdf" }] },
      { index: "2", selected: "true", length: "10", completedLength: "10", path: "E:\\Downloads\\mirrors.txt",
        uris: [{ status: "used", uri: "https://one.example/a" }, { status: "used", uri: "https://two.example/a" }] },
      { index: "3", selected: "false", length: "10", completedLength: "0", path: "E:\\Downloads\\skipped.txt" },
    ],
  }, { status: "removed", gid: "0000000000000001", files: [
    { index: "1", selected: "true", length: "10", completedLength: "10", path: "E:\\Downloads\\removed.txt" },
  ] }];
  const observed = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    observed.push({ method: body.method, path: request.url, offset: body.params[1] });
    const result = body.params[0] === "token:qa-key" ? { result: tasks } : { error: { code: 1 } };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const directory = await mkdtemp(join(tmpdir(), "filerecall-aria2-"));
  const sources = new DownloadSources(":memory:");
  let notifications = 0;
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  const connection = createAria2Connection(directory, secureStorage,
    (records) => sources.importAria2(records), () => notifications++);
  try {
    const { port } = server.address();
    await assert.rejects(connection.connect(port, "wrong"), /端口和密钥/);
    assert.equal((await connection.status()).connected, false);
    assert.deepEqual(await connection.connect(port, "qa-key"), { found: 2, changed: 2 });
    assert.deepEqual(await connection.refresh(), { found: 2, changed: 0 });
    assert.equal(notifications, 1);
    sources.importBatch({
      version: 1, profile: "12345678-1234-1234-1234-123456789abc",
      records: [{ key: "download:3", path: "E:\\Downloads\\chrome.pdf", startedAt: Date.now() }],
    });
    assert.equal(sources.search("", "chrome").length, 1);
    assert.equal(sources.search("", "aria2").length, 2);
    const [handbook] = sources.search("cdn.example");
    assert.equal(handbook.manager, "aria2");
    assert.equal(handbook.sourceStatus, "direct");
    assert.equal(sources.sourceToOpen(handbook.id), "https://cdn.example/handbook.pdf");
    assert.equal(sources.search("mirrors")[0].sourceStatus, "unknown");
    assert.deepEqual(sources.search("removed"), []);
    const saved = JSON.parse(await readFile(join(directory, "aria2-settings.json"), "utf8"));
    assert.equal(typeof saved.token, "string");
    await connection.disconnect();
    assert.equal((await connection.status()).connected, false);
    assert.equal(sources.search("").length, 3);
    assert.ok(observed.every(({ method, path, offset }) =>
      method === "aria2.tellStopped" && path === "/jsonrpc" && offset === -1));
  } finally {
    connection.close();
    sources.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
