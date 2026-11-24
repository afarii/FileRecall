import { useEffect, useState } from "react";

// Keep disk search asynchronous and report candidates to the unified result list.
export default function NtfsQuickResults({ query, enabled, onResults }: {
  query: string; enabled: boolean;
  onResults: (result: { query: string; files: NtfsResult[] }) => void;
}) {
  const [status, setStatus] = useState<NtfsStatus>();
  const [revision, setRevision] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    let active = true;
    let refreshTimer: number | undefined;
    const unsubscribe = window.fileRecall.onNtfsChanged((value) => {
      // Ignore unchanged status notifications; indexing progress should not
      // keep restarting an identical query.
      setStatus(value);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => setRevision((prior) => prior + 1), 600);
    });
    void window.fileRecall.ntfsStatus().then((value) => {
      if (active) { setStatus(value); setRevision((prior) => prior + 1); }
    }).catch(() => {});
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let deepTimer: number | undefined;
    if (!enabled || !query.trim()) {
      onResults({ query, files: [] });
      return;
    }
    const api = window.fileRecall as typeof window.fileRecall & {
      searchNtfsDeep: (query: string) => Promise<NtfsResult[]>;
    };
    // The first result page uses only B-tree indexes. Deep substring scans
    // occur only for zero-hit queries and run on a separate worker.
    const timer = window.setTimeout(() => {
      void api.searchNtfs(query).then((files) => {
        if (!active) return;
        onResults({ query, files });
        const word = query.trim();
        if (!files.length && (word.length >= 4 || /\p{Script=Han}/u.test(word))) {
          deepTimer = window.setTimeout(() => {
            void api.searchNtfsDeep(query).then((deepFiles) => {
              if (active) onResults({ query, files: deepFiles });
            }).catch(() => {});
          }, 350);
        }
      }).catch(() => { if (active) onResults({ query, files: [] }); });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (deepTimer !== undefined) window.clearTimeout(deepTimer);
    };
  }, [query, enabled, revision, onResults]);

  if (!enabled || !query.trim()) return null;
  const needsHelp = status?.autoPhase === "permission-required" || status?.autoPhase === "error";
  const paused = status?.drives.filter(({ phase }) => String(phase) === "paused") ?? [];
  if (!needsHelp && !paused.length) return null;
  async function recover() {
    setReconnecting(true);
    try {
      // Normally automatic. Offer only one recovery action when the OS
      // requires user authorization or an old version left disks paused.
      for (const { drive } of paused) await window.fileRecall.enableNtfs(drive);
      if (needsHelp) await window.fileRecall.retryAutoNtfs();
    } finally { setReconnecting(false); }
  }
  return <div className="search-index-hint" role="status">
    <button type="button" className="secondary" disabled={reconnecting}
      onClick={() => void recover().catch(() => {})}>
      {reconnecting ? "正在连接…" : "恢复全盘文件搜索"}
    </button>
  </div>;
}
