import { useEffect, useState } from "react";

// Keep disk search asynchronous and report candidates to the unified result list.
export default function NtfsQuickResults({ query, enabled, onResults }: {
  query: string; enabled: boolean;
  onResults: (result: { query: string; files: NtfsResult[] }) => void;
}) {
  const [status, setStatus] = useState<NtfsStatus>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let refreshTimer: number | undefined;
    const unsubscribe = window.fileRecall.onNtfsChanged((value) => {
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
    if (!enabled || !query.trim()) {
      onResults({ query, files: [] });
      return;
    }
    // Retain the previous matching rows during incremental NTFS status refreshes.
    const timer = window.setTimeout(() => {
      void window.fileRecall.searchNtfs(query).then((files) => {
        if (active) onResults({ query, files });
      }).catch(() => { if (active) onResults({ query, files: [] }); });
    }, 70);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, enabled, revision, onResults]);

  if (!enabled || !query.trim()) return null;
  const building = status?.drives.some(({ phase }) => phase === "building");
  return <div className="search-index-hint" role="status">
    {building && <span>磁盘索引仍在后台建立，搜索结果会逐步补充。</span>}
    {status?.autoPhase === "permission-required" && <span>磁盘索引等待授权，可在设置中重新连接。</span>}
  </div>;
}
