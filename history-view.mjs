import { DOWNLOAD_RECORD_PREFIX } from "./download-record-store.mjs";

export function text(value, fallback = "未记录") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function safeWebUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function fileName(record) {
  const path = text(record.filename, "");
  const name = path.split(/[\\/]/).at(-1);
  return name || (record.state === "in_progress" ? "文件名尚未确定" : "未命名文件");
}

export function timestamp(value) {
  const time = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

export function formatTime(value, dateOnly = false) {
  const time = timestamp(value);
  if (time === null) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
  }).format(time);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function sourceView(record) {
  const source = isObject(record.source) ? record.source : {};
  let status = ["matched", "candidate", "unknown"].includes(source.status) ? source.status : "unknown";
  const context = status === "matched" ? source.context : status === "candidate" ? source.candidate : null;
  const incomplete = status !== "unknown" && !isObject(context);
  if (incomplete) status = "unknown";
  const selected = status === "unknown" ? null : context;
  const url = selected ? safeWebUrl(selected.pageUrl) : null;
  return {
    status,
    context: selected,
    label: { matched: "来源已确认", candidate: "候选 · 未确认", unknown: "来源未知" }[status],
    site: url ? new URL(url).hostname : status === "unknown" ? "未知来源" : "页面地址未记录",
    title: selected ? text(selected.pageTitle, "页面标题未记录") : "暂无可靠的页面上下文",
    note: incomplete ? "来源关联信息不完整，暂按未知展示。" : {
      matched: "已根据保存的匹配证据关联到点击时的页面。",
      candidate: "以下上下文仅为候选，尚未确认为本次下载的来源。",
      unknown: "暂无可靠的来源上下文。下载地址和 referrer 仅作为原始信息保留。",
    }[status],
  };
}

export function downloadState(value) {
  const states = {
    complete: { label: "已完成", tone: "complete" },
    in_progress: { label: "下载中", tone: "progress" },
    interrupted: { label: "已中断", tone: "interrupted" },
  };
  return typeof value === "string" && Object.hasOwn(states, value)
    ? states[value] : { label: "状态未知", tone: "unknown" };
}

export const REASONS = {
  link_and_page: "下载链接与来源页面一致",
  link_only: "链接一致，但缺少 referrer",
  origin_only_referrer: "链接一致，referrer 仅保留网站地址",
  page_and_time: "页面与时间接近，缺少目标链接证据",
  ambiguous: "存在多个无法可靠区分的点击",
  no_recent_context: "没有可用的近期点击上下文",
  no_compatible_context: "未找到符合条件的点击上下文",
  context_already_used: "对应点击已用于其他下载",
  invalid_time: "时间信息无效",
  invalid_download_url: "下载地址无法参与匹配",
  invalid_referrer: "referrer 无效",
  creation_event_unavailable: "未收到下载创建事件",
  invalid_association: "关联信息不完整",
  unspecified: "未记录关联原因",
};

export const EVIDENCE = {
  exact: "完全一致", normalized: "规范化后一致", without_fragment: "忽略 # 片段后一致",
  origin_only: "仅网站地址一致", missing: "缺失", unavailable: "未提供",
};

export function readHistory(data) {
  const items = [];
  let skipped = 0;
  for (const [key, record] of Object.entries(isObject(data) ? data : {})) {
    if (!key.startsWith(DOWNLOAD_RECORD_PREFIX)) continue;
    if (!isObject(record)) { skipped++; continue; }
    items.push({ key, record });
  }
  items.sort((a, b) => {
    const aTime = timestamp(a.record.startTime);
    const bTime = timestamp(b.record.startTime);
    if (aTime !== bTime) return (bTime ?? -Infinity) - (aTime ?? -Infinity);
    return a.key.localeCompare(b.key);
  });
  return { items, skipped };
}

export function createHistoryLoader(storage, notify) {
  let generation = 0;
  return async function load() {
    const current = ++generation;
    notify({ status: "loading" });
    try {
      const data = await storage.get(null);
      if (current === generation) notify({ status: "ready", ...readHistory(data) });
    } catch (error) {
      if (current === generation) notify({ status: "error", message: text(error?.message, "本地存储暂时不可用") });
    }
  };
}
