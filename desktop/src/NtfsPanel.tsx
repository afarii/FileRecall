import { useEffect, useRef, useState } from "react";
import { FileTile } from "./FileDetails";

const phases = {
  disconnected: "等待连接",
  cached: "已恢复上次索引",
  paused: "已暂停（保留索引）",
  building: "正在建立文件名索引",
  rebuild: "等待重建",
  "catching-up": "正在补齐文件变更",
  ready: "实时索引",
  error: "暂不可用",
};

export default function NtfsPanel() {
  const api = window.fileRecall;
  const [status, setStatus] = useState<NtfsStatus>();
  const [drive, setDrive] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [matches, setMatches] = useState<NtfsResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    const stop = api.onNtfsChanged(setStatus);
    void api.ntfsStatus().then((value) => { if (active) setStatus(value); })
      .catch(() => { if (active) setError("无法读取 NTFS 索引状态。"); });
    return () => { active = false; stop(); };
  }, [api]);

  async function manage(action: () => Promise<NtfsStatus>) {
    setBusy(true);
    setError("");
    try {
      setStatus(await action());
    } catch (error) {
      setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "无法更新磁盘索引。");
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    const number = ++request.current;
    setSubmitted(query.trim());
    setSearching(true);
    setError("");
    try {
      const results = await api.searchNtfs(query);
      if (number === request.current) setMatches(results);
    } catch {
      if (number === request.current) setError("无法搜索整盘索引。");
    } finally {
      if (number === request.current) setSearching(false);
    }
  }

  async function reveal(item: NtfsResult) {
    try {
      if (await api.revealNtfs(item.drive, item.id)) return;
    } catch {
      // A move or a disconnected drive can invalidate a search result.
    }
    setError("文件已移动或无法访问。请重新搜索。");
  }

  const ready = status?.connected
    ? new Set(status.drives.filter(({ phase }) => phase === "ready" || phase === "building").map(({ drive }) => drive))
    : new Set<string>();
  const visible = matches.filter((item) => ready.has(item.drive));
  return <section className="folders-view" aria-labelledby="ntfs-heading">
    <div className="heading-row"><h1 id="ntfs-heading">NTFS 磁盘索引管理</h1></div>
    <p className="muted">文件名索引保存在本机用户目录，升级安装后直接复用；日常仅同步 NTFS 文件变更。暂停索引会保留数据，恢复后继续同步。只有索引缺失、磁盘变更或日志失效时才需要重建。</p>
    {status?.autoPhase === "discovering" && <p role="status">正在检测本地固定 NTFS 磁盘…</p>}
    {status?.autoPhase === "authorizing" && <p role="status">正在连接只读助手，可能需要 Windows 授权…</p>}
    {status?.autoMessage && <p role="status" className="muted">{status.autoMessage}</p>}
    {(status?.autoPhase === "permission-required" || status?.autoPhase === "error") &&
      <button type="button" className="secondary" disabled={busy} onClick={() => void manage(api.retryAutoNtfs)}>重试自动索引</button>}
    {!status?.available && <p role="status">{status ? "请使用 Windows 安装版启用整盘搜索。" : "正在读取状态…"}</p>}
    {status?.available && <>
      <form className="search-form" onSubmit={(event) => {
        event.preventDefault();
        void manage(() => api.enableNtfs(drive.trim().toUpperCase()));
      }}>
        <label className="search-box">
          <input aria-label="磁盘盘符" placeholder="输入本地盘符，例如 D" value={drive} maxLength={1}
            onChange={(event) => setDrive(event.target.value)} />
        </label>
        <button disabled={busy || !/^[a-z]$/i.test(drive.trim())}>手动添加磁盘</button>
        {!status.connected && status.drives.length > 0 &&
          <button type="button" className="secondary" disabled={busy}
            onClick={() => void manage(api.connectNtfs)}>重新连接助手</button>}
      </form>
      {status.drives.map((item) => <div className="folder-row" key={item.drive}>
        <div><strong>{item.drive}:\</strong> <span className="muted" role="status">{phases[item.phase]}</span>
          {item.message && <p className={item.phase === "error" ? "error" : "muted"}>{item.message}</p>}
        </div>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => void manage(() => String(item.phase) === "paused"
            ? api.enableNtfs(item.drive) : api.disableNtfs(item.drive))}>
          {String(item.phase) === "paused" ? "恢复索引" : "暂停索引（保留数据）"}</button>
      </div>)}
      {busy && <p className="muted" role="status">正在连接或更新设置…</p>}
      {ready.size > 0 && <form className="search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label className="search-box">
          <input type="search" aria-label="搜索整盘索引" placeholder="文件名或部分路径" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button disabled={searching || !query.trim()}>搜索</button>
      </form>}
      {searching && <p role="status">正在查找…</p>}
      {ready.size > 0 && submitted && !searching && visible.length === 0 && <p className="empty">没有找到匹配的文件。</p>}
      {visible.map((item) => <button type="button" key={item.drive + item.id} className="result-row" onClick={() => void reveal(item)}>
        <FileTile name={item.name} /><span className="result-copy"><strong>{item.name}</strong>
          <span title={item.path}>{item.path}</span></span>
        <span className="badge">{item.directory ? "文件夹" : "定位"}</span>
      </button>)}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
