import {
  text, safeWebUrl, fileName, timestamp, formatTime, sourceView, algorithmSourceView, downloadState,
  REASONS, EVIDENCE, createHistoryLoader, searchHistory, filterHistory,
} from "./history-view.mjs";
import { createFileActions } from "./history-file-actions.mjs";

const $ = (id) => document.getElementById(id);
const dialog = $("record-detail");
const refresh = $("refresh");
const search = $("history-search");
const sourceFilter = $("source-filter");
const downloadFilter = $("download-filter");
const rowButtons = new Map();
let items = [];
let selectedKey = null;
let pageStatus = "loading";
let editorKey = null;
let noteDirty = false;
let sourceDirty = false;
let annotationBusy = false;
const fileActions = createFileActions(globalThis.chrome, (state) => {
  $("show-file").disabled = state.showDisabled;
  $("open-file").disabled = state.openDisabled;
  $("file-action-status").textContent = state.message;
});

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${className}`);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function tile(record) {
  const node = element("span", "file-tile");
  node.setAttribute("aria-hidden", "true");
  const extension = fileName(record).split(".").at(-1).toUpperCase();
  node.dataset.extension = ["PDF", "ZIP", "GZ", "7Z", "EXE", "DMG", "MSI"].includes(extension) ? extension : "";
  node.append(icon("file"));
  return node;
}

function badge(source) {
  return element("span", `badge ${source.status}`, source.label);
}

function stateLabel(record) {
  const state = downloadState(record.state);
  const node = element("span", `download-state ${state.tone}`);
  node.append(state.tone === "complete" ? icon("check") : element("span", "state-dot"), document.createTextNode(state.label));
  return node;
}

function field(list, label, value, { url = false, path = false } = {}) {
  const wrapper = element("div", "detail-field");
  const description = element("dd", path ? "is-path" : "");
  const safeUrl = url ? safeWebUrl(value) : null;
  if (safeUrl) {
    const link = element("a", "", text(value));
    link.href = safeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    description.append(link);
  } else {
    description.textContent = text(value);
  }
  wrapper.append(element("dt", "", label), description);
  list.append(wrapper);
}

function section(container, heading, className = "") {
  const node = element("section", `detail-section ${className}`);
  const list = element("dl");
  node.append(element("h3", "", heading), list);
  container.append(node);
  return list;
}

function renderDetails(record) {
  const container = $("detail-record");
  const source = sourceView(record);
  const fragment = document.createDocumentFragment();
  const summary = element("div", "detail-summary");
  const copy = element("div", "detail-summary-copy");
  const title = element("h2", "", fileName(record));
  title.id = "detail-title";
  copy.append(title, stateLabel(record));
  summary.append(tile(record), copy);
  const banner = element("div", `source-banner ${source.status}`);
  banner.append(badge(source), element("p", "", source.note));
  fragment.append(summary, banner);

  if (source.context) {
    const page = section(fragment, { candidate: "候选页面 · 未确认", manual: "来源页面 · 人工填写",
      confirmed: "来源页面 · 人工确认候选", matched: "已确认的来源页面" }[source.status]);
    field(page, "页面标题", source.context.pageTitle);
    field(page, "页面 URL", source.context.pageUrl, { url: true });
  }

  const facts = section(fragment, "下载信息");
  field(facts, "下载 ID", Number.isSafeInteger(record.id) ? String(record.id) : null);
  field(facts, "文件名", fileName(record));
  field(facts, "本地保存路径", record.filename, { path: true });
  field(facts, "下载状态", downloadState(record.state).label);
  field(facts, "开始时间", formatTime(record.startTime));
  field(facts, "下载 URL", record.url, { url: true });
  field(facts, "Referrer · 下载事件提供的引用来源", record.referrer, { url: true });

  if (source.context && source.status !== "manual") {
    const click = section(fragment, source.status === "candidate" ? "候选点击上下文 · 未确认" : "点击时的上下文", "context");
    field(click, "链接目标 URL", source.context.linkUrl, { url: true });
    field(click, "点击文字", source.context.clickedText);
    field(click, "点击时间", formatTime(source.context.timestamp));
  }

  const evidence = element("details", "evidence-section");
  const body = element("dl", "evidence-body");
  const savedSource = record.source && typeof record.source === "object" ? record.source : {};
  const original = algorithmSourceView(record);
  field(body, "原始算法关联状态", original.label);
  if (original.context) {
    field(body, "原始页面标题", original.context.pageTitle);
    field(body, "原始页面 URL", original.context.pageUrl, { url: true });
    field(body, "原始链接目标 URL", original.context.linkUrl, { url: true });
    field(body, "原始点击文字", original.context.clickedText);
    field(body, "原始点击时间", formatTime(original.context.timestamp));
  }
  const reason = typeof savedSource.reason === "string" ? savedSource.reason : "unspecified";
  field(body, "关联原因", Object.hasOwn(REASONS, reason) ? REASONS[reason] : "未识别的关联原因");
  field(body, "原始原因", reason);
  for (const [key, label] of [["linkMatch", "链接地址"], ["pageMatch", "来源页面"]]) {
    const value = savedSource.evidence?.[key];
    field(body, label, typeof value === "string" ? Object.hasOwn(EVIDENCE, value) ? EVIDENCE[value] : value : null);
  }
  field(body, "候选数量", Number.isSafeInteger(savedSource.candidateCount) ? String(savedSource.candidateCount) : null);
  field(body, "点击至下载的时间差", Number.isFinite(savedSource.delayMs) ? `${savedSource.delayMs / 1000} 秒` : null);
  evidence.append(element("summary", "", "查看关联依据"), body);
  if (text(record.note, "")) {
    const notes = section(fragment, "备注");
    field(notes, "人工备注", record.note);
  }
  fragment.append(evidence, element("p", "detail-updated", `记录更新时间：${formatTime(record.updatedAt)}`));
  container.replaceChildren(fragment);
  renderAnnotationEditor(record);
  fileActions.inspect(record.id);
}

function renderAnnotationEditor(record) {
  if (editorKey !== selectedKey) {
    editorKey = selectedKey;
    noteDirty = false;
    sourceDirty = false;
    $("annotation-editor").open = false;
    $("annotation-status").textContent = "";
  }
  const source = sourceView(record);
  const candidate = algorithmSourceView(record).status === "candidate";
  const annotated = ["confirmed", "manual", "rejected"].includes(source.status);
  $("confirm-source").hidden = $("reject-source").hidden = !candidate || annotated;
  $("undo-source").hidden = !record.userSource;
  $("manual-source-fields").hidden = !["unknown", "rejected", "manual"].includes(source.status);
  if (!noteDirty) $("record-note").value = text(record.note, "");
  if (!sourceDirty) {
    $("manual-page-url").value = source.status === "manual" ? text(source.context.pageUrl, "") : "";
    $("manual-page-title").value = source.status === "manual" ? text(source.context.pageTitle, "") : "";
  }
  for (const id of ["confirm-source", "reject-source", "undo-source", "save-source", "save-note"]) {
    $(id).disabled = annotationBusy || !Number.isSafeInteger(record.id) || record.id < 0;
  }
}

function markSelection() {
  for (const [key, button] of rowButtons) button.setAttribute("aria-pressed", String(key === selectedKey && dialog.open));
}

function openDetails(key) {
  const item = items.find((item) => item.key === key);
  if (!item) return;
  selectedKey = key;
  renderDetails(item.record);
  if (!dialog.open) dialog.showModal();
  // Reset only on opening; live updates should preserve the reader's position.
  $("detail-content").scrollTop = 0;
  markSelection();
}

function renderRecords(visibleItems) {
  const fragment = document.createDocumentFragment();
  const focusedKey = [...rowButtons].find(([, button]) => button === document.activeElement)?.[0];
  rowButtons.clear();
  for (const { key, record } of visibleItems) {
    const row = element("li");
    const button = element("button", "record-button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    const file = element("span", "file-cell");
    const copy = element("span", "file-copy");
    const name = element("span", "file-name", fileName(record));
    name.title = fileName(record);
    const path = text(record.filename, "");
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const subtitle = element("span", "file-subtitle", separator >= 0 ? path.slice(0, separator) || "/" : "保存路径未记录");
    copy.append(name, subtitle);
    file.append(tile(record), copy);
    const source = sourceView(record);
    const sourceCell = element("span", "source-cell");
    const site = element("span", "source-site", source.site);
    site.title = source.context ? source.title : source.site;
    sourceCell.append(site, badge(source));
    const time = element("span", "time-cell", formatTime(record.startTime, true));
    const rawTime = timestamp(record.startTime);
    if (rawTime !== null) time.append(element("span", "", new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(rawTime)));
    button.append(file, sourceCell, time, stateLabel(record), icon("arrow", "row-arrow"));
    button.addEventListener("click", () => openDetails(key));
    rowButtons.set(key, button);
    row.append(button);
    fragment.append(row);
  }
  $("records").replaceChildren(fragment);
  markSelection();
  if (focusedKey) rowButtons.get(focusedKey)?.focus({ preventScroll: true });
  if (dialog.open) {
    const selected = items.find((item) => item.key === selectedKey);
    if (selected) renderDetails(selected.record);
    else dialog.close();
  }
}

function showState(title, description, error = null) {
  $("history-state").hidden = false;
  $("record-list").hidden = true;
  $("state-title").textContent = title;
  $("state-description").textContent = description;
  $("history-state").classList.toggle("is-error", error !== null);
  $("state-icon").replaceChildren(icon(error === null ? "history" : "alert"));
  $("error-detail").hidden = error === null;
  $("error-detail").textContent = error ?? "";
  $("retry").hidden = error === null;
}

function updatePage(state) {
  pageStatus = state.status;
  const loading = state.status === "loading";
  refresh.disabled = loading;
  $("retry").disabled = loading;
  $("records").setAttribute("aria-busy", String(loading));
  if (loading) {
    if (!items.length || $("record-list").hidden) showState("正在读取下载记录", "稍等片刻，你的下载即将呈现。");
    return;
  }
  if (state.status === "error") {
    if (dialog.open) dialog.close();
    $("record-count").textContent = "—";
    $("data-warning").hidden = true;
    showState("暂时无法读取下载记录", "请重试。如果问题持续，请重新加载扩展。", state.message);
    return;
  }
  items = state.items;
  $("record-count").textContent = String(items.length);
  $("data-warning").hidden = state.skipped === 0;
  $("data-warning").textContent = `有 ${state.skipped} 条记录格式异常，暂时无法展示。原始数据未被修改。`;
  renderResults();
}

function renderResults() {
  const visibleItems = filterHistory(searchHistory(items, search.value), {
    sourceStatus: sourceFilter.value, downloadStatus: downloadFilter.value,
  });
  const hasConditions = search.value.trim() || sourceFilter.value || downloadFilter.value;
  renderRecords(visibleItems);
  if (visibleItems.length) {
    $("history-state").hidden = true;
    $("record-list").hidden = false;
  } else if (hasConditions) {
    showState("没有找到匹配的下载记录", "请调整搜索关键词或筛选条件；清空搜索并将两组筛选设为“全部”可查看全部记录。");
  } else {
    showState("还没有下载记录", "在浏览器中下载一个文件，它会出现在这里。");
  }
  $("announcement").textContent = hasConditions
    ? `找到 ${visibleItems.length} 条匹配记录，共 ${items.length} 条下载记录`
    : `已读取 ${items.length} 条下载记录`;
}

search.addEventListener("input", () => {
  if (pageStatus === "ready") renderResults();
});
for (const filter of [sourceFilter, downloadFilter]) {
  filter.addEventListener("change", () => {
    if (pageStatus === "ready") renderResults();
  });
}

dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  fileActions.cancel();
  const key = selectedKey;
  selectedKey = null;
  markSelection();
  (rowButtons.get(key) ?? search).focus({ preventScroll: true });
});

$("show-file").addEventListener("click", () => fileActions.perform("show"));
$("open-file").addEventListener("click", () => fileActions.perform("open"));
$("check-file").addEventListener("click", () => {
  const selected = items.find((item) => item.key === selectedKey);
  if (selected) fileActions.inspect(selected.record.id);
});
$("record-note").addEventListener("input", () => { noteDirty = true; });
for (const id of ["manual-page-url", "manual-page-title"]) {
  $(id).addEventListener("input", () => { sourceDirty = true; });
}
globalThis.chrome?.downloads?.onChanged?.addListener((delta) => {
  const selected = items.find((item) => item.key === selectedKey);
  if (dialog.open && selected?.record.id === delta.id && (delta.exists || delta.state)) fileActions.inspect(delta.id);
});
globalThis.chrome?.downloads?.onErased?.addListener((id) => {
  const selected = items.find((item) => item.key === selectedKey);
  if (dialog.open && selected?.record.id === id) fileActions.inspect(id);
});

if (globalThis.chrome?.storage?.local) {
  const load = createHistoryLoader(chrome.storage.local, updatePage);
  async function annotate(change) {
    if (annotationBusy) return;
    const selected = items.find((item) => item.key === selectedKey);
    if (!selected) return;
    const key = selectedKey;
    annotationBusy = true;
    renderAnnotationEditor(selected.record);
    $("annotation-status").textContent = "正在保存…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "ANNOTATE_DOWNLOAD", id: selected.record.id, change });
      if (!result?.saved) throw new Error(result?.error ?? "未收到保存结果，请重试。");
      if (selectedKey === key) {
        if (change.kind === "note") {
          if ($("record-note").value === change.note) noteDirty = false;
        } else if (change.kind !== "manual" || ($("manual-page-url").value === change.pageUrl
          && $("manual-page-title").value === change.pageTitle)) sourceDirty = false;
        $("annotation-status").textContent = "已保存。";
      }
      await load();
    } catch (error) {
      if (selectedKey === key) $("annotation-status").textContent = `保存失败：${text(error?.message)}`;
    } finally {
      annotationBusy = false;
      const current = items.find((item) => item.key === selectedKey);
      if (current) renderAnnotationEditor(current.record);
    }
  }
  $("confirm-source").addEventListener("click", () => annotate({ kind: "confirm" }));
  $("reject-source").addEventListener("click", () => annotate({ kind: "reject" }));
  $("undo-source").addEventListener("click", () => annotate({ kind: "clearSource" }));
  $("save-source").addEventListener("click", () => annotate({ kind: "manual",
    pageUrl: $("manual-page-url").value, pageTitle: $("manual-page-title").value }));
  $("save-note").addEventListener("click", () => annotate({ kind: "note", note: $("record-note").value }));
  let importCursor = null;
  let importBusy = false;
  let totals = { added: 0, skipped: 0, failed: 0 };
  async function importBatch(restart) {
    if (importBusy) return;
    importBusy = true;
    $("import-history").disabled = true;
    $("import-next").disabled = true;
    if (restart) {
      importCursor = null;
      totals = { added: 0, skipped: 0, failed: 0 };
    }
    $("import-status").textContent = "正在导入本批 Chrome 下载历史…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "IMPORT_CHROME_HISTORY", cursor: importCursor });
      if (!result || result.error) throw new Error(result?.error ?? "未收到导入结果，请重新导入。");
      for (const key of Object.keys(totals)) totals[key] += result[key];
      importCursor = result.cursor;
      $("import-next").hidden = !result.hasMore;
      $("import-status").textContent = `累计新增 ${totals.added} 条，跳过 ${totals.skipped} 条，失败 ${totals.failed} 条。`
        + (result.hasMore ? "可继续导入下一批。" : "已处理完 Chrome 返回的历史。")
        + (totals.failed ? "失败记录可重新导入重试，已保存的记录会跳过。" : "")
        + (result.errors.length ? ` ${result.errors.join("；")}` : "");
    } catch (error) {
      $("import-next").hidden = importCursor === null;
      $("import-status").textContent = `导入未完成：${text(error?.message)}。已保存的记录仍保留，可重试。`
        + ` 累计已报告新增 ${totals.added} 条，跳过 ${totals.skipped} 条，失败 ${totals.failed} 条。`;
    } finally {
      importBusy = false;
      $("import-history").disabled = false;
      $("import-history").textContent = "重新导入 Chrome 历史";
      $("import-next").disabled = false;
      await load();
    }
  }
  $("import-history").addEventListener("click", () => importBatch(true));
  $("import-next").addEventListener("click", () => importBatch(false));
  refresh.addEventListener("click", load);
  $("retry").addEventListener("click", load);
  chrome.storage.onChanged.addListener((changes, area) => {
    // The batch's final load includes both imported records and concurrent live updates.
    if (!importBusy && area === "local" && Object.keys(changes).some((key) => key.startsWith("download:"))) load();
  });
  load();
} else {
  $("import-history").disabled = true;
  updatePage({ status: "error", message: "请通过 FileRecall 扩展入口打开此页面。" });
}
