import { text } from "./history-view.mjs";

// Keep Chrome's current file availability separate from saved FileRecall records.
export function createFileActions(chrome, notify) {
  let id = null;
  let generation = 0;
  let ready = false;
  let busy = false;
  let recheck = false;
  let message = "";
  const publish = () => notify({
    showDisabled: !ready || busy || typeof chrome?.downloads?.show !== "function",
    openDisabled: !ready || busy || typeof chrome?.downloads?.open !== "function",
    message,
  });

  async function inspect(downloadId) {
    if (busy && id === downloadId) { recheck = true; return; }
    const current = ++generation;
    id = downloadId;
    ready = false;
    busy = false;
    recheck = false;
    message = "正在检查 Chrome 下载记录…";
    publish();
    try {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error("下载 ID 缺失或无效，无法操作本地文件。");
      if (typeof chrome?.downloads?.search !== "function") throw new Error("Chrome downloads API 不可用。");
      const records = await chrome.downloads.search({ id });
      if (current !== generation) return;
      const item = records.find((item) => item.id === id);
      if (!item) throw new Error("Chrome 下载记录已丢失；FileRecall 历史记录仍保留。");
      if (item.state === "in_progress") throw new Error("文件仍在下载中，请完成下载后再操作。");
      if (item.state === "interrupted") throw new Error("下载已中断，无法操作完整文件。");
      if (item.state !== "complete") throw new Error("无法确认下载已完成，暂不能操作本地文件。");
      if (item.exists === false) throw new Error("文件已移动或删除，Chrome 无法访问原文件。");
      if (item.exists !== true) throw new Error("无法确认文件是否存在，暂不能操作本地文件。");
      ready = true;
      message = typeof chrome.downloads.show !== "function" || typeof chrome.downloads.open !== "function"
        ? "Chrome 部分文件操作 API 不可用，对应按钮已禁用。"
        : "Chrome 记录显示文件可用；实际文件可能已移动或删除。";
    } catch (error) {
      if (current !== generation) return;
      message = text(error?.message, "检查本地文件失败，请重试。");
    }
    if (current === generation) publish();
  }

  function perform(action) {
    if (!["show", "open"].includes(action) || !ready || busy) return;
    const current = generation;
    busy = true;
    message = "正在提交请求…";
    publish();
    const finish = (error) => {
      if (current !== generation) return;
      busy = false;
      if (error) {
        ready = false;
        message = `操作失败：${text(error.message, "Chrome 未能执行请求，请检查文件、下载记录及权限。")}`;
      } else {
        message = action === "show"
          ? "已请求在文件夹中显示；Chrome 不提供定位结果，请在文件管理器中确认。"
          : "Chrome 已接受打开请求，请在系统应用中确认文件是否打开。";
      }
      publish();
      if (recheck) inspect(id);
    };
    try {
      if (typeof chrome?.downloads?.[action] !== "function") throw new Error("Chrome 文件操作 API 不可用。");
      // Invoke open synchronously from the click handler to preserve the user gesture.
      const result = chrome.downloads[action](id);
      if (typeof result?.then === "function") {
        result.then(() => finish(), finish);
      } else if (action === "show") {
        finish(chrome.runtime?.lastError);
      } else {
        finish(new Error("当前 Chrome 无法返回打开结果，请升级浏览器后重试。"));
      }
    } catch (error) {
      finish(error);
    }
  }

  function cancel() {
    generation++;
    id = null;
    ready = false;
    busy = false;
    recheck = false;
  }

  return { inspect, perform, cancel };
}
