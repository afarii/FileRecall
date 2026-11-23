"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { assets, validAsset } = require("./semantic-model.cjs");

const maxDocuments = 500;
const minSimilarity = 0.84;
const cache = new Map();
let engine;

async function loadEngine() {
  const { modelPath } = workerData;
  const valid = await Promise.all(assets.map(([name, size, digest]) => validAsset(join(modelPath, name), size, digest)));
  if (!valid.every(Boolean)) throw new Error("本地模型校验失败，请重新下载。");
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const ort = require("onnxruntime-node");
  const [tokenizerFile, config] = await Promise.all(["tokenizer.json", "tokenizer_config.json"].map(async (file) =>
    JSON.parse(await readFile(join(modelPath, file), "utf8"))));
  const tokenizer = new Tokenizer(tokenizerFile, config);
  const session = await ort.InferenceSession.create(join(modelPath, "model_quantized.onnx"), {
    executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
  });
  return async (text) => {
    const { ids, attention_mask: mask, token_type_ids: tokenTypes } = tokenizer.encode(text);
    const length = Math.min(320, ids.length);
    const tensor = (values) => new ort.Tensor("int64", BigInt64Array.from(values.slice(0, length), BigInt), [1, length]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(mask ?? Array(ids.length).fill(1)) };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = tensor(tokenTypes ?? Array(ids.length).fill(0));
    const result = await session.run(feeds);
    const output = result.last_hidden_state ?? result[session.outputNames[0]];
    const dimension = output.dims.at(-1);
    const vector = new Float32Array(dimension);
    let normSquared = 0;
    for (let column = 0; column < dimension; column++) {
      for (let row = 0; row < length; row++) {
        if (!mask || mask[row]) vector[column] += output.data[row * dimension + column];
      }
      normSquared += vector[column] ** 2;
    }
    if (normSquared > 0) {
      const norm = Math.sqrt(normSquared);
      for (let column = 0; column < dimension; column++) vector[column] /= norm;
    }
    return vector;
  };
}

function passages(text) {
  const chars = Array.from(text);
  if (chars.length <= 500) return [text];
  const last = chars.length - 500;
  const offsets = new Set([0, Math.floor(last / 2), last]);
  return [...offsets].map((offset) => chars.slice(offset, offset + 500).join(""));
}

function similarity(left, right) {
  let score = 0;
  for (let i = 0; i < left.length; i++) score += left[i] * right[i];
  return score;
}

async function search(query) {
  const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 3000");
  try {
    const rows = db.prepare(`
      SELECT file_text.path, signature, name FROM file_text JOIN files ON files.path = file_text.path
      WHERE content <> '' ORDER BY files.last_seen_at DESC, file_text.path LIMIT ?
    `).all(maxDocuments + 1);
    const truncated = rows.length > maxDocuments;
    if (truncated) rows.pop();
    const paths = new Set(rows.map((row) => row.path));
    for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
    if (!rows.length) return { matches: [], indexed: 0, truncated };
    engine ??= await loadEngine();
    const queryVector = await engine("query: " + query);
    const content = db.prepare("SELECT content FROM file_text WHERE path = ? AND signature = ?");
    const matches = [];
    let indexed = 0;
    for (const row of rows) {
      let entry = cache.get(row.path);
      if (entry?.signature !== row.signature) {
        const document = content.get(row.path, row.signature);
        if (!document) continue;
        const vectors = [];
        for (const passage of passages(document.content)) {
          vectors.push(await engine(`passage: ${row.name}\n${passage}`));
        }
        entry = { signature: row.signature, vectors };
        cache.set(row.path, entry);
      }
      const score = Math.max(...entry.vectors.map((vector) => similarity(queryVector, vector)));
      if (score >= minSimilarity) matches.push({ path: row.path, signature: row.signature, score });
      indexed++;
      if (indexed % 10 === 0 || indexed === rows.length) {
        parentPort.postMessage({ progress: { done: indexed, total: rows.length } });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return { matches: matches.slice(0, 8), indexed, truncated };
  } finally {
    db.close();
  }
}

parentPort.on("message", async (query) => {
  try { parentPort.postMessage({ result: await search(query) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
