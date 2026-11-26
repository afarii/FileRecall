"use strict";
const { prepareQuery, scoreFile, compareFiles } = require("./search-relevance.cjs");

const keyOf = (file) => String(file.currentPath || file.path).replaceAll("/", "\\").toLowerCase();
const driveOf = (path) => /^([a-z]):\\/i.exec(path)?.[1]?.toUpperCase() ?? null;

function mergeFileSearch({ query, favoritesOnly = false, localFiles = [], ntfsFiles = [], drives = [] }) {
  const indexed = new Set(drives.map(({ drive }) => drive));
  const byPath = new Map();
  const localByPath = new Map(localFiles.map((file) => [keyOf(file), file]));
  // Preserve metadata, provenance and historical records from the old database.
  // Current NTFS filenames come exclusively from the authoritative MFT catalog.
  for (const file of localFiles) {
    const path = keyOf(file);
    const drive = driveOf(path);
    const covered = drive && indexed.has(drive);
    if (favoritesOnly && !file.favorite) continue;
    if (!query.trim() && !favoritesOnly && !file.favorite && !(file.useCount > 0)) continue;
    const metadataMatch = file.textMatched || file.annotationMatched;
    if (covered && file.status === "present" && query.trim() && !metadataMatch && !file.favorite) continue;
    byPath.set(path, { type: "local", file });
  }

  for (const file of ntfsFiles) {
    const key = keyOf(file);
    const metadata = localByPath.get(key);
    if (favoritesOnly && !file.favorite && !metadata?.favorite) continue;
    if (metadata && metadata.status === "present") {
      // Reuse existing identity-backed details (source, notes, status).
      // The NTFS record supplies the authoritative filename and ranking.
      byPath.set(key, { type: "local", file: {
        ...metadata, name: file.name, // Preserve original metadata path for identity-backed provenance.
        matchScore: file.matchScore,
        useCount: Math.max(metadata.useCount || 0, file.useCount || 0),
        favorite: Number(Boolean(metadata.favorite || file.favorite)),
      } });
    } else {
      byPath.set(key, { type: "ntfs", file });
    }
  }
  const prepared = prepareQuery(query);
  const results = [...byPath.values()];
  if (prepared.terms.length) {
    for (const record of results) {
      if (record.type === "local" && !Number.isFinite(record.file.matchScore)) {
        record.file = { ...record.file, matchScore: scoreFile(record.file, prepared) };
      }
    }
  }
  results.sort((a, b) => compareFiles(a.file, b.file));
  return results.slice(0, 300);
}
module.exports = { mergeFileSearch };
