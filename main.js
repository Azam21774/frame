const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { loadState, saveState, resetState } = require("./state");
const { runForAccount, HARD_MAX_RECIPIENTS, UPLOAD_DIR } = require("./automation");

let mainWindow;
let running = false;
let stopRequested = false;
const registry = new Map(); // email -> { chromeProcess, browser }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Every launch starts fresh: no settings, accounts, recipients, files, or
// run progress carry over from a previous session.
app.whenReady().then(() => {
  resetState();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Splits recipients serially: account 0 gets recipients[0..n), account 1
// gets the next n, etc. (n = recipientsPerAccount, capped at 25).
// Index-based, so it stays stable across stop/resume as long as the
// account list order doesn't change.
function computeBatches(accounts, recipients, recipientsPerAccount) {
  const n = Math.min(
    Math.max(1, Number(recipientsPerAccount) || HARD_MAX_RECIPIENTS),
    HARD_MAX_RECIPIENTS
  );

  return accounts.map((_, i) => recipients.slice(i * n, i * n + n));
}

function computeDashboard(state) {
  const n = Math.min(
    Math.max(1, Number(state.settings.recipientsPerAccount) || HARD_MAX_RECIPIENTS),
    HARD_MAX_RECIPIENTS
  );

  const batches = computeBatches(state.accounts, state.recipients, n);
  const assigned = batches.reduce((sum, b) => sum + b.length, 0);

  const success = state.accounts.filter((a) => a.status === "success");
  const failed = state.accounts.filter((a) => a.status === "failed");

  const sent = success.reduce((sum, acc) => {
    const idx = state.accounts.indexOf(acc);
    return sum + batches[idx].length;
  }, 0);

  return {
    totalRecipients: state.recipients.length,
    assignedRecipients: assigned,
    remainingRecipients: Math.max(0, assigned - sent),
    successCount: success.length,
    failedCount: failed.length,
    totalAccounts: state.accounts.length,
    running,
  };
}

function broadcastState() {
  const state = loadState();
  send("state-update", { state, dashboard: computeDashboard(state) });
}

// ---------- IPC: data CRUD ----------

ipcMain.handle("get-state", () => {
  const state = loadState();
  return { state, dashboard: computeDashboard(state), uploadDir: UPLOAD_DIR };
});

ipcMain.handle("save-settings", (event, settings) => {
  const state = loadState();
  state.settings = {
    projectName: String(settings.projectName || "").trim(),
    message: String(settings.message || ""),
    batchSize: Math.max(1, Number(settings.batchSize) || 1),
    recipientsPerAccount: Math.min(
      HARD_MAX_RECIPIENTS,
      Math.max(1, Number(settings.recipientsPerAccount) || HARD_MAX_RECIPIENTS)
    ),
  };
  saveState(state);
  broadcastState();
  return { ok: true };
});

ipcMain.handle("add-accounts", (event, text) => {
  const state = loadState();

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const existing = new Set(state.accounts.map((a) => a.email.toLowerCase()));
  const added = [];
  const skipped = [];

  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep === -1) {
      skipped.push(line);
      continue;
    }

    const email = line.slice(0, sep).trim();
    const password = line.slice(sep + 1).trim();

    if (!email || !password) {
      skipped.push(line);
      continue;
    }

    if (existing.has(email.toLowerCase())) continue;

    state.accounts.push({ email, password, status: "pending", error: null });
    existing.add(email.toLowerCase());
    added.push(email);
  }

  saveState(state);
  broadcastState();
  return { ok: true, added: added.length, skipped };
});

ipcMain.handle("remove-account", (event, email) => {
  const state = loadState();
  state.accounts = state.accounts.filter(
    (a) => a.email.toLowerCase() !== String(email).toLowerCase()
  );
  saveState(state);
  broadcastState();
  return { ok: true };
});

ipcMain.handle("set-recipients", (event, text) => {
  const state = loadState();

  const all = String(text || "")
    .split(/[\r\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  state.recipients = [...new Set(all.map((e) => e.toLowerCase()))];
  saveState(state);
  broadcastState();
  return { ok: true, count: state.recipients.length };
});

ipcMain.handle("pick-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose files to upload",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "All files", extensions: ["*"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] },
      { name: "Video", extensions: ["mp4", "mov", "avi", "mkv"] },
    ],
  });

  if (result.canceled) return { ok: true, added: 0 };

  const state = loadState();
  const existing = new Set(state.files);
  let added = 0;

  for (const filePath of result.filePaths) {
    if (!existing.has(filePath)) {
      state.files.push(filePath);
      existing.add(filePath);
      added++;
    }
  }

  saveState(state);
  broadcastState();
  return { ok: true, added };
});

ipcMain.handle("remove-file", (event, filePath) => {
  const state = loadState();
  state.files = state.files.filter((f) => f !== filePath);
  saveState(state);
  broadcastState();
  return { ok: true };
});

ipcMain.handle("reset-progress", () => {
  const state = loadState();
  state.accounts = state.accounts.map((a) => ({
    ...a,
    status: "pending",
    error: null,
  }));
  saveState(state);
  broadcastState();
  return { ok: true };
});

// ---------- IPC: run control ----------

ipcMain.handle("start", async () => {
  if (running) return { ok: false, error: "Already running." };

  const state = loadState();

  if (!state.settings.projectName) {
    return { ok: false, error: "Set a project name first." };
  }
  if (!state.accounts.length) {
    return { ok: false, error: "Add at least one account first." };
  }
  const pickedFiles = (state.files || []).filter((f) => fs.existsSync(f));
  let folderHasFiles = false;

  if (!pickedFiles.length) {
    // Just a fallback check — don't try to create this folder. Inside a
    // packaged (portable .exe) build, the app's own folder is read-only,
    // so writing here would throw instead of just "no files found".
    try {
      if (fs.existsSync(UPLOAD_DIR)) {
        folderHasFiles = fs
          .readdirSync(UPLOAD_DIR, { withFileTypes: true })
          .some((e) => e.isFile());
      }
    } catch {
      folderHasFiles = false;
    }
  }

  if (!pickedFiles.length && !folderHasFiles) {
    return {
      ok: false,
      error: `No files to upload. Use "Choose Files" in the app, or drop them in: ${UPLOAD_DIR}`,
    };
  }

  running = true;
  stopRequested = false;
  broadcastState();

  runAll()
    .catch((err) => {
      send("log", { email: null, message: `Run error: ${err && err.message ? err.message : err}` });
    })
    .finally(() => {
    running = false;
    stopRequested = false;
    broadcastState();
    send("automation-done", {});
  });

  return { ok: true };
});

ipcMain.handle("stop", () => {
  if (!running) return { ok: false, error: "Not running." };

  stopRequested = true;

  // Forcefully kill every Chrome currently in flight. Their runForAccount
  // calls will throw, be caught, and marked as NOT success — so a later
  // Start will retry them (already-successful accounts stay skipped).
  for (const [email, entry] of registry.entries()) {
    try {
      entry.browser?.close().catch(() => {});
    } catch {}
    try {
      if (entry.chromeProcess && entry.chromeProcess.exitCode === null) {
        entry.chromeProcess.kill();
      }
    } catch {}
  }
  registry.clear();

  return { ok: true };
});

async function runAll() {
  const state = loadState();
  const n = state.settings.recipientsPerAccount;
  const batches = computeBatches(state.accounts, state.recipients, n);
  const batchSize = state.settings.batchSize;

  const pendingIndexes = state.accounts
    .map((acc, i) => i)
    .filter((i) => state.accounts[i].status !== "success");

  for (let start = 0; start < pendingIndexes.length; start += batchSize) {
    if (stopRequested) break;

    const group = pendingIndexes.slice(start, start + batchSize);

    send("log", { email: null, message: `--- Batch: accounts ${group.map((i) => i + 1).join(", ")} ---` });

    const results = await Promise.all(
      group.map((accountIndex, i) => {
        const account = state.accounts[accountIndex];
        const recipients = batches[accountIndex];
        const startDelayMs = i * 2500;

        return runForAccount({
          account,
          index: accountIndex,
          recipients,
          projectName: state.settings.projectName,
          message: state.settings.message,
          uploadFiles: state.files,
          registry,
          startDelayMs,
          onEvent: (evt) => {
            if (evt.type === "log") {
              send("log", { email: evt.email, message: evt.message });
            } else if (evt.type === "recipient-progress") {
              send("recipient-progress", evt);
            } else if (evt.type === "account-start") {
              send("account-start", evt);
            }
          },
        }).then((result) => ({ accountIndex, result }));
      })
    );

    // Persist each account's outcome immediately.
    const fresh = loadState();

    for (const { accountIndex, result } of results) {
      const acc = fresh.accounts[accountIndex];
      if (!acc) continue;

      if (result.ok) {
        acc.status = "success";
        acc.error = null;
      } else {
        acc.status = "failed";
        acc.error = result.error;
      }
    }

    saveState(fresh);
    broadcastState();
  }
}
