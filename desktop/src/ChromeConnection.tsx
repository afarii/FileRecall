import { useEffect, useState } from "react";

export default function ChromeConnection({ refresh }: { refresh: () => void }) {
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

  return <details className="chrome-connection">
    <summary>Chrome 设置</summary>
    <div className="connection-panel">
      <p>在 Chrome 的 FileRecall 历史页发起同步。</p>
      {connection?.available && <>
        <p>首次连接请在 Chrome 扩展程序管理页（chrome://extensions）开启开发者模式，复制 FileRecall 的扩展 ID。</p>
        <form onSubmit={(event) => { event.preventDefault(); void connectChrome(); }}>
          <input aria-label="Chrome 扩展 ID" placeholder="粘贴 FileRecall 扩展 ID" spellCheck={false}
            value={extensionId} onChange={(event) => setExtensionId(event.target.value)} />
          <button disabled={connecting || !/^[a-p]{32}$/.test(extensionId.trim())}>保存连接</button>
        </form>
        {connection.extensionId && <p role="status">连接已配置。</p>}
      </>}
      {connectionError && <p className="error" role="alert">{connectionError}</p>}
      <button className="secondary" onClick={refresh}>刷新下载记录</button>
    </div>
  </details>;
}
