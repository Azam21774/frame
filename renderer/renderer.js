let currentState = null;
let currentDashboard = null;
const runningEmails = new Set();
const recipientProgress = {}; // email -> "done/total"

const el = (id) => document.getElementById(id);

function statusLabel(acc) {
  if (runningEmails.has(acc.email)) return "running";
  return acc.status || "pending";
}

function renderDashboard(dashboard) {
  el("cardTotal").textContent = dashboard.totalRecipients;
  el("cardRemaining").textContent = dashboard.remainingRecipients;
  el("cardSuccess").textContent = dashboard.successCount;
  el("cardFailed").textContent = dashboard.failedCount;

  el("runStatus").textContent = dashboard.running ? "Running" : "Idle";
  el("runStatus").className = "run-status " + (dashboard.running ? "running" : "idle");

  el("startBtn").disabled = dashboard.running;
  el("stopBtn").disabled = !dashboard.running;
}

function renderSettings(settings) {
  el("projectName").value = settings.projectName || "";
  el("message").value = settings.message || "";
  el("batchSize").value = settings.batchSize || 3;
  el("recipientsPerAccount").value = settings.recipientsPerAccount || 25;
}

function renderFiles(files) {
  const list = el("fileList");
  list.innerHTML = "";

  if (!files.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="file-name" style="color: var(--muted);">No files chosen yet (or drop files in the automation/ folder).</span>`;
    list.appendChild(li);
    return;
  }

  files.forEach((filePath) => {
    const name = filePath.split(/[\\/]/).pop();
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="file-name" title="${filePath}">${name}</span>
      <button class="remove-btn" data-file="${filePath}" title="Remove">✕</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await window.api.removeFile(btn.dataset.file);
    });
  });
}

function renderRecipientsHint(count) {
  el("recipientsCountHint").textContent = `${count} recipient(s) saved.`;
}

function renderAccounts(state) {
  const n = Math.min(25, Math.max(1, Number(state.settings.recipientsPerAccount) || 25));
  const tbody = el("accountsBody");
  tbody.innerHTML = "";

  state.accounts.forEach((acc, i) => {
    const start = i * n;
    const batchSize = Math.max(0, Math.min(n, state.recipients.length - start));
    const progress = recipientProgress[acc.email];
    const status = statusLabel(acc);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${acc.email}</td>
      <td><span class="status-pill status-${status}">${status}</span></td>
      <td>${progress ? progress : `${batchSize} assigned`}</td>
      <td title="${acc.error || ""}">${acc.error ? acc.error.slice(0, 40) : ""}</td>
      <td><button class="remove-btn" data-email="${acc.email}" title="Remove">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await window.api.removeAccount(btn.dataset.email);
    });
  });
}

function applyState({ state, dashboard }) {
  currentState = state;
  currentDashboard = dashboard;
  renderSettings(state.settings);
  renderFiles(state.files || []);
  renderRecipientsHint(state.recipients.length);
  renderAccounts(state);
  renderDashboard(dashboard);
}

function appendLog(email, message) {
  const box = el("logBox");
  const line = document.createElement("div");
  line.className = "line";
  const tag = email ? `<span class="tag">[${email}]</span> ` : "";
  line.innerHTML = `${tag}${message}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function init() {
  const initial = await window.api.getState();
  el("uploadDirHint").textContent = `Files to upload go in: ${initial.uploadDir}`;
  applyState(initial);
  el("recipientsInput").value = (initial.state.recipients || []).join("\n");

  window.api.onStateUpdate((payload) => applyState(payload));

  window.api.onLog((payload) => appendLog(payload.email, payload.message));

  window.api.onAccountStart((payload) => {
    runningEmails.add(payload.email);
    if (currentState) renderAccounts(currentState);
  });

  window.api.onRecipientProgress((payload) => {
    recipientProgress[payload.email] = `${payload.done}/${payload.total}`;
    if (currentState) renderAccounts(currentState);
  });

  window.api.onAutomationDone(() => {
    runningEmails.clear();
    appendLog(null, "Run finished.");
  });

  el("saveSettingsBtn").addEventListener("click", async () => {
    await window.api.saveSettings({
      projectName: el("projectName").value,
      message: el("message").value,
      batchSize: el("batchSize").value,
      recipientsPerAccount: el("recipientsPerAccount").value,
    });
  });

  el("pickFilesBtn").addEventListener("click", async () => {
    const result = await window.api.pickFiles();
    if (result.ok) {
      el("pickFilesHint").textContent = result.added
        ? `Added ${result.added} file(s).`
        : "";
    }
  });

  el("saveRecipientsBtn").addEventListener("click", async () => {
    // Saving doesn't clear the box — it stays showing exactly what's
    // saved, so you can see/edit the list later instead of it vanishing.
    const result = await window.api.setRecipients(el("recipientsInput").value);
    if (result.ok) {
      renderRecipientsHint(result.count);
    }
  });

  el("clearRecipientsBtn").addEventListener("click", async () => {
    if (!confirm("Clear all saved recipients?")) return;
    el("recipientsInput").value = "";
    await window.api.setRecipients("");
  });

  el("addAccountsBtn").addEventListener("click", async () => {
    const result = await window.api.addAccounts(el("accountsInput").value);
    if (result.ok) {
      el("accountsInput").value = "";
      el("addAccountsHint").textContent = result.skipped.length
        ? `Added ${result.added}. Skipped ${result.skipped.length} bad line(s): ${result.skipped.join(", ")}`
        : `Added ${result.added} account(s).`;
    }
  });

  el("resetBtn").addEventListener("click", async () => {
    if (confirm("Mark every account as pending again? This makes the next Start re-run everyone from scratch.")) {
      recipientProgress && Object.keys(recipientProgress).forEach((k) => delete recipientProgress[k]);
      await window.api.resetProgress();
    }
  });

  el("startBtn").addEventListener("click", async () => {
    el("logBox").innerHTML = "";
    const result = await window.api.start();
    if (!result.ok) {
      alert(result.error);
    }
  });

  el("stopBtn").addEventListener("click", async () => {
    await window.api.stop();
    appendLog(null, "Stop requested — killing in-progress Chrome instances...");
  });
}

init();
