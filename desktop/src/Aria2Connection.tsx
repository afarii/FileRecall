import { useEffect, useState } from "react";

export default function Aria2Connection() {
  const [connection, setConnection] = useState<Aria2Status>();
  const [port, setPort] = useState("16800");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    window.fileRecall.aria2Status().then((status) => {
      setConnection(status);
      setPort(String(status.port));
    }).catch(() => {
      setFailed(true);
      setMessage("无法读取连接设置。");
    });
  }, []);

  async function perform(action: "connect" | "refresh" | "disconnect") {
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      if (action === "disconnect") {
        await window.fileRecall.disconnectAria2();
        setMessage("已停止自动同步，之前导入的记录仍可搜索。");
      } else {
        const stats = action === "connect" ? await window.fileRecall.connectAria2(Number(port), secret)
          : await window.fileRecall.refreshAria2();
        setMessage(`读到 ${stats.found} 个已完成文件，新增或更新 ${stats.changed} 条记录。`);
      }
      setSecret("");
      setConnection(await window.fileRecall.aria2Status());
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "读取下载器记录失败。");
    } finally { setBusy(false); }
  }

  return <details className="chrome-connection">
    <summary>Motrix／aria2</summary>
    <div className="connection-panel">
      <p>请启动本机下载器。在 Motrix 的高级设置中查看 RPC 端口和密钥。</p>
      <form onSubmit={(event) => { event.preventDefault(); void perform("connect"); }}>
        <label>本机 RPC 端口<input type="number" required min={1} max={65535} value={port}
          onChange={(event) => setPort(event.target.value)} /></label>
        <label>RPC 密钥<input type="password" maxLength={512} autoComplete="off" value={secret}
          placeholder={connection?.hasSecret && String(connection.port) === port ? "留空沿用已保存的密钥" : "未设置密钥时留空"}
          onChange={(event) => setSecret(event.target.value)} /></label>
        <button disabled={busy}>连接并同步</button>
      </form>
      {connection?.connected && <>
        <p>已配置端口 {connection.port}，运行时每 30 秒读取一次完成记录。</p>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={() => void perform("refresh")}>立即同步</button>
          <button className="secondary" disabled={busy} onClick={() => void perform("disconnect")}>断开连接</button>
        </div>
      </>}
      {message && <p className={failed ? "error" : undefined} role={failed ? "alert" : "status"}>{message}</p>}
    </div>
  </details>;
}
