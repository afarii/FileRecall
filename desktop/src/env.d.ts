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
  favorite: 0 | 1;
  annotationMatched: 0 | 1;
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
  sourceStatus: "matched" | "confirmed" | "manual" | "candidate" | "unknown" | "rejected" | "direct";
  manager: "chrome" | "aria2" | "motw";
  sourceTitle: string;
  domain: string;
  canOpenSource: boolean;
  pathStatus: "present" | "missing" | "unknown";
}

type SourceRecord = Omit<BrowserDownload, "pathStatus">;
type SourceDecision = "confirmed" | "rejected" | "undo";
interface FileAnnotation {
  favorite: boolean;
  note: string;
  tags: string[];
}

interface MotwEvidence {
  zoneId: number | null;
  hostUrl: string | null;
  referrerUrl: string | null;
  observedAt?: number | null;
  historical?: boolean;
}

interface FileProvenance {
  identity: string | null;
  confirmed: SourceRecord | null;
  candidates: Array<SourceRecord & { evidence: string }>;
  rejected: SourceRecord[];
  aliases: Array<Pick<FileRecord, "path" | "name" | "firstSeenAt" | "lastSeenAt" | "status">>;
  annotation: FileAnnotation | null;
}

interface ScanResult {
  folder: string;
  indexed?: number;
  skipped?: number;
  missing?: number;
  complete: boolean;
  error?: string;
}

interface ModelStatus {
  ready: boolean;
  downloading: boolean;
  downloaded: number;
  total: number;
}

interface SemanticResult {
  files: FileRecord[];
  indexed: number;
  truncated: boolean;
}

interface Aria2Status {
  connected: boolean;
  port: number;
  hasSecret: boolean;
}

interface Aria2Sync {
  found: number;
  changed: number;
}

interface DesktopUpdateStatus {
  currentVersion: string;
  phase: "idle" | "unsupported" | "checking" | "current" | "available" | "downloading" | "ready" | "installing";
  version?: string;
  percent?: number;
  message?: string;
}

interface NtfsStatus {
  available: boolean;
  autoPhase?: "idle" | "discovering" | "authorizing" | "ready" | "permission-required" | "error";
  autoMessage?: string;
  connected: boolean;
  drives: Array<{ drive: string; phase: "disconnected" | "building" | "rebuild" | "catching-up" | "ready" | "error"; message?: string }>;
}

interface NtfsResult {
  id: string;
  drive: string;
  path: string;
  name: string;
  directory: boolean;
  cached?: boolean;
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
    downloads(query: string, manager?: BrowserDownload["manager"]): Promise<BrowserDownload[]>;
    aria2Status(): Promise<Aria2Status>;
    connectAria2(port: number, secret: string): Promise<Aria2Sync>;
    refreshAria2(): Promise<Aria2Sync>;
    disconnectAria2(): Promise<void>;
    onDownloadsChanged(callback: () => void): () => void;
    chromeStatus(): Promise<{ available: boolean; extensionId: string | null }>;
    connectChrome(extensionId: string): Promise<string | null>;
    openSource(id: string): Promise<boolean>;
    openLinkedSource(path: string, id: string): Promise<boolean>;
    provenance(path: string): Promise<FileProvenance>;
    decideSource(path: string, identity: string, id: string, decision: SourceDecision): Promise<FileProvenance>;
    linkedFile(id: string): Promise<Pick<FileRecord, "path" | "name" | "status"> | null>;
    annotate(path: string, identity: string, input: FileAnnotation): Promise<FileAnnotation>;
    openFile(path: string): Promise<{ ok: boolean; message?: string }>;
    copyPath(kind: "local" | "download", key: string): Promise<boolean>;
    reveal(path: string): Promise<{ ok: boolean; message?: string }>;
    hotkey(): Promise<{ shortcut: string; registered: boolean }>;
    setHotkey(value: string): Promise<{ ok: true; shortcut: string } | { ok: false; message: string }>;
    onSearchFocus(callback: () => void): () => void;
    updateStatus(): Promise<DesktopUpdateStatus>;
    checkUpdate(): Promise<DesktopUpdateStatus>;
    downloadUpdate(): Promise<DesktopUpdateStatus>;
    installUpdate(): Promise<DesktopUpdateStatus>;
    onUpdateStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
    ntfsStatus(): Promise<NtfsStatus>;
    connectNtfs(): Promise<NtfsStatus>;
    enableNtfs(drive: string): Promise<NtfsStatus>;
    disableNtfs(drive: string): Promise<NtfsStatus>;
    searchNtfs(query: string): Promise<NtfsResult[]>;
    retryAutoNtfs(): Promise<NtfsStatus>;
    ntfsMotw(drive: string, id: string): Promise<MotwEvidence | null>;
    localMotw(path: string): Promise<MotwEvidence | null>;
    revealNtfs(drive: string, id: string): Promise<boolean>;
    onNtfsChanged(callback: (status: NtfsStatus) => void): () => void;
    semanticStatus(): Promise<ModelStatus>;
    installSemantic(): Promise<ModelStatus>;
    semanticSearch(query: string): Promise<SemanticResult>;
    onModelProgress(callback: (progress: Pick<ModelStatus, "downloaded" | "total">) => void): () => void;
    onSemanticProgress(callback: (progress: { done: number; total: number }) => void): () => void;
  };
}
