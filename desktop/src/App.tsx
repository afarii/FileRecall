import { useCallback, useEffect, useRef, useState } from "react";
import ChromeConnection from "./ChromeConnection";
import FileDetails, { FileTile, recordKey, recordStatus, type SearchRecord } from "./FileDetails";
import logo from "../../filerecall.svg";

export default function App() {
  const [view, setView] = useState<"files" | "folders">("files");
  const [folders, setFolders] = useState<IndexedFolder[]>([]);
  const [historyFolders, setHistoryFolders] = useState<Array<{ path: string; count: number }>>([]);
  const [clearingFolder, setClearingFolder] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<{ query: string; files: FileRecord[] }>();
  const [browserResult, setBrowserResult] = useState<{ query: string; files: BrowserDownload[]; error?: string }>();
  const [downloadRefresh, setDownloadRefresh] = useState(0);
  const [filter, setFilter] = useState<"all" | "local" | "chrome" | "missing">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const reloadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [textEnabled, setTextEnabled] = useState<boolean>();
  const [changingText, setChangingText] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (search: string) => {
    const version = ++reloadVersion.current;
    const [nextFiles, nextFolders, nextHistoryFolders] = await Promise.all([
      window.fileRecall.search(search),
      window.fileRecall.folders(),
      window.fileRecall.historyFolders(),
    ]);
    if (version !== reloadVersion.current || search !== currentQuery.current) return;
    setLocalResult({ query: search, files: nextFiles });
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

  const refreshDownloads = useCallback(() => setDownloadRefresh((value) => value + 1), []);

  useEffect(() => {
    window.addEventListener("focus", refreshDownloads);
    return () => window.removeEventListener("focus", refreshDownloads);
  }, [refreshDownloads]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      window.fileRecall.downloads(query).then((files) => {
        if (active) setBrowserResult({ query, files });
      }).catch(() => {
        if (active) setBrowserResult({ query, files: [], error: "读取 Chrome 下载记录失败，可在 Chrome 设置中重试。" });
      });
    }, query ? 150 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, downloadRefresh]);

  const closeDetails = useCallback(() => {
    setSelected(null);
    selectedButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!selected) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) closeDetails();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selected, closeDetails]);

  async function openSource(id: string) {
    setError("");
    try {
      if (!await window.fileRecall.openSource(id)) setError("此记录当前没有可打开的可信来源。");
    } catch {
      setError("无法打开来源页面，请重试。");
    }
  }


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


  const local = localResult?.query === query ? localResult : undefined;
  const browser = browserResult?.query === query ? browserResult : undefined;
  const localRecords: SearchRecord[] = (filter === "chrome" ? [] : (local?.files ?? []))
    .filter((file) => filter !== "missing" || (file.status === "missing" && !file.currentPath))
    .map((file) => ({ type: "local", file }));
  const chromeRecords: SearchRecord[] = (filter === "local" ? [] : (browser?.files ?? []))
    .filter((file) => filter !== "missing" || file.pathStatus === "missing")
    .map((file) => ({ type: "chrome", file }));
  const selectedRecord = [...localRecords, ...chromeRecords].find((record) => recordKey(record) === selected);
  const hasResults = localRecords.length + chromeRecords.length > 0;
  const loading = (!error && filter !== "chrome" && !local) || (filter !== "local" && !browser);
  const pastFolders = historyFolders.filter((history) => !folders.some((folder) => folder.path === history.path));

  function renderRecords(records: SearchRecord[], title: string) {
    if (!records.length) return null;
    return <section className="results-group" aria-label={title}>
      <h2>{title} <span>{records.length} 条</span></h2>
      {records.map((record) => {
        const { file } = record;
        const key = recordKey(record);
        const status = recordStatus(record);
        const subtitle = record.type === "local" ? (record.file.currentPath || file.path)
          : (record.file.domain || file.path);
        return <button type="button" className="result-row" key={key} aria-expanded={selected === key}
          aria-controls={selected === key ? "file-details" : undefined}
          onClick={(event) => {
            selectedButton.current = event.currentTarget;
            setSelected(selected === key ? null : key);
            setError("");
          }}>
          <FileTile name={file.name} />
          <span className="result-copy"><strong>{file.name}</strong>
            <span title={subtitle}>{subtitle}</span>
            {record.type === "local" && record.file.textMatched === 1 && <small>正文匹配</small>}
          </span>
          <span className={`badge ${status.tone}`}>{status.label}</span>
        </button>;
      })}
    </section>;
  }

  return <div className="app">
    <header className="app-bar">
      <span className="brand"><span className="brand-mark"><img src={logo} alt="" /></span>FileRecall</span>
      <span className="muted">本地存储</span>
    </header>
    <main>
      <nav className="app-nav" aria-label="主要功能">
        <button aria-pressed={view === "files"} onClick={() => setView("files")}>搜索文件</button>
        <button aria-pressed={view === "folders"} onClick={() => { setSelected(null); setView("folders"); }}>授权目录</button>
        <ChromeConnection refresh={refreshDownloads} />
      </nav>
      {view === "files" ? <div className={`search-layout ${selectedRecord ? "with-details" : ""}`}>
        <section className="search-content" aria-labelledby="search-heading">
          <h1 id="search-heading">搜索文件</h1>
          <label className="search-box">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.4 4.4"/>
            </svg>
            <input type="search" aria-label="搜索文件和来源"
              placeholder={textEnabled ? "文件名、路径、正文或来源" : "文件名、路径或来源"}
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="filters" role="group" aria-label="筛选搜索结果">
            {([["all", "全部"], ["local", "本地文件"], ["chrome", "浏览器下载"], ["missing", "已丢失"]] as const)
              .map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key}
                onClick={() => { setFilter(key); setSelected(null); }}>{label}</button>)}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {browser?.error && filter !== "local" && <p className="error" role="alert">{browser.error}</p>}
          {!hasResults && loading && <p className="empty" role="status">正在搜索…</p>}
          {!hasResults && !loading && <p className="empty">{query.trim() || filter !== "all" ? "没有找到匹配的记录。" :
            <>暂无文件记录。<button className="secondary" onClick={() => setView("folders")}>管理授权目录</button></>}</p>}
          {renderRecords(localRecords, "本地文件")}
          {renderRecords(chromeRecords, "Chrome 下载")}
        </section>
        {selectedRecord && <FileDetails record={selectedRecord} onClose={closeDetails} reveal={reveal} openSource={openSource} />}
      </div> : <section className="folders-view" aria-labelledby="folder-heading">
        <div className="heading-row"><h1 id="folder-heading">授权目录</h1>
          <div className="actions">
            <button className="secondary" disabled={busy || !folders.length} onClick={() => perform(() => window.fileRecall.rescan())}>重新扫描</button>
            <button disabled={busy} onClick={() => perform(() => window.fileRecall.addFolder())}>添加文件夹</button>
          </div>
        </div>
        {textEnabled !== undefined && <label className="text-search-setting">
          <input type="checkbox" checked={textEnabled} disabled={changingText || busy}
            onChange={(event) => void changeText(event.target.checked)} />
          <span>搜索文件正文<small>仅索引不超过 128 KiB 的 UTF-8 TXT 和 Markdown。关闭时清除本机正文索引。</small></span>
        </label>}
        {error && <p className="error" role="alert">{error}</p>}
        {busy && <p role="status" className="muted">正在处理索引…</p>}
        {notice && !busy && <p role="status" className="muted">{notice}</p>}
        {clearingFolder && <div className="clear-history" role="alertdialog" aria-label="清除目录历史">
          <p>清除 {clearingFolder} 及其子目录的全部 FileRecall 历史，并停止这些目录的索引。磁盘文件保留。</p>
          <div className="actions">
            <button disabled={busy} onClick={clearHistory}>确认清除历史</button>
            <button className="secondary" disabled={busy} onClick={() => setClearingFolder(null)}>取消</button>
          </div>
        </div>}
        {!folders.length && <p className="empty">尚未选择扫描目录。</p>}
        {folders.map((folder) => <div className="folder-row" key={folder.path}>
          <div><strong>{folder.path}</strong>
            <p className="muted">{{ waiting: "等待扫描", scanning: "正在更新索引", watching: "自动监控中", retrying: "等待自动重试" }[folder.state]}</p>
            {folder.error && <p className="error">{folder.error}</p>}
          </div>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => removeFolder(folder.path)} aria-label={`停止索引 ${folder.path}`}>停止索引</button>
            <button className="secondary" disabled={busy} onClick={() => setClearingFolder(folder.path)} aria-label={`停止并清除历史 ${folder.path}`}>停止并清除历史</button>
          </div>
        </div>)}
        {pastFolders.length > 0 && <h2>已停止索引的历史</h2>}
        {pastFolders.map((history) => <div className="folder-row" key={history.path}>
          <strong>{history.path}</strong>
          <button className="secondary" disabled={busy} onClick={() => setClearingFolder(history.path)} aria-label={`清除历史 ${history.path}`}>清除历史（{history.count} 条）</button>
        </div>)}
      </section>}
    </main>
  </div>;
}
