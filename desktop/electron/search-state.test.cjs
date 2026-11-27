"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

test("empty results are displayed only after every requested search stage settles", async () => {
  const { searchDisplay } = await import("../src/search-state.ts");
  const base = { inputPending: false, filePhase: "complete", historyPending: false, historyFailed: false, hasResults: false };
  const display = (overrides) => searchDisplay({ ...base, ...overrides });
  assert.equal(display({}), "empty");
  assert.equal(display({ inputPending: true }), "searching");
  assert.equal(display({ filePhase: undefined }), "searching");
  assert.equal(display({ filePhase: "searching" }), "searching");
  assert.equal(display({ filePhase: "supplementing" }), "searching");
  assert.equal(display({ historyPending: true }), "searching");
  assert.equal(display({ filePhase: "failed" }), "failed");
  assert.equal(display({ historyFailed: true }), "failed");
  assert.equal(display({ filePhase: "failed", historyPending: true }), "searching");
  assert.equal(display({ hasResults: true, filePhase: "supplementing" }), "partial");
  assert.equal(display({ hasResults: true, historyPending: true }), "partial");
  assert.equal(display({ hasResults: true }), "results");
  assert.equal(display({ hasResults: true, filePhase: "failed" }), "results");
});
