import test from "node:test";
import assert from "node:assert/strict";
import { createDownloadRecord, createDownloadRecordStore } from "./download-record-store.mjs";
import { createContextRecord, matchContext } from "./context-matcher.mjs";

const startedAt = "2026-10-22T12:00:05.490Z";
const updatedAt = "2026-10-22T12:00:06.000Z";
const download = (overrides = {}) => ({
  id: 7, url: "https://testfile.cc/file.zip", referrer: "https://testfile.cc/",
  startTime: startedAt, filename: "", state: "in_progress", ...overrides,
});
const click = (overrides = {}) => ({
  pageUrl: "https://testfile.cc/#files", pageTitle: "TestFile.cc",
  linkUrl: "https://testfile.cc/file.zip", clickedText: "Download",
  timestamp: "2026-10-22T12:00:00.000Z", ...overrides,
});
const association = (context = click(), item = download()) => matchContext(item, [
  createContextRecord(context, Date.parse(startedAt)),
]);

function memoryStorage(initial = {}, hooks = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      await hooks.get?.(key);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(values) {
      await hooks.set?.(values);
      Object.assign(data, structuredClone(values));
    },
  };
}

test("history import shares the write queue, preserves live associations and never replaces existing keys", async () => {
  const storage = memoryStorage({ "download:8": null });
  const store = createDownloadRecordStore(storage, () => updatedAt);
  const live = store.create(download(), association());
  const importing = store.import(download({ filename: "historical.zip" }));
  await live;
  const before = structuredClone(storage.data["download:7"]);
  assert.equal(await importing, false);
  assert.deepEqual(storage.data["download:7"], before);
  assert.equal(await store.import(download({ id: 8 })), false);
  assert.equal(storage.data["download:8"], null);
  assert.equal(await store.import(download({ id: 9 })), true);
  await store.update({ id: 9, state: { current: "complete" } });
  assert.equal(storage.data["download:9"].state, "complete");
  assert.equal(storage.data["download:9"].source.reason, "history_import");
  await assert.rejects(store.import(download({ id: "7" })), /Invalid/);
});

test("candidate confirmation, rejection and undo store snapshots separately and preserve original evidence and notes", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage, () => updatedAt);
  await store.create(download(), association(click({ linkUrl: null })));
  const original = structuredClone(storage.data["download:7"].source);
  await store.annotate(7, { kind: "note", note: "  useful file  " });
  await store.annotate(7, { kind: "confirm" });
  let saved = storage.data["download:7"];
  assert.equal(saved.userSource.type, "confirmed_candidate");
  assert.deepEqual(saved.userSource.context, original.candidate);
  assert.notEqual(saved.userSource.context, saved.source.candidate);
  assert.equal(saved.userSource.updatedAt, updatedAt);
  assert.deepEqual(saved.source, original);
  await store.annotate(7, { kind: "reject" });
  saved = storage.data["download:7"];
  assert.equal(saved.userSource.type, "rejected_candidate");
  assert.deepEqual(saved.userSource.context, original.candidate);
  await store.annotate(7, { kind: "manual", pageUrl: "https://other.example/page", pageTitle: "Other page" });
  assert.equal(storage.data["download:7"].userSource.type, "manual");
  await store.annotate(7, { kind: "clearSource" });
  assert.equal(storage.data["download:7"].userSource, null);
  assert.equal(storage.data["download:7"].note, "useful file");
  assert.deepEqual(storage.data["download:7"].source, original);
});

test("manual pages and notes can be edited, cleared, reloaded and retained through import and download events", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.import(download());
  const original = structuredClone(storage.data["download:7"].source);
  await Promise.all([
    store.annotate(7, { kind: "manual", pageUrl: " https://Example.com/page " }),
    store.annotate(7, { kind: "note", note: "Read later" }),
    store.update({ id: 7, filename: { current: "final.zip" }, state: { current: "complete" } }),
    store.import(download()),
  ]);
  const record = storage.data["download:7"];
  assert.equal(record.userSource.context.pageUrl, "https://example.com/page");
  assert.equal(record.userSource.context.pageTitle, "");
  assert.equal(record.note, "Read later");
  assert.equal(record.filename, "final.zip");
  assert.equal(record.state, "complete");
  assert.deepEqual(record.source, original);
  const restarted = createDownloadRecordStore(storage);
  await restarted.annotate(7, { kind: "manual", pageUrl: "http://edited.example/", pageTitle: "Edited" });
  assert.equal(storage.data["download:7"].userSource.context.pageTitle, "Edited");
  await restarted.annotate(7, { kind: "note", note: "" });
  assert.equal(storage.data["download:7"].note, "");
  await restarted.annotate(7, { kind: "clearSource" });
  assert.equal(storage.data["download:7"].userSource, null);
  assert.deepEqual(storage.data["download:7"].source, original);
});

test("late live creation fills imported evidence without dropping concurrent manual annotations", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  const operations = [
    store.import(download()),
    store.annotate(7, { kind: "manual", pageUrl: "https://manual.example/", pageTitle: "Known page" }),
    store.annotate(7, { kind: "note", note: "keep me" }),
    store.update({ id: 7, state: { current: "interrupted" } }),
    store.create(download(), association()),
    store.import(download()),
  ];
  await Promise.all(operations);
  const record = storage.data["download:7"];
  assert.equal(record.source.status, "matched");
  assert.equal(record.userSource.type, "manual");
  assert.equal(record.note, "keep me");
  assert.equal(record.state, "interrupted");
});

test("annotations validate IDs, source operations and text/URL input without modifying records on failure", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.import(download());
  const before = structuredClone(storage.data);
  for (const change of [
    { kind: "confirm" }, { kind: "reject" }, { kind: "bogus" },
    { kind: "note", note: {} }, { kind: "note", note: "x".repeat(1001) },
    ...["javascript:alert(1)", "data:text/html,bad", "file:///tmp/file", "//example.com", "invalid"].map((pageUrl) => ({ kind: "manual", pageUrl, pageTitle: "" })),
    { kind: "manual", pageUrl: "https://example.com/", pageTitle: {} },
  ]) await assert.rejects(store.annotate(7, change));
  await assert.rejects(store.annotate(-1, { kind: "note", note: "x" }));
  await assert.rejects(store.annotate(99, { kind: "note", note: "x" }), /记录已丢失/);
  assert.deepEqual(storage.data, before);
  await store.create(download({ id: 8 }), association());
  await assert.rejects(store.annotate(8, { kind: "manual", pageUrl: "https://example.com/", pageTitle: "" }), /先排除/);
});

test("failed annotation writes are reported and later queued operations still succeed", async () => {
  let fail = false;
  const storage = memoryStorage({}, { set() { if (fail) throw new Error("quota exceeded"); } });
  const store = createDownloadRecordStore(storage);
  await store.import(download());
  fail = true;
  await assert.rejects(store.annotate(7, { kind: "note", note: "not saved" }), /quota exceeded/);
  assert.equal(storage.data["download:7"].note, undefined);
  fail = false;
  await store.update({ id: 7, state: { current: "complete" } });
  await store.annotate(7, { kind: "note", note: "saved" });
  assert.equal(storage.data["download:7"].state, "complete");
  assert.equal(storage.data["download:7"].note, "saved");
});

for (const status of ["matched", "candidate"]) {
  test(`live creation fills an imported placeholder with ${status} evidence while retaining saved facts and annotations`, async () => {
    const storage = memoryStorage();
    const store = createDownloadRecordStore(storage, () => updatedAt);
    await store.import(download({ filename: "imported.zip" }));
    storage.data["download:7"].annotation = { tags: ["keep"], note: "manual note" };
    storage.data["download:7"].source.annotation = "manual source note";
    storage.data["download:7"].url = "https://saved.example/file.zip";
    const evidence = association(status === "candidate" ? click({ linkUrl: null }) : click());
    const updating = store.update({ id: 7, filename: { current: "final.zip" }, state: { current: "complete" } });
    const creating = store.create(download(), evidence);
    await Promise.all([updating, creating]);
    const result = storage.data["download:7"];
    assert.equal(result.filename, "final.zip");
    assert.equal(result.state, "complete");
    assert.equal(result.url, "https://saved.example/file.zip");
    assert.deepEqual(result.annotation, { tags: ["keep"], note: "manual note" });
    assert.equal(result.source.annotation, "manual source note");
    assert.deepEqual(result.source, { ...createDownloadRecord(download(), evidence, updatedAt).source,
      annotation: "manual source note" });
    const before = structuredClone(result);
    assert.equal(await store.import(download({ filename: "stale.zip" })), false);
    await store.create(download(), association());
    assert.deepEqual(storage.data["download:7"], before);
  });
}

test("import queued before live creation cannot suppress reliable source evidence", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  const importing = store.import(download());
  const creating = store.create(download(), association());
  assert.equal(await importing, true);
  await creating;
  assert.equal(storage.data["download:7"].source.status, "matched");
});

test("live creation preserves ordinary records and imported placeholders without reliable new context", async () => {
  for (const source of [
    { status: "unknown", reason: "no_recent_context" },
    { status: "matched", reason: "history_import", context: click() },
    { status: "candidate", reason: "history_import", candidate: click() },
  ]) {
    const existing = { ...download(), source, annotation: "keep" };
    const storage = memoryStorage({ "download:7": existing });
    await createDownloadRecordStore(storage).create(download(), association());
    assert.deepEqual(storage.data["download:7"], existing);
  }
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.import(download());
  const before = structuredClone(storage.data["download:7"]);
  await store.create(download(), { status: "unknown", reason: "no_recent_context" });
  assert.deepEqual(storage.data["download:7"], before);
  await store.create(download(), { status: "matched", context: null });
  assert.deepEqual(storage.data["download:7"], before);
});

test("creation stores one complete record with separate facts and matched context", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage, () => updatedAt);
  const result = await store.create(download(), association());
  assert.deepEqual(Object.keys(storage.data), ["download:7"]);
  assert.equal(result.id, 7);
  assert.equal(result.url, download().url);
  assert.equal(result.referrer, download().referrer);
  assert.equal(result.startTime, startedAt);
  assert.equal(result.filename, "");
  assert.equal(result.state, "in_progress");
  assert.equal(result.updatedAt, updatedAt);
  assert.equal(result.source.status, "matched");
  assert.equal(result.source.context.pageTitle, "TestFile.cc");
  assert.equal(result.source.candidate, null);
  assert.equal(result.source.reason, "link_and_page");
  assert.equal(result.source.delayMs, 5_490);
  assert.deepEqual(result.source.evidence, association().evidence);
  assert.equal("recordIndex" in result.source, false);
});

test("filename and completion update the original record and preserve its source", async () => {
  const storage = memoryStorage();
  let tick = 0;
  const store = createDownloadRecordStore(storage, () => new Date(Date.parse(updatedAt) + tick++).toISOString());
  const created = await store.create(download(), association());
  await store.update({ id: 7, filename: { current: "C:/Downloads/file.zip" } });
  await store.update({ id: 7, state: { current: "complete" } });
  const result = storage.data["download:7"];
  assert.equal(result.filename, "C:/Downloads/file.zip");
  assert.equal(result.state, "complete");
  assert.deepEqual(result.source, created.source);
  assert.notEqual(result.updatedAt, created.updatedAt);
  assert.equal(Object.keys(storage.data).length, 1);
});

test("interrupted downloads remain in storage", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.create(download(), association());
  await store.update({ id: 7, state: { current: "interrupted" } });
  assert.equal(storage.data["download:7"].state, "interrupted");
  assert.equal(storage.data["download:7"].source.status, "matched");
});

test("VS Code candidates stay unconfirmed through filename and state updates", async () => {
  const item = download({
    url: "https://code.visualstudio.com/sha/download?os=win",
    referrer: "https://code.visualstudio.com/",
  });
  const context = click({ pageUrl: item.referrer, pageTitle: "VS Code", linkUrl: null });
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.create(item, association(context, item));
  await store.update({ id: 7, filename: { current: "C:/Downloads/VSCode.exe" }, state: { current: "complete" } });
  const source = storage.data["download:7"].source;
  assert.equal(source.status, "candidate");
  assert.equal(source.context, null);
  assert.equal(source.candidate.pageTitle, "VS Code");
  assert.equal(source.candidate.linkUrl, null);
  assert.equal(source.reason, "page_and_time");
});

test("the model never copies candidate or unknown data into confirmed context", () => {
  const source = createDownloadRecord(download(), {
    ...association(), status: "candidate", context: click(), candidate: click({ linkUrl: null }),
  }, updatedAt).source;
  assert.equal(source.context, null);
  assert.equal(source.candidate.linkUrl, null);
  const unknown = createDownloadRecord(download(), {
    status: "unknown", reason: "ambiguous", context: click(), candidate: click(), candidateCount: 2,
  }, updatedAt).source;
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.context, null);
  assert.equal(unknown.candidate, null);
  assert.equal(unknown.candidateCount, 2);
  assert.equal(createDownloadRecord(download(), { status: "matched", context: null }, updatedAt).source.status, "unknown");
});

test("unknown association still stores all browser download facts", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.create(download(), matchContext(download(), []));
  const result = storage.data["download:7"];
  assert.equal(result.url, download().url);
  assert.equal(result.startTime, startedAt);
  assert.equal(result.source.status, "unknown");
  assert.equal(result.source.reason, "no_recent_context");
  assert.equal(result.source.context, null);
  assert.equal(result.source.candidate, null);
});

test("the full read-merge-write operation is serialized, even while the first write is blocked", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstSet = new Promise((resolve) => { entered = resolve; });
  let getCount = 0;
  let setCount = 0;
  const storage = memoryStorage({}, {
    get() { getCount++; },
    async set() { if (++setCount === 1) { entered(); await gate; } },
  });
  const store = createDownloadRecordStore(storage);
  const creation = store.create(download(), association());
  await firstSet;
  const filename = store.update({ id: 7, filename: { current: "final.zip" } });
  const completion = store.update({ id: 7, state: { current: "complete" } });
  const other = store.create(download({ id: 8 }), association());
  await Promise.resolve();
  assert.equal(getCount, 1);
  release();
  await Promise.all([creation, filename, completion, other]);
  assert.equal(storage.data["download:7"].filename, "final.zip");
  assert.equal(storage.data["download:7"].state, "complete");
  assert.equal(storage.data["download:8"].state, "in_progress");
  assert.equal(Object.keys(storage.data).length, 2);
});

test("rapid same-ID updates preserve every field and the latest values", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  const operations = [store.create(download(), association())];
  for (let i = 0; i < 25; i++) operations.push(store.update({ id: 7, filename: { current: `file-${i}.zip` } }));
  operations.push(store.update({ id: 7, state: { current: "complete" } }));
  await Promise.all(operations);
  assert.equal(storage.data["download:7"].filename, "file-24.zip");
  assert.equal(storage.data["download:7"].state, "complete");
  assert.equal(storage.data["download:7"].source.context.pageTitle, "TestFile.cc");
  assert.equal(Object.keys(storage.data).length, 1);
});

test("an early delta is preserved when creation arrives later", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.update({ id: 7, filename: { current: "final.zip" }, state: { current: "complete" } });
  assert.equal(storage.data["download:7"].url, null);
  assert.equal(storage.data["download:7"].source.reason, "creation_event_unavailable");
  await store.create(download(), association());
  const result = storage.data["download:7"];
  assert.equal(result.filename, "final.zip");
  assert.equal(result.state, "complete");
  assert.equal(result.url, download().url);
  assert.equal(result.source.status, "matched");
});

test("duplicate creation cannot revert facts or promote a previously stored candidate", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  await store.create(download(), association(click({ linkUrl: null })));
  await store.update({ id: 7, filename: { current: "final.zip" }, state: { current: "complete" } });
  await store.create(download(), association());
  assert.equal(storage.data["download:7"].filename, "final.zip");
  assert.equal(storage.data["download:7"].state, "complete");
  assert.equal(storage.data["download:7"].source.status, "candidate");
  assert.equal(storage.data["download:7"].source.context, null);
  assert.equal(Object.keys(storage.data).length, 1);
});

test("a new store instance reads persisted records before applying updates", async () => {
  const storage = memoryStorage();
  await createDownloadRecordStore(storage).create(download(), association());
  const restarted = createDownloadRecordStore(storage);
  await restarted.update({ id: 7, state: { current: "complete" } });
  assert.equal(storage.data["download:7"].url, download().url);
  assert.equal(storage.data["download:7"].source.context.pageTitle, "TestFile.cc");
  assert.equal(storage.data["download:7"].state, "complete");
});

for (const method of ["get", "set"]) {
  test(`${method} failure rejects with the download ID and cause, and later writes still run`, async () => {
    let fail = true;
    const storage = memoryStorage({}, {
      [method]() { if (fail) { fail = false; throw new Error(`${method} failed: quota or disk unavailable`); } },
    });
    const store = createDownloadRecordStore(storage);
    await assert.rejects(store.create(download(), association()), (error) => {
      assert.match(error.message, /persist download 7/);
      assert.match(error.message, new RegExp(`${method} failed`));
      assert.equal(error.cause.message, `${method} failed: quota or disk unavailable`);
      return true;
    });
    assert.equal(storage.data["download:7"], undefined);
    await store.create(download(), association());
    await store.update({ id: 7, state: { current: "interrupted" } });
    assert.equal(storage.data["download:7"].state, "interrupted");
  });
}

test("unsupported deltas cause no write, and empty filename values are preserved", async () => {
  let writes = 0;
  const storage = memoryStorage({}, { set() { writes++; } });
  const store = createDownloadRecordStore(storage);
  assert.equal(await store.update({ id: 7, bytesReceived: { current: 10 } }), null);
  assert.equal(writes, 0);
  await store.create(download({ filename: "first.zip" }), association());
  await store.update({ id: 7, filename: { current: "" } });
  assert.equal(storage.data["download:7"].filename, "");
});

test("queued writes use snapshots of creation and delta inputs", async () => {
  const storage = memoryStorage();
  const store = createDownloadRecordStore(storage);
  const item = download();
  const source = association();
  const creation = store.create(item, source);
  item.url = "https://changed.example/";
  source.context.pageTitle = "Changed";
  const delta = { id: 7, filename: { current: "final.zip" } };
  const update = store.update(delta);
  delta.filename.current = "changed.zip";
  await Promise.all([creation, update]);
  assert.equal(storage.data["download:7"].url, download().url);
  assert.equal(storage.data["download:7"].source.context.pageTitle, "TestFile.cc");
  assert.equal(storage.data["download:7"].filename, "final.zip");
});
