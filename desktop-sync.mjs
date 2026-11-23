import { algorithmSourceView, readHistory, sourceView } from "./history-view.mjs";

const host = "com.filerecall.desktop";
const profileKey = "desktopSyncProfile";
const batchSize = 16;

function sourceSnapshot(source) {
  const url = source.context?.pageUrl;
  const title = source.context?.pageTitle;
  return {
    status: source.status,
    url: typeof url === "string" ? url.slice(0, 4097) : "",
    title: typeof title === "string" ? title.slice(0, 512) : "",
  };
}

export async function syncDesktop({ storage, runtime }, progress = () => {}) {
  let profile = (await storage.get(profileKey))[profileKey];
  if (!profile) {
    profile = crypto.randomUUID();
    await storage.set({ [profileKey]: profile });
  }
  const { items, skipped } = readHistory(await storage.get(null));
  const completed = items.filter(({ record }) => record.state === "complete");
  let synced = 0;
  let ignored = skipped;
  for (let offset = 0; offset < completed.length; offset += batchSize) {
    const records = completed.slice(offset, offset + batchSize).map(({ key, record }) => ({
      key,
      path: typeof record.filename === "string" ? record.filename.slice(0, 32768) : "",
      startedAt: Date.parse(record.startTime) || 0,
      algorithm: sourceSnapshot(algorithmSourceView(record)),
      effective: sourceSnapshot(sourceView(record)),
    }));
    try {
      const reply = await runtime.sendNativeMessage(host, { version: 1, profile, records });
      if (!reply?.ok || !Number.isInteger(reply.saved) || !Number.isInteger(reply.skipped)
        || reply.saved < 0 || reply.skipped < 0 || reply.saved + reply.skipped !== records.length) {
        throw new Error(reply?.error || "桌面端响应无效。");
      }
      synced += reply.saved;
      ignored += reply.skipped;
      progress(synced);
    } catch (error) {
      throw new Error(`已同步 ${synced} 条。请确认已注册桌面连接组件，再重试。`, { cause: error });
    }
  }
  return { synced, ignored };
}

const button = globalThis.document?.getElementById("desktop-sync");
button?.addEventListener("click", async () => {
  const status = document.getElementById("desktop-sync-status");
  button.disabled = true;
  try {
    if (!await chrome.permissions.request({ permissions: ["nativeMessaging"] })) {
      status.textContent = "桌面同步需要本地连接权限。";
      return;
    }
    status.textContent = "正在同步已完成下载…";
    const { synced, ignored } = await navigator.locks.request(host, () =>
      syncDesktop({ storage: chrome.storage.local, runtime: chrome.runtime },
        (count) => { status.textContent = `已同步 ${count} 条…`; }));
    status.textContent = synced || ignored ? `已同步 ${synced} 条，跳过 ${ignored} 条。` : "暂无已完成的下载。";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
