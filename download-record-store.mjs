export const DOWNLOAD_RECORD_PREFIX = "download:";

const FACT_FIELDS = ["url", "referrer", "startTime", "filename", "state"];

function recordSource(association) {
  const status = association?.status;
  const valid = status === "unknown"
    || (status === "matched" && association.context != null)
    || (status === "candidate" && association.candidate != null);

  return {
    status: valid ? status : "unknown",
    reason: valid ? association.reason ?? "unspecified" : association ? "invalid_association" : "creation_event_unavailable",
    evidence: valid ? structuredClone(association.evidence ?? null) : null,
    candidateCount: valid ? association.candidateCount ?? 0 : 0,
    delayMs: valid ? association.delayMs ?? null : null,
    context: valid && status === "matched" ? structuredClone(association.context) : null,
    candidate: valid && status === "candidate" ? structuredClone(association.candidate) : null,
  };
}

export function createDownloadRecord(download, association, updatedAt) {
  const record = { id: download.id };
  for (const field of FACT_FIELDS) record[field] = download[field] ?? null;
  return { ...record, source: recordSource(association), updatedAt };
}

export function createDownloadRecordStore(storage, now = () => new Date().toISOString()) {
  let pending = Promise.resolve();

  function write(id, change) {
    const result = pending.then(async () => {
      try {
        const key = `${DOWNLOAD_RECORD_PREFIX}${id}`;
        const values = await storage.get(key);
        const existing = values[key];
        const record = change(existing, now(), Object.hasOwn(values, key));
        if (record !== existing) await storage.set({ [key]: record });
        return record;
      } catch (error) {
        throw new Error(`Could not persist download ${id}: ${error?.message ?? String(error)}`, { cause: error });
      }
    });
    // A failed operation still rejects for its caller, but must not block later writes.
    pending = result.catch(() => {});
    return result;
  }

  return {
    annotate(id, change) {
      if (!Number.isSafeInteger(id) || id < 0) return Promise.reject(new Error("下载 ID 无效。"));
      const patch = structuredClone(change);
      return write(id, (existing, updatedAt) => {
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("下载记录已丢失，无法保存标注。");
        const candidate = existing.source?.status === "candidate" && existing.source.candidate;
        let userSource;
        switch (patch?.kind) {
          case "confirm":
          case "reject":
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("当前记录没有可操作的候选来源。");
            userSource = { type: patch.kind === "confirm" ? "confirmed_candidate" : "rejected_candidate",
              context: structuredClone(candidate), updatedAt };
            break;
          case "manual": {
            const source = existing.source;
            const context = source?.status === "matched" ? source.context : source?.status === "candidate" ? source.candidate : null;
            const unknown = !context || typeof context !== "object" || Array.isArray(context);
            if (!unknown && !["manual", "rejected_candidate"].includes(existing.userSource?.type)) throw new Error("请先排除候选页面，再手动填写来源。");
            const title = patch.pageTitle ?? "";
            if (typeof patch.pageUrl !== "string" || patch.pageUrl.length > 2048
              || typeof title !== "string" || title.length > 300) throw new Error("页面地址或标题格式无效，或超出长度限制。");
            let url;
            try { url = new URL(patch.pageUrl.trim()); } catch { throw new Error("请输入合法的 HTTP/HTTPS 页面地址。"); }
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许 HTTP/HTTPS 页面地址。");
            userSource = { type: "manual", context: { pageUrl: url.href, pageTitle: title.trim() }, updatedAt };
            break;
          }
          case "clearSource":
            userSource = null;
            break;
          case "note":
            if (typeof patch.note !== "string" || patch.note.length > 1000) throw new Error("备注最多 1000 字。");
            return { ...existing, note: patch.note.trim(), updatedAt };
          default:
            throw new Error("未知的人工标注操作。");
        }
        return { ...existing, userSource, updatedAt };
      });
    },

    import(download) {
      if (!Number.isSafeInteger(download?.id) || download.id < 0) return Promise.reject(new Error("Invalid Chrome download ID"));
      const initial = createDownloadRecord(download, { status: "unknown", reason: "history_import" }, null);
      let added = false;
      return write(download.id, (existing, updatedAt, exists) => {
        if (exists) return existing;
        added = true;
        return { ...initial, updatedAt };
      }).then(() => added);
    },

    create(download, association) {
      // Snapshot inputs now, before the operation waits for earlier storage writes.
      const initial = createDownloadRecord(download, association, null);
      return write(download.id, (existing, updatedAt) => {
        if (!existing) return { ...initial, updatedAt };
        const importedPlaceholder = existing.source?.status === "unknown"
          && existing.source.reason === "history_import"
          && ["matched", "candidate"].includes(initial.source.status);
        if (existing.source?.reason !== "creation_event_unavailable" && !importedPlaceholder) return existing;

        // Import or a delta can precede creation. Add live evidence without
        // reverting saved facts or discarding annotations and other user data.
        const merged = { ...initial, ...existing, source: { ...existing.source, ...initial.source }, updatedAt };
        for (const field of FACT_FIELDS) merged[field] = existing[field] ?? initial[field];
        return merged;
      });
    },

    update(delta) {
      const patch = {};
      for (const field of ["filename", "state"]) {
        if (typeof delta[field]?.current === "string") patch[field] = delta[field].current;
      }
      if (Object.keys(patch).length === 0) return Promise.resolve(null);

      return write(delta.id, (existing, updatedAt) => ({
        ...(existing ?? createDownloadRecord({ id: delta.id }, null, updatedAt)),
        ...patch,
        updatedAt,
      }));
    },
  };
}
