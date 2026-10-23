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
        if (existing.source.reason !== "creation_event_unavailable") return existing;

        // A delta can arrive before creation. Fill missing facts without reverting it.
        const merged = { ...initial, updatedAt };
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
