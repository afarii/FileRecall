import { test } from "node:test";
import assert from "node:assert/strict";
import { syncDesktop } from "./desktop-sync.mjs";

test("desktop sync batches completed downloads, retains candidate evidence, and retries safely", async () => {
  const data = Object.fromEntries(Array.from({ length: 17 }, (_, id) => [
    "download:" + id, {
      state: "complete", filename: "C:\\Demo\\notes.txt", startTime: "2026-11-16T00:00:00Z",
      source: { status: "candidate", candidate: { pageUrl: "https://example.org/notes" } },
      userSource: { type: "rejected_candidate" },
    },
  ]));
  data["download:99"] = { state: "in_progress" };
  const sent = [];
  const storage = {
    get: async (key) => key ? { [key]: data[key] } : { ...data },
    set: async (patch) => Object.assign(data, patch),
  };
  let fail = true;
  const runtime = { async sendNativeMessage(host, batch) {
    assert.equal(host, "com.filerecall.desktop");
    sent.push(batch);
    if (fail && sent.length === 2) throw new Error("host disconnected");
    return { ok: true, saved: batch.records.length, skipped: 0 };
  } };
  await assert.rejects(syncDesktop({ storage, runtime }), /已同步 16 条/);
  fail = false;
  assert.deepEqual(await syncDesktop({ storage, runtime }), { synced: 17, ignored: 0 });
  assert.deepEqual(sent[0], sent[2]);
  assert.equal(sent[0].records[0].algorithm.status, "candidate");
  assert.equal(sent[0].records[0].effective.status, "rejected");
  assert.equal(sent[0].records[0].effective.url, "");
  assert.equal(data["download:99"].state, "in_progress");
});
