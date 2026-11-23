import { useEffect, useState } from "react";

export default function MotwInfo({ localPath, drive, fileId }: {
  localPath?: string; drive?: string; fileId?: string;
}) {
  const [value, setValue] = useState<MotwEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const request = localPath ? window.fileRecall.localMotw(localPath)
      : drive && fileId ? window.fileRecall.ntfsMotw(drive, fileId) : Promise.resolve(null);
    void request.then((result) => { if (active) setValue(result); })
      .catch(() => { if (active) setValue(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [localPath, drive, fileId]);
  return <section className="detail-section">
    <h3>Windows 文件来源标记 (MOTW)</h3>
    {loading ? <p className="muted">正在读取本地来源标记…</p>
      : value ? <>
        <span className="badge warn">{value.historical ? "历史来源线索 · 待核对" : "来源线索 · 待核对"}</span>
        <dl>
          {value.referrerUrl && <><dt>来源页面</dt><dd>{value.referrerUrl}</dd></>}
          {value.hostUrl && <><dt>下载地址</dt><dd>{value.hostUrl}</dd></>}
          {value.zoneId !== null && <><dt>Windows 安全区域</dt><dd>{value.zoneId}</dd></>}
        </dl>
        <p className="muted">{value.historical ? "此前观察到的来源标记，文件可能已删除或标记已经变化。" : "本地文件来源标记可能被修改。"}请人工核对。</p>
      </> : <p className="muted">此文件没有可读取的 Windows 来源标记。</p>}
  </section>;
}
