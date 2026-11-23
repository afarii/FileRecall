import { useEffect, useState } from "react";
import { FileTile } from "./FileDetails";
import MotwInfo from "./MotwInfo";

export default function NtfsQuickResults({ query, enabled, existingPaths, onCount, onSelect }: {
  query: string; enabled: boolean; existingPaths: string[];
  onCount: (count: number) => void; onSelect: () => void;
}) {
  const [status, setStatus] = useState<NtfsStatus>();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ query: string; files: NtfsResult[] }>();
  const [selected, setSelected] = useState<NtfsResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const unsubscribe = window.fileRecall.onNtfsChanged((value) => {
      setStatus(value);
      setRevision((prior) => prior + 1);
    });
    void window.fileRecall.ntfsStatus().then((value) => {
      if (active) { setStatus(value); setRevision((prior) => prior + 1); }
    }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    let active = true;
    if (!enabled || !query.trim()) {
      setResult({ query, files: [] });
      return;
    }
    const timer = window.setTimeout(() => {
      void window.fileRecall.searchNtfs(query).then((files) => {
        if (active) setResult({ query, files });
      }).catch(() => { if (active) setResult({ query, files: [] }); });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, enabled, revision]);
  const local = new Set(existingPaths.map((path) => path.toLowerCase()));
  const matches = enabled && result?.query === query
    ? result.files.filter((item) => !local.has(item.path.toLowerCase())) : [];
  useEffect(() => { onCount(matches.length); }, [matches.length, onCount]);
  async function reveal(item: NtfsResult) {
    setError("");
    try {
      if (!await window.fileRecall.revealNtfs(item.drive, item.id)) setError("文件已移动或无法访问，请重新搜索。");
    } catch { setError("无法定位此文件。"); }
  }
  if (!enabled || !query.trim()) return null;
  const building = status?.drives.some((entry) => entry.phase === "building");
  return <>
    {building && <p className="muted" role="status">正在后台建立整盘索引；已扫描的文件可以先搜索，完成后自动显示更多结果…</p>}
    {status?.autoPhase === "permission-required" && <p className="muted" role="status">整盘索引需要 Windows 授权，可在「磁盘索引」重试。</p>}
    {matches.length > 0 && <section className="results-group" aria-label="整盘文件结果">
      <h2>整盘文件 <span>{matches.length} 条</span></h2>
      {matches.map((item) => <button type="button" className="result-row" key={item.drive + item.id}
        aria-expanded={selected?.drive === item.drive && selected?.id === item.id}
        onClick={() => { setSelected(item); onSelect(); }}>
        <FileTile name={item.name} />
        <span className="result-copy"><strong>{item.name}</strong><span title={item.path}>{item.path}</span></span>
        <span className="badge">{item.cached ? "索引缓存" : item.directory ? "文件夹" : "整盘索引"}</span>
      </button>)}
      {selected && matches.some((item) => item.drive === selected.drive && item.id === selected.id) &&
        <section className="source-candidate" aria-label="整盘文件详情">
          <strong>{selected.name}</strong><p>{selected.path}</p>
          {selected.cached ? <p className="muted">缓存记录待连接 NTFS 助手核验，重连后可定位文件。</p>
            : <button type="button" onClick={() => void reveal(selected)}>在文件夹中显示</button>}
          {!selected.directory && !selected.cached && <MotwInfo drive={selected.drive} fileId={selected.id} />}
        </section>}
    </section>}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
