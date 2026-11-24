import { useState } from "react";

type Sample = {
  time: string; mainLoopP95Ms: number; mainLoopMaxMs: number;
  mainLoopUtilPct: number; processCpuPctOfOneCore: number;
  processRssMiB: number; rendererLagMs: number;
  localSearchP95Ms?: number; ntfsSearchP95Ms?: number; deepSearchP95Ms?: number;
  ntfsLoopP95Ms: number; ntfsLoopMaxMs: number; ntfsActiveScanCount: number;
};
type Report = { format: string; recent: Sample[] };
type DiagnosticsApi = {
  performanceReport: () => Promise<Report>;
  copyPerformanceReport: () => Promise<boolean>;
  revealPerformanceLog: () => Promise<boolean>;
};
export default function PerformanceDiagnostics() {
  const [report, setReport] = useState<Report>();
  const [message, setMessage] = useState("");
  const api = window.fileRecall as typeof window.fileRecall & DiagnosticsApi;
  const latest = report?.recent.at(-1);
  async function run(action: "read" | "copy" | "reveal") {
    setMessage("");
    try {
      if (action === "read") {
        setReport(await api.performanceReport());
      } else if (action === "copy") {
        await api.copyPerformanceReport();
        setMessage("性能摘要已复制，不包含文件路径、文件名或搜索内容。");
      } else {
        await api.revealPerformanceLog();
        setMessage("已定位本机性能日志，出现未响应时也会定期写入。");
      }
    } catch {
      setMessage("读取诊断信息失败，可尝试重新打开 FileRecall。");
    }
  }
  return <details className="chrome-connection">
    <summary>性能诊断</summary>
    <div className="connection-panel">
      <p>每 10 秒在本机记录主进程卡顿、CPU、内存以及 NTFS 索引线程耗时。仅记录数值，不记录文件名或搜索内容。</p>
      <div className="actions">
        <button type="button" onClick={() => void run("read")}>刷新指标</button>
        <button type="button" className="secondary" onClick={() => void run("copy")}>复制性能摘要</button>
        <button type="button" className="secondary" onClick={() => void run("reveal")}>定位日志文件</button>
      </div>
      {latest && <p className="perf-summary">
        主进程最严重卡顿：{latest.mainLoopMaxMs} ms；索引线程：{latest.ntfsLoopMaxMs} ms；
        本地搜索 P95：{latest.localSearchP95Ms ?? 0} ms；NTFS 搜索 P95：{latest.ntfsSearchP95Ms ?? 0} ms；
        CPU（按单核计）：{latest.processCpuPctOfOneCore}%；内存：{latest.processRssMiB} MiB；
        索引中磁盘：{latest.ntfsActiveScanCount}
      </p>}
      {report && !latest && <p>尚无采样，程序运行后会自动留下本地记录。</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </details>;
}
