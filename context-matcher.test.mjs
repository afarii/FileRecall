import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_WINDOW_MS, createContextRecord, matchContext, pruneContexts,
} from "./context-matcher.mjs";

const BASE_TIME = Date.parse("2026-10-19T00:00:00Z");
const at = (offset) => new Date(BASE_TIME + offset).toISOString();
const click = (overrides = {}) => ({
  pageUrl: "https://testfile.cc/#speed-files",
  pageTitle: "TestFile.cc - Download Test Files",
  linkUrl: "https://testfile.cc/files/test.bin?size=10",
  clickedText: "Download test file",
  timestamp: at(0),
  ...overrides,
});
const download = (overrides = {}) => ({
  id: 7,
  url: "https://testfile.cc/files/test.bin?size=10",
  referrer: "https://testfile.cc/",
  startTime: at(5_490),
  ...overrides,
});
const record = (overrides = {}) => createContextRecord(click(overrides), BASE_TIME + 5_000);

test("testfile: link and page match after 5.49 seconds, even with an empty filename", () => {
  const result = matchContext(download({ filename: "" }), [record()]);
  assert.equal(result.status, "matched");
  assert.equal(result.reason, "link_and_page");
  assert.equal(result.delayMs, 5_490);
  assert.deepEqual(result.evidence, { linkMatch: "exact", pageMatch: "without_fragment" });
  assert.equal(result.context.pageTitle, click().pageTitle);
  assert.equal(result.candidate, null);
});

test("VS Code: a unique same-page button is only a candidate, with no invented URL", () => {
  const context = record({
    pageUrl: "https://code.visualstudio.com/",
    pageTitle: "Visual Studio Code",
    linkUrl: null,
    clickedText: "Download for Windows",
  });
  const result = matchContext(download({
    url: "https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user",
    referrer: "https://code.visualstudio.com/",
  }), [context]);
  assert.equal(result.status, "candidate");
  assert.equal(result.reason, "page_and_time");
  assert.equal(result.delayMs, 5_490);
  assert.equal(result.context, null);
  assert.equal(result.candidate.linkUrl, null);
  assert.equal(result.candidate.pageTitle, "Visual Studio Code");
  assert.equal(result.recordIndex, null);
  assert.equal(context.used, false);
});

test("an exact resource link with an origin-only referrer is a candidate, not a conflict", () => {
  const context = record({ pageUrl: "https://source.example/articles/files?category=tools" });
  const result = matchContext(download({ referrer: "https://source.example/" }), [context]);
  assert.equal(result.status, "candidate");
  assert.equal(result.reason, "origin_only_referrer");
  assert.deepEqual(result.evidence, { linkMatch: "exact", pageMatch: "origin_only" });
  assert.equal(result.context, null);
  assert.equal(result.candidate.pageUrl, context.context.pageUrl);
});

test("resource fragments are ignored, while original context URLs are preserved", () => {
  const context = record({ linkUrl: `${click().linkUrl}#download` });
  const result = matchContext(download(), [context]);
  assert.equal(result.status, "matched");
  assert.equal(result.evidence.linkMatch, "without_fragment");
  assert.equal(result.context.linkUrl, `${click().linkUrl}#download`);
});

test("fragment normalization also works with a reduced origin-only referrer", () => {
  const context = record({
    pageUrl: "https://source.example/files",
    linkUrl: `${click().linkUrl}#download`,
  });
  const result = matchContext(download({ referrer: "https://source.example/" }), [context]);
  assert.equal(result.status, "candidate");
  assert.equal(result.reason, "origin_only_referrer");
  assert.equal(result.evidence.linkMatch, "without_fragment");
});

test("standard URL normalization allows host case and default-port differences", () => {
  const result = matchContext(download(), [record({
    pageUrl: "https://TESTFILE.cc:443/",
    linkUrl: "https://TESTFILE.cc:443/files/test.bin?size=10",
  })]);
  assert.equal(result.status, "matched");
  assert.equal(result.evidence.linkMatch, "normalized");
  assert.equal(result.evidence.pageMatch, "normalized");
});

test("resource paths and query strings remain strict", async (t) => {
  for (const url of [
    "https://testfile.cc/files/other.bin?size=10",
    "https://testfile.cc/files/Test.bin?size=10",
    "https://testfile.cc/files/test.bin/?size=10",
    "https://testfile.cc/files/test.bin?size=20",
    "https://testfile.cc/files/test.bin",
    "http://testfile.cc/files/test.bin?size=10",
  ]) {
    await t.test(url, () => {
      assert.equal(matchContext(download({ url }), [record()]).status, "unknown");
    });
  }
  const context = record({ linkUrl: "https://testfile.cc/file?a=1&b=2#one" });
  assert.equal(matchContext(download({ url: "https://testfile.cc/file?b=2&a=1" }), [context]).status, "unknown");
});

test("an origin fallback is not allowed for a different origin or a full conflicting referrer", async (t) => {
  const context = record({ pageUrl: "https://source.example/files?section=1" });
  for (const referrer of [
    "https://other.example/",
    "http://source.example/",
    "https://source.example:8443/",
    "https://source.example/other",
    "https://source.example/files?section=2",
    "https://source.example/?campaign=1",
  ]) {
    await t.test(referrer, () => {
      assert.equal(matchContext(download({ referrer }), [context]).status, "unknown");
    });
  }
});

test("origin-only page evidence is insufficient for a button", () => {
  const context = record({ pageUrl: "https://source.example/files", linkUrl: null });
  assert.equal(matchContext(download({ referrer: "https://source.example/" }), [context]).status, "unknown");
});

test("an exact link with no referrer is only a candidate", () => {
  const result = matchContext(download({ referrer: "" }), [record()]);
  assert.equal(result.status, "candidate");
  assert.equal(result.reason, "link_only");
  assert.equal(result.context, null);
});

test("duplicate link clicks remain ambiguous instead of choosing the newest", () => {
  const result = matchContext(download(), [record(), record({ timestamp: at(5_000) })]);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.candidateCount, 2);
  assert.equal(result.context, null);
});

test("a strong link match does not override a viable same-page button", () => {
  const result = matchContext(download(), [record(), record({ linkUrl: null })]);
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.status, "unknown");
});

test("multiple buttons and multiple origin-only link candidates remain ambiguous", () => {
  const buttons = [record({ linkUrl: null }), record({ linkUrl: null, clickedText: "Other button" })];
  assert.equal(matchContext(download(), buttons).reason, "ambiguous");
  const links = [record({ pageUrl: "https://source.example/one" }), record({ pageUrl: "https://source.example/two" })];
  const result = matchContext(download({ referrer: "https://source.example/" }), links);
  assert.equal(result.status, "unknown");
  assert.equal(result.candidateCount, 2);
});

test("used records prevent reuse and remain evidence against selecting a weaker candidate", () => {
  const used = { ...record(), used: true };
  const records = pruneContexts([used], BASE_TIME + 5_490);
  assert.equal(records.length, 1);
  assert.equal(matchContext(download(), records).reason, "context_already_used");
  assert.equal(matchContext(download(), [...records, record({ linkUrl: null })]).reason, "ambiguous");
});

test("the 60-second window includes its boundary and rejects older or future clicks", () => {
  assert.equal(CONTEXT_WINDOW_MS, 60_000);
  for (const offset of [5_490, 59_999, 60_000]) {
    assert.equal(matchContext(download({ startTime: at(offset) }), [record()]).status, "matched");
  }
  for (const offset of [-1, 60_001]) {
    assert.equal(matchContext(download({ startTime: at(offset) }), [record()]).reason, "no_recent_context");
  }
  assert.equal(matchContext(download(), [record()], 5_000).status, "unknown");
  assert.equal(matchContext(download(), [record()], 6_000).status, "matched");
});

test("time differences use click and download timestamps, not message receipt time", () => {
  const context = createContextRecord(click(), BASE_TIME + 4_000);
  const records = pruneContexts([context], BASE_TIME + 20_000);
  assert.equal(matchContext(download(), records).delayMs, 5_490);
});

test("expiry removes both used and unused contexts, and a worker restart starts empty", () => {
  const records = [record(), { ...record(), used: true }];
  assert.equal(pruneContexts(records, BASE_TIME + 60_000).length, 2);
  assert.deepEqual(pruneContexts(records, BASE_TIME + 60_001), []);
  assert.deepEqual(pruneContexts(records, BASE_TIME - 1), []);
  assert.equal(matchContext(download(), []).reason, "no_recent_context");
});

test("invalid messages cannot become button candidates", () => {
  for (const context of [
    null,
    {},
    click({ linkUrl: undefined }),
    click({ linkUrl: "" }),
    click({ linkUrl: "not a URL" }),
    click({ linkUrl: "javascript:download()" }),
    click({ pageUrl: "not a URL" }),
    click({ pageTitle: null }),
    click({ clickedText: null }),
    click({ timestamp: "not a date" }),
    click({ timestamp: at(5_001) }),
  ]) {
    assert.equal(createContextRecord(context, BASE_TIME + 5_000), null);
  }
});

test("invalid download times, URLs, and referrers produce unknown results", () => {
  assert.equal(matchContext(download({ startTime: "bad" }), [record()]).reason, "invalid_time");
  assert.equal(matchContext(download({ url: "data:text/plain,test" }), [record()]).reason, "invalid_download_url");
  assert.equal(matchContext(download({ referrer: "bad" }), [record()]).reason, "invalid_referrer");
});

test("matching and cleanup do not mutate inputs or consume candidates", () => {
  const original = click();
  const context = createContextRecord(original, BASE_TIME + 5_000);
  original.pageTitle = "Changed after capture";
  assert.equal(context.context.pageTitle, "TestFile.cc - Download Test Files");
  Object.freeze(context.context);
  Object.freeze(context);
  const records = Object.freeze([context]);
  assert.equal(matchContext(download(), records).status, "matched");
  assert.equal(pruneContexts(records, BASE_TIME + 5_490).length, 1);
  assert.equal(context.used, false);
});
