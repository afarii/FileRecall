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
    folders(): Promise<Array<{ path: string; addedAt: number }>>;
    historyFolders(): Promise<Array<{ path: string; count: number }>>;
    clearHistory(path: string): Promise<number>;
    removeFolder(path: string): Promise<void>;
    addFolder(): Promise<ScanResult | null>;
    rescan(): Promise<ScanResult[]>;
    search(query: string): Promise<FileRecord[]>;
    reveal(path: string): Promise<{ ok: boolean; message?: string }>;
  };
}
