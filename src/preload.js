"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  getStatus: () => ipcRenderer.invoke("dshDesktop:getStatus"),
  saveSettings: (patch) => ipcRenderer.invoke("dshDesktop:saveSettings", patch),
  checkForUpdates: () => ipcRenderer.invoke("dshDesktop:checkForUpdates"),
  restartServer: () => ipcRenderer.invoke("dshDesktop:restartServer"),
  openLogFolder: () => ipcRenderer.invoke("dshDesktop:openLogFolder"),
  pickDirectory: () => ipcRenderer.invoke("dshDesktop:pickDirectory"),
  openSettings: () => ipcRenderer.invoke("dshDesktop:openSettings"),
  quitApp: () => ipcRenderer.invoke("dshDesktop:quitApp"),
  onStatus: (cb) => {
    ipcRenderer.on("dshDesktop:status", (_e, status) => cb(status));
  },
});
