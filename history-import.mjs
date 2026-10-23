// Each user request writes at most 100 records. Overlap the timestamp boundary
// because Chrome's time cursor alone would omit downloads with equal start times.
export const IMPORT_BATCH_SIZE = 100;
const MAX_BOUNDARY_IDS = 900;

export async function importHistoryBatch(downloads, store, cursor = null) {
  if (cursor !== null && (!Number.isFinite(cursor.time) || !Number.isFinite(new Date(cursor.time + 1).getTime()) || !Array.isArray(cursor.ids)
    || cursor.ids.length > MAX_BOUNDARY_IDS || cursor.ids.some((id) => !Number.isSafeInteger(id) || id < 0))) {
    throw new Error("导入分页信息无效或同一时间的记录过多，请重新导入；已有记录不会丢失。");
  }
  const seen = new Set(cursor?.ids ?? []);
  const query = { orderBy: ["-startTime", "-id"], limit: IMPORT_BATCH_SIZE + seen.size + 1 };
  if (cursor) query.startedBefore = new Date(cursor.time + 1).toISOString();
  const records = await downloads.search(query);
  if (!Array.isArray(records)) throw new Error("Chrome 返回的下载历史格式无效。");
  const remaining = records.filter((record) => !seen.has(record?.id));
  const batch = remaining.slice(0, IMPORT_BATCH_SIZE);
  // Reject unusable pagination data before writing, rather than silently skipping history.
  if (batch.some((record) => !Number.isSafeInteger(record?.id) || record.id < 0
    || typeof record.startTime !== "string" || !Number.isFinite(Date.parse(record.startTime)))) {
    throw new Error("Chrome 下载历史包含无效 ID 或时间，已停止本批导入；已有记录保持不变。");
  }
  const result = { added: 0, skipped: 0, failed: 0, errors: [], hasMore: remaining.length > batch.length, cursor: null };
  if (batch.length && result.hasMore) {
    const time = Date.parse(batch.at(-1).startTime);
    const ids = batch.filter((record) => Date.parse(record.startTime) === time).map((record) => record.id);
    result.cursor = { time, ids: [...new Set([...(time === cursor?.time ? seen : []), ...ids])] };
    if (result.cursor.ids.length > MAX_BOUNDARY_IDS) {
      throw new Error("同一时间的下载记录过多，无法继续分页；本批未写入，之前导入的记录保持不变。");
    }
  }
  for (const record of batch) {
    try {
      if (await store.import(record)) result.added++;
      else result.skipped++;
    } catch (error) {
      result.failed++;
      if (result.errors.length < 3) result.errors.push(`下载 ${record.id}：${error?.message ?? "保存失败"}`);
    }
  }
  return result;
}
