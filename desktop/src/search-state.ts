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
