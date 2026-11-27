"use strict";

const { nameSearchKeys, queryTerms } = require("./filename-search.cjs");

// Relevance depends on the query's words and the candidate, never on the
// database index or anchor that happened to retrieve it.
function prepareQuery(query) {
  return { normalized: String(query || "").trim().toLowerCase(), terms: queryTerms(query) };
}

function scoreFile(row, query) {
  const name = String(row.name || "").toLowerCase();
  const directory = Boolean(row.isDirectory || row.directory === true);
  const dot = directory ? -1 : name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const chinese = /\p{Script=Han}/u.test(stem);
  let initials = row.initials, pinyin = row.pinyin;
  if (chinese && (initials == null || pinyin == null)) {
    ({ initials, pinyin } = nameSearchKeys(stem));
  } else if (chinese && /^[a-z0-9]+$/.test(ext)) {
    if (initials?.endsWith(ext)) initials = initials.slice(0, -ext.length);
    if (pinyin?.endsWith(ext)) pinyin = pinyin.slice(0, -ext.length);
  }
  const words = stem.split(/[^\p{L}\p{N}]+/u);
  const path = String(row.path || row.directory || "").toLowerCase();
  let sum = 0, stemMatch = false, extensionMatch = false;
  for (const raw of query.terms) {
    const term = raw.replaceAll("/", "\\");
    if (term.includes("\\")) {
      sum += 350;
      stemMatch = true;
      continue;
    }
    const phonetic = /^[a-z0-9]+$/.test(term);
    const literal = stem === term ? 440 : stem.startsWith(term) ? 360
      : words.some((word) => word.startsWith(term)) ? 320 : stem.includes(term) ? 120 : 0;
    const initial = chinese && phonetic
      ? initials?.startsWith(term) ? 390 : initials?.includes(term) ? 180 : 0 : 0;
    const full = chinese && phonetic
      ? pinyin?.startsWith(term) ? 370 : pinyin?.includes(term) ? 170 : 0 : 0;
    const main = Math.max(literal, initial, full, name === term ? 500 : 0);
    // All prefixes of the same extension have identical relevance. A final
    // letter narrows the matches rather than abruptly changing the scoring.
    const suffix = term.startsWith(".") ? term.slice(1) : term;
    const extension = suffix && ext.startsWith(suffix) ? 300
      : suffix && ext.includes(suffix) ? 45 : 0;
    if (main >= extension && main > 0) stemMatch = true;
    else if (extension > 0) extensionMatch = true;
    sum += Math.max(main, extension, path.includes(term) ? 30 : 0);
  }
  let score = query.terms.length ? sum / query.terms.length : 0;
  if (stemMatch && extensionMatch && query.terms.length > 1) score += 100;
  if (name === query.normalized && query.normalized) score += 250;
  score += Math.min(900, Math.log2(1 + (Number(row.useCount) || 0)) * 220);
  if (row.favorite) score += 180;
  if (/\.(?:pdf|docx?|xlsx?|pptx?|md|txt|csv)$/i.test(name)) score += 125;
  if (directory) score -= 45;
  if (/\.(?:sys|dll|exe|mui|log)$/i.test(name)) score -= 200;
  if (/\\(?:windows|program files|program files \(x86\)|programdata)(?:\\|$)/i.test(path)) score -= 190;
  return Math.round(score);
}

function compareFiles(a, b) {
  return (b.matchScore || 0) - (a.matchScore || 0) ||
    Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    a.name.localeCompare(b.name) ||
    String(a.path || a.directory || "").localeCompare(String(b.path || b.directory || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""));
}

module.exports = { prepareQuery, scoreFile, compareFiles };
