"use strict";
const { win32 } = require("node:path");

const keyOf = (file) => String(file.currentPath || file.path).replaceAll("/", "\\").toLowerCase();
const driveOf = (path) => /^([a-z]):\\/i.exec(path)?.[1]?.toUpperCase() ?? null;

function mergeFileSearch({ query, favoritesOnly = false, localFiles = [], ntfsFiles = [], drives = [] }) {
  const indexed = new Set(drives.map(({ drive }) => drive));
  const byPath = new Map();
  // Preserve metadata, provenance and historical records from the old database.
  // Current NTFS filenames come exclusively from the authoritative MFT catalog.
  for (const file of localFiles) {
    const path = keyOf(file);
    const drive = driveOf(path);
    const covered = drive && indexed.has(drive);
    if (favoritesOnly && !file.favorite) continue;
    const metadataMatch = file.textMatched || file.annotationMatched;
    if (covered && file.status === "present" && query.trim() && !metadataMatch && !file.favorite) continue;
    byPath.set(path, { type: "local", file });
  }

  for (const file of ntfsFiles) {
    const key = keyOf(file);
    const previous = byPath.get(key);
    if (favoritesOnly && !file.favorite && !(previous?.file?.favorite)) continue;
    if (previous && previous.type === "local" && previous.file.status === "present") {
      // Reuse existing identity-backed details (source, notes, status).
      previous.file.matchScore = file.matchScore;
      previous.file.useCount = Math.max(previous.file.useCount || 0, file.useCount || 0);
      previous.file.favorite = Number(Boolean(previous.file.favorite || file.favorite));
    } else {
      byPath.set(key, { type: "ntfs", file });
    }
  }
  const results = [...byPath.values()];
  results.sort((a, b) => {
    const score = (row) => row.file.matchScore ?? 0;
    return score(b) - score(a) ||
      Number(Boolean(b.file.favorite)) - Number(Boolean(a.file.favorite)) ||
      (b.file.useCount || 0) - (a.file.useCount || 0) ||
      a.file.name.localeCompare(b.file.name);
  });
  return results.slice(0, 300);
}
module.exports = { mergeFileSearch };
