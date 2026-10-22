// An adjustable upper bound for recent clicks, not a guaranteed download latency.
export const CONTEXT_WINDOW_MS = 60_000;

function parseHttpUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function compareUrls(left, right) {
  const leftUrl = parseHttpUrl(left);
  const rightUrl = parseHttpUrl(right);
  if (!leftUrl || !rightUrl) return null;
  if (left === right) return "exact";
  if (leftUrl.href === rightUrl.href) return "normalized";
  leftUrl.hash = "";
  rightUrl.hash = "";
  return leftUrl.href === rightUrl.href ? "without_fragment" : null;
}

function isOriginOnlyReferrer(pageUrl, referrer) {
  const page = parseHttpUrl(pageUrl);
  const source = parseHttpUrl(referrer);
  return Boolean(page && source && page.origin === source.origin
    && source.href === `${source.origin}/`);
}

export function createContextRecord(context, receivedAt) {
  if (!context || typeof context.pageTitle !== "string"
    || typeof context.clickedText !== "string" || typeof context.timestamp !== "string"
    || !parseHttpUrl(context.pageUrl)
    || (context.linkUrl !== null && !parseHttpUrl(context.linkUrl))) return null;

  const clickedAt = Date.parse(context.timestamp);
  if (!Number.isFinite(clickedAt) || !Number.isFinite(receivedAt)
    || clickedAt > receivedAt) return null;

  return {
    context: {
      pageUrl: context.pageUrl,
      pageTitle: context.pageTitle,
      linkUrl: context.linkUrl,
      clickedText: context.clickedText,
      timestamp: context.timestamp,
    },
    clickedAt,
    receivedAt,
    used: false,
  };
}

export function pruneContexts(records, now, windowMs = CONTEXT_WINDOW_MS) {
  // Keep used records until expiry so removing them cannot promote a weaker click.
  return records.filter((record) => Number.isFinite(record.clickedAt)
    && record.clickedAt <= now && now - record.clickedAt <= windowMs);
}

function unknown(reason, candidateCount = 0) {
  return {
    status: "unknown",
    reason,
    candidateCount,
    context: null,
    candidate: null,
    delayMs: null,
    evidence: null,
    recordIndex: null,
  };
}

export function matchContext(download, records, windowMs = CONTEXT_WINDOW_MS) {
  const startedAt = typeof download.startTime === "string"
    ? Date.parse(download.startTime) : NaN;
  if (!Number.isFinite(startedAt)) return unknown("invalid_time");
  if (!parseHttpUrl(download.url)) return unknown("invalid_download_url");
  if (typeof download.referrer !== "string"
    || (download.referrer && !parseHttpUrl(download.referrer))) {
    return unknown("invalid_referrer");
  }

  const candidates = [];
  let recentCount = 0;
  for (const [recordIndex, record] of records.entries()) {
    const delayMs = startedAt - record.clickedAt;
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > windowMs) continue;
    recentCount += 1;

    const click = record.context;
    const linkMatch = compareUrls(click.linkUrl, download.url);
    const pageMatch = compareUrls(click.pageUrl, download.referrer);
    let status;
    let reason;
    let pageEvidence = pageMatch;

    if (linkMatch && pageMatch) {
      status = "matched";
      reason = "link_and_page";
    } else if (linkMatch && !download.referrer) {
      status = "candidate";
      reason = "link_only";
      pageEvidence = "missing";
    } else if (linkMatch && isOriginOnlyReferrer(click.pageUrl, download.referrer)) {
      status = "candidate";
      reason = "origin_only_referrer";
      pageEvidence = "origin_only";
    } else if (click.linkUrl === null && pageMatch) {
      status = "candidate";
      reason = "page_and_time";
    } else {
      continue;
    }

    candidates.push({
      recordIndex,
      status,
      reason,
      delayMs,
      evidence: { linkMatch: linkMatch ?? "unavailable", pageMatch: pageEvidence },
    });
  }

  if (candidates.length === 0) {
    return unknown(recentCount ? "no_compatible_context" : "no_recent_context");
  }
  // Do not choose the latest click or prefer a strong click over another viable one.
  if (candidates.length > 1) return unknown("ambiguous", candidates.length);

  const selected = candidates[0];
  const record = records[selected.recordIndex];
  if (record.used) return unknown("context_already_used", 1);

  return {
    ...selected,
    candidateCount: 1,
    context: selected.status === "matched" ? record.context : null,
    candidate: selected.status === "candidate" ? record.context : null,
    recordIndex: selected.status === "matched" ? selected.recordIndex : null,
  };
}
