"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createShutdown } = require("./shutdown.cjs");

test("shutdown starts once, waits for successful cleanup, and isolates task failure", async () => {
  let calls = 0, forced = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const shutdown = createShutdown({
    tasks: [() => { calls++; throw new Error("cleanup failed"); }, () => { calls++; return pending; }],
    finalize: finish, forceExit: () => { forced++; finish(); }, timeoutMs: 1000,
  });
  shutdown.start();
  shutdown.start();
  await Promise.resolve();
  assert.equal(shutdown.started, true);
  assert.equal(calls, 2);
  release();
  await complete;
  assert.equal(forced, 0);
});

test("shutdown exits even if worker cleanup never settles", async () => {
  let forced = 0, graceful = 0, release, finish;
  const pending = new Promise(resolve => { release = resolve; });
  const complete = new Promise(resolve => { finish = resolve; });
  const shutdown = createShutdown({
    tasks: [() => pending], finalize: () => { graceful++; },
    forceExit: () => { forced++; finish(); }, timeoutMs: 20,
  });
  shutdown.start();
  await complete;
  assert.equal(forced, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(graceful, 0);
});

test("shutdown falls back to exit when final database close throws", async () => {
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const shutdown = createShutdown({
    tasks: [], finalize: () => { throw new Error("busy database"); },
    forceExit: finish, timeoutMs: 1000,
  });
  shutdown.start();
  await complete;
});
