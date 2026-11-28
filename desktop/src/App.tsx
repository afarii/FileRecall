import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChromeConnection from "./ChromeConnection";
import Aria2Connection from "./Aria2Connection";
import HotkeySettings from "./HotkeySettings";
import DesktopUpdates from "./DesktopUpdates";
import NtfsQuickResults from "./NtfsQuickResults";
import NtfsDetails from "./NtfsDetails";
import PerformanceDiagnostics from "./PerformanceDiagnostics";
import useSemanticSearch from "./useSemanticSearch";
import FileDetails, { FileTile, recordKey, recordStatus, type SearchRecord } from "./FileDetails";
import logo from "../../filerecall.svg";
import { searchDisplay, preservePreviousResults, canActivateSearchResult, type SearchPhase } from "./search-state";

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
    if ((file as LocalRanking & {matchScore?: number}).matchScore !== undefined) return (file as LocalRanking & {matchScore?: number}).matchScore!;
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
  const [view, setView] = useState<"files" | "folders" | "settings">("files");
  const [folders, setFolders] = useState<IndexedFolder[]>([]);
  const [historyFolders, setHistoryFolders] = useState<Array<{ path: string; count: number }>>([]);
  const [clearingFolder, setClearingFolder] = useState<string | null>(null);
  const [unifiedResult, setUnifiedResult] = useState<{ query: string; favorites: boolean; files: UnifiedRecord[]; phase: SearchPhase; error?: string }>();
  const [browserResult, setBrowserResult] = useState<{
    query: string; files: BrowserDownload[]; manager?: BrowserDownload["manager"]; pending?: boolean; error?: string;
  }>();
  const [downloadRefresh, setDownloadRefresh] = useState(0);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [selected, setSelected] = useState<string | null>(null);

  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - last - 1000);
      last = now;
      if (document.visibilityState === "visible" && lag > 250) {
        const api = window.fileRecall as typeof window.fileRecall & {
          reportRendererLag: (ms: number) => Promise<void>;
        };
        void api.reportRendererLag(lag).catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedResults, setExpandedResults] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [previousResults, setPreviousResults] = useState<{ favorites: boolean; current: UnifiedRecord[]; history: UnifiedRecord[]; historyVisible: boolean }>();
  const [slowSearch, setSlowSearch] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(query), query.trim() ? 25 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);
  const [mode, setMode] = useState<"literal" | "semantic">("literal");
  const searchInput = useRef<HTMLInputElement | null>(null);
  const resultPane = useRef<HTMLElement | null>(null);
  const semantic = useSemanticSearch();
  const currentQuery = useRef(searchQuery);
  currentQuery.current = searchQuery;
  const currentFavorite = useRef(filter === "favorites");
  currentFavorite.current = filter === "favorites";
  const reloadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [textEnabled, setTextEnabled] = useState<boolean>();
  const [changingText, setChangingText] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (search: string) => {
    const version = ++reloadVersion.current;
    const favorite = currentFavorite.current;
    const isCurrent = () => version === reloadVersion.current &&
      search === currentQuery.current && favorite === currentFavorite.current;
    const api = window.fileRecall as typeof window.fileRecall & {
      unifiedSearch: (query: string, favorites: boolean, deep?: boolean) => Promise<UnifiedRecord[]>;
    };
    setUnifiedResult((previous) => ({
      query: search, favorites: favorite, phase: "searching",
      files: previous?.query === search && previous.favorites === favorite ? previous.files : [],
    }));
    let files: UnifiedRecord[] = [];
    try {
      files = await api.unifiedSearch(search, favorite);
      if (!isCurrent()) return;
      const supplement = search.trim().length >= 2 && files.length < 40;
      setUnifiedResult({ query: search, favorites: favorite, files, phase: supplement ? "supplementing" : "complete" });
      if (!supplement) return;
      // The pending state includes the debounce before the background query.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      if (!isCurrent()) return;
      const more = await api.unifiedSearch(search, favorite, true);
      if (!isCurrent()) return;
      const merged = new Map(files.map((record) => [unifiedKey(record), record]));
      for (const record of more) if (!merged.has(unifiedKey(record))) merged.set(unifiedKey(record), record);
      setUnifiedResult({ query: search, favorites: favorite, files: [...merged.values()], phase: "complete" });
    } catch {
      if (!isCurrent()) return;
      setUnifiedResult((previous) => ({
        query: search, favorites: favorite,
        files: previous?.query === search && previous.favorites === favorite ? previous.files : files,
        phase: "failed", error: "文件检索未能完成，请重新搜索。",
      }));
    }
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
  }, [reload, searchQuery, mode, filter]);

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

  // New MFT snapshots and a restored cached volume should become searchable
  // without waiting for the next keystroke. Coalesce frequent index updates.
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = window.fileRecall.onNtfsChanged(() => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (mode === "literal") void reload(currentQuery.current).catch(() => {});
      }, 400);
    });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [mode, reload]);

  useEffect(() => { setExpandedResults(false); setShowHistory(false); }, [searchQuery, filter]);

  useEffect(() => {
    window.fileRecall.textEnabled().then(setTextEnabled).catch(() => setError("无法读取正文搜索设置。"));
  }, []);

  useEffect(() => window.fileRecall.onSearchFocus(() => {
    setView("files");
    window.setTimeout(() => { searchInput.current?.focus(); searchInput.current?.select(); }, 0);
  }), []);

  const refreshDownloads = useCallback(() => setDownloadRefresh((value) => value + 1), []);
  const downloadManager = undefined;

  useEffect(() => {
    window.addEventListener("focus", refreshDownloads);
    return () => window.removeEventListener("focus", refreshDownloads);
  }, [refreshDownloads]);

  useEffect(() => window.fileRecall.onDownloadsChanged(refreshDownloads), [refreshDownloads]);

  useEffect(() => {
    let active = true;
    if (mode === "semantic" || filter === "favorites" || !searchQuery.trim()) return;
    setBrowserResult((previous) => ({ query: searchQuery, manager: downloadManager, pending: true,
      files: previous?.query === searchQuery && previous.manager === downloadManager ? previous.files : [] }));
    const timer = window.setTimeout(() => {
      window.fileRecall.downloads(searchQuery, downloadManager).then((files) => {
        if (active) setBrowserResult({ query: searchQuery, files, manager: downloadManager });
      }).catch(() => {
        if (active) setBrowserResult({ query: searchQuery, files: [], manager: downloadManager, error: "读取下载记录失败，请重试。" });
      });
    }, searchQuery ? 80 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [searchQuery, downloadRefresh, downloadManager, mode, filter]);

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


  const inputPending = query !== searchQuery;
  const matched = !inputPending && unifiedResult?.query === searchQuery &&
    unifiedResult.favorites === (filter === "favorites") ? unifiedResult : undefined;
  const browser = !inputPending && browserResult?.query === searchQuery && browserResult.manager === downloadManager ? browserResult : undefined;
  const semanticMode = mode === "semantic";
  const semanticResult = semantic.result?.query === query ? semantic.result.result : undefined;
  const localOnly = filter === "favorites";
  const downloadRecords: SearchRecord[] = useMemo(() => (semanticMode || localOnly ||
    (!searchQuery.trim() && filter === "all") ? [] : (browser?.files ?? []))
    .map((file): SearchRecord => ({ type: "download", file })), [browser, semanticMode, localOnly, filter, searchQuery]);
  const { currentRecords, historyRecords } = useMemo(() => {
    const filenameRecords: UnifiedRecord[] = semanticMode
      ? (semanticResult?.files ?? []).map((file): UnifiedRecord => ({ type: "local", file }))
      : (matched?.files ?? []);
    // Download events are separate historical evidence. A reused pathname
    // does not prove the current file is the one originally downloaded.
    // MOTW observations can identify a current file; keep it in current results.
    // A duplicate current filename row already exposes its MOTW details.
    const filenames = new Set(filenameRecords.filter((record) => record.type === "ntfs" || (record.type === "local" && record.file.status === "present"))
      .map((record) => record.file.path.toLowerCase()));
    const downloads = downloadRecords.filter((record) => record.type !== "download" || record.file.manager !== "motw" ||
      record.file.pathStatus !== "present" || !filenames.has(record.file.path.toLowerCase()));
    const current: UnifiedRecord[] = [];
    const history: UnifiedRecord[] = [];
    for (const record of [...filenameRecords, ...downloads]) {
      // A download history entry proves a past transfer, while current-file
      // identity comes from the file index. Keep provenance-only rows together.
      const historical = record.type === "local"
        ? record.file.status === "missing" && !record.file.currentPath
        : record.type === "download" && (record.file.manager !== "motw" || record.file.pathStatus !== "present");
      (historical ? history : current).push(record);
    }
    if (!semanticMode) {
      const compare = (a: UnifiedRecord, b: UnifiedRecord) => {
        const left = a.file as LocalRanking;
        const right = b.file as LocalRanking;
        return relevance(b, searchQuery) - relevance(a, searchQuery) ||
          Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) ||
          (right.useCount ?? 0) - (left.useCount ?? 0) ||
          (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) ||
          left.name.localeCompare(right.name) || left.path.localeCompare(right.path) ||
          unifiedKey(a).localeCompare(unifiedKey(b));
      };
      current.sort(compare);
      history.sort(compare);
    }
    return { currentRecords: current, historyRecords: history };
  }, [semanticMode, semanticResult, matched, downloadRecords, searchQuery]);
  const historyVisible = showHistory || currentRecords.length === 0;
  const allRecords = useMemo(() => [...currentRecords, ...historyRecords], [currentRecords, historyRecords]);
  const selectedRecord = allRecords.find((record) => unifiedKey(record) === selected);
  const hasResults = allRecords.length > 0;
  // The fast filename results render before the slower download/history enrichment completes.
  const searchingHistory = !semanticMode && !localOnly && Boolean(searchQuery.trim()) && (!browser || Boolean(browser.pending));
  const display = searchDisplay({ inputPending, filePhase: matched?.phase, historyPending: searchingHistory,
    historyFailed: !localOnly && Boolean(browser?.error), hasResults });
  const showingPrevious = !semanticMode && preservePreviousResults({
    display, query, favorites: localOnly, previousFavorites: previousResults?.favorites,
    previousCount: (previousResults?.current.length ?? 0) + (previousResults?.history.length ?? 0),
  });
  const visibleCurrent = showingPrevious ? previousResults!.current : currentRecords;
  const visibleHistory = showingPrevious ? previousResults!.history : historyRecords;
  const visibleHistoryExpanded = showingPrevious ? previousResults!.historyVisible : historyVisible;
  const canActivate = semanticMode || canActivateSearchResult({ inputPending, showingPrevious, hasResults });
  useEffect(() => {
    if (semanticMode || inputPending) return;
    if (hasResults) {
      setPreviousResults({ favorites: localOnly, current: currentRecords, history: historyRecords, historyVisible });
    } else if (display === "empty" || display === "failed") {
      setPreviousResults(undefined);
    }
  }, [semanticMode, inputPending, hasResults, localOnly, currentRecords, historyRecords, historyVisible, display]);

  const showSearchDelay = !semanticMode && Boolean(query.trim()) && display === "searching" && !showingPrevious;
  useEffect(() => {
    setSlowSearch(false);
    if (!showSearchDelay) return;
    const timer = window.setTimeout(() => setSlowSearch(true), 500);
    return () => window.clearTimeout(timer);
  }, [showSearchDelay, query, localOnly]);

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
          : record.type === "download" && record.file.pathStatus !== "present"
            ? { tone: record.file.pathStatus === "missing" || record.file.pathStatus === "recycled" ? "warn" : "",
              label: record.file.pathStatus === "recycled" ? "在回收站" : record.file.pathStatus === "missing" ? (record.file.manager === "motw" ? "历史文件" : "历史下载") : "状态未确认" }
            : recordStatus(record);
        const subtitle = record.type === "local" ? (record.file.currentPath || file.path)
          : record.type === "ntfs" ? record.file.path : record.file.manager === "motw" && record.file.pathStatus === "present" ? file.path : (record.file.domain || file.path);
        const needle = searchQuery.trim().toLowerCase();
        const sourceMatched = record.type === "download" && needle.length > 0
          && [record.file.domain, record.file.sourceTitle].some((value) => value.toLowerCase().includes(needle));
        return <button type="button" className="result-row" key={key} disabled={!canActivate} aria-expanded={canActivate && selected === key}
          aria-controls={selected === key ? "file-details" : undefined}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const rows = Array.from(resultPane.current?.querySelectorAll<HTMLButtonElement>(".result-row") ?? []);
            const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
            (next ?? searchInput.current)?.focus();
          }}
          onClick={(event) => {
            if (!canActivate) return;
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
          {(record.type === "download" || (record.type === "ntfs" && (Boolean(status.label) || Boolean((record.file as NtfsRanking & {favorite?: number}).favorite))) ||
            (record.type === "local" && (record.file.status !== "present" || Boolean(record.file.currentPath) || record.file.favorite === 1))) &&
            <span className={`badge ${status.tone}`}>{(record.type === "local" && record.file.favorite === 1) || (record.type === "ntfs" && Boolean((record.file as NtfsRanking & {favorite?: number}).favorite)) ? "★ " : ""}{status.label}</span>}
        </button>;
      })}
      {records.length > 60 && !expandedResults &&
        <button type="button" className="secondary show-more" disabled={!canActivate} onClick={() => setExpandedResults(true)}>
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
          <button type="button" className="secondary" onClick={() => { setFilter("all"); setMode("semantic"); setView("files"); }}>本地 AI 搜索</button>
        </div>
        <div className="settings-tools">
          <HotkeySettings />
          <ChromeConnection refresh={refreshDownloads} />
          <Aria2Connection />
          <DesktopUpdates />
          <PerformanceDiagnostics />
        </div>
      </section> : view === "files" ? <div className={`search-layout ${selectedRecord ? "with-details" : ""}`}>
        <section ref={resultPane} className="search-content" aria-labelledby="search-heading">
          <h1 id="search-heading">搜索文件</h1>
          <form className="search-form" onSubmit={(event) => {
            event.preventDefault();
            if (semanticMode && semantic.model?.ready && textEnabled) void semantic.search(query);
            if (!semanticMode && canActivate) resultPane.current?.querySelector<HTMLButtonElement>(".result-row:not(:disabled)")?.click();
          }}>
          <label className="search-box">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.4 4.4"/>
            </svg>
            <input type="search" ref={searchInput} aria-label="搜索文件和来源"
              placeholder={semanticMode ? "用一句话描述你记得的内容" : "搜索文件名、网站或下载线索"}
              value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); setExpandedResults(false); setError(""); }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || !canActivate) return;
                const first = resultPane.current?.querySelector<HTMLButtonElement>(".result-row:not(:disabled)");
                if (first) { event.preventDefault(); first.focus(); }
              }} />
            {showSearchDelay && slowSearch && <span className="search-delay-spinner" role="status" aria-label="检索中" />}
          </label>
          {semanticMode && <button disabled={semantic.searching || !semantic.model?.ready || !textEnabled || !query.trim()}>搜索</button>}
          <button type="button" className="secondary" aria-pressed={localOnly} title="仅显示收藏" onClick={() => { setMode("literal"); setFilter(localOnly ? "all" : "favorites"); setSelected(null); }}>{localOnly ? "★ 收藏" : "☆ 收藏"}</button>
          {semanticMode && <button type="button" className="secondary" onClick={() => setMode("literal")}>普通搜索</button>}
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
          </div> : null}
          {error && <p className="error" role="alert">{error}</p>}
          {!semanticMode && browser?.error && !localOnly && <p className="error" role="alert">{browser.error}</p>}
          {!semanticMode && matched?.error && <p className="error" role="alert">{matched.error}</p>}
          {!semanticMode && display === "empty" && <p className="empty">{searchQuery.trim() || filter !== "all"
            ? "没有找到匹配的记录。" : "输入文件名、拼音或来源即可开始搜索。常用文件会显示在这里。"}</p>}
          {renderRecords(visibleCurrent, semanticMode ? "相近内容" : "搜索结果")}
          {!semanticMode && visibleHistory.length > 0 && <>
            {visibleCurrent.length > 0 && <button type="button"
              className="secondary history-toggle" disabled={!canActivate} aria-expanded={visibleHistoryExpanded}
              onClick={() => { setShowHistory((previous) => !previous); setExpandedResults(false); setSelected(null); }}>
              {visibleHistoryExpanded ? "收起历史记录" : "查看 " + visibleHistory.length + " 条相关下载与历史记录"}
              <span aria-hidden="true">{visibleHistoryExpanded ? "⌃" : "⌄"}</span>
            </button>}
            {visibleHistoryExpanded && renderRecords(visibleHistory, "历史与找回")}
          </>}
          <NtfsQuickResults enabled={!semanticMode} />
        </section>
        {selectedRecord && (selectedRecord.type === "ntfs"
          ? <NtfsDetails key={unifiedKey(selectedRecord)} file={selectedRecord.file} onClose={closeDetails}
            onFavoriteChanged={() => void reload(currentQuery.current).catch((err) => setError(String(err)))} />
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
