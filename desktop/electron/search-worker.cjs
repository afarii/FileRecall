"use strict";

// All synchronous SQLite reads run on a dedicated Node worker. The UI and
// Electron IPC event loop stay responsive during expensive short queries.
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { performance } = require("node:perf_hooks");
const { FileIndex } = require("./indexer.cjs");
const { NtfsCatalog, fullPath } = require("./ntfs-catalog.cjs");
const { DownloadSources } = require("./download-sources.cjs");
const { MotwMemory } = require("./motw-memory.cjs");
const { existsSync } = require("node:fs");
const { mergeFileSearch } = require("./unified-search.cjs");
const { compareFiles } = require("./search-relevance.cjs");

let local;
let ntfs;
let downloads;
let motw;
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
      downloads?.close();
      motw?.close();
      local = undefined;
      ntfs = undefined;
      downloads = undefined;
      motw = undefined;
      files = [];
    } else if (kind === "local") {
      files = localReader().search(query);
    } else if (kind === "smart-sources") {
      files=[];
      if(workerData.motwDatabase && existsSync(workerData.motwDatabase)){
        motw ??= new MotwMemory(workerData.motwDatabase,{readOnly:true});
        files.push(...motw.smartCandidates(query));
      }
      if(workerData.downloadsDatabase && existsSync(workerData.downloadsDatabase)){
        downloads ??= new DownloadSources(workerData.downloadsDatabase,{readOnly:true});
        files.push(...downloads.smartCandidates(query));
      }
    } else if (kind === "downloads") {
      if (!workerData.downloadsDatabase || !existsSync(workerData.downloadsDatabase)) {
        files = [];
      } else {
        downloads ??= new DownloadSources(workerData.downloadsDatabase, { readOnly: true });
        files = downloads.search(query).slice(0, 80);
      }
      if (workerData.motwDatabase && existsSync(workerData.motwDatabase)) {
        motw ??= new MotwMemory(workerData.motwDatabase, { readOnly: true });
        files = [...motw.search(query), ...files];
      }
    } else if (kind === "smart-context") {
      const catalog=ntfsReader();
      files=catalog?(drives||[]).flatMap(({drive,cached})=>catalog.smartContext(drive,query).map(row=>({
        type:"ntfs",file:{id:row.id,drive,name:row.name,path:fullPath(row),directory:false,cached,
          favorite:row.favorite||0,useCount:row.useCount||0,lastUsedAt:row.lastUsedAt||0}
      }))):[];
    } else if (kind === "unified" || kind === "unified-deep") {
      const list = Array.isArray(drives) ? drives : [];
      const source = localReader();
      const indexedDrives = new Set(list.map(({ drive }) => drive));
      const hasUncoveredRoots = source.roots().some(({ path }) => {
        const volume = /^([a-z]):[\\/]/i.exec(path)?.[1]?.toUpperCase();
        return !volume || !indexedDrives.has(volume);
      });
      // The legacy filename engine is now a compatibility fallback only.
      // On NTFS-only installs, query note/history/text metadata plus point
      // lookups for MFT hits; never perform a second full filename search.
      const metadata = favoritesOnly ? source.searchFavorites(query)
        : list.length && !hasUncoveredRoots ? source.searchAuxiliary(query)
          : source.search(query);
      const catalog = ntfsReader();
      const matches = catalog ? list.flatMap(({ drive, cached }) => {
        const rows = !query.trim()
          ? favoritesOnly ? catalog.favorites(drive) : catalog.recent(drive)
          : catalog.search(drive, query, { fastOnly: kind === "unified" });
        return rows.map((row) => ({
          id: row.id, drive, name: row.name, path: fullPath(row),
          directory: Boolean(row.isDirectory), cached,
          favorite: row.favorite || 0, useCount: row.useCount || 0,
          lastUsedAt: row.lastUsedAt || 0, matchScore: row.matchScore || 0,
        }));
      }) : [];
      // Attach source evidence and annotations by path without querying
      // the legacy filename index. Preserve old identity-verified paths.
      const metadataByPath = new Map(metadata.map((file) =>
        [String(file.currentPath || file.path).toLowerCase(), file]));
      for (const file of matches) {
        const key = file.path.toLowerCase();
        if (metadataByPath.has(key)) continue;
        const details = source.metadataAtPath(file.path);
        if (details) {
          metadataByPath.set(key, details);
        }
      }
      files = mergeFileSearch({
        query, favoritesOnly: Boolean(favoritesOnly),
        localFiles: [...metadataByPath.values()], ntfsFiles: matches, drives: list,
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
      files.sort(compareFiles);
      files = files.slice(0, 100);
    } else {
      throw new Error("未知搜索类型");
    }
    parentPort.postMessage({ id, files, elapsedMs: performance.now() - started });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error.message || error) });
  }
});
