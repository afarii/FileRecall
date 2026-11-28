export type SearchPhase = "searching" | "supplementing" | "complete" | "failed";
export type SearchDisplay = "searching" | "partial" | "results" | "failed" | "empty";

// A zero count only becomes an empty result when every requested search
// stream has settled. Debounce, fast lookup and deferred lookup are all pending.
export function searchDisplay({
  inputPending, filePhase, historyPending, historyFailed, hasResults,
}: {
  inputPending: boolean;
  filePhase: SearchPhase | undefined;
  historyPending: boolean;
  historyFailed: boolean;
  hasResults: boolean;
}): SearchDisplay {
  const pending = inputPending || filePhase === undefined ||
    filePhase === "searching" || filePhase === "supplementing" || historyPending;
  if (hasResults) return pending ? "partial" : "results";
  if (pending) return "searching";
  if (filePhase === "failed" || historyFailed) return "failed";
  return "empty";
}

export function preservePreviousResults({
  display, query, favorites, previousFavorites, previousCount,
}: {
  display: SearchDisplay;
  query: string;
  favorites: boolean;
  previousFavorites: boolean | undefined;
  previousCount: number;
}): boolean {
  return display === "searching" && Boolean(query.trim()) &&
    favorites === previousFavorites && previousCount > 0;
}

export function canActivateSearchResult({
  inputPending, showingPrevious, hasResults,
}: {
  inputPending: boolean;
  showingPrevious: boolean;
  hasResults: boolean;
}): boolean {
  return !inputPending && !showingPrevious && hasResults;
}

export type FileSearchSnapshot<T> = { query: string; favorites: boolean; files: T[]; phase: SearchPhase; error?: string };

// Retain the settled same-query rows while a background refresh is incomplete.
// A new query can render its fast results immediately. Only a completed refresh
// may remove rows (e.g. when a file was deleted).
export function fastSearchSnapshot<T>(previous: FileSearchSnapshot<T> | undefined,
  query: string, favorites: boolean, files: T[], supplement: boolean): FileSearchSnapshot<T> {
  const same = previous?.query === query && previous.favorites === favorites;
  return { query, favorites, phase: supplement ? "supplementing" : "complete",
    files: supplement && same && previous.files.length ? previous.files : files };
}
