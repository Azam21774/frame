# Frame.io Automation (Electron app)

A desktop app that logs into multiple Frame.io accounts in parallel, creates a
project in each, uploads the files from the `automation/` folder, shares them
with a batch of recipients, and sends. Controlled entirely from a UI — no
`.env`, `acc.txt`, or `.txt` files to hand-edit.

## Setup

1. Install Node.js (18+) if you don't have it.
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
   This downloads Electron and `puppeteer-core`.
3. Put the file(s) you want uploaded into the `automation/` folder (next to
   this README). Every file in that folder is uploaded to every account's
   project.
4. Start the app:
   ```
   npm start
   ```

Chrome (Google Chrome, not Chromium) must already be installed on your
machine — the app drives your real local Chrome, it does not bundle one.

## Using the app

- **Settings panel** — set the Project Name, an optional message, how many
  Chrome windows run at once ("batch size"), and how many recipients each
  account sends to (max 25, Frame.io's own limit). Click **Save Settings**.
- **Recipients panel** — paste all your recipient emails (one per line, or
  comma/semicolon-separated) and click **Save Recipients**. These get split
  serially across accounts: account 1 gets the first batch, account 2 the
  next, and so on.
- **Accounts panel** — paste accounts as `email:password`, one per line, and
  click **Add Accounts**. Each account shows its live status (pending /
  running / success / failed), how many recipients it's assigned, and the
  error if it failed. Click the ✕ next to an account to remove it.
- **Start / Stop** — Start runs every account that isn't already marked
  "success", in parallel batches of the size you set. Stop immediately kills
  every Chrome currently running; those accounts are marked failed (not
  success), so the **next time you click Start, it resumes from there** —
  already-successful accounts are skipped, not redone.
- **Reset progress** — marks every account as pending again, so the next
  Start re-runs everyone from the first recipient.

## How resume actually works (read this)

Frame.io's "Send" button fires once for the whole recipient batch — there's
no partial-send state to save. So resume works **per account, not per
recipient**: if an account's batch was fully sent (status = success), it's
left alone. If an account was interrupted at any point — mid-login, mid-
upload, mid-typing-recipients — it's simply retried **from the start of its
own batch** next time you hit Start. You will never re-send to an account
that already succeeded, but a half-finished account starts its own batch
over, since there's no safe way to know which of its recipients the Send
click actually included.

## Where things are stored

- Settings, accounts, recipients, picked files and per-account status are
  saved in your normal per-user app-data folder — **not** inside this
  project folder or inside the packaged `.exe`. That's intentional: a
  packaged app's own folder is read-only, so this is the only place it can
  actually write.
  - Windows: `%APPDATA%\FrameioAutomation\state.json`
  - Mac: `~/Library/Application Support/FrameioAutomation/state.json`
  - This is also what gets wiped on every launch (the "always opens fresh"
    behavior).
- `automation/` — an optional fallback folder for upload files, only used
  if you haven't picked any files via the "Choose Files" button in the app.
- Chrome profiles are created fresh per run under
  `~/chrome-profiles/frameio-ui/` and are not auto-deleted, so you can
  inspect a profile after a failure if needed.

## Building a portable Windows .exe

### Option A — on an actual Windows machine (simplest)

1. Copy this folder to a Windows PC with Node.js installed, open a terminal
   in it, and run:
   ```
   npm install
   npm run dist:win
   ```
2. electron-builder downloads Electron + packaging tools the first time
   (needs internet), then builds.
3. The finished file appears at:
   ```
   dist\FrameioAutomation-portable.exe
   ```
   That single `.exe` is portable — no installer, just double-click to run
   it. Copy it anywhere (a USB drive, another PC) and it still works.

### Option B — from a Mac/Linux, via GitHub Actions (no Wine needed)

Building a Windows target from Mac/Linux normally needs Wine, which can be a
pain to install (Gatekeeper, untrusted taps, etc.). This repo includes
`.github/workflows/build-windows.yml`, which builds on an actual Windows
machine in the cloud instead — no Wine, nothing to install locally.

1. Push this folder to a GitHub repo (public or private — this uses GitHub's
   free Actions minutes either way):
   ```
   git init
   git add .
   git commit -m "Frame.io automation app"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. On GitHub, open the repo → **Actions** tab → you'll see "Build portable
   Windows exe" run automatically (it also runs on every push to main). If
   it hasn't started, click it → **Run workflow**.
3. Once it finishes (green check, a couple of minutes), open that run →
   scroll to **Artifacts** → download `FrameioAutomation-portable` — it's a
   zip containing `FrameioAutomation-portable.exe`.
4. That `.exe` is the real portable build, made by an actual Windows
   machine — just double-click to run it, no installer.

Two things to remember about the portable build:
- Google Chrome must still be installed on whatever PC runs the `.exe` —
  the app drives real local Chrome, it doesn't bundle one.
- "Fresh on every open" still applies: the `.exe` resets all saved
  settings/accounts/recipients/files every time it's launched, same as
  running it with `npm start`.

## Notes / limitations

- This build does not auto-retry a "slow to load" login within the same run
  the way the old script did — if a Chrome loads late and the account fails
  at login, it just sits as "failed" until you click Start again, which
  retries it. In practice that's the same outcome, one click later.
- Only the file(s) in `automation/` are ever uploaded; there's no per-account
  file selection in this version.
- Chrome windows will visibly open — this is intentional, so you can handle
  OTP/verification if Frame.io ever asks for it.
