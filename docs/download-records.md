# DownloadRecord (Issue #11)

Each download is saved under `download:<id>` in `chrome.storage.local`.

```js
{
  id: 7,
  url: "https://example.com/file.zip",
  referrer: "https://example.com/",
  startTime: "2026-10-22T12:00:00.000Z",
  filename: "C:/Downloads/file.zip",
  state: "complete", // in_progress | complete | interrupted
  source: {
    status: "matched", // matched | candidate | unknown
    reason: "link_and_page",
    evidence: { linkMatch: "exact", pageMatch: "exact" },
    candidateCount: 1,
    delayMs: 5490,
    context: { /* confirmed click snapshot, only for matched */ },
    candidate: null // unconfirmed click snapshot, only for candidate
  },
  updatedAt: "2026-10-22T12:00:06.000Z"
}
```

The top-level facts come from download events. `source` comes from the existing
matching rules. A candidate always has `context: null`; lifecycle updates never
promote it. The separate, current-tab title lookup remains a Console observation
and does not overwrite a stored click snapshot or establish confirmed provenance.

The service worker is the only record writer. One Promise queue serializes each
complete storage read, merge, and write. Separate keys prevent one download from
replacing another. Rejected operations are reported with the download ID and cause;
they do not block subsequent operations. Duplicate creation keeps the existing
record. If a delta arrives first, a partial record contains null for missing facts;
later creation fills them without reverting the newer filename or state.

Each update reads storage again, so a restarted worker can update existing history.
Only writes that have completed are durable; this queue is not a disk transaction
or a retry journal. Forced termination during a write may lose that update. Events
missed while the extension is disabled are not backfilled. Local storage has a
quota, and removing the extension clears its local data. No automatic deletion or
migration is implemented. The recent-click queue stays in memory and is not saved.

## Automated tests

```powershell
node --test context-matcher.test.mjs download-record-store.test.mjs background.test.mjs
```

## Real Chrome checks

1. Reload FileRecall at `chrome://extensions`, check its storage permission, and
   refresh the test pages. Open the extension service worker DevTools.
2. Download from testfile.cc. In the worker Console, use the observed download ID:
   `await chrome.storage.local.get("download:7")`. Check the browser facts and
   `source` evidence; a unique strong match has a confirmed `source.context`.
3. Download using the VS Code button. When the matcher returns `candidate`, verify
   `source.context === null` and `source.candidate.linkUrl === null`. A completed
   download must remain a candidate rather than become a confirmed source.
4. Download two files concurrently, including a sufficiently large one. Cancel
   one in Chrome's download UI. Re-read both IDs: filename updates and complete or
   interrupted states must be saved without replacing either record.
5. Reload the extension, then re-read those keys. Restart Chrome normally using
   the same profile and extension installation, reopen the worker DevTools, and
   check the keys again. Do not uninstall/reinstall as a restart test.
6. Storage failures are tested with rejected reads and writes in the Node suite.
   In Chrome, any actual failure must show `Download record creation failed` or
   `Download record update failed`, followed by the ID and underlying cause.

Read all records without relying on Console history:

```js
const data = await chrome.storage.local.get(null);
console.table(Object.entries(data)
  .filter(([key]) => key.startsWith("download:"))
  .map(([, record]) => ({
    id: record.id, filename: record.filename,
    state: record.state, sourceStatus: record.source.status
  })));
```
