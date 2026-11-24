import { useEffect, useState } from "react";

// Indexing runs automatically. Only an actionable connection problem appears
// on the search screen; routine disk state is intentionally hidden.
export default function NtfsQuickResults({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<NtfsStatus>();
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const unsubscribe = window.fileRecall.onNtfsChanged((value) => {
      if (active) setStatus(value);
    });
    void window.fileRecall.ntfsStatus().then((value) => {
      if (active) setStatus(value);
    }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [enabled]);

  if (!enabled) return null;
  const needsHelp = status?.autoPhase === "permission-required" || status?.autoPhase === "error";
  const paused = status?.drives.filter(({ phase }) => String(phase) === "paused") ?? [];
  if (!needsHelp && !paused.length) return null;

  async function recover() {
    setReconnecting(true);
    try {
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
