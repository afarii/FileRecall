"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("fileRecall", Object.freeze({
  folders: () => ipcRenderer.invoke("folders:list"),
  historyFolders: () => ipcRenderer.invoke("history:folders"),
  clearHistory: (path) => ipcRenderer.invoke("history:clear", path),
  removeFolder: (path) => ipcRenderer.invoke("folders:remove", path),
  addFolder: () => ipcRenderer.invoke("folders:add"),
  rescan: () => ipcRenderer.invoke("folders:rescan"),
  search: (query) => ipcRenderer.invoke("files:search", query),
  textEnabled: () => ipcRenderer.invoke("files:text-enabled"),
  setTextEnabled: (enabled) => ipcRenderer.invoke("files:set-text-enabled", enabled),
  downloads: (query, manager) => ipcRenderer.invoke("downloads:search", query, manager),
  aria2Status: () => ipcRenderer.invoke("aria2:status"),
  connectAria2: (port, secret) => ipcRenderer.invoke("aria2:connect", port, secret),
  refreshAria2: () => ipcRenderer.invoke("aria2:refresh"),
  disconnectAria2: () => ipcRenderer.invoke("aria2:disconnect"),
  onDownloadsChanged: (callback) => subscribe("downloads:changed", callback),
  chromeStatus: () => ipcRenderer.invoke("chrome:status"),
  connectChrome: (id) => ipcRenderer.invoke("chrome:connect", id),
  openSource: (id) => ipcRenderer.invoke("downloads:open-source", id),
  openLinkedSource: (path, id) => ipcRenderer.invoke("provenance:open-source", path, id),
  provenance: (path) => ipcRenderer.invoke("provenance:local", path),
  decideSource: (path, identity, id, decision) => ipcRenderer.invoke("provenance:decide", path, identity, id, decision),
  linkedFile: (id) => ipcRenderer.invoke("provenance:download", id),
  annotate: (path, identity, input) => ipcRenderer.invoke("files:annotate", path, identity, input),
  openFile: (path) => ipcRenderer.invoke("files:open", path),
  copyPath: (kind, key) => ipcRenderer.invoke("files:copy-path", kind, key),
  reveal: (path) => ipcRenderer.invoke("files:reveal", path),
  hotkey: () => ipcRenderer.invoke("hotkey:status"),
  setHotkey: (value) => ipcRenderer.invoke("hotkey:update", value),
  semanticStatus: () => ipcRenderer.invoke("semantic:status"),
  installSemantic: () => ipcRenderer.invoke("semantic:install"),
  semanticSearch: (query) => ipcRenderer.invoke("semantic:search", query),
  onSearchFocus: (callback) => subscribe("search:focus", callback),
  updateStatus: () => ipcRenderer.invoke("updates:status"),
  checkUpdate: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateStatus: (callback) => subscribe("updates:changed", callback),
  onModelProgress: (callback) => subscribe("semantic:download-progress", callback),
  onSemanticProgress: (callback) => subscribe("semantic:search-progress", callback),
  onChanged: (callback) => subscribe("library:changed", callback),
}));
