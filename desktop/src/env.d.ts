interface FileRecord {
  path: string;
  rootPath: string;
  name: string;
  size: number;
  modifiedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: "present" | "missing";
}

interface IndexedFolder {
  path: string;
  addedAt: number;
  state: "waiting" | "scanning" | "watching" | "retrying";
  error: string;
  lastScanAt: number | null;
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
    reveal(path: string): Promise<{ ok: boolean; message?: string }>;
  };
}
