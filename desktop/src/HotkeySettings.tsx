import { useEffect, useState } from "react";

export default function HotkeySettings() {
  const [value, setValue] = useState("Ctrl+Shift+Space");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.fileRecall.hotkey().then(({ shortcut, registered }) => {
      setValue(shortcut);
      if (!registered) setMessage("当前热键未注册，可能已被其他应用占用。");
    }).catch(() => setMessage("无法读取热键设置。"));
  }, []);

  async function save() {
    setBusy(true);
    try {
      const result = await window.fileRecall.setHotkey(value);
      setMessage(result.ok ? "搜索热键已生效。" : result.message);
      if (result.ok) setValue(result.shortcut);
    } catch {
      setMessage("无法保存热键。");
    } finally {
      setBusy(false);
    }
  }

  return <details className="chrome-connection">
    <summary>搜索热键</summary>
    <div className="connection-panel">
      <p>FileRecall 运行时，在其他窗口按热键可呼出搜索。</p>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input aria-label="全局搜索热键" value={value} maxLength={50} spellCheck={false}
          onChange={(event) => setValue(event.target.value)} />
        <button disabled={busy || !value.trim()}>保存热键</button>
      </form>
      {message && <p role="status">{message}</p>}
    </div>
  </details>;
}
