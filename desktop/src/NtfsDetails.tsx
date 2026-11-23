import { useState } from "react";
import { FileTile } from "./FileDetails";
import MotwInfo from "./MotwInfo";

export default function NtfsDetails({ file, onClose }: { file: NtfsResult; onClose: () => void }) {
  const [error, setError] = useState("");
  async function reveal() {
    setError("");
    try {
      if (!await window.fileRecall.revealNtfs(file.drive, file.id)) {
        setError("文件已移动或磁盘索引暂不可用，请重新搜索。");
      }
    } catch { setError("无法定位此文件。"); }
  }
  return <aside className="file-details" id="file-details" aria-label="文件详情">
    <div className="detail-heading">
      <span>文件详情</span>
      <button type="button" className="icon-button" aria-label="关闭文件详情" onClick={onClose}>×</button>
    </div>
    <div className="detail-file">
      <FileTile name={file.name} />
      <div><h2>{file.name}</h2><span className="muted">{file.directory ? "文件夹" : "本地文件"}</span></div>
    </div>
    <section className="detail-section">
      <h3>文件位置</h3>
      <p>{file.path}</p>
      {file.cached
        ? <p className="muted">这是离线缓存。磁盘重新连接后可定位文件。</p>
        : <button type="button" onClick={() => void reveal()}>在资源管理器中显示</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    {!file.directory && !file.cached && <section className="detail-section">
      <h3>文件来源线索</h3>
      <MotwInfo drive={file.drive} fileId={file.id} />
    </section>}
  </aside>;
}
