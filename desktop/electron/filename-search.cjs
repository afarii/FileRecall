"use strict";

const { pinyin } = require("pinyin-pro");

// Keys are computed locally once at indexing time, never transmitted.
function nameSearchKeys(name) {
  const parts = String(name || "").match(/[\p{Script=Han}]+|[a-z0-9]+/giu) || [];
  let full = "";
  let initials = "";
  for (const part of parts) {
    if (!/^\p{Script=Han}/u.test(part)) {
      const raw = part.toLowerCase();
      full += raw;
      initials += raw;
      continue;
    }
    const syllables = pinyin(part, { toneType: "none", type: "array" })
      .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""));
    full += syllables.join("");
    initials += syllables.map((value) => value[0] || "").join("");
  }
  return { pinyin: full, initials };
}

function queryTerms(query) {
  if (typeof query !== "string") return [];
  return query.trim().toLowerCase().slice(0, 200).split(/\s+/u)
    .filter(Boolean).slice(0, 12);
}

// Repeated query words require repeated non-overlapping occurrences in a
// single representation. Never count one spelling once per phonetic alias.
function termGroups(terms) {
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return [...counts].map(([term, count]) => ({ term, count }));
}

function termCondition(columns, term, count = 1) {
  const args = [];
  const clauses = columns.map((column) => {
    if (count === 1) {
      args.push(term);
      return "instr(" + column + ", ?) > 0";
    }
    args.push(term, term.length * count);
    return "(length(" + column + ") - length(replace(" + column + ", ?, ''))) >= ?";
  });
  return { where: "(" + clauses.join(" OR ") + ")", args };
}

module.exports = { nameSearchKeys, queryTerms, termGroups, termCondition };
