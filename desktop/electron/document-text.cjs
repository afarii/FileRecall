"use strict";

const yauzl = require("yauzl");
const { SaxesParser } = require("saxes");

const maxCharacters = 128 * 1024;
const maxWordXml = 4 * 1024 * 1024;
const wordNamespaces = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

function wordXml(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let found = false;
      zip.on("error", reject);
      zip.on("end", () => { if (!found) resolve(""); });
      zip.on("entry", (entry) => {
        if (entry.fileName !== "word/document.xml") return zip.readEntry();
        found = true;
        if (entry.uncompressedSize > maxWordXml) {
          zip.close();
          return resolve("");
        }
        zip.openReadStream(entry, async (openError, stream) => {
          try {
            if (openError) throw openError;
            const chunks = [];
            let amount = 0;
            for await (const chunk of stream) {
              amount += chunk.length;
              if (amount > maxWordXml) throw new Error("Word 文档正文超过限制。");
              chunks.push(chunk);
            }
            resolve(Buffer.concat(chunks).toString("utf8"));
          } catch (readError) { reject(readError); }
          finally { zip.close(); }
        });
      });
      zip.readEntry();
    });
  });
}

async function readWordText(buffer) {
  const xml = await wordXml(buffer);
  if (!xml) return "";
  const parser = new SaxesParser({ xmlns: true });
  let text = "";
  let inText = false;
  const append = (value) => { if (text.length < maxCharacters) text += value.slice(0, maxCharacters - text.length); };
  parser.on("opentag", (tag) => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === "t") inText = true;
    if (tag.local === "tab") append(" ");
    if (tag.local === "br") append("\n");
  });
  parser.on("text", (value) => { if (inText) append(value); });
  parser.on("cdata", (value) => { if (inText) append(value); });
  parser.on("closetag", (tag) => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === "t") inText = false;
    if (tag.local === "p") append("\n");
  });
  parser.write(xml).close();
  return text;
}

async function readPdfText(buffer) {
  const { getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(buffer, {
    isEvalSupported: false, useWasm: false, useWorkerFetch: false, stopAtErrors: true,
  });
  let text = "";
  try {
    for (let i = 1; i <= Math.min(document.numPages, 100) && text.length < maxCharacters; i++) {
      const page = await document.getPage(i);
      const data = await page.getTextContent();
      let pageText = "";
      for (const item of data.items) {
        if (typeof item.str !== "string") continue;
        const adjacentCjk = /\p{Script=Han}$/u.test(pageText) && /^\p{Script=Han}/u.test(item.str);
        if (pageText && !adjacentCjk && !/\s$/.test(pageText) && item.str) pageText += " ";
        pageText += item.str + (item.hasEOL ? "\n" : "");
        if (pageText.length >= maxCharacters) break;
      }
      text += pageText.slice(0, maxCharacters - text.length) + "\n";
      page.cleanup();
    }
    return text.slice(0, maxCharacters);
  } finally { await document.loadingTask.destroy(); }
}

module.exports = { readPdfText, readWordText };
