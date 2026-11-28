import { useEffect, useState } from "react";

export default function SourceMemoryPanel() {
  const [state, setState] = useState<SourceMemorySettings>();
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => void window.fileRecall.sourceSettings().then(value => {
      if (active) setState(value);
    }).catch(() => { if (active) setError("无法读取来源设置。"); });
    refresh();
    const unsubscribe = window.fileRecall.onDownloadsChanged(refresh);
    return () => { active = false; unsubscribe(); };
  }, []);
  async function change(clear = false) {
    if (!state?.available) return;
    setBusy(true); setError("");
    try {
      const next = clear ? await window.fileRecall.clearSources() : await window.fileRecall.setSourceEnabled(!state.enabled);
      setState(next);
      setConfirmClear(false);
    } catch { setError("来源记忆设置更新失败。"); }
    finally { setBusy(false); }
  }
  return <details className="chrome-connection">
    <summary>文件来源记忆</summary>
    <p className="muted">在本机记录 Windows 文件来源。新文件自动采集，并低速补查下载、文档和桌面目录。</p>
    <p>{state?.available ? `已保存 ${state.count} 条来源 · ${state.enabled ? "自动采集已开启" : "已暂停采集"}` : "来源记忆暂不可用"}</p>
    <div className="actions">
      <button className="secondary" disabled={busy || !state?.available} onClick={() => void change()}>{state?.enabled ? "暂停采集" : "开启采集"}</button>
      <button className="secondary" disabled={busy || !state?.available} onClick={() => setConfirmClear(true)}>清除 Windows 来源记忆</button>
    </div>
    {confirmClear && <div>
      <p>清除已保存的 Windows 来源并暂停采集。磁盘文件、浏览器下载历史和收藏会保留。已清除的文件身份不会再次自动记录。</p>
      <div className="actions"><button disabled={busy} onClick={() => void change(true)}>确认清除</button>
      <button className="secondary" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </details>;
}
