const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// IMPORTANT: this must be a writable, per-user folder — NOT a path inside
// the app's own install/package folder. A packaged (portable .exe) app's
// own folder is read-only, so writing state.json there crashes the app
// silently on every launch. app.getPath("userData") is always writable
// (e.g. %APPDATA%\FrameioAutomation on Windows, ~/Library/Application
// Support/FrameioAutomation on Mac).
function getStateFile() {
  return path.join(app.getPath("userData"), "state.json");
}

const DEFAULT_STATE = {
  settings: {
    projectName: "",
    message: "",
    batchSize: 3,
    recipientsPerAccount: 25,
  },
  accounts: [], // { email, password, status: 'pending'|'success'|'failed', error }
  recipients: [], // ["a@x.com", ...]
  files: [], // ["/absolute/path/to/file.pdf", ...] — picked via UI
};

function loadState() {
  const stateFile = getStateFile();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  if (!fs.existsSync(stateFile)) {
    return structuredClone(DEFAULT_STATE);
  }

  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);

    return {
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      recipients: Array.isArray(parsed.recipients) ? parsed.recipients : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(state) {
  const stateFile = getStateFile();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function resetState() {
  const fresh = structuredClone(DEFAULT_STATE);
  saveState(fresh);
  return fresh;
}

module.exports = { loadState, saveState, resetState, getStateFile };
