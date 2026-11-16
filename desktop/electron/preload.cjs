"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fileRecall", Object.freeze({
  folders: () => ipcRenderer.invoke("folders:list"),
  addFolder: () => ipcRenderer.invoke("folders:add"),
  rescan: () => ipcRenderer.invoke("folders:rescan"),
  search: (query) => ipcRenderer.invoke("files:search", query),
  reveal: (path) => ipcRenderer.invoke("files:reveal", path),
}));
