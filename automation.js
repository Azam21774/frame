const puppeteer = require("puppeteer-core");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LOGIN_URL = "https://accounts.frame.io/";
const BASE_DEBUG_PORT = 9226;
const UPLOAD_DIR = path.join(__dirname, "automation");
const PROFILE_BASE = path.join(os.homedir(), "chrome-profiles", "frameio-ui");
const HARD_MAX_RECIPIENTS = 25;
// Minimum wait when no upload requests are visible. Raise this if Share
// fires before big files finish uploading; lower it for tiny files.
const MIN_WAIT_NO_UPLOAD_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every polling loop below checks this first. When Stop kills Chrome, the
// page/browser disconnects — without this check, loops silently catch
// that as "not found yet" and keep retrying for their own (sometimes very
// long, e.g. 5 minutes) timeout instead of aborting immediately.
function isDead(page) {
  try {
    return page.isClosed() || !page.browser().isConnected();
  } catch {
    return true;
  }
}

function assertAlive(page) {
  if (isDead(page)) {
    throw new Error("Stopped: Chrome disconnected.");
  }
}

function findChrome() {
  const candidates = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(
        os.homedir(),
        "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
      ),
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ],
  };

  const list = candidates[process.platform] || [];

  for (const candidate of list) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Could not find a Chrome install for platform "${process.platform}". ` +
      `Checked: ${list.join(", ") || "(no known paths for this platform)"}`
  );
}

// ---------- low-level DOM helpers ----------

async function waitForChrome(endpoint, chromeProcess, timeout = 25000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (chromeProcess.exitCode !== null) {
      throw new Error("Chrome exited before Puppeteer connected.");
    }

    try {
      return await puppeteer.connect({
        browserURL: endpoint,
        defaultViewport: null,
      });
    } catch {
      await sleep(300);
    }
  }

  throw new Error(
    `Cannot connect to Chrome at ${endpoint}. Check whether that port is already in use.`
  );
}

async function findVisibleInput(page, selectors, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    assertAlive(page);

    for (const selector of selectors) {
      const elements = await page.$$(selector);

      for (const element of elements) {
        const visible = await element
          .evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              !el.disabled
            );
          })
          .catch(() => false);

        if (visible) return element;
      }
    }

    await sleep(300);
  }

  throw new Error(
    `Input not found within ${timeout / 1000}s: ${selectors.join(", ")}`
  );
}

async function typeIntoInput(page, selectors, value, label, timeout = 20000) {
  const element = await findVisibleInput(page, selectors, timeout);
  await element.click();
  await element.type(value, { delay: 75 });
  return label;
}

async function clickButtonByText(page, patterns, timeout = 25000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    assertAlive(page);
    const buttons = await page.$$('button, input[type="submit"]');

    for (const button of buttons) {
      const info = await button
        .evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            text: (
              el.innerText ||
              el.value ||
              el.getAttribute("aria-label") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden",
            disabled: el.disabled,
          };
        })
        .catch(() => null);

      if (
        !info ||
        !info.visible ||
        info.disabled ||
        !patterns.some((pattern) => pattern.test(info.text))
      ) {
        continue;
      }

      await button.click();
      return info.text;
    }

    await sleep(300);
  }

  throw new Error(
    `Button not found: ${patterns.map(String).join(", ")}`
  );
}

async function waitForPasswordField(page, timeout = 90000) {
  const selectors = [
    "#PasswordPage-PasswordField",
    'input[data-id="PasswordPage-PasswordField"]',
    'input[name="password"][type="password"]',
    'input[autocomplete="current-password"]',
  ];

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    assertAlive(page);

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (!element) continue;

        const visible = await element.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            !el.disabled
          );
        });

        if (visible) return element;
      } catch {
        // Page may still be navigating.
      }
    }

    await sleep(300);
  }

  throw new Error(
    `Password field did not appear within ${timeout / 1000}s. URL: ${page.url()}`
  );
}

// ---------- workflow steps ----------

async function login(page, email, password, log) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  log("Frame.io page opened.");

  await typeIntoInput(
    page,
    [
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[autocomplete="username"]',
    ],
    email,
    "Email",
    90000
  );
  log("Email typed.");

  await clickButtonByText(page, [/let'?s go/i, /continue/i, /^next$/i], 60000);
  log("Email Continue clicked.");

  const passwordInput = await waitForPasswordField(page, 90000);
  await passwordInput.click();
  await passwordInput.type(password, { delay: 75 });
  log("Password typed.");

  await clickButtonByText(page, [/continue/i, /sign in/i, /log in/i, /^next$/i]);
  log("Password Continue clicked.");

  const urlCheckDeadline = Date.now() + 5000;
  while (
    Date.now() < urlCheckDeadline &&
    /accounts\.frame\.io/i.test(page.url())
  ) {
    assertAlive(page);
    await sleep(150);
  }

  if (/accounts\.frame\.io/i.test(page.url())) {
    log("OTP/verification may be required — complete it in Chrome.");
  }

  // Up to 5 minutes for OTP — but as a manual poll (not
  // page.waitForSelector) so Stop can abort it within ~300ms instead of
  // waiting out the full 5 minutes.
  const dashboardDeadline = Date.now() + 300000;
  let dashboardFound = false;

  while (Date.now() < dashboardDeadline) {
    assertAlive(page);

    const found = await page
      .$('[data-testid="create-project-button"]')
      .catch(() => null);

    if (found) {
      dashboardFound = true;
      break;
    }

    await sleep(300);
  }

  if (!dashboardFound) {
    throw new Error("Workspace dashboard did not appear within 5 minutes.");
  }

  log("Workspace dashboard detected.");
}

async function fillProjectName(page, projectName, log) {
  const selector = '[data-testid="workspaces-create-project-modal--name-field"]';

  await page.waitForSelector(selector, { visible: true, timeout: 20000 });

  const input = await page.$(selector);

  await input.click({ clickCount: 3 });
  await input.evaluate((el) => {
    el.focus();
    el.select();
  });

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.press("Backspace");

  const leftover = await input.evaluate((el) => el.value);

  if (leftover !== "") {
    await input.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  await input.type(projectName, { delay: 80 });

  const actualValue = await input.evaluate((el) => el.value);

  if (actualValue !== projectName) {
    throw new Error(
      `Project name mismatch. Expected "${projectName}", got "${actualValue}".`
    );
  }

  log(`Project name verified: ${actualValue}`);
}

function trackUploads(page) {
  const tracker = { started: 0, finished: 0, failed: 0, inflight: new Set() };

  page.on("request", (request) => {
    if (request.method() === "PUT") {
      tracker.started++;
      tracker.inflight.add(request);
    }
  });

  page.on("requestfinished", (request) => {
    if (tracker.inflight.delete(request)) tracker.finished++;
  });

  page.on("requestfailed", (request) => {
    if (tracker.inflight.delete(request)) tracker.failed++;
  });

  return tracker;
}

async function selectCard(card, label, log) {
  const isChecked = () =>
    card.evaluate((el) => !!el.querySelector('input[type="checkbox"]')?.checked);

  if (await isChecked()) return true;

  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));

  // Click straight through the DOM (no real mouse coordinates, so
  // nothing — overlays, hover-only visibility, occluded windows — can
  // intercept it) and try several candidate elements in order, since
  // which one actually has the click handler can vary.
  const attemptClick = async (evalFn, waitMs = 400) => {
    await card.evaluate(evalFn).catch(() => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await isChecked()) return true;
      await sleep(80);
    }
    return false;
  };

  let done = await attemptClick(
    (el) => el.querySelector('label[aria-label^="Select asset"]')?.click()
  );

  if (!done) {
    done = await attemptClick(
      (el) => el.querySelector('[data-testid="toggle-checkbox"]')?.click()
    );
  }

  if (!done) {
    done = await attemptClick(
      (el) => el.querySelector('input[type="checkbox"]')?.click()
    );
  }

  if (!done) {
    try {
      const realLabel = await card.$('label[aria-label^="Select asset"]');
      if (realLabel) {
        await realLabel.click();
        const deadline = Date.now() + 600;
        while (Date.now() < deadline) {
          if (await isChecked()) {
            done = true;
            break;
          }
          await sleep(80);
        }
      }
    } catch {
      // fall through — logged as not-selected below
    }
  }

  if (done) log(`${label}: selected.`);
  return done;
}

async function waitForUploadsAndSelect(page, expectedCount, tracker, log) {
  const cardSel = '[data-finder-asset-card="true"]';

  log("Waiting for uploads to finish...");

  const startedAt = Date.now();
  const deadline = startedAt + 15 * 60 * 1000;
  let idleSince = null;
  let warned = false;

  // Smart wait: select each card the instant it becomes visible, instead
  // of waiting for the whole upload batch to finish first. A card that
  // isn't interactive yet (still uploading) just gets retried on the next
  // tick — cheap, since a successful select exits this on the first try.
  const selected = new Set(); // keys of cards already confirmed selected
  const lastAttempt = new Map(); // key -> last attempt timestamp
  let cardCount = 0;

  while (true) {
    assertAlive(page);

    if (Date.now() > deadline) {
      throw new Error("Upload did not finish within 15 minutes.");
    }

    const cardHandles = await page.$$(cardSel).catch(() => []);
    cardCount = cardHandles.length;

    for (let i = 0; i < cardHandles.length; i++) {
      const card = cardHandles[i];
      const assetId = await card
        .evaluate((el) => el.getAttribute("data-asset-id"))
        .catch(() => null);
      const key = assetId || `idx-${i}`;

      if (selected.has(key)) continue;

      // Don't hammer a still-uploading card every 300ms — retry at most
      // once a second until it's actually ready to be clicked.
      const last = lastAttempt.get(key) || 0;
      if (Date.now() - last < 1000) continue;
      lastAttempt.set(key, Date.now());

      const ok = await selectCard(card, `Card ${i + 1}/${expectedCount}`, log);
      if (ok) selected.add(key);
    }

    const sawUploads = tracker.started > 0;
    const elapsed = Date.now() - startedAt;

    // Upload requests often don't show up in page events (Frame.io uploads
    // from a worker). Instead of waiting a fixed 45s, treat the Share
    // button becoming enabled as the "ready" signal.
    const shareReady = await page
      .evaluate((sel) => {
        const b = document.querySelector(sel);
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          !b.disabled &&
          b.getAttribute("aria-disabled") !== "true"
        );
      }, 'button[data-dd-action-name="finder-menu-bar.share"]')
      .catch(() => false);

    if (!sawUploads && !warned && elapsed > 3000) {
      log("No upload requests visible to the page; using Share button as ready signal.");
      warned = true;
    }

    const ready =
      cardCount >= expectedCount &&
      selected.size >= expectedCount &&
      tracker.inflight.size === 0 &&
      shareReady &&
      (sawUploads || elapsed > MIN_WAIT_NO_UPLOAD_MS);

    if (ready) {
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= 500) break;
    } else {
      idleSince = null;
    }

    await sleep(300);
  }

  log(`Uploads complete. Selected ${selected.size}/${expectedCount} file(s).`);

  if (selected.size === 0) {
    throw new Error("Could not select the uploaded file(s).");
  }
}

async function clickShare(page, log) {
  const shareButton = 'button[data-dd-action-name="finder-menu-bar.share"]';
  const dialogHint = '[data-testid="project-member-invite-input"]';

  await page.waitForSelector(shareButton, { visible: true, timeout: 20000 });

  // Verify the share dialog actually opened, not just that the click
  // fired — a real mouse click can be swallowed by an overlay without
  // throwing, which would otherwise look like success and fail silently
  // several steps later.
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertAlive(page);
    try {
      await page.click(shareButton);
    } catch {
      await page.evaluate((sel) => document.querySelector(sel)?.click(), shareButton);
    }

    try {
      await page.waitForSelector(dialogHint, { visible: true, timeout: 5000 });
      log("Share clicked, dialog opened.");
      return;
    } catch {
      log(`Share click attempt ${attempt} didn't open the dialog, retrying...`);
    }
  }

  throw new Error("Clicked Share but the recipient dialog never opened.");
}

async function waitForInputToClear(input, timeout, page) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (page) assertAlive(page);
    const value = await input.evaluate((el) => el.value).catch(() => "");
    if (!value) return true;
    await sleep(60);
  }

  return false;
}

async function fillRecipients(page, recipients, onRecipientDone, log) {
  const inputSelector = '[data-testid="project-member-invite-input"]';
  await page.waitForSelector(inputSelector, { visible: true, timeout: 20000 });

  for (let i = 0; i < recipients.length; i++) {
    assertAlive(page);
    const email = recipients[i];
    const input = await page.$(inputSelector);

    await input.click();
    await input.type(email, { delay: 20 });

    const deadlineTyped = Date.now() + 1000;
    while (Date.now() < deadlineTyped) {
      assertAlive(page);
      const value = await input.evaluate((el) => el.value);
      if (value === email) break;
      await sleep(40);
    }

    await page.keyboard.press("Enter");

    let cleared = await waitForInputToClear(input, 2000, page);

    if (!cleared) {
      await page.keyboard.press("Enter");
      cleared = await waitForInputToClear(input, 2000, page);
    }

    if (!cleared) {
      log(`Warning: could not confirm "${email}" was added as a chip.`);
    }

    log(`Recipient ${i + 1}/${recipients.length} added: ${email}`);
    if (onRecipientDone) onRecipientDone(i + 1, recipients.length, email);
  }
}

async function fillMessage(page, message, log) {
  if (!message) {
    log("No message set, skipping.");
    return;
  }

  const selector = '[data-testid="FormDialog-message"]';
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  const textarea = await page.$(selector);
  await textarea.click();

  await textarea.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, message);

  const actual = await textarea.evaluate((el) => el.value);

  if (actual !== message) {
    throw new Error("Message field did not accept the text.");
  }

  log("Message filled.");
}

async function clickSend(page, log) {
  const sendSelector = '[data-testid="done-button"]';
  await page.waitForSelector(sendSelector, { visible: true, timeout: 20000 });

  await page.waitForFunction(
    (sel) => {
      const button = document.querySelector(sel);
      return button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    },
    { timeout: 20000 },
    sendSelector
  );

  await page.click(sendSelector);
  log("Send clicked.");

  const closeDeadline = Date.now() + 8000;
  let closed = false;

  while (Date.now() < closeDeadline) {
    assertAlive(page);
    const stillThere = await page.$(sendSelector);
    if (!stillThere) {
      closed = true;
      break;
    }
    await sleep(150);
  }

  if (closed) {
    log("Share dialog closed, send confirmed.");
  } else {
    log("Could not confirm dialog closed, giving it a grace period.");
    await sleep(2000);
  }
}

async function createProjectAndUpload(page, projectName, recipients, message, uploadFiles, onRecipientDone, log) {
  // Prefer files picked in the UI. Fall back to the automation/ folder
  // for anyone still dropping files in manually.
  let files = Array.isArray(uploadFiles) ? uploadFiles.filter(Boolean) : [];

  if (files.length) {
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      throw new Error(`File(s) not found on disk: ${missing.join(", ")}`);
    }
  } else if (fs.existsSync(UPLOAD_DIR)) {
    files = fs
      .readdirSync(UPLOAD_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(UPLOAD_DIR, entry.name));
  }

  if (!files.length) {
    throw new Error(
      "No files to upload. Pick files in the Files panel, or drop them in the automation/ folder."
    );
  }

  const newProjectButton = '[data-testid="create-project-button"]';
  await page.waitForSelector(newProjectButton, { visible: true, timeout: 30000 });
  await page.click(newProjectButton);
  log("New Project clicked.");

  await fillProjectName(page, projectName, log);

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.innerText.trim() === "Create New Project" && !button.disabled
      ),
    { timeout: 20000 }
  );

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.innerText.trim() === "Create New Project" && !element.disabled
    );
    if (!button) throw new Error("Create New Project button not found.");
    button.click();
  });

  log("Create New Project clicked.");

  const uploadButton = '[data-testid="empty-folder-upload-button"]';
  await page.waitForSelector(uploadButton, { visible: true, timeout: 60000 });
  log("New project upload area opened.");

  const fileInput = 'input[type="file"][name="files"]';
  await page.waitForSelector(fileInput, { timeout: 20000 });
  const inputHandle = await page.$(fileInput);

  if (!inputHandle) {
    throw new Error("Frame.io file input not found.");
  }

  const uploadTracker = trackUploads(page);
  await inputHandle.uploadFile(...files);
  log(`Upload selection submitted for ${files.length} file(s).`);

  await waitForUploadsAndSelect(page, files.length, uploadTracker, log);

  if (recipients.length) {
    await clickShare(page, log);
    await fillRecipients(page, recipients, onRecipientDone, log);
    await fillMessage(page, message, log);
    await clickSend(page, log);
  }
}

// ---------- per-account runner ----------

// registry: Map<string email, { chromeProcess, browser }> so the UI's
// Stop button can forcefully kill an in-progress Chrome.
async function runForAccount({
  account,
  index,
  recipients,
  projectName,
  message,
  uploadFiles,
  registry,
  onEvent,
  startDelayMs = 0,
}) {
  const tag = account.email;
  const log = (msg) => onEvent({ type: "log", email: tag, message: msg });

  let browser;
  let chromeProcess;

  try {
    if (startDelayMs > 0) await sleep(startDelayMs);

    const chrome = findChrome();
    const debugPort = BASE_DEBUG_PORT + index;

    fs.mkdirSync(PROFILE_BASE, { recursive: true });
    const profilePath = fs.mkdtempSync(path.join(PROFILE_BASE, `run-${index + 1}-`));

    chromeProcess = spawn(
      chrome,
      [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profilePath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        // Chrome throttles JS timers/rendering in windows that are
        // occluded (covered by another window) or not focused, to save
        // resources. With several Chrome windows stacked on top of each
        // other, that throttling makes every wait/poll in this script
        // look "stuck" even though nothing is actually wrong — these
        // flags turn that throttling off so background/overlapped
        // windows run at full speed, same as a focused one.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-features=CalculateNativeWinOcclusion",
        LOGIN_URL,
      ],
      { stdio: "ignore" }
    );

    chromeProcess.on("error", (err) => log(`Chrome launch error: ${err.message}`));
    registry.set(tag, { chromeProcess, browser: null });

    browser = await waitForChrome(`http://127.0.0.1:${debugPort}`, chromeProcess);
    registry.set(tag, { chromeProcess, browser });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    page.setDefaultTimeout(20000);

    // Extra layer on top of the launch flags above: tell the page itself
    // (via CDP) that it's always "active", so the site's own JS never
    // slows down animations/timers just because the OS window happens to
    // be stacked behind another one.
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
    } catch {
      // Best-effort only — the launch flags already cover most of this.
    }

    onEvent({ type: "account-start", email: tag });
    log(`Starting (port ${debugPort})...`);

    await login(page, account.email, account.password, log);

    const onRecipientDone = (done, total) =>
      onEvent({ type: "recipient-progress", email: tag, done, total });

    await createProjectAndUpload(
      page,
      projectName,
      recipients,
      message,
      uploadFiles,
      onRecipientDone,
      log
    );

    log("Workflow finished. Closing Chrome...");

    try {
      await browser.close();
    } catch {}

    if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
    registry.delete(tag);

    onEvent({ type: "account-success", email: tag });
    return { ok: true };
  } catch (error) {
    log(`Failed: ${error.message}`);

    onEvent({ type: "account-failed", email: tag, error: error.message });
    return { ok: false, error: error.message };
  } finally {
    if (browser) {
      try {
        browser.disconnect();
      } catch {}
    }
  }
}

module.exports = {
  runForAccount,
  HARD_MAX_RECIPIENTS,
  BASE_DEBUG_PORT,
  UPLOAD_DIR,
};
