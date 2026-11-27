import { useEffect, useState } from "react";
import FileNotes from "./FileNotes";
import MotwInfo from "./MotwInfo";

export type SearchRecord =
  | { type: "local"; file: FileRecord }
  | { type: "download"; file: BrowserDownload };

export const recordKey = (record: SearchRecord) =>
  record.type === "local" ? "local:" + record.file.path : "download:" + record.file.id;

const sourceLabels = {
  matched: "来源已确认", confirmed: "人工确认", manual: "人工填写",
  candidate: "候选待确认", unknown: "来源未知", rejected: "候选已排除",
  direct: "下载地址已记录",
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
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() || "";
  const kind = (["PDF"].includes(extension) ? "pdf"
    : ["DOC", "DOCX", "TXT", "MD"].includes(extension) ? "document"
    : ["XLS", "XLSX", "CSV"].includes(extension) ? "sheet"
    : ["PPT", "PPTX"].includes(extension) ? "slides"
    : ["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG"].includes(extension) ? "image"
    : ["ZIP", "RAR", "7Z", "TAR"].includes(extension) ? "archive"
    : ["SYS", "DLL", "EXE"].includes(extension) ? "system" : "file");
  const labels: Record<string, string> = { pdf: "PDF", document: "DOC", sheet: "XLS", slides: "PPT",
    image: "IMG", archive: "ZIP", system: "SYS", file: extension.slice(0, 3) || "FILE" };
  const label = labels[kind] ?? "FILE";
  return <span className="file-tile" data-kind={kind} aria-hidden="true">{label}</span>;
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
  const localFile = record.type === "local" ? record.file : null;
  const browserId = record.type === "download" ? record.file.id : null;
  const [provenance, setProvenance] = useState<FileProvenance>();
  const [linked, setLinked] = useState<Pick<FileRecord, "path" | "name" | "status"> | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    let active = true;
    if (localFile) {
      window.fileRecall.provenance(localFile.path).then((state) => {
        if (active) setProvenance(state);
      }).catch(() => { if (active) setSourceError("无法读取文件来历。"); });
    } else if (browserId) {
      window.fileRecall.linkedFile(browserId).then((value) => {
        if (active) setLinked(value);
      }).catch(() => { if (active) setSourceError("无法读取关联的本地文件。"); });
    }
    return () => { active = false; };
  }, [localFile?.path, localFile?.status, localFile?.currentPath, localFile?.modifiedAt, browserId]);

  async function decideSource(id: string, decision: SourceDecision) {
    if (!localFile || !provenance?.identity) return;
    setDeciding(true);
    setSourceError("");
    try {
      setProvenance(await window.fileRecall.decideSource(localFile.path, provenance.identity, id, decision));
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "无法更新文件关联。");
    } finally { setDeciding(false); }
  }

  const confirmed = provenance?.confirmed;
  async function fileAction(action: "open" | "copy") {
    setActionMessage("");
    try {
      if (action === "open") {
        const result = await window.fileRecall.openFile(file.path);
        if (!result.ok) setActionMessage(result.message ?? "无法打开此文件。");
      } else {
        const copied = await window.fileRecall.copyPath(record.type, browserId ?? file.path);
        setActionMessage(copied ? "路径已复制。" : "无法复制路径。");
      }
    } catch { setActionMessage("文件操作失败，请重试。"); }
  }
  async function openLinkedSource(id: string) {
    setActionMessage("");
    try {
      if (!await window.fileRecall.openLinkedSource(file.path, id)) setActionMessage("当前没有可打开的可信来源。");
    } catch { setActionMessage("无法打开来源页面。"); }
  }
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
        <div className="actions">
          {(record.file.currentPath || record.file.status === "present") && <>
            <button onClick={() => reveal(file.path)}>{record.file.currentPath ? "定位现址" : "在文件夹中显示"}</button>
            <button className="secondary" onClick={() => void fileAction("open")}>打开文件</button>
          </>}
          <button className="secondary" onClick={() => void fileAction("copy")}>复制路径</button>
        </div>
      </section>
      <section className="detail-section">
        <h3>文件记录</h3>
        <dl><dt>大小</dt><dd>{formatSize(record.file.size)}</dd>
          <dt>首次发现</dt><dd>{new Date(record.file.firstSeenAt).toLocaleString()}</dd>
          <dt>最近发现</dt><dd>{new Date(record.file.lastSeenAt).toLocaleString()}</dd></dl>
        {provenance && provenance.aliases.length > 1 && <details className="path-history">
          <summary>查看观察到的路径</summary>
          {provenance.aliases.map((alias) => <p key={alias.path}>{new Date(alias.firstSeenAt).toLocaleString()} · {alias.path}</p>)}
        </details>}
      </section>
      <section className="detail-section">
        <h3>文件来历</h3>
        {confirmed ? <>
          <span className="badge good">文件关联已确认</span>
          <dl>
            <dt>原下载路径</dt><dd>{confirmed.path}</dd>
            <dt>{confirmed.manager === "aria2" ? "下载地址" : "网页来源"}</dt>
            <dd>{[confirmed.domain, confirmed.sourceTitle].filter(Boolean).join(" · ") || sourceLabels[confirmed.sourceStatus]}</dd>
          </dl>
          <div className="actions">
            {confirmed.canOpenSource && <button onClick={() => void openLinkedSource(confirmed.id)}>
              {record.file.status === "missing" && !record.file.currentPath
                ? "查看来源，尝试找回" : confirmed.manager === "aria2" ? "打开下载地址" : "打开来源页面"} ↗</button>}
            <button className="secondary" disabled={deciding} onClick={() => void decideSource(confirmed.id, "undo")}>撤销关联</button>
          </div>
        </> : <p className="muted">{provenance ? "来源未知" : "正在读取来历…"}</p>}
        {!confirmed && provenance?.candidates.map((candidate) => <div className="source-candidate" key={candidate.id}>
          <strong>{candidate.name}</strong> <span className="badge warn">{candidate.evidence} · 待核对</span>
          <p>{candidate.path}</p>
          <p className="muted">{[candidate.manager === "aria2" ? "Motrix／aria2" : "Chrome", candidate.domain, candidate.sourceTitle,
            new Date(candidate.startedAt).toLocaleString()].filter(Boolean).join(" · ")}</p>
          <div className="actions">
            <button disabled={deciding} onClick={() => void decideSource(candidate.id, "confirmed")}>确认是同一文件</button>
            <button className="secondary" disabled={deciding} onClick={() => void decideSource(candidate.id, "rejected")}>排除</button>
          </div>
        </div>)}
        {provenance?.rejected.map((item) => <div className="source-candidate" key={item.id}>
          <p className="muted">已排除 · {item.name} · {item.path}</p>
          <button className="secondary" disabled={deciding} onClick={() => void decideSource(item.id, "undo")}>撤销排除</button>
        </div>)}
      </section>
      <MotwInfo localPath={file.path} />
      {provenance?.identity && provenance.annotation &&
        <FileNotes key={provenance.identity} path={file.path} identity={provenance.identity} initial={provenance.annotation} />}
    </> : <>
      <section className="detail-section">
        <h3>下载记录</h3><dl>
          <dt>原路径</dt><dd>{file.path}</dd>
          <dt>原路径状态</dt><dd>{{ present: "原路径有文件", missing: "原路径已丢失", unknown: "原路径状态未知" }[record.file.pathStatus]}</dd>
          <dt>{record.file.manager === "aria2" ? "首次导入" : "下载时间"}</dt><dd>{new Date(record.file.startedAt).toLocaleString()}</dd>
          {linked && <><dt>{linked.status === "present" ? "当前位置" : "关联的历史路径"}</dt><dd>{linked.path}</dd></>}
        </dl>
        <div className="actions">
          {linked?.status === "present" && <button onClick={() => {
            const api = window.fileRecall as typeof window.fileRecall & { revealLinkedDownload: (id: string) => Promise<boolean> };
            void api.revealLinkedDownload(record.file.id).then((ok) => { if (!ok) setActionMessage("文件位置已改变，请重新打开详情。"); })
              .catch(() => setActionMessage("无法定位关联文件。"));
          }}>定位现址</button>}
          <button className="secondary" onClick={() => void fileAction("copy")}>复制原路径</button>
        </div>
      </section>
      <section className="detail-section">
        <h3>{record.file.manager === "aria2" ? "下载地址" : "文件来源"}</h3>
        <p>{[record.file.domain, record.file.sourceTitle].filter(Boolean).join(" · ") || status.label}</p>
        {record.file.manager === "aria2" && <p className="muted">下载器只提供任务地址，来源网页未知。</p>}
        {record.file.canOpenSource && <button onClick={() => openSource(record.file.id)}>
          {record.file.pathStatus === "missing" ? "查看来源，尝试找回"
            : record.file.manager === "aria2" ? "打开下载地址" : "打开来源页面"} ↗</button>}
        {record.file.sourceStatus === "candidate" && <p className="muted">可在 Chrome 扩展中核对来源。</p>}
      </section>
    </>}
    {sourceError && <p className="error" role="alert">{sourceError}</p>}
    {actionMessage && <p className="muted" role="status">{actionMessage}</p>}
  </aside>;
}
