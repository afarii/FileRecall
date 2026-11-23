export type SearchRecord =
  | { type: "local"; file: FileRecord }
  | { type: "chrome"; file: BrowserDownload };

export const recordKey = (record: SearchRecord) =>
  record.type === "local" ? "local:" + record.file.path : "chrome:" + record.file.id;

const sourceLabels = {
  matched: "来源已确认", confirmed: "人工确认", manual: "人工填写",
  candidate: "候选待确认", unknown: "来源未知", rejected: "候选已排除",
};

export function recordStatus(record: SearchRecord) {
  if (record.type === "local") {
    if (record.file.currentPath) return { label: "路径已变更", tone: "good" };
    return record.file.status === "present" ? { label: "存在", tone: "good" } : { label: "已丢失", tone: "warn" };
  }
  const { file } = record;
  return {
    label: sourceLabels[file.sourceStatus],
    tone: file.canOpenSource ? "good" : file.sourceStatus === "candidate" ? "warn" : "",
  };
}

export function FileTile({ name }: { name: string }) {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() || "FILE";
  return <span className="file-tile" data-extension={extension} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5"/>
    </svg>
  </span>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function FileDetails({ record, onClose, reveal, openSource }: {
  record: SearchRecord;
  onClose: () => void;
  reveal: (path: string) => void;
  openSource: (id: string) => void;
}) {
  const { file } = record;
  const status = recordStatus(record);
  return <aside className="file-details" id="file-details" aria-label="文件详情">
    <div className="detail-heading"><span>文件详情</span>
      <button type="button" className="icon-button" aria-label="关闭文件详情" onClick={onClose}>×</button>
    </div>
    <div className="detail-file"><FileTile name={file.name} /><div><h2>{file.name}</h2>
      <span className={`badge ${status.tone}`}>{status.label}</span>
    </div></div>
    {record.type === "local" ? <>
      <section className="detail-section">
        <h3>文件位置</h3>
        <dl>
          <dt>当前位置</dt><dd>{record.file.currentPath ?? (record.file.status === "present" ? file.path : "未找到文件")}</dd>
          {record.file.status === "missing" && <><dt>原路径</dt><dd>{file.path}</dd></>}
          {!record.file.currentPath && record.file.possiblePath && <><dt>未确认候选</dt><dd>{record.file.possiblePath}</dd></>}
        </dl>
        {(record.file.currentPath || record.file.status === "present") &&
          <button onClick={() => reveal(file.path)}>{record.file.currentPath ? "定位现址" : "在文件夹中显示"}</button>}
      </section>
      <section className="detail-section">
        <h3>文件记录</h3>
        <dl><dt>大小</dt><dd>{formatSize(record.file.size)}</dd>
          <dt>最近发现</dt><dd>{new Date(record.file.lastSeenAt).toLocaleString()}</dd>
          <dt>来源</dt><dd>来源未知</dd></dl>
      </section>
    </> : <>
      <section className="detail-section">
        <h3>下载记录</h3><dl>
          <dt>原路径</dt><dd>{file.path}</dd>
          <dt>原路径状态</dt><dd>{{ present: "原路径有文件", missing: "原路径已丢失", unknown: "原路径状态未知" }[record.file.pathStatus]}</dd>
          <dt>下载时间</dt><dd>{new Date(record.file.startedAt).toLocaleString()}</dd>
        </dl>
      </section>
      <section className="detail-section">
        <h3>文件来源</h3>
        <p>{[record.file.domain, record.file.sourceTitle].filter(Boolean).join(" · ") || status.label}</p>
        {record.file.canOpenSource && <button onClick={() => openSource(record.file.id)}>打开来源页面 ↗</button>}
        {record.file.sourceStatus === "candidate" && <p className="muted">可在 Chrome 扩展中核对来源。</p>}
      </section>
    </>}
  </aside>;
}
