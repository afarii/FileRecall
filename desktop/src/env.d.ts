interface FileRecord {
  path: string;
  rootPath: string;
  name: string;
  size: number;
  modifiedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: "present" | "missing";
  currentPath: string | null;
  possiblePath: string | null;
  textMatched: 0 | 1;
}

interface IndexedFolder {
  path: string;
  addedAt: number;
  state: "waiting" | "scanning" | "watching" | "retrying";
  error: string;
  lastScanAt: number | null;
}

interface BrowserDownload {
  id: string;
  path: string;
  name: string;
  startedAt: number;
  sourceStatus: "matched" | "confirmed" | "manual" | "candidate" | "unknown" | "rejected";
  sourceTitle: string;
  domain: string;
  canOpenSource: boolean;
  pathStatus: "present" | "missing" | "unknown";
}

interface ScanResult {
  folder: string;
  indexed?: number;
  skipped?: number;
  missing?: number;
  complete: boolean;
  error?: string;
}

interface Window {
  fileRecall: {
    folders(): Promise<IndexedFolder[]>;
    onChanged(callback: () => void): () => void;
    historyFolders(): Promise<Array<{ path: string; count: number }>>;
    clearHistory(path: string): Promise<number>;
    removeFolder(path: string): Promise<void>;
    addFolder(): Promise<ScanResult | null>;
    rescan(): Promise<ScanResult[]>;
    search(query: string): Promise<FileRecord[]>;
    textEnabled(): Promise<boolean>;
    setTextEnabled(enabled: boolean): Promise<void>;
    downloads(query: string): Promise<BrowserDownload[]>;
    chromeStatus(): Promise<{ available: boolean; extensionId: string | null }>;
    connectChrome(extensionId: string): Promise<string | null>;
    openSource(id: string): Promise<boolean>;
    reveal(path: string): Promise<{ ok: boolean; message?: string }>;
  };
}
