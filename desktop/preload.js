// Kennzeichnet die Oberflaeche als Desktop-Programm (keine Browser-Hinweise)
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("wwDesktop", { platform: process.platform, version: process.versions.electron });
