"use strict";

const { lstat, open } = require("node:fs/promises");

const MAX_STREAM_BYTES = 8192;
const MAX_URL_CHARS = 2048;

function safeHttpUrl(raw) {
  if (!raw || raw.length > MAX_URL_CHARS || /[\x00-\x1f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseMotw(text) {
  if (typeof text !== "string") return null;
  let section = "";
  let zoneId = null;
  let hostUrl = null;
  let referrerUrl = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (section !== "zonetransfer") continue;
    const equal = line.indexOf("=");
    if (equal < 1) continue;
    const key = line.slice(0, equal).trim().toLowerCase();
    const value = line.slice(equal + 1).trim();
    if (key === "zoneid" && /^[0-4]$/.test(value)) zoneId = Number(value);
    if (key === "hosturl") hostUrl = safeHttpUrl(value);
    if (key === "referrerurl") referrerUrl = safeHttpUrl(value);
  }
  return zoneId === null && !hostUrl && !referrerUrl ? null : { zoneId, hostUrl, referrerUrl };
}

async function readMotw(path, { platform = process.platform, stat = lstat, openFile = open } = {}) {
  if (platform !== "win32" || typeof path !== "string" || !/^[a-z]:\\/i.test(path)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const handle = await openFile(path + ":Zone.Identifier", "r");
    try {
      const buffer = Buffer.alloc(MAX_STREAM_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_STREAM_BYTES) return null;
      const raw = buffer.subarray(0, bytesRead);
      return parseMotw(raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    // Absent or inaccessible alternate data streams are expected.
    return null;
  }
}

module.exports = { parseMotw, readMotw };
