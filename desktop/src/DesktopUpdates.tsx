import { useEffect, useState } from "react";

export default function DesktopUpdates() {
  const [status, setStatus] = useState<DesktopUpdateStatus>();
  const [error, setError] = useState("");
  const api = window.fileRecall;

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onUpdateStatus(setStatus);
    void api.updateStatus().then((value) => {
      if (active) setStatus(value);
    }).catch(() => { if (active) setError("无法读取软件更新状态。"); });
    return () => { active = false; unsubscribe(); };
  }, [api]);

  function run(action: () => Promise<DesktopUpdateStatus>) {
    setError("");
    void action().catch(() => setError("更新操作失败，请重试。"));
  }

  const phase = status?.phase;
  const messages = {
    idle: "可手动检查预览版更新。",
    unsupported: "应用内更新适用于 Windows 安装版。",
    checking: "正在检查更新…",
    current: "当前已是最新版本。",
    available: `版本 ${status?.version} 可下载。`,
    downloading: `正在下载更新（${status?.percent ?? 0}%）…`,
    ready: `版本 ${status?.version} 已下载，可以安装。`,
    installing: "正在启动更新安装程序…",
  };
  return <details className="chrome-connection">
    <summary>{phase === "available" || phase === "ready" ? "软件更新（有新版）" : "软件更新"}</summary>
    <div className="connection-panel">
      {status?.currentVersion && <p>当前版本 {status.currentVersion}</p>}
      <p role="status">{error || status?.message || (phase ? messages[phase] : "正在读取更新状态…")}</p>
      {(phase === "idle" || phase === "current" || phase === "checking") &&
        <button disabled={phase === "checking"} onClick={() => run(api.checkUpdate)}>检查更新</button>}
      {phase === "available" && <button onClick={() => run(api.downloadUpdate)}>下载新版</button>}
      {phase === "ready" && <button onClick={() => run(api.installUpdate)}>重启并安装</button>}
    </div>
  </details>;
}
