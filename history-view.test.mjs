import test from "node:test";
import assert from "node:assert/strict";
import {
  readHistory, sourceView, algorithmSourceView, fileName, text, safeWebUrl, timestamp, formatTime,
  downloadState, createHistoryLoader, searchHistory, filterHistory,
} from "./history-view.mjs";

const context = { pageUrl: "https://source.example/files", pageTitle: "Original page", linkUrl: "https://cdn.example/file.zip", clickedText: "Download" };
const record = (overrides = {}) => ({
  id: 7, filename: "C:\\Downloads\\file.zip", state: "complete",
  startTime: "2026-10-22T10:00:00Z", url: "https://cdn.example/file.zip",
  referrer: "https://source.example/", source: { status: "matched", context }, ...overrides,
});

test("manual source views, note search and filters distinguish user decisions from raw algorithm evidence", () => {
  const candidate = record({ source: { status: "candidate", candidate: context } });
  const confirmed = { ...candidate, userSource: { type: "confirmed_candidate", context: { ...context, pageTitle: "Confirmed Snapshot" } } };
  const rejected = { ...candidate, userSource: { type: "rejected_candidate", context }, note: "Personal Reminder" };
  const manual = record({ source: { status: "unknown" }, userSource: { type: "manual",
    context: { pageUrl: "https://manual.example/page", pageTitle: '<img src=x onerror="alert(1)">' } } });
  const items = [record(), candidate, confirmed, rejected, manual, record({ source: { status: "unknown" } })]
    .map((record, index) => ({ key: `download:${index}`, record }));
  const before = structuredClone(items);
  assert.equal(sourceView(confirmed).status, "confirmed");
  assert.equal(sourceView(confirmed).label, "人工确认候选");
  assert.equal(algorithmSourceView(confirmed).status, "candidate");
  assert.equal(sourceView(rejected).status, "rejected");
  assert.equal(sourceView(rejected).context, null);
  assert.equal(sourceView(manual).label, "人工填写");
  assert.deepEqual(searchHistory([items[3]], "source.example"), []);
  assert.deepEqual(searchHistory(items, "PERSONAL REMINDER"), [items[3]]);
  assert.deepEqual(searchHistory(items, "CONFIRMED SNAPSHOT"), [items[2]]);
  assert.deepEqual(searchHistory(items, "MANUAL.EXAMPLE"), [items[4]]);
  assert.deepEqual(searchHistory(items, "<img"), [items[4]]);
  for (const [index, sourceStatus] of ["matched", "candidate", "confirmed", "rejected", "manual", "unknown"].entries()) {
    assert.deepEqual(filterHistory(items, { sourceStatus }), [items[index]]);
  }
  assert.deepEqual(filterHistory(searchHistory(items, "MANUAL.EXAMPLE"), { sourceStatus: "manual", downloadStatus: "complete" }), [items[4]]);
  assert.deepEqual(filterHistory(items, { sourceStatus: "confirmed", downloadStatus: "interrupted" }), []);
  assert.equal(sourceView({ ...rejected, userSource: null }).status, "candidate");
  assert.equal(sourceView({ ...manual, userSource: null }).status, "unknown");
  for (const userSource of [null, [], "bad", { type: "manual", context: { pageUrl: "javascript:bad" } }, { type: "confirmed_candidate", context: null }]) {
    assert.equal(sourceView({ ...candidate, userSource }).status, "candidate");
  }
  assert.deepEqual(items, before);
});

test("source and download filters intersect with search, preserve order and never mutate records", () => {
  const items = readHistory({
    "download:1": record(),
    "download:2": record({ state: "in_progress", source: { status: "candidate", candidate: context },
      startTime: "2026-10-23T10:00:00Z" }),
    "download:3": record({ state: "interrupted", source: { status: "unknown", context, candidate: context } }),
    "download:4": record({ state: "complete", source: { status: "candidate", candidate: context } }),
  }).items;
  const before = structuredClone(items);
  const keys = (sourceStatus = "", downloadStatus = "", query = "") =>
    filterHistory(searchHistory(items, query), { sourceStatus, downloadStatus }).map((item) => item.key);
  const expected = {
    "": { "": [2, 1, 3, 4], complete: [1, 4], in_progress: [2], interrupted: [3] },
    matched: { "": [1], complete: [1], in_progress: [], interrupted: [] },
    candidate: { "": [2, 4], complete: [4], in_progress: [2], interrupted: [] },
    unknown: { "": [3], complete: [], in_progress: [], interrupted: [3] },
  };
  for (const [source, states] of Object.entries(expected)) {
    for (const [state, ids] of Object.entries(states)) {
      assert.deepEqual(keys(source, state), ids.map((id) => `download:${id}`));
      assert.deepEqual(keys(source, state, "FILE.ZIP"), ids.map((id) => `download:${id}`));
      assert.deepEqual(keys(source, state, "no match"), []);
    }
  }
  assert.deepEqual(keys("candidate", "complete", "ORIGINAL PAGE"), ["download:4"]);
  assert.deepEqual(keys("unknown", "interrupted", "source.example"), []);
  assert.equal(sourceView(filterHistory(items, { sourceStatus: "candidate" })[0].record).label, "候选 · 未确认");
  assert.deepEqual(filterHistory(items), items);
  assert.deepEqual(items, before);
});

test("filters keep malformed sources unknown and missing download states out of specific status results", () => {
  const sources = [null, [], "broken", {}, { status: "__proto__" },
    { status: "matched", context: null }, { status: "candidate", candidate: null }];
  const items = sources.map((source, index) => ({ key: `download:${index}`, record: { source, state: index % 2 ? null : "unexpected" } }));
  items.push({ key: "download:partial", record: {} });
  const before = structuredClone(items);
  assert.deepEqual(filterHistory(items, { sourceStatus: "unknown" }), items);
  for (const sourceStatus of ["matched", "candidate"]) {
    assert.deepEqual(filterHistory(items, { sourceStatus }), []);
  }
  for (const downloadStatus of ["complete", "in_progress", "interrupted"]) {
    assert.deepEqual(filterHistory(items, { downloadStatus }), []);
  }
  assert.deepEqual(filterHistory(items), items);
  assert.deepEqual(items, before);
});

test("search matches basenames and only the source context selected by its saved status", () => {
  const items = readHistory({
    "download:1": record({ filename: "C:/Private/Report.PDF", source: { status: "matched", context,
      candidate: { pageUrl: "https://wrong.example/", pageTitle: "Wrong candidate" } } }),
    "download:2": record({ filename: "/tmp/Archive.ZIP", startTime: "2026-10-23T10:00:00Z",
      source: { status: "candidate", candidate: { pageUrl: "https://Possible.example/hidden-path", pageTitle: "Possible Guide" },
        context: { pageUrl: "https://wrong.example/", pageTitle: "Wrong confirmed" } } }),
    "download:3": record({ filename: "C:/Private/Notes.txt", source: { status: "unknown", context, candidate: context } }),
  }).items;
  const before = structuredClone(items);
  const keys = (query) => searchHistory(items, query).map((item) => item.key);
  assert.deepEqual(keys("pOrT.p"), ["download:1"]);
  assert.deepEqual(keys("ARCHIVE"), ["download:2"]);
  assert.deepEqual(keys("SOURCE.EXAMPLE"), ["download:1"]);
  assert.deepEqual(keys("original PAGE"), ["download:1"]);
  assert.deepEqual(keys("POSSIBLE.EXAMPLE"), ["download:2"]);
  assert.deepEqual(keys("sible gui"), ["download:2"]);
  assert.deepEqual(keys("NOTES"), ["download:3"]);
  for (const query of ["wrong", "cdn.example", "hidden-path", "Private", "Download", "no match"]) {
    assert.deepEqual(keys(query), [], query);
  }
  assert.deepEqual(keys(""), items.map((item) => item.key));
  assert.deepEqual(keys("   "), items.map((item) => item.key));
  assert.deepEqual(keys("."), ["download:2", "download:1", "download:3"]);
  assert.equal(sourceView(searchHistory(items, "Possible")[0].record).label, "候选 · 未确认");
  assert.deepEqual(items, before);
});

test("search tolerates partial records without searching presentation fallbacks or invalid sources", () => {
  const items = readHistory({ "download:1": {}, "download:2": record({ filename: null,
    source: { status: "matched", context: null } }), "download:3": record({ filename: {},
    source: { status: "candidate", candidate: { pageTitle: {}, pageUrl: "javascript:bad" } } }) }).items;
  assert.equal(searchHistory(items, "").length, 3);
  for (const query of ["source.example", "未命名", "未记录", "javascript", "暂无", "file.zip"]) {
    assert.deepEqual(searchHistory(items, query), []);
  }
});

test("history reads only DownloadRecord keys, skips corrupt values, and keeps partial records", () => {
  const data = {
    "download:7": record(), "download:8": {}, "download:9": null,
    "download:10": "broken", "download:11": [], preferences: { anything: true },
  };
  const original = structuredClone(data);
  const result = readHistory(data);
  assert.equal(result.items.length, 2);
  assert.equal(result.skipped, 3);
  assert.deepEqual(data, original);
  assert.deepEqual(readHistory(null), { items: [], skipped: 0 });
});

test("history sorts by actual start time descending, including timezone offsets", () => {
  const result = readHistory({
    "download:1": record({ startTime: "2026-10-22T10:00:00+02:00" }),
    "download:2": record({ startTime: "2026-10-22T09:00:00Z" }),
    "download:3": record({ startTime: "bad date" }),
    "download:4": record({ startTime: null }),
  });
  assert.deepEqual(result.items.map((item) => item.key), ["download:2", "download:1", "download:3", "download:4"]);
});

test("matched and candidate sources never borrow each other's context", () => {
  const matched = sourceView(record({ source: { status: "matched", context, candidate: { pageTitle: "Wrong" } } }));
  assert.equal(matched.title, "Original page");
  assert.equal(matched.site, "source.example");
  const candidate = sourceView(record({ source: {
    status: "candidate", context: { pageTitle: "Not confirmed" },
    candidate: { ...context, pageTitle: "Possible page", linkUrl: null },
  } }));
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.title, "Possible page");
  assert.match(candidate.label, /未确认/);
  assert.equal(candidate.context.linkUrl, null);
});

test("unknown sources never infer a website or title from referrer, URL, or stray contexts", () => {
  const result = sourceView(record({ source: { status: "unknown", context, candidate: context } }));
  assert.equal(result.status, "unknown");
  assert.equal(result.site, "未知来源");
  assert.equal(result.context, null);
});

test("missing or malformed source information degrades without claiming confirmation", () => {
  for (const source of [null, [], "broken", {}, { status: "__proto__" }, { status: "matched", context: null }, { status: "candidate", candidate: null }]) {
    assert.equal(sourceView(record({ source })).status, "unknown");
  }
  const result = sourceView(record({ source: { status: "matched", context: {} } }));
  assert.equal(result.title, "页面标题未记录");
  assert.equal(result.site, "页面地址未记录");
});

test("Windows and POSIX paths display basenames with sensible missing-field fallbacks", () => {
  assert.equal(fileName(record()), "file.zip");
  assert.equal(fileName(record({ filename: "/home/user/report.pdf" })), "report.pdf");
  assert.equal(fileName(record({ filename: "", state: "in_progress" })), "文件名尚未确定");
  assert.equal(fileName(record({ filename: null })), "未命名文件");
  assert.equal(fileName(record({ filename: {} })), "未命名文件");
});

test("unsafe and malformed URLs cannot become clickable links", () => {
  for (const value of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/secret", "//example.com", "/relative", null, {}]) {
    assert.equal(safeWebUrl(value), null);
  }
  assert.equal(safeWebUrl("https://example.com/files?q=1#section"), "https://example.com/files?q=1#section");
  assert.equal(safeWebUrl("http://example.com/"), "http://example.com/");
});

test("external strings remain literal text and non-string fields do not get coerced", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  assert.equal(text(hostile), hostile);
  assert.equal(text({ toString() { throw new Error("must not execute"); } }), "未记录");
  assert.equal(sourceView(record({ source: { status: "candidate", candidate: { ...context, pageTitle: hostile } } })).title, hostile);
});

test("dates and download states tolerate missing and unexpected values", () => {
  for (const value of [null, {}, "", "bad"]) {
    assert.equal(timestamp(value), null);
    assert.equal(formatTime(value), "时间未知");
  }
  assert.notEqual(formatTime("2026-10-22T10:00:00Z"), "时间未知");
  assert.equal(downloadState("complete").label, "已完成");
  assert.equal(downloadState("interrupted").label, "已中断");
  assert.equal(downloadState("in_progress").label, "下载中");
  for (const value of ["__proto__", "toString", {}, null]) assert.equal(downloadState(value).label, "状态未知");
});

test("the loader performs a read only and handles empty storage", async () => {
  const states = [];
  const load = createHistoryLoader({ async get(key) { assert.equal(key, null); return {}; } }, (state) => states.push(state));
  await load();
  assert.deepEqual(states, [{ status: "loading" }, { status: "ready", items: [], skipped: 0 }]);
});

test("a storage read failure is reported and a later retry succeeds", async () => {
  const states = [];
  let failed = false;
  const load = createHistoryLoader({ async get() {
    if (!failed) { failed = true; throw new Error("Storage unavailable"); }
    return { "download:7": record() };
  } }, (state) => states.push(state));
  await load();
  assert.deepEqual(states.at(-1), { status: "error", message: "Storage unavailable" });
  await load();
  assert.equal(states.at(-1).status, "ready");
  assert.equal(states.at(-1).items.length, 1);
});

test("a slower old read cannot overwrite a newer refresh", async () => {
  const states = [];
  let resolveOld;
  let count = 0;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const load = createHistoryLoader({ get() {
    return ++count === 1 ? old : Promise.resolve({ "download:8": record({ id: 8 }) });
  } }, (state) => states.push(state));
  const first = load();
  await load();
  resolveOld({ "download:7": record() });
  await first;
  assert.equal(states.at(-1).items[0].record.id, 8);
  assert.equal(states.filter((state) => state.status === "ready").length, 1);
});

test("an older read failure cannot replace a newer successful result", async () => {
  const states = [];
  let rejectOld;
  let count = 0;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  const load = createHistoryLoader({ get() { return ++count === 1 ? old : Promise.resolve({}); } }, (state) => states.push(state));
  const first = load();
  await load();
  rejectOld(new Error("Stale failure"));
  await first;
  assert.equal(states.at(-1).status, "ready");
});
