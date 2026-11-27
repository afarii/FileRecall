import { useEffect, useState } from "react";

type SourceState = {
  identity: string | null;
  confirmed: BrowserDownload | null;
  candidates: Array<BrowserDownload & { evidence: string }>;
};

const api = () => window.fileRecall as typeof window.fileRecall & {
  ntfsProvenance: (drive: string, id: string) => Promise<SourceState>;
  decideNtfsSource: (drive: string, id: string, identity: string, downloadId: string,
    decision: "confirmed" | "undo") => Promise<SourceState>;
};

export default function NtfsSourceInfo({ drive, fileId }: { drive: string; fileId: string }) {
  const [state, setState] = useState<SourceState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setState(undefined);
    setError("");
    void api().ntfsProvenance(drive, fileId).then((result) => {
      if (active) setState(result);
    }).catch(() => { if (active) setError("无法读取文件来历。"); });
    return () => { active = false; };
  }, [drive, fileId]);

  async function decide(id: string, decision: "confirmed" | "undo") {
    if (!state?.identity) return;
    setBusy(true);
    setError("");
    try {
      setState(await api().decideNtfsSource(drive, fileId, state.identity, id, decision));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法更新文件关联。");
    } finally { setBusy(false); }
  }

  return <section className="detail-section">
    <h3>下载来源</h3>
    {state?.confirmed ? <>
      <span className="badge good">文件关联已确认</span>
      <p>{[state.confirmed.domain, state.confirmed.sourceTitle].filter(Boolean).join(" · ") || "已关联下载记录"}</p>
      <p className="muted">{state.confirmed.path}</p>
      <div className="actions">
        {state.confirmed.canOpenSource && <button onClick={() => {
          void window.fileRecall.openSource(state.confirmed!.id)
            .then((ok) => { if (!ok) setError("当前没有可打开的可信来源。"); })
            .catch(() => setError("无法打开来源。"));
        }}>打开来源 ↗</button>}
        <button className="secondary" disabled={busy} onClick={() => void decide(state.confirmed!.id, "undo")}>撤销关联</button>
      </div>
    </> : state?.identity ? <>
      {state.candidates.length ? <p className="muted">核对下载记录后，可保存关联。移动或重命名后仍可通过来源找回。</p>
        : <p className="muted">暂无匹配的下载记录。</p>}
      {state.candidates.map((candidate) => <div className="source-candidate" key={candidate.id}>
        <strong>{candidate.name}</strong> <span className="badge warn">{candidate.evidence} · 待核对</span>
        <p>{candidate.path}</p>
        <p className="muted">{[candidate.domain, candidate.sourceTitle,
          new Date(candidate.startedAt).toLocaleString()].filter(Boolean).join(" · ")}</p>
        <button disabled={busy} onClick={() => void decide(candidate.id, "confirmed")}>确认是同一文件</button>
      </div>)}
    </> : state && <p className="muted">当前无法验证文件身份，暂不建立关联。</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
