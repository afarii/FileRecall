import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChromeConnection from "./ChromeConnection";
import Aria2Connection from "./Aria2Connection";
import HotkeySettings from "./HotkeySettings";
import DesktopUpdates from "./DesktopUpdates";
import NtfsPanel from "./NtfsPanel";
import NtfsQuickResults from "./NtfsQuickResults";
import NtfsDetails from "./NtfsDetails";
import useSemanticSearch from "./useSemanticSearch";
import FileDetails, { FileTile, recordKey, recordStatus, type SearchRecord } from "./FileDetails";
import logo from "../../filerecall.svg";

type UnifiedRecord = SearchRecord | { type: "ntfs"; file: NtfsResult };
type LocalRanking = FileRecord & { useCount?: number; lastUsedAt?: number; matchRank?: number };
type NtfsRanking = NtfsResult & { useCount?: number; lastUsedAt?: number; matchScore?: number };
const unifiedKey = (record: UnifiedRecord) => record.type === "ntfs"
  ? "ntfs:" + record.file.drive + ":" + record.file.id : recordKey(record);

function relevance(record: UnifiedRecord, query: string) {
  const file = record.file;
  const name = file.name.toLowerCase();
  const needle = query.trim().toLowerCase();
  const path = file.path.toLowerCase();
  if (record.type === "ntfs") return (record.file as NtfsRanking).matchScore ?? 0;
  const usage = record.type === "local" ? ((file as LocalRanking).useCount ?? 0) : 0;
  let score = Math.min(900, Math.log2(usage + 1) * 220);
  if (record.type === "local") {
    const rank = (file as LocalRanking).matchRank ?? 5;
    score += [700, 280, 200, 310, 370, 80][rank] ?? 80;
    if (record.file.favorite === 1) score += 80;
    if (record.file.status === "missing" && !record.file.currentPath) score -= 130;
  } else {
    score += name === needle ? 700 : name.startsWith(needle) ? 280 : 160;
  }
  if (/\.(?:pdf|docx?|xlsx?|pptx?|md|txt|csv)$/i.test(name)) score += 125;
  if (/\.(?:sys|dll|exe|mui|log)$/i.test(name)) score -= 200;
  if (/\\(?:windows|program files|program files \(x86\)|programdata)\\/i.test(path)) score -= 190;
  return score;
}

export default function App() {
  const [view, setView] = useState<"files" | "folders" | "ntfs" | "settings">("files");
  const [folders, setFolders] = useState<IndexedFolder[]>([]);
  const [historyFolders, setHistoryFolders] = useState<Array<{ path: string; count: number }>>([]);
  const [clearingFolder, setClearingFolder] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<{ query: string; files: FileRecord[] }>();
  const [browserResult, setBrowserResult] = useState<{
    query: string; files: BrowserDownload[]; manager?: BrowserDownload["manager"]; error?: string;
  }>();
  const [downloadRefresh, setDownloadRefresh] = useState(0);
  const [filter, setFilter] = useState<"all" | "local" | "chrome" | "aria2" | "missing" | "favorites" | "trusted" | "candidate">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [ntfsResult, setNtfsResult] = useState<{ query: string; files: NtfsResult[] }>();
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedResults, setExpandedResults] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query), query.trim() ? 110 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);
  const [mode, setMode] = useState<"literal" | "semantic">("literal");
  const searchInput = useRef<HTMLInputElement | null>(null);
  const resultPane = useRef<HTMLElement | null>(null);
  const semantic = useSemanticSearch();
  const currentQuery = useRef(searchQuery);
  currentQuery.current = searchQuery;
  const reloadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [textEnabled, setTextEnabled] = useState<boolean>();
  const [changingText, setChangingText] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (search: string) => {
    const version = ++reloadVersion.current;
    const nextFiles = await window.fileRecall.search(search);
    if (version !== reloadVersion.current || search !== currentQuery.current) return;
    setLocalResult({ query: search, files: nextFiles });
  }, []);
  const refreshFolders = useCallback(async () => {
    const [nextFolders, nextHistoryFolders] = await Promise.all([
      window.fileRecall.folders(), window.fileRecall.historyFolders(),
    ]);
    setFolders(nextFolders);
    setHistoryFolders(nextHistoryFolders);
  }, []);

  useEffect(() => {
    if (mode === "literal") void reload(searchQuery).catch((err) => setError(String(err)));
  }, [reload, searchQuery, mode]);

  useEffect(() => {
    if (view === "folders") void refreshFolders().catch((err) => setError(String(err)));
  }, [view, refreshFolders]);

  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = window.fileRecall.onChanged(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (mode === "literal") void reload(currentQuery.current).catch((err) => setError(String(err)));
        if (view === "folders") void refreshFolders().catch((err) => setError(String(err)));
      }, 250);
    });
    return () => { if (timer !== undefined) window.clearTimeout(timer); unsubscribe(); };
  }, [reload, refreshFolders, mode, view]);

  useEffect(() => { setExpandedResults(false); }, [searchQuery, filter]);

  useEffect(() => {
    window.fileRecall.textEnabled().then(setTextEnabled).catch(() => setError("无法读取正文搜索设置。"));
  }, []);

  useEffect(() => window.fileRecall.onSearchFocus(() => {
    setView("files");
    window.setTimeout(() => { searchInput.current?.focus(); searchInput.current?.select(); }, 0);
  }), []);

  const refreshDownloads = useCallback(() => setDownloadRefresh((value) => value + 1), []);
  const downloadManager = filter === "aria2" ? "aria2"
    : filter === "chrome" || filter === "trusted" || filter === "candidate" ? "chrome" : undefined;

  useEffect(() => {
    window.addEventListener("focus", refreshDownloads);
    return () => window.removeEventListener("focus", refreshDownloads);
  }, [refreshDownloads]);

  useEffect(() => window.fileRecall.onDownloadsChanged(refreshDownloads), [refreshDownloads]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (mode === "semantic") return;
      window.fileRecall.downloads(searchQuery, downloadManager).then((files) => {
        if (active) setBrowserResult({ query: searchQuery, files, manager: downloadManager });
      }).catch(() => {
        if (active) setBrowserResult({ query: searchQuery, files: [], manager: downloadManager, error: "读取下载记录失败，请重试。" });
      });
    }, searchQuery ? 80 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [searchQuery, downloadRefresh, downloadManager, mode]);

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
      if (!enabled) semantic.invalidate();
      setTextEnabled(enabled);
      setNotice(enabled ? "已开启正文搜索，授权目录会自动重扫。" : "已关闭正文搜索并清除正文索引。");
      await reload(currentQuery.current);
      await refreshFolders();
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
      await refreshFolders();
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
      semantic.invalidate();
      setNotice(`已停止索引 ${path}，历史记录仍可搜索。`);
      await reload(currentQuery.current);
      await refreshFolders();
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
      semantic.invalidate();
      setClearingFolder(null);
      setNotice(`已清除 ${removed} 条历史记录，磁盘文件保留。`);
      await reload(currentQuery.current);
      await refreshFolders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }


  const local = localResult?.query === searchQuery ? localResult : undefined;
  const browser = browserResult?.query === searchQuery && browserResult.manager === downloadManager ? browserResult : undefined;
  const semanticMode = mode === "semantic";
  const semanticResult = semantic.result?.query === query ? semantic.result.result : undefined;
  const downloadsOnly = filter === "chrome" || filter === "aria2" || filter === "trusted" || filter === "candidate";
  const localOnly = filter === "local" || filter === "favorites";
  const localFiles = semanticMode ? (semanticResult?.files ?? []) : (downloadsOnly ? [] : (local?.files ?? []));
  const localRecords: SearchRecord[] = useMemo(() => localFiles
    .filter((file) => semanticMode || filter !== "missing" || (file.status === "missing" && !file.currentPath))
    .filter((file) => semanticMode || filter !== "favorites" || file.favorite === 1)
    .map((file): SearchRecord => ({ type: "local", file })), [localFiles, filter, semanticMode]);
  const downloadRecords: SearchRecord[] = useMemo(() => (semanticMode || localOnly ? [] : (browser?.files ?? []))
    .filter((file) => filter !== "missing" || file.pathStatus === "missing")
    .filter((file) => filter !== "trusted" || (file.manager === "chrome" && file.canOpenSource))
    .filter((file) => filter !== "candidate" || file.sourceStatus === "candidate")
    .map((file): SearchRecord => ({ type: "download", file })), [browser, semanticMode, localOnly, filter]);
  const allRecords: UnifiedRecord[] = useMemo(() => {
    const localPaths = new Set(localRecords.filter((record) => record.type === "local")
      .map((record) => (record.type === "local" ? record.file.currentPath || record.file.path : "").toLowerCase()));
    const diskRecords: UnifiedRecord[] = semanticMode || (filter !== "all" && filter !== "local") ||
      ntfsResult?.query !== searchQuery ? [] : ntfsResult.files
      .filter((file) => !localPaths.has(file.path.toLowerCase()))
      .map((file) => ({ type: "ntfs" as const, file }));
    const merged: UnifiedRecord[] = [...localRecords, ...diskRecords, ...downloadRecords];
    if (!semanticMode) merged.sort((a, b) => relevance(b, searchQuery) - relevance(a, searchQuery));
    return merged;
  }, [localRecords, downloadRecords, ntfsResult, searchQuery, filter, semanticMode]);
  const selectedRecord = allRecords.find((record) => unifiedKey(record) === selected);
  const hasResults = allRecords.length > 0;
  const loading = (!error && !downloadsOnly && !local) || (!localOnly && !browser);
  const pastFolders = historyFolders.filter((history) => !folders.some((folder) => folder.path === history.path));

  function renderRecords(records: UnifiedRecord[], title: string) {
    if (!records.length) return null;
    return <section className="results-group" aria-label={title}>
      <h2>{title} <span>{records.length} 条</span></h2>
      {records.slice(0, expandedResults ? 500 : 60).map((record) => {
        const { file } = record;
        const key = unifiedKey(record);
        const status = record.type === "ntfs"
          ? { tone: "", label: record.file.cached ? "缓存" : record.file.directory ? "文件夹" : "" }
          : recordStatus(record);
        const subtitle = record.type === "local" ? (record.file.currentPath || file.path)
          : record.type === "ntfs" ? record.file.path : (record.file.domain || file.path);
        const needle = searchQuery.trim().toLowerCase();
        const sourceMatched = record.type === "download" && needle.length > 0
          && [record.file.domain, record.file.sourceTitle].some((value) => value.toLowerCase().includes(needle));
        return <button type="button" className="result-row" key={key} aria-expanded={selected === key}
          aria-controls={selected === key ? "file-details" : undefined}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const rows = Array.from(resultPane.current?.querySelectorAll<HTMLButtonElement>(".result-row") ?? []);
            const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
            (next ?? searchInput.current)?.focus();
          }}
          onClick={(event) => {
            selectedButton.current = event.currentTarget;
            setSelected(selected === key ? null : key);
            setError("");
          }}>
          <FileTile name={file.name} />
          <span className="result-copy"><strong>{file.name}</strong>
            <span title={subtitle}>{subtitle}</span>
            {record.type === "local" && (semanticMode || record.file.textMatched === 1) &&
              <small>{semanticMode ? "语义匹配" : "正文匹配"}</small>}
            {record.type === "local" && !semanticMode && record.file.annotationMatched === 1 && <small>备注或标签匹配</small>}
            {sourceMatched && <small>{record.type === "download" && record.file.manager === "aria2" ? "下载地址匹配" : "来源匹配"}</small>}
          </span>
          {(record.type === "download" || (record.type === "ntfs" && Boolean(status.label)) ||
            (record.type === "local" && (record.file.status !== "present" || Boolean(record.file.currentPath) || record.file.favorite === 1))) &&
            <span className={`badge ${status.tone}`}>{record.type === "local" && record.file.favorite === 1 ? "★ " : ""}{status.label}</span>}
        </button>;
      })}
      {records.length > 60 && !expandedResults &&
        <button type="button" className="secondary show-more" onClick={() => setExpandedResults(true)}>
          显示更多（共 {records.length} 条）
        </button>}
    </section>;
  }

  return <div className="app">
    <header className="app-bar">
      <span className="brand"><span className="brand-mark"><img src={logo} alt="" /></span>FileRecall</span>
      <nav className="app-actions" aria-label="主要功能">
        <button type="button" aria-pressed={view === "files"} onClick={() => setView("files")}>搜索</button>
        <button type="button" aria-pressed={view !== "files"} onClick={() => { setSelected(null); setView("settings"); }}>设置</button>
      </nav>
    </header>
    <main>
      {view === "settings" ? <section className="folders-view settings-view" aria-label="设置">
        <h1>设置</h1>
        <p className="muted">索引和连接在后台运行，需要时再调整。</p>
        <div className="settings-links">
          <button type="button" className="secondary" onClick={() => setView("folders")}>授权目录与正文搜索</button>
          <button type="button" className="secondary" onClick={() => setView("ntfs")}>磁盘索引管理</button>
        </div>
        <div className="settings-tools">
          <HotkeySettings />
          <ChromeConnection refresh={refreshDownloads} />
          <Aria2Connection />
          <DesktopUpdates />
        </div>
      </section> : view === "ntfs" ? <NtfsPanel /> : view === "files" ? <div className={`search-layout ${selectedRecord ? "with-details" : ""}`}>
        <section ref={resultPane} className="search-content" aria-labelledby="search-heading">
          <h1 id="search-heading">搜索文件</h1>
          <div className="search-modes" role="group" aria-label="搜索方式">
            <button type="button" className="secondary" aria-pressed={!semanticMode}
              onClick={() => { setSelected(null); setMode("literal"); }}>字面搜索</button>
            <button type="button" className="secondary" aria-pressed={semanticMode}
              onClick={() => { setSelected(null); setMode("semantic"); }}>本地 AI 搜索</button>
          </div>
          <form className="search-form" onSubmit={(event) => {
            event.preventDefault();
            if (semanticMode && semantic.model?.ready && textEnabled) void semantic.search(query);
          }}>
          <label className="search-box">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.4 4.4"/>
            </svg>
            <input type="search" ref={searchInput} aria-label="搜索文件和来源"
              placeholder={semanticMode ? "用一句话描述你记得的内容" : "文件名、全拼、首字母、扩展名组合或来源，例如 pdf sybg"}
              value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); setExpandedResults(false); }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                const first = resultPane.current?.querySelector<HTMLButtonElement>(".result-row");
                if (first) { event.preventDefault(); first.focus(); }
              }} />
          </label>
          {semanticMode && <button disabled={semantic.searching || !semantic.model?.ready || !textEnabled || !query.trim()}>搜索</button>}
          </form>
          {semanticMode ? <div className="semantic-options">
            {semantic.error && <p className="error" role="alert">{semantic.error}</p>}
            {!textEnabled && <p>先在<button type="button" className="secondary" onClick={() => setView("folders")}>授权目录</button>开启正文索引。</p>}
            {!semantic.model?.ready && <>
              <p>首次需下载约 135 MB 模型。下载完成后可离线搜索。</p>
              <button onClick={() => void semantic.install()} disabled={semantic.installing}>
                {semantic.installing ? `正在下载 ${Math.floor(100 * (semantic.model?.downloaded ?? 0) / (semantic.model?.total || 1))}%` : "下载本地模型"}
              </button>
            </>}
            {semantic.searching && <p role="status">{semantic.progress
              ? `正在比较本地文档 ${semantic.progress.done}/${semantic.progress.total}`
              : "正在准备本地语义索引…"}</p>}
            {semanticResult && !semanticResult.files.length && <p role="status">{semanticResult.indexed
              ? "未找到足够相关的文件。" : "暂无可用正文，请确认授权目录已完成索引。"}</p>}
            {semanticResult?.truncated && <p className="muted">本次比较了最近索引的 500 份文件。</p>}
          </div> : <div className="filters" role="group" aria-label="筛选搜索结果">
            {([["all", "全部"], ["local", "本地文件"], ["favorites", "收藏"], ["missing", "已丢失"],
              ["chrome", "Chrome"], ["aria2", "Motrix"]] as const)
              .map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key}
                onClick={() => { setFilter(key); setSelected(null); }}>{label}</button>)}
            <details className="filter-more">
              <summary>更多筛选</summary>
              <button type="button" aria-pressed={filter === "trusted"} onClick={() => setFilter("trusted")}>可信网页来源</button>
              <button type="button" aria-pressed={filter === "candidate"} onClick={() => setFilter("candidate")}>来源待核对</button>
            </details>
          </div>}
          {error && <p className="error" role="alert">{error}</p>}
          {!semanticMode && browser?.error && !localOnly && <p className="error" role="alert">{browser.error}</p>}
          {!semanticMode && !hasResults && loading && <p className="empty" role="status">正在搜索…</p>}
          {!semanticMode && !hasResults && !loading && <p className="empty">{searchQuery.trim() || filter !== "all" ? "没有找到匹配的记录。" :
            <>暂无文件记录。<button className="secondary" onClick={() => setView("folders")}>管理授权目录</button></>}</p>}
          {renderRecords(allRecords, semanticMode ? "相近内容" : "搜索结果")}
          <NtfsQuickResults query={searchQuery} enabled={!semanticMode && (filter === "all" || filter === "local") && query === searchQuery}
            onResults={setNtfsResult} />
        </section>
        {selectedRecord && (selectedRecord.type === "ntfs"
          ? <NtfsDetails key={unifiedKey(selectedRecord)} file={selectedRecord.file} onClose={closeDetails} />
          : <FileDetails key={unifiedKey(selectedRecord)} record={selectedRecord}
            onClose={closeDetails} reveal={reveal} openSource={openSource} />)}
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
          <span>搜索文件正文<small>支持 UTF-8 TXT、Markdown、带文字层的 PDF 和 .docx。关闭时清除本机正文索引。</small></span>
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
