import { createContextRecord, matchContext, pruneContexts } from "./context-matcher.mjs";
import { createDownloadRecordStore } from "./download-record-store.mjs";
import { importHistoryBatch } from "./history-import.mjs";

let recentContexts = [];
const downloadRecords = createDownloadRecordStore(chrome.storage.local);

chrome.action.onClicked.addListener(async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  } catch (error) {
    console.error("Could not open download history:", error);
  }
});

function withoutFragment(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  console.log("Download created:", {
    id: downloadItem.id,
    filename: downloadItem.filename,
    url: downloadItem.url,
    referrer: downloadItem.referrer,
    startTime: downloadItem.startTime,
  });   

  recentContexts = pruneContexts(recentContexts, Date.now());
  const { recordIndex, ...association } = matchContext(downloadItem, recentContexts);
  if (recordIndex !== null) recentContexts[recordIndex].used = true;
  console.log("Download context:", {
    id: downloadItem.id,
    url: downloadItem.url,
    referrer: downloadItem.referrer,
    startTime: downloadItem.startTime,
    filename: downloadItem.filename,
    state: downloadItem.state,
    ...association,
  });

  try {
    await downloadRecords.create(downloadItem, association);
  } catch (error) {
    console.error("Download record creation failed:", error);
  }

  const sourceUrl = downloadItem.referrer;
  let sourceTitle = "未知";

  if (sourceUrl) {
    try {
      const tabs = await chrome.tabs.query({});
      let matches = tabs.filter((tab) => tab.url === sourceUrl);

      if (matches.length === 0) {
        const sourceWithoutFragment = withoutFragment(sourceUrl);
        if (sourceWithoutFragment) {
          matches = tabs.filter(
            (tab) => withoutFragment(tab.url) === sourceWithoutFragment,
          );
        }
      }

      const title = matches[0]?.title;

      if (title?.trim() && matches.every((tab) => tab.title === title)) {
        sourceTitle = title;
      }
    } catch {
      // Keep the title unknown if the tab query fails.
    }
  }

  console.log("Download source:", {
    id: downloadItem.id,
    sourceUrl,
    sourceTitle,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ANNOTATE_DOWNLOAD") {
    if (sender?.url !== chrome.runtime.getURL("history.html")) {
      sendResponse({ error: "请从 FileRecall 历史详情保存标注。" });
      return;
    }
    downloadRecords.annotate(message.id, message.change)
      .then(() => sendResponse({ saved: true }), (error) => sendResponse({ error: error?.message ?? "保存失败，请重试。" }));
    return true;
  }
  if (message?.type === "IMPORT_CHROME_HISTORY") {
    if (sender?.url !== chrome.runtime.getURL("history.html")) {
      sendResponse({ error: "请从 FileRecall 历史页主动导入。" });
      return;
    }
    importHistoryBatch(chrome.downloads, downloadRecords, message.cursor ?? null)
      .then(sendResponse, (error) => sendResponse({ error: error?.message ?? "导入失败，请重试。" }));
    return true;
  }
  if (message?.type === "CLICK_CONTEXT") {
    console.log("Click context:", message.context);
    const now = Date.now();
    const record = createContextRecord(message.context, now);
    if (record) recentContexts.push(record);
    recentContexts = pruneContexts(recentContexts, now);
  }
});

chrome.downloads.onChanged.addListener(async (downloadDelta) => {
  if (downloadDelta.filename) {
    console.log("Download filename changed:", {
      id: downloadDelta.id,
      filename: downloadDelta.filename.current,
    });
  }

  if (downloadDelta.state) {
    console.log("Download state changed:", {
      id: downloadDelta.id,
      state: downloadDelta.state.current,
    });
  }

  try {
    await downloadRecords.update(downloadDelta);
  } catch (error) {
    console.error("Download record update failed:", error);
  }
});
