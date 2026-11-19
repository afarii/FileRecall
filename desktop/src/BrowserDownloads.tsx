import { useEffect, useState } from "react";

const sourceLabels = {
  matched: "来源已确认",
  confirmed: "人工确认",
  manual: "人工填写",
  candidate: "候选来源",
  unknown: "来源未知",
  rejected: "候选已排除",
};
const pathLabels = { present: "原路径有文件", missing: "原路径已丢失", unknown: "原路径状态未知" };

export default function BrowserDownloads() {
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<BrowserDownload[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [connection, setConnection] = useState<{ available: boolean; extensionId: string | null }>();
  const [extensionId, setExtensionId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    let current = true;
    window.fileRecall.chromeStatus().then((status) => {
      if (current) {
        setConnection(status);
        setExtensionId(status.extensionId || "");
      }
    }).catch(() => {
      if (current) setConnectionError("无法读取 Chrome 连接设置。");
    });
    return () => { current = false; };
  }, []);

  async function connectChrome() {
    setConnecting(true);
    setConnectionError("");
    try {
      const id = await window.fileRecall.connectChrome(extensionId);
      if (!id) throw new Error();
      setConnection({ available: true, extensionId: id });
      setExtensionId(id);
    } catch {
      setConnectionError("无法保存 Chrome 连接，请检查扩展 ID 后重试。");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    let current = true;
    setError("");
    setRecords(null);
    window.fileRecall.downloads(query).then((result) => {
      if (current) setRecords(result);
    }).catch(() => {
      if (current) setError("读取下载记录失败，请刷新重试。");
    });
    return () => { current = false; };
  }, [query, refresh]);

  async function openSource(id: string) {
    setError("");
    try {
      if (!await window.fileRecall.openSource(id)) setError("此记录当前没有可打开的可信来源。");
    } catch {
      setError("无法打开来源页面，请重试。");
    }
  }

  return <div className="content">
    <div className="heading-row">
      <h1>浏览器下载</h1>
      <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>刷新</button>
    </div>
    {connection?.available && <details className="chrome-connection">
      <summary>Chrome 连接设置</summary>
      <p>在 Chrome 打开扩展程序管理页（chrome://extensions），开启开发者模式并复制 FileRecall 的扩展 ID。</p>
      <form onSubmit={(event) => { event.preventDefault(); void connectChrome(); }}>
        <input aria-label="Chrome 扩展 ID" placeholder="粘贴 FileRecall 扩展 ID" spellCheck={false}
          value={extensionId} onChange={(event) => setExtensionId(event.target.value)} />
        <button disabled={connecting || !/^[a-p]{32}$/.test(extensionId.trim())}>保存连接</button>
      </form>
      {connection.extensionId && <p role="status">连接已配置。请在 Chrome 的 FileRecall 历史页发起同步。</p>}
    </details>}
    {connectionError && <div className="alert error" role="alert">{connectionError}</div>}
    <div className="search">
      <input aria-label="搜索下载和来源" placeholder="搜索文件名、网站或页面标题"
        value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {records === null && !error && <p className="empty" role="status">正在读取下载记录…</p>}
    {records?.length === 0 && <p className="empty">
      {query.trim() ? "没有匹配的下载记录。" : "在 Chrome 的 FileRecall 历史页选择「同步到 FileRecall 桌面端」。"}
    </p>}
    {records && records.length > 0 && <div className="summary">
      <span>{records.length} 条结果（最多显示 200 条）</span>
    </div>}
    {records?.map((record) => <div key={record.id} className="download-row">
      <div className="file-info"><div>
        <strong title={record.path}>{record.name}</strong>
        <small title={record.path}>{record.path}</small>
        <small>{new Date(record.startedAt).toLocaleString()} · {pathLabels[record.pathStatus]}</small>
      </div></div>
      <div className="file-info"><div>
        <strong>{record.domain || sourceLabels[record.sourceStatus]}</strong>
        <small title={record.sourceTitle}>{[record.domain && sourceLabels[record.sourceStatus], record.sourceTitle].filter(Boolean).join(" · ")}</small>
      </div></div>
      {record.canOpenSource && <button className="link-button" onClick={() => void openSource(record.id)}>打开来源页面</button>}
    </div>)}
  </div>;
}
