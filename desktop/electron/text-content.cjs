"use strict";

const fs = require("node:fs/promises");
const { extname, isAbsolute, relative, sep } = require("node:path");

const maxBytes = 128 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function canIndexText(path, size) {
  const extension = extname(path).toLowerCase();
  return (extension === ".txt" || extension === ".md") && size <= BigInt(maxBytes);
}

function textSignature(info) {
  return [info.dev, info.ino, info.birthtimeNs, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function readText(path, root, signature) {
  const realPath = await fs.realpath(path);
  const scope = relative(root, realPath);
  if (!scope || isAbsolute(scope) || scope === ".." || scope.startsWith(".." + sep)) return null;
  const handle = await fs.open(realPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || textSignature(before) !== signature) return null;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== Number(before.size) || textSignature(after) !== signature) return null;
    try {
      const text = utf8.decode(buffer.subarray(0, offset));
      return text.includes("\0") ? "" : text.toLowerCase();
    } catch {
      return "";
    }
  } finally {
    await handle.close();
  }
}

module.exports = { canIndexText, textSignature, readText };
