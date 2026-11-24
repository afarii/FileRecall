"use strict";

// All synchronous SQLite reads run on a dedicated Node worker. The UI and
// Electron IPC event loop stay responsive during expensive short queries.
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { performance } = require("node:perf_hooks");
const { FileIndex } = require("./indexer.cjs");
const { NtfsCatalog, fullPath } = require("./ntfs-catalog.cjs");
const { mergeFileSearch } = require("./unified-search.cjs");

let local;
let ntfs;
function localReader() {
  if (!local) {
    const reader = Object.create(FileIndex.prototype);
    reader.db = new DatabaseSync(workerData.localDatabase, { readOnly: true });
    local = reader;
  }
  return local;
}
function ntfsReader() {
  if (!workerData.ntfsDatabase) return null;
  if (!ntfs) {
    const reader = Object.create(NtfsCatalog.prototype);
    reader.db = new DatabaseSync(workerData.ntfsDatabase, { readOnly: true });
    reader.applicationData = workerData.applicationData.toLowerCase();
    ntfs = reader;
  }
  return ntfs;
}

parentPort.on("message", ({ id, kind, query, drives, favoritesOnly }) => {
  const started = performance.now();
  try {
    let files;
    if (kind === "shutdown") {
      local?.db.close();
      ntfs?.db.close();
      local = undefined;
      ntfs = undefined;
      files = [];
    } else if (kind === "local") {
      files = localReader().search(query);
    } else if (kind === "unified") {
      const list = Array.isArray(drives) ? drives : [];
      const metadata = favoritesOnly
        ? localReader().searchFavorites(query)
        : localReader().search(query);
      const catalog = ntfsReader();
      const matches = catalog ? list.flatMap(({ drive, cached }) => {
        const rows = !query.trim() && favoritesOnly
          ? catalog.favorites(drive)
          : query.trim() ? catalog.search(drive, query, { fastOnly: true }) : [];
        return rows.map((row) => ({
          id: row.id, drive, name: row.name, path: fullPath(row),
          directory: Boolean(row.isDirectory), cached,
          favorite: row.favorite || 0, useCount: row.useCount || 0,
          lastUsedAt: row.lastUsedAt || 0, matchScore: row.matchScore || 0,
        }));
      }) : [];
      files = mergeFileSearch({
        query, favoritesOnly: Boolean(favoritesOnly),
        localFiles: metadata, ntfsFiles: matches, drives: list,
      });
    } else if (kind === "ntfs" || kind === "ntfs-deep") {
      const catalog = ntfsReader();
      files = catalog ? (drives || []).flatMap(({ drive, cached }) =>
        catalog.search(drive, query, { fastOnly: kind === "ntfs" }).map((row) => ({
          id: row.id, drive, name: row.name, path: fullPath(row),
          directory: Boolean(row.isDirectory), cached,
          useCount: row.useCount || 0, lastUsedAt: row.lastUsedAt || 0,
          matchScore: row.matchScore || 0,
          favorite: row.favorite || 0,
        }))) : [];
      files.sort((a, b) => b.matchScore - a.matchScore ||
        b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path));
      files = files.slice(0, 100);
    } else {
      throw new Error("未知搜索类型");
    }
    parentPort.postMessage({ id, files, elapsedMs: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error.message || error) });
  }
});
