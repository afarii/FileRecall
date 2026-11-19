"use strict";

const { contextBridge, ipcRenderer } = require("electron");

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
  downloads: (query) => ipcRenderer.invoke("downloads:search", query),
  chromeStatus: () => ipcRenderer.invoke("chrome:status"),
  connectChrome: (id) => ipcRenderer.invoke("chrome:connect", id),
  openSource: (id) => ipcRenderer.invoke("downloads:open-source", id),
  reveal: (path) => ipcRenderer.invoke("files:reveal", path),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
}));
