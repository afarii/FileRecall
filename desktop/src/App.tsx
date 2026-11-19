import { useCallback, useEffect, useRef, useState } from "react";
import BrowserDownloads from "./BrowserDownloads";

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function App() {
  const [view, setView] = useState<"files" | "downloads">("files");
  const [folders, setFolders] = useState<IndexedFolder[]>([]);
  const [historyFolders, setHistoryFolders] = useState<Array<{ path: string; count: number }>>([]);
  const [clearingFolder, setClearingFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [query, setQuery] = useState("");
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const reloadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [textEnabled, setTextEnabled] = useState<boolean>();
  const [changingText, setChangingText] = useState(false);
  const [notice, setNotice] = useState("文件索引仅保存在本机。");
  const [error, setError] = useState("");

  const reload = useCallback(async (search: string) => {
    const version = ++reloadVersion.current;
    const [nextFiles, nextFolders, nextHistoryFolders] = await Promise.all([
      window.fileRecall.search(search),
      window.fileRecall.folders(),
      window.fileRecall.historyFolders(),
    ]);
    if (version !== reloadVersion.current || search !== currentQuery.current) return;
    setFiles(nextFiles);
    setFolders(nextFolders);
    setHistoryFolders(nextHistoryFolders);
  }, []);

  useEffect(() => {
    reload(query).catch((err) => setError(String(err)));
  }, [reload, query]);

  useEffect(() => window.fileRecall.onChanged(() => {
    reload(currentQuery.current).catch((err) => setError(String(err)));
  }), [reload]);

  useEffect(() => {
    window.fileRecall.textEnabled().then(setTextEnabled).catch(() => setError("无法读取正文搜索设置。"));
  }, []);

  async function changeText(enabled: boolean) {
    setChangingText(true);
    setError("");
    try {
      await window.fileRecall.setTextEnabled(enabled);
      setTextEnabled(enabled);
      setNotice(enabled ? "已开启正文搜索，授权目录会自动重扫。" : "已关闭正文搜索并清除正文索引。");
      await reload(currentQuery.current);
    } catch {
      setError("无法更新正文搜索设置，请重试。");
    } finally {
      setChangingText(false);
    }
  }

  async function perform(action: () => Promise<ScanResult | ScanResult[] | null>) {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (!result) return;
      const scans = Array.isArray(result) ? result : [result];
      const totals = scans.reduce(
        (sum, scan) => ({
          indexed: sum.indexed + (scan.indexed ?? 0),
          missing: sum.missing + (scan.missing ?? 0),
          skipped: sum.skipped + (scan.skipped ?? 0),
        }),
        { indexed: 0, missing: 0, skipped: 0 },
      );
      const problems = scans.filter((scan) => !scan.complete);
      const failures = problems.filter((scan) => scan.error);
      if (failures.length) {
        setError(failures.map((scan) => `${scan.folder}：${scan.error}`).join("\n"));
      }
      setNotice(`已索引 ${totals.indexed} 个文件；新增丢失记录 ${totals.missing} 个。` +
        (problems.length ? ` ${problems.length} 个目录扫描不完整，暂缓判定其中的文件丢失。` : ""));
      await reload(currentQuery.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string) {
    setError("");
    try {
      const result = await window.fileRecall.reveal(path);
      if (!result.ok) setError(result.message ?? "无法定位文件。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeFolder(path: string) {
    setBusy(true);
    setError("");
    try {
      await window.fileRecall.removeFolder(path);
      setNotice(`已停止索引 ${path}，历史记录仍可搜索。`);
      await reload(currentQuery.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const missingCount = files.filter((file) => file.status === "missing" && !file.currentPath).length;

  async function clearHistory() {
    if (!clearingFolder) return;
    setBusy(true);
    setError("");
    try {
      const removed = await window.fileRecall.clearHistory(clearingFolder);
      setClearingFolder(null);
      setNotice(`已清除 ${removed} 条历史记录，磁盘文件保留。`);
      await reload(currentQuery.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div><strong>FileRecall</strong><small>Desktop · v0.4 MVP</small></div>
        </div>
        <div className="section-label">文件来源</div>
        <button className={view === "files" ? "nav-item active" : "nav-item"}
          aria-pressed={view === "files"} onClick={() => setView("files")}>本地文件记忆</button>
        <button className={view === "downloads" ? "nav-item active" : "nav-item"}
          aria-pressed={view === "downloads"} onClick={() => setView("downloads")}>浏览器下载</button>
        <div hidden={view !== "files"}>
        <div className="section-label with-gap">已授权目录</div>
        {folders.length === 0 ? <p className="sidebar-note">尚未选择扫描目录</p> :
          folders.map((folder) => <div key={folder.path}>
            <div className="folder" title={folder.path}>▣ &nbsp; {folder.path}</div>
            <div className="folder-state" role="status">
              {{ waiting: "等待扫描", scanning: "正在更新索引", watching: "自动监控中", retrying: "等待自动重试" }[folder.state]}
              {folder.error && <p>{folder.error}</p>}
            </div>
            <button className="stop-indexing" disabled={busy} onClick={() => removeFolder(folder.path)} aria-label={`停止索引 ${folder.path}`}>停止索引</button>
            <button className="stop-indexing" disabled={busy} onClick={() => setClearingFolder(folder.path)} aria-label={`停止并清除历史 ${folder.path}`}>停止并清除历史</button>
          </div>)}
        {historyFolders.some((history) => !folders.some((folder) => folder.path === history.path)) &&
          <div className="section-label with-gap">已停止索引的历史</div>}
        {historyFolders.filter((history) => !folders.some((folder) => folder.path === history.path)).map((history) =>
          <div key={history.path}>
            <div className="folder" title={history.path}>{history.path}</div>
            <button className="stop-indexing" disabled={busy} onClick={() => setClearingFolder(history.path)} aria-label={`清除历史 ${history.path}`}>清除历史（{history.count} 条）</button>
          </div>)}
        </div>
        <div className="sidebar-bottom">仅扫描你主动选择的目录<br />默认不上传文件信息</div>
      </aside>
      <main>
        <header className="topbar"><span>文件记忆库</span><span className="local-label">● &nbsp; 本地存储</span></header>
        {view === "downloads" ? <BrowserDownloads /> : <div className="content">
          <div className="heading-row">
            <div><h1>找回你的文件</h1><p>即使文件已经删除，历史记录仍然保留。</p></div>
            <div className="actions">
              <button className="secondary" disabled={busy || folders.length === 0} onClick={() => perform(() => window.fileRecall.rescan())}>重新扫描</button>
              <button disabled={busy} onClick={() => perform(() => window.fileRecall.addFolder())}>+ 添加文件夹</button>
            </div>
          </div>
          <div className="search"><span>⌕</span><input aria-label="搜索本地文件"
            placeholder={textEnabled ? "搜索文件名、路径或正文…" : "搜索文件名、路径…"}
            value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          {textEnabled !== undefined && <label className="text-search-setting">
            <input type="checkbox" checked={textEnabled} disabled={changingText || busy}
              onChange={(event) => void changeText(event.target.checked)} />
            <span>搜索文件正文 <small>索引授权目录中不超过 128 KiB 的 UTF-8 TXT、Markdown。丢失文件仍可按正文搜索，关闭时清除本机正文索引。</small></span>
          </label>}
          {error && <div className="alert error" role="alert">{error}</div>}
          {clearingFolder && <div className="clear-history" role="dialog" aria-label="清除目录历史">
            <p>清除 {clearingFolder} 及其子目录的全部 FileRecall 历史，并停止这些目录的索引。磁盘文件保留。</p>
            <button disabled={busy} onClick={clearHistory}>确认清除历史</button>
            <button className="secondary" disabled={busy} onClick={() => setClearingFolder(null)}>取消</button>
          </div>}
          {busy ? <div className="alert">正在扫描文件夹，请保持应用开启…</div> : <div className="alert">{notice}</div>}
          <div className="summary"><div><strong>{files.length}</strong><span>条结果（最多显示 500 条）</span></div><div><strong>{missingCount}</strong><span>个已丢失文件（当前结果中）</span></div></div>
          <div className="result-header"><span>文件</span><span>大小</span><span>状态</span><span>操作</span></div>
          {files.length === 0 ? <div className="empty">{folders.length === 0 ? "添加一个文件夹，开始建立你的本地文件记忆。" : "没有找到匹配的文件。"}</div> :
            files.map((file) => <div className="result-row" key={file.path}>
              <div className="file-info"><span className="file-icon">▤</span><div>
                <strong title={file.path}>{file.name}</strong><small title={file.path}>{file.path}</small>
                {file.textMatched === 1 && <small>正文匹配</small>}
                {file.currentPath && <small title={file.currentPath}>现址 {file.currentPath}</small>}
                {!file.currentPath && file.possiblePath && <small title={file.possiblePath}>未确认候选 {file.possiblePath}</small>}
              </div></div>
              <span className="size">{formatSize(file.size)}</span>
              <span className={file.status === "present" || file.currentPath ? "pill present" : "pill missing"}>
                {file.currentPath ? "路径已变更" : file.status === "present" ? "存在" : "已丢失"}
              </span>
              <button className="link-button" disabled={file.status === "missing" && !file.currentPath} onClick={() => reveal(file.path)}>
                {file.currentPath ? "定位现址" : "在文件夹中显示"}
              </button>
            </div>)}
          <p className="footer-note">文件变化自动更新，应用启动时补扫，每 30 秒校验并恢复目录监控。丢失记录保留至手动清除。</p>
        </div>}
      </main>
    </div>
  );
}
