import test from "node:test";
import assert from "node:assert/strict";
import { importHistoryBatch, IMPORT_BATCH_SIZE } from "./history-import.mjs";
import { createDownloadRecordStore } from "./download-record-store.mjs";
import { searchHistory, sourceView } from "./history-view.mjs";

function fixture(records) {
  const data = {};
  const queries = [];
  const fail = new Set();
  const store = createDownloadRecordStore({
    async get(key) { return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) {
      if (Object.keys(values).some((key) => fail.has(key))) throw new Error("quota exceeded");
      Object.assign(data, structuredClone(values));
    },
  });
  const downloads = { async search(query) {
    queries.push(query);
    return records.filter((record) => !query.startedBefore || Date.parse(record.startTime) < Date.parse(query.startedBefore))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime) || b.id - a.id).slice(0, query.limit);
  } };
  return { data, queries, fail, store, downloads };
}
const record = (id, time = id) => ({ id, startTime: new Date(1_700_000_000_000 + time).toISOString(),
  filename: `C:/Downloads/file-${id}.zip`, state: "complete", url: "https://cdn.example/file.zip",
  referrer: "https://source.example/page", exists: true });

test("imports many records in user-driven batches, including equal timestamp boundaries", async () => {
  const records = Array.from({ length: 1205 }, (_, id) => record(id, id < 250 ? 0 : id));
  const { downloads, store, data, queries } = fixture(records);
  let cursor = null;
  let added = 0;
  let result;
  do {
    result = await importHistoryBatch(downloads, store, cursor);
    assert.ok(result.added <= IMPORT_BATCH_SIZE);
    assert.equal(result.failed, 0);
    added += result.added;
    cursor = result.cursor;
  } while (result.hasMore);
  assert.equal(added, records.length);
  assert.equal(Object.keys(data).length, records.length);
  assert.ok(queries.length > 12);
  assert.ok(queries.every((query) => query.limit > 0 && query.limit <= 1001));
  assert.deepEqual(queries[0], { orderBy: ["-startTime", "-id"], limit: 101 });
  assert.ok(queries.some((query) => query.limit > 101));
  const imported = data["download:1"];
  assert.equal(imported.filename, records[1].filename);
  assert.equal(imported.referrer, records[1].referrer);
  assert.equal(imported.source.status, "unknown");
  assert.equal(imported.source.reason, "history_import");
  assert.equal(imported.source.context, null);
  assert.equal(imported.source.candidate, null);
  assert.equal(imported.source.evidence, null);
  assert.equal(sourceView(imported).context, null);
  assert.match(sourceView(imported).note, /无法恢复过去的点击上下文/);
  assert.deepEqual(searchHistory([{ key: "download:1", record: imported }], "source.example"), []);
  assert.equal(searchHistory([{ key: "download:1", record: imported }], "FILE-1").length, 1);
});

test("repeated imports preserve every existing value and imported facts without extra writes", async () => {
  const { downloads, store, data } = fixture([record(1), record(2), record(3), record(4)]);
  for (const [id, status] of [[1, "matched"], [2, "candidate"], [3, "unknown"]]) {
    data[`download:${id}`] = { ...record(id), filename: "saved.zip", annotation: "keep",
      source: { status, context: { pageTitle: "Saved" }, evidence: { linkMatch: "exact" } } };
  }
  const original = structuredClone(data);
  const first = await importHistoryBatch(downloads, store);
  assert.equal(first.added, 1);
  assert.equal(first.skipped, 3);
  for (const key of Object.keys(original)) assert.deepEqual(data[key], original[key]);
  const before = structuredClone(data);
  const second = await importHistoryBatch(downloads, store);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 4);
  assert.deepEqual(data, before);
});

test("partial persistence failure does not stop other records and restarting retries only missing records", async () => {
  const { downloads, store, data, fail } = fixture([record(1), record(2), record(3)]);
  fail.add("download:2");
  const result = await importHistoryBatch(downloads, store);
  assert.equal(result.added, 2);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0], /下载 2.*quota exceeded/);
  assert.deepEqual(Object.keys(data).sort(), ["download:1", "download:3"]);
  fail.clear();
  const retried = await importHistoryBatch(downloads, store);
  assert.equal(retried.added, 1);
  assert.equal(retried.skipped, 2);
  assert.equal(retried.failed, 0);
});

test("empty history, failed queries, malformed records and cursors never report false completion", async () => {
  const { downloads, store, data } = fixture([]);
  assert.deepEqual(await importHistoryBatch(downloads, store), {
    added: 0, skipped: 0, failed: 0, errors: [], hasMore: false, cursor: null,
  });
  await assert.rejects(importHistoryBatch({ async search() { throw new Error("Chrome unavailable"); } }, store), /Chrome unavailable/);
  await assert.rejects(importHistoryBatch({ async search() { return [record(1), { id: 2 }]; } }, store), /无效 ID 或时间/);
  for (const cursor of [{}, { time: 1, ids: [-1] }, { time: 1, ids: Array(901).fill(1) }]) {
    await assert.rejects(importHistoryBatch(downloads, store, cursor), /分页信息/);
  }
  assert.deepEqual(data, {});
});

test("query failures after a committed batch leave it intact and allow retrying the same cursor", async () => {
  const { downloads, store, data } = fixture(Array.from({ length: 105 }, (_, id) => record(id)));
  const first = await importHistoryBatch(downloads, store);
  assert.equal(first.added, 100);
  const before = structuredClone(data);
  await assert.rejects(importHistoryBatch({ async search() { throw new Error("read failed"); } }, store, first.cursor), /read failed/);
  assert.deepEqual(data, before);
  const next = await importHistoryBatch(downloads, store, first.cursor);
  assert.equal(next.added, 5);
  assert.equal(next.hasMore, false);
});

test("an excessive equal-time boundary stops explicitly before writing instead of silently skipping records", async () => {
  const { downloads, store, data } = fixture(Array.from({ length: 1100 }, (_, id) => record(id, 0)));
  const cursor = { time: 1_700_000_000_000, ids: Array.from({ length: 900 }, (_, id) => 1099 - id) };
  await assert.rejects(importHistoryBatch(downloads, store, cursor), /同一时间.*本批未写入/);
  assert.deepEqual(data, {});
});
