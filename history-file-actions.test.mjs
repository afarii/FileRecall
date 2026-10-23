import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFileActions } from "./history-file-actions.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const states = [];
  const chrome = { downloads: {
    async search(query) { calls.push(["search", query]); return [{ id: query.id, state: "complete", exists: true }]; },
    show(id) { calls.push(["show", id]); },
    open(id) { calls.push(["open", id]); return Promise.resolve(); },
    ...overrides,
  } };
  return { calls, states, chrome, actions: createFileActions(chrome, (state) => states.push(state)) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("file operations require a checked ID and separate explicit actions; void show never claims success", async () => {
  const { actions, calls, states } = fixture();
  actions.perform("show");
  actions.perform("open");
  assert.deepEqual(calls, []);
  await actions.inspect(7);
  assert.deepEqual(calls, [["search", { id: 7 }]]);
  assert.equal(states.at(-1).openDisabled, false);
  actions.perform("show");
  assert.deepEqual(calls.at(-1), ["show", 7]);
  assert.match(states.at(-1).message, /不提供定位结果/);
  actions.perform("open");
  // The API must run in the click's synchronous stack, before any promise settles.
  assert.deepEqual(calls.at(-1), ["open", 7]);
  assert.equal(states.at(-1).openDisabled, true);
  actions.perform("open");
  assert.equal(calls.filter(([name]) => name === "open").length, 1);
  await flush();
  assert.match(states.at(-1).message, /接受打开请求/);
  assert.doesNotMatch(states.at(-1).message, /成功|已打开/);
});

test("a file change during an open request is rechecked after the request settles", async () => {
  let finishOpen;
  let exists = true;
  const { actions, states } = fixture({
    async search({ id }) { return [{ id, exists, state: "complete" }]; },
    open() { return new Promise((resolve) => { finishOpen = resolve; }); },
  });
  await actions.inspect(7);
  actions.perform("open");
  exists = false;
  await actions.inspect(7);
  assert.equal(states.at(-1).openDisabled, true);
  finishOpen();
  await flush();
  assert.match(states.at(-1).message, /移动或删除/);
  assert.equal(states.at(-1).openDisabled, true);
});

test("invalid IDs, missing Chrome history, incomplete downloads and missing files block both operations", async (t) => {
  for (const id of [undefined, null, "7", -1, 1.5, NaN]) {
    const { actions, calls, states } = fixture();
    await actions.inspect(id);
    assert.match(states.at(-1).message, /ID/);
    assert.deepEqual(calls, []);
  }
  for (const [name, result, message] of [
    ["lost", [], /记录已丢失/],
    ["wrong ID", [{ id: 8, state: "complete", exists: true }], /记录已丢失/],
    ["progress", [{ id: 7, state: "in_progress", exists: true }], /下载中/],
    ["interrupted", [{ id: 7, state: "interrupted", exists: true }], /已中断/],
    ["missing file", [{ id: 7, state: "complete", exists: false }], /移动或删除/],
    ["missing existence", [{ id: 7, state: "complete" }], /是否存在/],
    ["missing state", [{ id: 7, exists: true }], /下载已完成/],
  ]) {
    await t.test(name, async () => {
      const { actions, calls, states } = fixture({ async search() { return result; } });
      await actions.inspect(7);
      assert.equal(states.at(-1).showDisabled, true);
      assert.equal(states.at(-1).openDisabled, true);
      assert.match(states.at(-1).message, message);
      actions.perform("show");
      actions.perform("open");
      assert.deepEqual(calls, []);
    });
  }
});

test("API exceptions, promise rejections and runtime errors are visible and can be retried", async () => {
  for (const overrides of [
    { search() { throw new Error("search denied"); } },
    { async search() { throw new Error("search denied"); } },
    { search: undefined },
  ]) {
    const { actions, states } = fixture(overrides);
    await actions.inspect(7);
    assert.equal(states.at(-1).openDisabled, true);
    assert.match(states.at(-1).message, /denied|不可用/);
  }
  for (const action of ["show", "open"]) {
    for (const fail of [() => { throw new Error("permission denied"); }, () => Promise.reject(new Error("permission denied"))]) {
      const { actions, states, chrome } = fixture({ [action]: fail });
      await actions.inspect(7);
      actions.perform(action);
      await flush();
      assert.match(states.at(-1).message, /操作失败.*permission denied/);
      assert.equal(states.at(-1).openDisabled, true);
      chrome.downloads[action] = () => Promise.resolve();
      await actions.inspect(7);
      actions.perform(action);
      await flush();
      assert.doesNotMatch(states.at(-1).message, /失败/);
    }
  }
  const { actions, states, chrome } = fixture();
  await actions.inspect(7);
  chrome.runtime = { lastError: { message: "show denied" } };
  actions.perform("show");
  assert.match(states.at(-1).message, /操作失败.*show denied/);
  const unsupported = fixture({ open() {} });
  await unsupported.actions.inspect(7);
  unsupported.actions.perform("open");
  assert.match(unsupported.states.at(-1).message, /升级浏览器/);
});

test("stale checks and action completions cannot overwrite another record or a closed drawer", async () => {
  let resolveOld;
  const { actions, states } = fixture({ search({ id }) {
    return id === 1 ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve([{ id, state: "complete", exists: true }]);
  } });
  const old = actions.inspect(1);
  await actions.inspect(2);
  resolveOld([]);
  await old;
  assert.equal(states.at(-1).openDisabled, false);
  let finishOpen;
  const second = fixture({ open() { return new Promise((resolve) => { finishOpen = resolve; }); } });
  await second.actions.inspect(7);
  second.actions.perform("open");
  second.actions.cancel();
  await second.actions.inspect(8);
  const latest = second.states.at(-1);
  finishOpen();
  await flush();
  assert.equal(second.states.at(-1), latest);
  second.actions.cancel();
  second.actions.perform("open");
  assert.equal(second.calls.filter(([name]) => name === "open").length, 0);
});

test("manifest declares the separate Chrome file opening permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("downloads.open"));
});
