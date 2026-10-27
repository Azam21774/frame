const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  addAccounts: (text) => ipcRenderer.invoke("add-accounts", text),
  removeAccount: (email) => ipcRenderer.invoke("remove-account", email),
  setRecipients: (text) => ipcRenderer.invoke("set-recipients", text),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  removeFile: (filePath) => ipcRenderer.invoke("remove-file", filePath),
  resetProgress: () => ipcRenderer.invoke("reset-progress"),
  start: () => ipcRenderer.invoke("start"),
  stop: () => ipcRenderer.invoke("stop"),

  onStateUpdate: (callback) =>
    ipcRenderer.on("state-update", (event, payload) => callback(payload)),
  onLog: (callback) =>
    ipcRenderer.on("log", (event, payload) => callback(payload)),
  onRecipientProgress: (callback) =>
    ipcRenderer.on("recipient-progress", (event, payload) => callback(payload)),
  onAccountStart: (callback) =>
    ipcRenderer.on("account-start", (event, payload) => callback(payload)),
  onAutomationDone: (callback) =>
    ipcRenderer.on("automation-done", (event, payload) => callback(payload)),
});
