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

const { queryTerms, termGroups, termCondition } = require("./query-terms.cjs");

module.exports = { nameSearchKeys, queryTerms, termGroups, termCondition };
