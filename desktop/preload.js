// Kennzeichnet die Oberflaeche als Desktop-Programm (keine Browser-Hinweise) und reicht die Aktualisierung durch
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wwDesktop", { platform: process.platform, version: process.versions.electron,
  update: { check: () => ipcRenderer.invoke("ww-update-check"), install: () => ipcRenderer.invoke("ww-update-install") } });
