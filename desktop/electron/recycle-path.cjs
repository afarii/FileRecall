"use strict";

const { win32 } = require("node:path");

// Windows stores recycled payloads as $R* and metadata as $I* under
// the volume-root $Recycle.Bin. A normal file called $Report.pdf is valid.
function isRecyclePath(path) {
  return typeof path === "string" && /^[a-z]:\\\$recycle\.bin(?:\\|$)/i.test(win32.normalize(path));
}

function historicalLocation(row) {
  if (isRecyclePath(row.path)) {
    // Earlier versions overwrote the last normal pathname. Preserve the
    // observation and URL, without inventing a name or exposing a $R token.
    return { path: "", name: "原文件名未知" };
  }
  return { path: row.path, name: row.name || win32.basename(row.path) };
}

async function resolveRememberedFile(row, lookup, verify) {
  if (!row) return null;
  const history = historicalLocation(row);
  if (row.deleted) return { ...history, status: "missing" };
  const result = await Promise.resolve().then(() => lookup(row.volume, row.frn)).catch(() => null);
  if (result?.state === "missing") return { ...history, status: "missing" };
  if (result?.state !== "present") return null;
  const current = await verify(result.target);
  if (current?.identity !== row.identity) return null;
  if (isRecyclePath(current.path)) return { ...history, status: "missing", recycled: true };
  return { path: current.path, name: win32.basename(current.path), status: "present" };
}

module.exports = { isRecyclePath, historicalLocation, resolveRememberedFile };
