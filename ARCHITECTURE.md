# Me-Tracker — Architecture & Navigation Guide

**Read this file completely before writing any code in this repo.**

This document exists for one reason: to stop architectural drift across Claude
sessions. Every session starts with no memory. Without this file, each session
re-derives intent from code and gets it subtly wrong. If something here
conflicts with what you think is right, **this file wins** — or you stop and ask
Ryan. You do not silently "improve" a decision recorded here.

Ryan is not a programmer. Explain findings in plain language. Report what you
did and state plainly what you could not verify.

---

## 0. The one-minute version

Me-Tracker is a personal consistency tracker. Not a medical device, not a
research tool. It answers one question: *am I doing the things I said I'd do?*

Two halves:

- **Client** — static files, vanilla JS, no build step, no framework, no npm.
  Runs in Safari on an iPhone 16 Pro. **Owns the data** in localStorage.
- **Server** — Python on Ryan's Alienware R5 (Windows, always on), reachable
  only over Tailscale. Does the two jobs the browser cannot: Google Health API
  sync and food-photo vision. **Does not own the data.**

The client never holds a secret. The server never has a public port.

---

## 1. Governing principles

These are load-bearing. Violating one is a bug even if the code works.

### 1.1 Per-pillar defaults
For fasting and sleep, no log for a day still means the plan was followed. Do
not add "did you do X today?" prompts to those. **Training is now the explicit
exception: it assumes nothing** (see the table and §9.5). Dietary never assumed
anything either.

There is no single global default and there never really was — **do not
describe this app as "silence = compliance"**, that framing was retired. State
the rule per pillar:

| Pillar   | Unlogged day | Control |
|----------|--------------|---------|
| Fasting  | Assumed held — scores 100 | Fasting Fail button (§7.1). **No pause exists.** |
| Sleep    | 7h assumed | API overrides the assumption once it lands (§6) |
| Training | **Nothing assumed — an unlogged day scores 0** | Per-exercise checkboxes (§9.4, **read-only on Home**, **editable only on the day itself**) are the entire record — **no deviation control (§9.6)**. Not-started/running/pausable (§9.0/§9.1). Full rules in §9.5 |
| Dietary  | Nothing assumed | Macros count only when supplied |

- **Fasting.** The fast is assumed to have held unless the Fail button is
  pressed. Unlogged scores 100; only a `fastDeviations` record marking the day
  broken drops it to 0. Binary, per §7.1 — no hours-completed grading.
- **Sleep.** 7h is assumed when there is no data. The API overrides that
  assumption; it does not compete with it.
- **Training. Nothing is assumed — this pillar is the exception to the opening
  paragraph, deliberately.** Empty checkboxes mean it did not happen, and a day
  is editable only on the day itself. The phrase **"assumed done" no longer
  describes training, and neither does the schedule fallback** — both were
  retired on 2026-08-12 and survive only in the frozen pre-epoch path. Ticking
  is the record; a recorded Google Health session adds 50. Pausable — see §9.1,
  though pause no longer changes the score. **Full rules in §9.5.**
- **Dietary.** Nothing is assumed. Macros are counted only when supplied,
  because there is no defensible default for food that wasn't logged.

**Pause is training only.** Pausing holds the 12-week program clock and touches
nothing else — fasting, sleep and dietary scoring carry on unchanged. **There is
no global pause and must not be one.** Each pillar gets its own control with its
own ruleset; a single switch that suspended everything would make the number
mean "Ryan wasn't measuring" rather than "Ryan wasn't doing it."

**Scoped exception — training only.** Per-exercise checkboxes exist (§9.4)
because a commercial gym produces genuine partial completion (equipment in use,
time ran out). **Unchecked means not done** — half the boxes is half the score,
no boxes is zero — and a day can only be ticked on the day itself (§9.5). This
exception does not extend to fasting, sleep, or diet: they keep their own
defaults above.

**There is no deviation control.** The "Log a Deviation" tray on the Training
page was removed (§9.6) and nothing replaced it. `d.deviations` is still in
storage and still read by `derive.js` when scoring, but **no UI writes it**.
Deviation notes were already deprecated before that and are likewise never
written. **The Fasting Fail button and its note (§7.1) are a different control
and are unaffected** — that one stays.

### 1.2 localStorage is the source of truth
`metracker_v2` in the browser holds everything the app scores from. The server
is a **sidecar**, not a database: it fetches, aggregates, and hands back small
daily summaries. It does not hold the canonical record.

This was an explicit decision. Do not "upgrade" it to a server-side database.

### 1.3 Derive, never store
Anything computable at render time is computed at render time. Program week, HR
zones, scores, averages, relative strength — all derived. Stored data is only
what cannot be recomputed: measurements, logs, deviations.

### 1.4 The schema is additive-only
`metracker_v2` keys are never renamed, retyped, or removed. New features add new
top-level keys. A migration that rewrites existing data is never the answer.

### 1.5 Mobile-first
Every layout decision assumes a 393pt-wide iPhone screen held one-handed in a
gym. Generous font sizes. Tall scroll is fine. Tap targets at least 44pt.

### 1.6 No new colors
All color comes from the `:root` custom properties in `styles/tokens.css`. If a
design needs a color that isn't there, that is a conversation with Ryan, not a
hex literal.

### 1.7 Estimates are labeled as estimates
Vision-derived macros and hormone indices are guesses. They render visually
distinct from measured data. The app never presents an estimate with the same
confidence as a barcode lookup or a scale reading.

---

## 2. Hosting — Tailscale, not GitHub Pages

**The app is served from the Alienware over Tailscale.** GitHub is version
control and off-site backup only. It is not the host.

**The real address, for real** (this replaced an earlier `alienware.<tailnet>`
placeholder that never matched the actual machine):

```
Machine:    Alienware R5, Tailscale hostname desktop-1g38tar
Tailnet:    tail865703.ts.net
Tailscale IP: 100.112.223.16
URL:        https://desktop-1g38tar.tail865703.ts.net
Server:     server/app.py, bound to 127.0.0.1:8123 — loopback only
```

- Serve with `tailscale serve` — **not** Funnel. Funnel exposes to the public
  internet, which defeats the point. Serve gives HTTPS with a valid certificate
  at the URL above, which iOS Safari needs for a secure context.
- Client and API are same-origin. **No CORS, no preflight, no proxy shim.**
- No deploy step. Edit, refresh the phone.
- If Tailscale is off or the machine is down, the app is unreachable. Accepted.

### 2.1 The localStorage origin trap — read before any hosting change

localStorage is scoped to the **origin** — scheme + hostname + port, exactly.
Three different-looking addresses for the same machine are three different,
non-communicating storage buckets:

| Address | Origin |
|---|---|
| `http://127.0.0.1:8123` | local testing only |
| `http://100.112.223.16:8123` | the raw Tailscale IP |
| `https://desktop-1g38tar.tail865703.ts.net` | **the real one, used day to day** |

**Data saved under one of these is invisible from the other two. Not
deleted — unreachable**, sitting in a browser storage bucket keyed to an
origin nobody is loading any more. This bit Ryan once already with
`rjpursley.github.io` vs. the Tailscale hostname; it will bite again with
these three if they're not treated as genuinely different places.

**Before ever switching which address you load the app from: Export first.**
The drawer's Export Backup writes `metracker_v2` to a downloadable JSON file;
Import Backup reads one back in. This doubles as the backup against iOS
evicting site data from infrequently-visited sites, which it does.

**Rule of thumb: always use `https://desktop-1g38tar.tail865703.ts.net` on the
phone, every time, for real use.** The other two addresses are for testing
from the Alienware itself.

### 2.2 The PIN gate — removed 2026-08-11

**There is no PIN gate.** It was removed deliberately, not lost by accident —
if a future session finds no `checkPin()` in `index.html` and is tempted to
treat that as a regression, it is not one.

**Why it went:** the gate was written back when the app lived on GitHub
Pages, where the HTML (PIN included) was on a public URL anyone could read.
Once §2 moved hosting to Tailscale, that threat model was already gone — the
app is reachable only from Ryan's own devices, behind Tailscale's own auth,
behind his phone's lock screen. A `prompt()` dialog guarded nothing that
wasn't already guarded twice over, and §2.2 previously argued it was worth
keeping anyway as a "someone picked up an unlocked phone" speed bump. This
session's explicit instruction overrode that: `window.prompt()` is unsupported
in some mobile/WebView contexts (see the 2026-08-11 black-screen incident,
§2.2.1) — including, on some iOS versions, a page running in standalone
"Add to Home Screen" mode, which is a plausible way Ryan actually opens this
app day to day. A security control that can hang or crash the entire app for
its one legitimate user is a worse trade than the mis-tap risk it guarded
against.

**What was removed:** the inline `<script>` block that was the first thing in
`<head>` — `checkPin()`, its `prompt()`/`alert()` calls, the hardcoded PIN
value, and the redirect-to-Google punishment for a wrong guess or a cancelled
prompt. Nothing else lived in or after that block; it was checked, not
assumed, before deletion. The PIN number itself was also scrubbed from the two
dead copies of this file under `archive/` (never served, kept only as
history) — it does not appear anywhere in the repo any more.

**Do not re-add a PIN, password, or lock screen without asking Ryan first.**
If the hosting model ever changes back to something public, that is a
conversation, not a silent restoration of this file.

#### 2.2.1 The 2026-08-11 black-screen investigation

Ryan reported a black screen and suspected the PIN. Investigated before
assuming: served the real, unmodified `index.html` (PIN block intact) over
plain HTTP and captured the actual console error.

**What the error actually was:** `Error: prompt() is not supported`, thrown
inside `checkPin()`. Confirmed reproducible — matches what prior sessions
also reported.

**What it was NOT:** in every load tested, that thrown error did not by
itself blank the page — the DOM still rendered fully underneath it (nav,
score, prescription card, all populated), because the exception only aborted
that one inline `<script>` block; parsing continued into `<body>` and the
`js/app.js` module regardless. Stale ES module caching — the other suspect
named going into this session — was also checked directly and ruled out as
today's active cause: every `js/*.js` request came back a fresh `200` with no
link errors on a clean load, and `server/app.py` already carries anti-cache
middleware for `.js`/`.css` (§2.3 territory) from an earlier session.

**What was actually found, and fixed:** `index.html` itself had no
`Cache-Control` header at all — the existing anti-cache middleware only
matched `.js`/`.css` paths, never the HTML shell. Reproduced directly: after
editing `index.html`, a brand-new browser tab kept rendering the **old**
cached copy (PIN block and all), with no corresponding request even reaching
the server's access log — proof the browser was never revalidating, not just
caching briefly. That is a real, silent staleness bug of exactly the same
family the `.js`/`.css` middleware was already written to prevent, just
scoped to the file that boots the whole app instead of one module. Fixed by
extending that same middleware to also cover `/` and `/index.html`
(`server/app.py`) — now every load of the shell is `no-store`, matching the
scripts and styles it loads.

**Given both of the above, the most likely real-world explanation for
Ryan's black screen** is a combination: his phone had at some point cached
an old `index.html` (no header ever told it not to), and depending on the
exact WebKit build/mode showing it — particularly standalone "Add to Home
Screen" mode, where `prompt()` support is known to be unreliable — an
unsupported synchronous `prompt()` call can hang the render thread rather
than throw-and-continue the way it did in every environment tested this
session. A hang before `<body>` ever paints would look exactly like a black
screen, indefinitely, with no console error ever surfacing to explain it.
Removing the PIN gate entirely removes that hang path outright; fixing the
caching gap means a fresh load actually reaches his phone the next time
something changes, rather than being invisibly ignored.

**What to tell Ryan:** close the app fully (swipe it away, don't just
background it) and reopen it once after this ships, so his phone is
guaranteed to fetch the new `index.html` instead of whatever it has cached.
After that one reopen, the no-store headers mean this specific staleness
class shouldn't recur.

### 2.3 Running the server — for a future session with no memory of this one

Everything below assumes you're sitting at the Alienware (or connected to it).
This is written for six months from now, having forgotten all of this.

**Is it running right now?**
```
Invoke-RestMethod http://127.0.0.1:8123/api/health
```
A JSON reply (`status: ok`, a timestamp, `secrets_readable`) means yes. A
connection error means the server is not running — see "Start it by hand"
below. This only checks the LOCAL port; it says nothing about whether
Tailscale is currently exposing it (see the serve check further down).

**Start it by hand** (works whether or not it's set to start at boot):
```
powershell -File "C:\Users\Ryan\Desktop\Me-Tracker\server\start-server.ps1"
```
Leave that window open — it runs in the foreground and blocks for as long as
the server does. Closing the window stops the server. For it to survive you
closing the window, it needs to be running via the scheduled task instead
(next section) — start it through Task Scheduler
(`Start-ScheduledTask -TaskName "Me-Tracker Server"`), not by hand, if you
want it to keep running after you walk away.

**Restart it** — find and stop whatever's using port 8123, then start it
again:
```
Get-NetTCPConnection -LocalPort 8123 | Select-Object OwningProcess
Stop-Process -Id <that number> -Force
powershell -File "C:\Users\Ryan\Desktop\Me-Tracker\server\start-server.ps1"
```
Or, if it's running as the scheduled task:
```
Stop-ScheduledTask -TaskName "Me-Tracker Server"
Start-ScheduledTask -TaskName "Me-Tracker Server"
```

**Check the logs** if something's wrong — three files in `server\logs\`:
- `boot.log` — **check this one first.** One line per attempt to start the
  server (invoked / waiting on the venv / launched / exited), written by
  `start-server.ps1` itself before anything else happens. This is the file
  that would have shown "nothing was ever attempted" during the 2026-08
  incident below, if it had existed at the time.
- `server.log` — normal output.
- `server.err.log` — startup messages and errors; uvicorn logs its normal
  "server started" lines here too, so a few lines in this file on their own
  are not a problem.

**Starts automatically at boot, no login required**, via a Windows Scheduled
Task named "Me-Tracker Server" that runs as the built-in SYSTEM account
(chosen specifically because it needs no stored password — see the comment
in `server/register-scheduled-task.ps1`). One-time setup, only if it isn't
already registered:
```
# From an elevated PowerShell window — right-click PowerShell, "Run as
# administrator" — this specific step does not work from a normal window:
powershell -File "C:\Users\Ryan\Desktop\Me-Tracker\server\register-scheduled-task.ps1"
```
Confirm it's there: `Get-ScheduledTask -TaskName "Me-Tracker Server"`.
Remove it entirely: `Unregister-ScheduledTask -TaskName "Me-Tracker Server" -Confirm:$false`.

**Is Tailscale actually exposing it to the phone?**
```
tailscale serve status
```
Should show port 8123 mapped to `https://desktop-1g38tar.tail865703.ts.net`.
If it says "No serve config", run `server/tailscale-serve.ps1` — this is
NOT tied to the boot task or the Python server; it's a separate, one-time
Tailscale-side setting that (unlike the scheduled task) persists on its own
and does not need re-running after a reboot.

**If `tailscale serve` or `tailscale cert` complains that this account
doesn't support getting TLS certs**, that's not a bug — HTTPS Certificates
needs to be turned on for the tailnet first, in the
[Tailscale admin console](https://login.tailscale.com/admin/dns), under DNS
→ HTTPS Certificates. That's a one-time toggle only a tailnet admin (Ryan)
can flip; nothing on the Alienware side can work around it. Do not fall back
to plain HTTP as a workaround — iOS Safari needs the secure context HTTPS
provides, and the whole reason `serve` (not `funnel`) is used is to get that
without exposing anything to the public internet.

### 2.4 The 2026-08 "server dead after reboot" incident

**Symptom:** after a reboot, port 8123 was closed and the app was unreachable.
`Get-ScheduledTaskInfo` showed `LastRunTime` stuck at `11/30/1999` — Windows'
sentinel for "this task has never once fired" — not a crash after starting.
The Task Scheduler operational log (the thing that would normally record a
boot trigger firing) was **disabled** on this machine, so there was no
record of what happened at that boot, and no way to confirm the exact
mechanism.

**What was fixed, without being able to prove which part was the original
cause:**

1. **Enabled the TaskScheduler/Operational event log** (`wevtutil sl
   Microsoft-Windows-TaskScheduler/Operational /e:true`) so any future boot
   leaves real evidence instead of nothing.
2. **Added a 30-second delay to the boot trigger** in
   `register-scheduled-task.ps1`. A bare `AtStartup` trigger fires the
   instant the Task Scheduler engine itself comes up, which is earlier than
   some systems are fully ready for. This machine also has **Fast Startup
   (hiberboot) turned on** (`HiberbootEnabled = 1`), which is a
   Microsoft-documented source of unreliable `AtStartup` trigger firing,
   because a plain "Shut down" is a hybrid shutdown that resumes the kernel
   session rather than performing a genuine boot. The delay is the standard
   mitigation. Disabling Fast Startup entirely (Control Panel → Power
   Options → "Choose what the power buttons do" → uncheck "Turn on fast
   startup") would remove that variable altogether, but that's a Windows
   power setting, not something this repo can flip — it's Ryan's call if
   the delay alone isn't enough.
3. **Added a retry loop and a dedicated `boot.log`** to `start-server.ps1`
   (§2.3 above). Before this, a transient miss (venv not yet visible on
   disk, antivirus still scanning it) threw immediately and left **zero**
   evidence anywhere that the task had even tried. Now it retries for up to
   a minute and logs every attempt, success or failure.
4. **Found and fixed an unrelated, real bug introduced while writing this
   fix, not the original cause:** editing `start-server.ps1` and
   `register-scheduled-task.ps1` stripped their UTF-8 byte-order mark. A
   `.ps1` file with no BOM is read using Windows' default codepage
   (`cp1252` on this machine), not UTF-8. One of the new log lines had an
   em dash inside an actual string (not a comment); under `cp1252` its
   bytes decode into a Unicode "smart quote" character, which PowerShell's
   parser treats as a real string terminator — silently corrupting the
   whole script into something that fails to parse at all. Caught before
   it shipped by decoding the files exactly as a BOM-less script would be
   read and re-parsing them; both files now carry an explicit UTF-8 BOM
   again and the em dash was removed from the one string that had it.
   **Lesson for future edits to these two files: keep a UTF-8 BOM on them,
   and keep punctuation like em dashes out of actual string literals (they're
   fine in `#` comments).**

**What was verified live, without a reboot:** the server was already running
at the time of this fix (started earlier via `Start-ScheduledTask`, not by
this fix), and `/api/health` returned `secrets_readable: true` — confirming
the `METRACKER_SECRETS_DIR` override in `start-server.ps1` really does work
correctly when the process is actually running as SYSTEM, which is the part
of §2.3's design most worth doubting. NTFS permissions on
`C:\Users\Ryan\.metracker` were also checked and already grant SYSTEM full
control, so that was never the problem.

**What was NOT verified: an actual reboot.** Everything above is confirmed
by reading logs, checking permissions, and running the updated
`start-server.ps1` by hand — not by restarting the machine and watching it
come back on its own. The one-time step below still needs to be run once
(elevated) for the new boot delay to take effect, and then the real test is
a genuine restart with nobody touching the keyboard afterward: port 8123
listening, the phone able to load `https://desktop-1g38tar.tail865703.ts.net`,
and `/api/health` showing `secrets_readable: true` — with `boot.log` showing
what happened either way.

---

## 3. Repo structure

```
Me-Tracker/
├── index.html              # Shell only: topbar, drawer, page mounts
├── ARCHITECTURE.md         # This file
├── .gitignore              # Covers client_secret*.json, env.txt, *.env, etc.
│
├── styles/
│   ├── tokens.css          # :root variables. THE only place colors are defined
│   ├── base.css            # Reset, typography, layout primitives
│   └── components.css      # Cards, bars, keypad, day-strip, checkboxes
│
├── js/
│   ├── app.js              # Entry point. Modules need one; keeps the bootstrap out of index.html
│   ├── util.js             # Local-date helpers. Below store/schedule so imports cannot cycle
│   ├── store.js            # metracker_v2 read/write, export/import. Schema owner
│   ├── schedule.js         # SCHEDULE, PROGRESSION, PROGRAM_START constants
│   ├── derive.js           # Scoring, program week, HR zones, averages
│   ├── api.js              # Calls to the local server. All fetch() lives here
│   ├── components/
│   │   └── vitals-header.js  # Live HR / zone / steps. Mounted on Main AND Training
│   └── pages/
│       ├── home.js
│       ├── training.js
│       ├── dietary.js
│       ├── vitals.js       # Sleep / HR / Steps
│       ├── fasting.js
│       ├── health.js       # Health Status
│       ├── prs.js          # Personal Records. Tested 1RMs for the four main lifts
│       ├── calendar.js     # Drawer's Calendar page. Exists today, so its code needs a home
│       └── log.js          # Drawer's Log Entry page. Same reason; keeps one screen in one file
│
├── server/                 # Runs on the Alienware, also serves the client
│   ├── app.py              # FastAPI. Binds 127.0.0.1:8123 ONLY — see §2
│   ├── requirements.txt    # Pinned via pip freeze — see §2.3
│   ├── start-server.ps1    # What Task Scheduler (or you, by hand) runs
│   ├── register-scheduled-task.ps1  # One-time, needs an elevated window
│   ├── tailscale-serve.ps1 # One-time Tailscale-side exposure — see §2.3
│   ├── .venv/               # gitignored — not committed, recreate from requirements.txt
│   ├── logs/                # gitignored — boot.log / server.log / server.err.log
│   ├── google_health.py    # BUILT (§6) — OAuth refresh, paginated pulls, aggregation
│   ├── google_health_auth.py # BUILT (§6.4) — one-time, by-hand consent flow
│   ├── data/               # gitignored — vitals_daily.json + raw/ (§6)
│   ├── vision.py           # NOT YET BUILT — Ollama minicpm-v job queue
│   └── barcode.py          # NOT YET BUILT — Open Food Facts lookup
│
└── archive/                # Superseded files. Never read these as current.
```

**Secrets live in `C:\Users\Ryan\.metracker\`** — outside the repo entirely, so
no git command can reach them. Read via `Path.home() / '.metracker'`, overridable
with the `METRACKER_SECRETS_DIR` environment variable. Never hardcode the
username.

**Why the split:** the single file reached 85KB and became the primary cause of
session drift. File boundaries are the fix. Do not re-merge them.

Uses ES modules (`<script type="module">`), native in Safari. No bundler.

---

## 4. Navigation model

**Two levels. That is the whole model.**

```
Main Page
├── Live HR + zone + step count      (pinned at top)
├── 2-week calendar strip            (7 days back … today … 7 days forward)
└── Consistency Score box            — every row is a nav button
    ├── Score        (aggregate; no page)
    ├── Training     → Training page
    ├── Dietary      → Dietary page
    ├── Sleep/HR     → Vitals page
    ├── Fasting      → Fasting page
    └── Health       → Health Status page
```

Every row shows **two numbers: `week avg / month avg`**. Until enough history
exists both render `0/0`. Do not show a partial average computed over three
days — suppression was chosen deliberately.

The drawer is unchanged. The score box is an additional entry point, not a
replacement.

**One deliberate third level: Training → Personal Records** (§10.1). It is the
only one, and it was a choice between two rules. The drawer was the natural home
for a rarely-used logging page, but §11 protects drawer structure; 1RMs are
training data, so they sit behind Training. Logging a tested max happens roughly
once per 12-week cycle, so burying it one level deeper costs nothing daily.
**This is not a licence to nest further.** If a third level is ever wanted
again, that is a conversation with Ryan.

Vitals keeps **3 days of history maximum** on screen. Longer ranges exist only
as graphs and averages, not as scrollable detail. **BUILT:** the Vitals
page's two scrollable lists (`sleep-history`, `hr-history` in
`js/pages/vitals.js`) are capped at `HISTORY_DAYS_MAX = 3`; the 15-day chart
and the three average cards above it are the "graphs and averages" this
section carves out, and keep their existing 15-day window.

---

## 5. Heart rate zones — Karvonen

**Decided. Do not substitute a different formula.**

```
HR_MAX_METHOD  = 'tanaka'     // 208 - (0.7 * age)
HR_ZONE_METHOD = 'karvonen'   // % of heart rate reserve
```

```
maxHR  = 208 - (0.7 * age)
HRR    = maxHR - restingHR
zoneLo = restingHR + (HRR * pctLo)
zoneHi = restingHR + (HRR * pctHi)
```

| Stage | Name            | % HRR   |
|-------|-----------------|---------|
| 1     | Active Recovery | 50–60%  |
| 2     | Aerobic Base    | 60–70%  |
| 3     | Tempo           | 70–80%  |
| 4     | Threshold       | 80–90%  |
| 5     | Peak            | 90–100% |

`restingHR` comes from `dailyRestingHeartRate` via the API, recalculated weekly.
**Never hardcoded.** As conditioning improves resting HR falls and zones shift
down automatically — that shift is itself evidence the program is working.

**BUILT (§6):** `derive.js`'s `weeklyRestingHR()` averages the trailing 7
days of the API's daily resting HR; `karvonenZones()`/`currentZone()` combine
that with `tanakaMaxHR(age)`. Age has no other home in the schema and is
entered on the Health Status page, stored additively as `d.body.age`. Either
missing means no zone table — never a guessed one.

**Why Karvonen:** plain %MHR put Zone 2 at 106–124 bpm; Karvonen puts it near
133–144. Training at the lower band builds little aerobic base. If a future
session "corrects" this back to %MHR, that is drift, not a fix.

---

## 6. Google Health API — BUILT

Replaces the Fitbit Web API (deprecated September 2026). Google OAuth 2.0.
The Fitbit account is already migrated to Google sign-in.

**Files:** `server/google_health.py` (the sync engine — OAuth refresh,
pagination, aggregation, the server-side store) and
`server/google_health_auth.py` (the one-time, by-hand consent flow, see
§6.4). Endpoints live in `server/app.py`; the client's read path is
`js/api.js` (fetch + in-memory cache) feeding `js/derive.js`
(`hasStartedActivity`, `getSleepForDate`, the Karvonen helpers, §5) and
`js/components/vitals-header.js`.

**Credentials live in `.metracker/` only.** Two files:
`client_secret.json` (client ID + secret) and `google_refresh_token.json`
(written by google_health_auth.py, §6.4). Never read, printed, logged, or
returned by any endpoint — `google_health.py`'s secrets-handling functions
pull only the two fields needed to build a `Credentials` object in memory.

**Consent screen stays in Testing status** with Ryan as a Test User. This grants
restricted scopes without the production review queue. Refresh tokens for
unverified apps expire periodically; re-running consent (§6.4) is expected
maintenance, not a bug.

### 6.1 Two rules that silently corrupt data if ignored

1. **Always follow `nextPageToken`.** Responses cap at a few thousand rows; one
   day of 5-second HR is roughly 8,700. `fetch_data_points()` in
   `google_health.py` loops until `nextPageToken` is absent and logs the page
   count for every pull to `server/logs/sync.log` — so a silent truncation
   would show up as a suspiciously low page count in that log, not just look
   like a short day. Verified against a synthetic 8,700-point day (mocked
   HTTP, not the live API): 9 pages at 1,000/page, all 8,700 points returned.

2. **Aggregate on ingest; the browser gets summaries only.** Per day, the
   server stores: resting HR, the single latest heart-rate reading (bpm +
   timestamp — see §6.2 on why this one exception exists), minutes per
   device-defined HR zone, workout avg/peak HR, sleep stage totals, steps,
   weight, body fat %, HRV, VO2 max, and the list of started exercise
   sessions. `GET /api/vitals/*` (§6.3) only ever returns this aggregate.
   Raw intraday samples are cached server-side under `server/data/raw/` for
   about 7 days for debugging (`purge_old_raw()`), then deleted, and are
   never served to the client.

### 6.2 What "live HR" in the vitals header actually means

The header (§4) shows a `Heart Rate` reading, but rule 2 above means the
browser never receives a raw sample stream — there is no real-time bpm to
show. The one deliberate exception: `aggregate_day()` reduces each day's raw
heart-rate pull to a single `latestHR: {bpm, at}` — the most recent sample of
the day, and nothing else from that series. That is still a small daily-
summary field, not raw data, and it is only ever as fresh as the last sync
(nightly, or whenever `POST /api/sync` was last run) — never a live stream.
If the server has no reading for today, the header shows the em-dash
placeholder, never a stale number from a previous day (§1.7, §4).

**HR zone minutes (`hrZoneMinutes`) are the device's own zone buckets**,
passed through under whatever labels the API returns — **not** the app's
Karvonen zones. The live header's `Zone` value is computed client-side, from
`latestHR.bpm` + the Karvonen formula (§5) + age; the stored `hrZoneMinutes`
is a separate, historical field for later graphing. Do not conflate the two.

### 6.3 Endpoints and sync schedule

| Route | Method | Returns |
|---|---|---|
| `/api/vitals/{date}` | GET | One day's aggregate, or `{date, found:false}` |
| `/api/vitals?from=&to=` | GET | `{days: {date: aggregate, ...}}` for a range |
| `/api/sync` | POST | Triggers a sync of the trailing `SYNC_RANGE_DAYS` (3) days; returns per-type counts/page-counts/errors |
| `/api/sync/status` | GET | `{lastWriteUtc, daysStored}` — see §6.5 |

**Manual sync re-pulls the last 3 days, not just today**, because Fitbit/
Google generally only finish settling a day's sleep and HRV once Ryan's phone
itself syncs overnight — a sync that only ever asked for "today" could
permanently miss a late-settling yesterday. Re-pulling a small trailing
window is cheap and makes that class of miss self-correcting within days. The
nightly automatic sync (`server/app.py`'s `_nightly_sync_loop`) uses the same
window on the same schedule.

**Nightly sync runs at 04:15 local**, chosen for three reasons:
- It sits a clean 20 minutes past the end of the Ollama vision window
  (20:30–03:55, §8), which shares the Alienware's GPU/VRAM with a trading
  bot — a sync never overlaps that window.
- It is late enough that Fitbit/Google have almost always finished settling
  the previous day's sleep and HRV by then.
- It is well before Ryan is normally awake, so the pull's minute or two of
  network activity is invisible either way.

### 6.4 Running the consent flow (refresh token missing or expired)

`google_health.py` never attempts this itself — a background service running
as SYSTEM at boot has no desktop session to show a browser in, and must fail
with a clear message instead of hanging. When `/api/sync` or the nightly log
reports "No refresh token on file" or "Google rejected the refresh token",
run, from a normal logged-in session on the Alienware:

```
server\.venv\Scripts\python.exe server\google_health_auth.py
```

Sign in and grant the three requested scopes when the browser opens. It
writes `.metracker\google_refresh_token.json` and prints confirmation — no
server restart needed, the next sync just picks it up. If Google doesn't
issue a fresh refresh token (it can decide a live grant already exists),
remove Me-Tracker's access at https://myaccount.google.com/permissions and
run the script again, which forces a fresh consent screen.

### 6.5 Telling whether the last sync succeeded

- `GET /api/sync/status` — `daysStored` should be non-zero and `lastWriteUtc`
  recent (within the last day, given the nightly schedule).
- `server/logs/sync.log` — every attempt, manual or nightly, logs its start,
  the page count and row count per data type, and either what it wrote or
  exactly what failed (auth, network, an unexpected response shape). Same
  reasoning as `boot.log` (§2.3): a sync that silently never ran should leave
  a visible gap here, not just an app with stale numbers.
- `GET /api/vitals/{today}` returning `found:false` for a day well after it
  should have synced is the symptom; the log above is where to find why.

### 6.6 Field names and filter grammar — confirmed, not guessed

**The first real sync (2026-08-11) 400'd on every data type.** The original
build guessed at filter grammar and field names from partial public docs;
the guesses were wrong in specific, now-understood ways — see the fix note
at the top of `google_health.py` for the full diagnosis. Two classes of bug:

1. Two internal type keys (`daily_hrv`, `time_in_hr_zone`) were shorthand
   that didn't match Google's real snake_case identifiers
   (`daily_heart_rate_variability`, `time_in_heart_rate_zone`) — the filter
   string's data-type prefix has to be the real name.
2. Every filter used an invented member path (`interval.civil_end_time`,
   which only exists for `sleep`) and `<=` where the API only accepts `<`.

**The fix, and where the real answer came from:** Google's own discovery
document, `https://health.googleapis.com/$discovery/rest?version=v4` — fetch
it and read `resources.users.dataTypes.dataPoints.methods.list.parameters
.filter.description` for the authoritative filter grammar, and
`schemas.DataPoint.properties` for the real per-type field names (the kebab-
case path each one names is right there in each field's description). This
beats the narrative docs pages, which are incomplete. `FILTER_CATEGORY` in
`google_health.py` encodes what that document says: every type is
`interval`, `sample`, `daily` (date-only, no time), or — the one exception —
`sleep`, which is filtered by its **end** time, not start.

**No more guess-and-retry.** The original "try interval, fall back to
sample on a 400" logic is gone. A 400 now is a genuinely unexpected
problem, logged in full (never truncated — a 300-character slice used to
cut the response off right before the part naming the bad filter member,
which is most of why this took two sessions instead of one) and raised, not
silently retried with a different guess.

**Verified against live data**, not just against a 200 status code: real
steps/resting-HR/sleep numbers, heart-rate pagination confirmed at 21 pages
for a single day (8,475 samples), and a forced credential failure left the
daily store byte-for-byte unchanged. See the 2026-08-11 session's commit
for the exact figures.

### 6.7 Day-boundary bucketing — civil day, never UTC

**A second bug, found right after §6.6's fix:** syncing one date alone and
syncing a range containing that date produced different totals for it —
13809 vs 14306 steps for the same day. Root cause: `_bucket_by_day()`
decided which day a point belonged to by calling `.date()` on its raw UTC
timestamp. A step or HR-zone interval starting in the Eastern evening has a
UTC timestamp after midnight the *next* UTC day, so `.date()` filed it a day
late — and *which* points crossed that boundary depended on the query
window, since a single-civil-day query and a wide-range query pull
different sets of them. Same family of bug as the `toISOString()`/local-date
issue this project has already been bitten by once (§12), now on the server.

**THE BOUNDARY RULE: a data point belongs to whatever local civil day
Google's own API already computed for it** — the identical concept the
query filter is built on (§6.6), so bucketing can never disagree with what
was fetched. Confirmed by inspecting live responses (not assumed from the
schema): `steps`, `heart_rate`, `weight`, `body_fat`, and
`time_in_heart_rate_zone` all carry a `civilStartTime`/`civilEndTime`/
`civilTime` field with this precomputed date. `exercise` and `sleep` do
**not** get it populated despite the schema declaring it available — for
those two only, the local date is computed manually from the UTC time plus
its `startUtcOffset`/`endUtcOffset`, never from the bare UTC timestamp.
`sleep` still buckets by its **end** time (the wake day), matching how it's
filtered (§6.6).

Verified: single-day and range syncs of the same date now produce
byte-identical totals. Do not "simplify" `_bucket_by_day()` back to a plain
`.date()` call on a UTC timestamp — that is this exact bug returning.

### 6.8 Backfill scope — 2026-05-17 onward, not full history

Google Health actually holds data back to **2021-07-30**, with steady
day-by-day coverage through 2024-08, then a ~20-month gap with nothing at
all, then it resumes 2026-05-17 (with a couple of shorter internal gaps —
late May, and late June through 2026-07-29 — matching "Fitbit stopped
pushing in late June and has now resumed").

**The 2026-08-11 backfill deliberately covers only 2026-05-17 through
today**, not the full 2021+ history. Pulling ~3 years of 5-second
heart-rate samples at scale (391,835 rows for the ~87-day window that WAS
pulled, across 394 pages) would mean tens of thousands of pages and a
multi-hour run for data this app has no use for — it aggregates to daily
summaries and never needed 2021 in the first place. This was a judgment
call, not an instruction followed to the letter (the request said "the
earliest date Google Health has"); if the full history is ever wanted, sync
from `2021-07-30` explicitly rather than assuming today's default range
covers it.

### 6.9 Every reader of synced data must go through `getCachedVitals()`

**Diagnosed and fixed 2026-08-12.** The Vitals (Sleep / HR) page showed an
empty 15-day chart, em-dashes for Resting HR and Workout HR, and "No sleep
data yet" — while Steps on the same page, same window, rendered fifteen days
correctly. The server was serving real values the entire time.

**The pipeline was healthy end to end.** Google held the data, the sync
fetched it, `aggregate_day()` kept it, and both `/api/vitals/{date}` and
`/api/vitals?from=&to=` served it. The fault was one file at the very last
step: `js/pages/vitals.js` read sleep and heart rate **only** from
`d.sleeps` / `d.hrs` — the manual-entry arrays written by the two forms at the
bottom of that same file. Ryan has never hand-logged sleep or HR, because the
watch does it, so those arrays were empty. Steps rendered because steps was
the single line on the page wired to `getCachedVitals()` when §6 was built.

**THE RULE: `d.sleeps` and `d.hrs` are the MANUAL log, not the data set.**
Anything that displays or scores a vital must consult the Google Health cache
as well, with the §6 precedence — a manual log wins where one exists, the
synced aggregate fills the gap, neither means "no data" and never a guess
(§1.7). `derive.js`'s `getSleepForDate()` and `weeklyRestingHR()` already did
this correctly, which is why the **sleep pillar score and the Karvonen zones
were right the whole time** and only the page display was blind. Two read
paths for the same fact is what allowed one of them to rot unnoticed.

**Why it hid for so long:** every symptom of an empty manual array is
identical to the symptom of a failed sync. A blank chart and an em-dash look
like "the server is down", so the investigation naturally starts at the server
— which was fine. The discriminating evidence is per-data-type: a sync failure
cannot return steps for fifteen days and nothing for sleep across the same
window through the same code.

**Checklist for a future session adding any synced metric to a page:** wire
the display to `getCachedVitals()` at the same time as the aggregation, not
later. If a metric renders blank, check which array the *page* is reading
before suspecting the sync — `sync.log` and `server/data/vitals_daily.json`
will tell you in under a minute whether the data ever arrived.

#### Genuine data gaps, which are NOT this bug

Fixing the above does not fill every day, and that is correct behaviour:

| Field | Coverage in the store (46 days, 2026-05-17 → 08-12) | Why |
|---|---|---|
| steps | 46 / 46 | — |
| restingHR | 39 / 46 | Google has none on the rest |
| sleep | 25 / 46 | Google returns zero sleep rows for those dates — **notably 2026-07-30 → 08-05**, where resting HR exists but sleep does not. A wear/device-sync question, not a code one. |
| workout avg HR | 9 / 46 | only days with a recorded session |
| hrv | 17 / 46 | Google has none on the rest |
| weight / bodyFatPct / vo2Max | 0 / 46 | Google returns **zero rows for every date** — the Versa 2 does not report these. Confirmed a separate cause from the above, not a shared bug. |

**Sleep stage detail varies by record type.** Google returns `CLASSIC` records
(one `ASLEEP` total, no breakdown) and `STAGES` records (`AWAKE`/`LIGHT`/
`DEEP`/`REM`). Deep sleep is genuinely unavailable on `CLASSIC` nights and the
UI must say so rather than render `0.0h deep`.

**Open, deliberately not fixed here:** `aggregate_day()` sums *all*
`stagesSummary` minutes into `sleep.totalMinutes`, which includes `AWAKE` —
so a night with 12 awake minutes stores 572 rather than 560. It inflates
sleep hours slightly and therefore the sleep score. Left alone because it
changes stored aggregates and scoring, which is Ryan's call, not a drive-by
fix during a display bug.

---

## 7. Fasting protocol — intermittent only

**One protocol. Every single day. No exceptions, no variation by weekday and
no variation by program week.**

| Fast | When | Window |
|---|---|---|
| Daily 18:6 | **every day** | eat **12:30–18:30** local, fast the rest |

That is the whole table.

### ############ REMOVED — DO NOT REINTRODUCE ############

Three extended fasts have been removed from this app across three separate
decisions. A future session that finds the schedule "too simple" and adds one
back is causing drift.

| Removed fast | Was | Removed |
|---|---|---|
| Quarterly 60–72hr | every quarter | earlier session |
| **Weekly 24hr** | Sat 18:30 → Sun 18:30 | **2026-08-12** |
| **Deload 48hr** | Fri 18:30 → Sun 18:30, program weeks 4 and 8 | **2026-08-12** |

Also removed with them, in `derive.js`: `isDeloadFastWeek()`,
`FASTING_PROTOCOL.DELOAD_WEEKS` / `TEST_WEEK` / `weeklyHours` / `deloadHours`,
the never-in-week-12 test-week rule, and the paused-program `week: null`
special case. That last one existed **only** so a deload fast could ask "is
this week 4?" on a date with no program week to answer with; with no
week-dependent fast left, there is nothing to special-case, and `fastPlan()`
now reports the real program week (or `null` while not started) honestly.

They were deleted outright rather than left behind a disabled flag — the same
reasoning `schedule.js` records for the old per-weekday `fastLabel`. Dead data
describing a retired protocol is precisely what a future session mistakes for
the current one.

**Ryan can still log a longer fast by hand.** The Log Entry page's fast-type
`<select>` still offers 16:8 / 18:6 / OMAD / 24h / 36h / 48h, deliberately.
What shrank is the *scheduled* protocol, not what can be *recorded*.

**Fasting scoring did not change.** Still binary, still assumed-held, still
dropped to 0 only by the Fasting Fail button (§7.1). `fastBroken()`,
`d.fastDeviations` and the Fail control were not touched.

### 7.0 Where the protocol lives
The schedule is `fastPlan(date)` in `derive.js`, returning
`{kind, protocol, headline, detail, week, paused}`. **`kind` is always
`'daily'`** — there are no other kinds. The return shape was kept deliberately
so `pages/fasting.js` needed no rework; `week` and `paused` are still reported
honestly even though neither changes the plan any more. It is pure derivation
(§1.3).

**The timer and phase engine are a separate thing and remain protected (§11).**
`calcFastHrs()`, `getPhase()`, the phase bar and `startFastTimer()` are
untouched. Changing *which fast is scheduled* is not the same as changing *how
a running fast is measured*; do not confuse the two.

`schedule.js` used to carry a per-weekday `fastLabel` string describing the OLD
protocol — a static per-weekday string cannot express a fast that depends on
the program week, so it went unread once `fastPlan()` took over and was later
removed entirely rather than left as dead data. Do not add it back.

### 7.1 Fasting Fail button
A deviation control, matching the missed-workout pattern. Silence means the fast
held; one tap means it did not.

- **Binary.** No partial credit, no hours-completed grading. A break is a break.
- **Intentional breaks count as fails.** There is no "planned exception" escape
  hatch. Decided explicitly: an exemption path would drift toward exempting
  everything, and then the number measures nothing.
- **Optional free-text note.** No extra tap required. Exists so a bad month reads
  as "eight fails, six of them travel" rather than just "eight."

Stored additively as `d.fastDeviations{}`, keyed by date:
`{ broke: true, note: "" }`

Do not soften the wording in the UI and do not add a confirmation dialog. The log
should be frictionless and unemotional.

---

## 8. Food tracking — confidence tiers

Every macro entry carries a `confidence` field. Not decoration: the Dietary score
treats low-confidence sugar as a range, not a point value.

| Tier    | Source                      | UI treatment      |
|---------|-----------------------------|-------------------|
| `exact` | Barcode → Open Food Facts   | Normal            |
| `high`  | Label OCR via minicpm-v     | Normal + ~ prefix |
| `low`   | Plate photo volume estimate | Muted + ± range   |

**Order of attempt is always barcode → label OCR → plate estimate.**
Deterministic lookup before inference, always.

### Vision pipeline timing
Ollama `minicpm-v:latest` (Qwen2 7.6B, Q4_0, CLIP projector, 32k ctx) shares VRAM
with a trading bot. **Vision jobs run 20:30–03:55 only.** Photos upload from the
phone immediately and queue server-side until the window opens. Macros appear the
next morning. This latency is accepted by design — do not add a "process now"
button that would contend for VRAM.

Plate estimates use a 3D-printed fiducial of known width **and height**, shot at
an angle so height projects into the frame.

### 8.1 Supplements are user-editable

**This supersedes the "Supplement list" line in §11.** The list is Ryan's data,
not a constant: add, delete and reorder all live on the Dietary page.

- Stored as `d.supplements` — an array of `{name, detail, icon}`.
- The original three (Himalayan salt, CoQ-10, Magnesium Threonate) are now
  `SEED_SUPPLEMENTS` in `store.js`, which owns the schema and its defaults.
- **The seed applies only when the key is ABSENT.** An existing empty array is a
  valid state meaning "Ryan deleted them all"; re-seeding would resurrect
  entries he removed on purpose.
- Still **unscored** — a checklist, not a pillar. Do not wire it into scoring.
- Do not hardcode supplements in `index.html` again.

### 8.2 Suggested macro targets

Under each Macro Target input the Dietary page shows a suggested value derived
from bodyweight:

```
protein  = bodyweight × 1.0 g
calories = bodyweight × 15            (maintenance baseline)
fat      = 25% of calories ÷ 9
carbs    = remainder after protein and fat
sugar    = 10% of calories ÷ 4        (a ceiling, not a goal)
```

Worked at a 200 lb rolling bodyweight: 3000 kcal → protein **200 g**, fat
**83 g**, carbs **363 g**, sugar **75 g max**.

- **SUGGESTIONS, NOT AUTOFILL.** Nothing writes to `d.targets`. Ryan's entered
  value always wins, and the suggestion renders beside it either way.
- **Bodyweight is the 7-day rolling average** (§10), never the latest daily
  reading — daily weight is mostly water, and a target that swung with
  yesterday's salt would be noise.
- **No bodyweight means no suggestion.** Every field renders `—`. Do not
  substitute a default weight: a macro target invented from a number Ryan never
  entered is worse than a blank.

#### Resting HR and waist do not feed these — decided explicitly

Both are available and both are tempting. **They are progress indicators, not
nutrition inputs.** Wiring them in would move suggested protein because Ryan
slept badly or measured his waist after a large meal — the number would drift
for reasons that have nothing to do with what he should eat, and he would stop
trusting it. Training load enters through bodyweight and the ×15 multiplier
only. Activity-adjusted calories would be a conversation with Ryan, not a quiet
edit.

### 8.3 Macro consistency graph

The Dietary page's old "Meal History" list is replaced by a single button that
opens a 30-day macro graph (protein / fat / carbs / sugar). A list answered
"what did I eat"; the question that matters is "am I hitting the same numbers
day after day".

**Days with no meals logged are gaps, not zeroes.** An unlogged day is not a
zero-protein day, and the card says so under the chart.

Chart.js colour literals are the documented §1.6 exception — canvas cannot
resolve `var()`. They stay confined to the chart config; the on-page legend uses
real tokens.

---

## 9. Training page

**Status: description, not specification** — except where marked. The page
renders, top to bottom: the live vitals header, the program pause card, the
Personal Records nav row, and the prescription card (today's, or the selected
day's) with a checkbox per exercise. **Nothing below the card** — the deviation
tray that used to sit there is gone (§9.6).

**Training scoring is defined in §9.5.** That section is the authority; if the
code disagrees with it, the code is wrong.

### 9.0 Three program states — not started / running / paused

**Not started is a distinct state from paused.** Before this existed,
`PROGRAM_START` was a hardcoded constant and `programWeek()` counted calendar
days from it unconditionally, so a program nobody had begun still displayed
"Week 2 of 12" — a number with no meaning, because Ryan had not trained a
single session. The fix is a third state, not a special case of pause.

| State | Stored as | `programWeek()` | Training page shows |
|---|---|---|---|
| **Not started** | `d.programStart === null` | `null`, always | "Program not started" + Start control |
| **Running** | `d.programStart` is a date, no open pause | `1`–`12` | "Program running · Week N of 12" + Pause control |
| **Paused** | `d.programStart` is a date, open entry in `d.programPauses[]` | held at the week it was paused on | "Program dormant · Held at week N of 12" + Resume control |

**Stored additively.** `d.programStart` is a `YYYY-MM-DD` string once Ryan
taps Start, or `null` before that. `store.js`'s `init()` and the `app.js`
migration guard both default it to **`null`, never to `PROGRAM_START`** — a
store gaining this field for the first time (i.e. every store that existed
before this feature) must read as *not started*, not silently become
"already running since a hardcoded date". That would have reproduced the
exact bug this feature exists to fix.

**`PROGRAM_START` (`schedule.js`) is kept — per §1.4's spirit for code
constants — but demoted.** It is no longer read as "the" start date anywhere.
Its only remaining job is a last-resort fallback inside `programWeek()` if a
stored `programStart` value is present but malformed (fails `Date` parsing),
so the function still cannot throw. Do not delete it, and do not restore it
as the default.

**`programWeek(ds)` returns `null` while not started — never `1`, never a
computed value.** Every caller must treat `null` as "no week to report", not
coerce it. `fastPlan()` (§7) passes it straight through as `plan.week`, which
is allowed to be `null`; nothing in the fasting protocol depends on the week
any more, so there is no longer a caller that could be forced into guessing
one. The renderer must not coerce `null` into a number either.

**Starting the program** (`pages/training.js`'s `startProgram()`) sets
`d.programStart` to today and does nothing else — it does not touch
`d.programPauses`. Week 1 then means week 1, counted from the day Ryan
actually began. The control sits on the Training page behind the **same
random 3-digit keypad gate** pause/resume already use (§9.2) — reusing the
gate, not a new one, because starting is exactly the kind of decision Ryan
should not trigger by mis-tap either. It is a one-way transition: there is no
UI path back to not-started once started.

#### The interim home routine

Ryan trains at home until the gym (and Alsruhe) opens. **`HOME_SCHEDULE`**
in `schedule.js` is a second, complete schedule — same `{name, equip, detail,
block}` shape as Alsruhe's `SCHEDULE`, sourced from `Simple Workout
Routine.rtf` in the repo root (65lb sandbag, ~42-45lb sandbag, 50lb
kettlebell, 10-25lb gada club, pull-up bar) — that is **active only while
Alsruhe has not been started.**

- **`getActiveScheduleForDate(ds)` in `derive.js` is the one and only place
  that routing decision is made:** Alsruhe's `SCHEDULE` once
  `isProgramStarted()`, otherwise `HOME_SCHEDULE`. Every page that used to call
  `getScheduleForDate()` directly (Home's day strip, the Training page, the
  Calendar page, and `derive.js`'s own scoring functions) now goes through
  this instead, so the rule is never duplicated. `getScheduleForDate()` and
  the new `getHomeScheduleForDate()` in `schedule.js` remain pure day-lookup
  functions with no notion of which one is "active" — that decision belongs in
  `derive.js`, not in the pure-data file.
- **Fixed loads, not percentages.** No `tmKey`, no `mainLift`, no exercise
  carries `main:true`. These exercises are never routed through
  `trainingMax()` / `mainLiftRx()` — there is no Training Max for a fixed
  sandbag or kettlebell weight, and there must never be one.
- **Everything else about it is identical to Alsruhe**, because it goes
  through the exact same code: per-exercise checkboxes (§9.4, stored the same
  way, by name) and training scoring (§9.5 — the interim's strength days are
  categorized `Bodyweight`, matching Alsruhe's own Day 6 precedent for
  non-barbell, implement-based training).
- **When Alsruhe starts, the app switches to it automatically** —
  `getActiveScheduleForDate()` re-evaluates on every render. `HOME_SCHEDULE`
  stays in the code for later reuse (a future gap between programs, a deload
  week away from the gym, etc.) — it is not deleted once Alsruhe is running.

### 9.1 Program pause — built

If Ryan says "the program is paused", the app can now represent it.

- **Stored as `d.programPauses[]`** — an additive array of `{start, end}`, dates
  as `YYYY-MM-DD`. An open pause has `end === null`. The array is **append-only**:
  resuming sets `end` on the last open entry, and a later pause pushes a new
  entry. Pause history is never rewritten, so "how long was it dormant" stays
  answerable.
- **`programWeek(date)` subtracts elapsed paused days before dividing by seven,**
  so unpausing resumes at the same program week rather than jumping ahead. A
  paused span is `[start, end)` — the resume date counts as a running day, which
  makes a 10-day pause subtract exactly 10 days. An open pause accrues up to the
  date being asked about, so a dormant program stops advancing live.
- **While paused the Training page says the program is dormant**, with the week
  it is held at, rather than showing an advancing number. The rest of the
  console functions normally.
- **Pause is training only** (§1.1). It does not touch fasting, sleep or dietary
  scoring, and there is no global pause.
- Helpers live in `derive.js` (`programPauses`, `openPause`, `isPaused`,
  `pausedDays`) and write nothing, per §1.3. Pausing and resuming write from
  `pages/training.js`.

**Pause no longer changes the training score at all.** As of 2026-08-12 there
is one formula for every non-rest day (§9.5) and no paused branch in it: a
paused day is scored on its checkboxes exactly like a running one. Pause's only
job is holding the program week. There is deliberately **no neutral or excluded
state**.

*Historical note, so the record is straight:* this has now been three different
things. Originally pause had **no effect whatsoever** on the score — a paused
Monday scored 100 exactly like a running one, despite an earlier revision of
this file implying otherwise. Then §9.5 gave it a branch of its own (API
activity only, checkboxes ignored). That branch is now gone too, and the
pre-epoch path (`legacyTrainingScore()`) is the only place it still runs.

### 9.2 Pause confirmation gate — built, also gates Start (§9.0)

A random 3-digit challenge renders above a numeric keypad with a cancel button.
The action commits **only on an exact match**. A new number is generated every
time the gate opens, so the entry cannot become muscle memory. Cancel and a
wrong code both leave the store untouched; a wrong code clears the entry and
keeps the same challenge for the retry.

**This is deliberate-action protection against a mis-tap, not security.** Anyone
holding the phone can read the number off the screen — that is fine, it is not
the threat. **Do not simplify it to a `confirm()` dialog:** a confirm sheet is
one tap away from the same accident, rendered right where the thumb is already
travelling.

**The same gate now also confirms Start (§9.0)**, not just pause/resume —
`gate.action` is `'pause'`, `'resume'` or `'start'`, and all three read as
valid English verbs directly (`gateHtml()` no longer needs to translate the
action into separate wording). Starting the program is exactly the kind of
one-way decision this gate exists to protect against a pocket mis-tap.

The gate lives in `pages/training.js` because pause and start are the only
things that use it today. If a second pillar ever needs one, extract it to
`js/components/` then — not before.

### 9.3 Built (§6)

- The live data source for the vitals header and for §9.5's activity check —
  server/google_health.py plus js/api.js's cache. Both wait until the cache
  has actually been primed (an async fetch on app boot, js/app.js) before
  showing anything other than the placeholder — never a guess in the gap.

### 9.4 Per-exercise checkboxes — built

One checkbox per exercise, grouped by block (warm-up → giant set → assistance →
finisher), matching `{name, equip, detail, block}` in `schedule.js`.

- **RETROACTIVE TICKING IS NOT ALLOWED.** A day is editable only on that date
  (the same-day lock, §9.5). At local midnight it locks permanently. The
  earlier rule — "retroactive ticking is allowed with no time limit" — is
  **false and has been removed**; do not restore it.
- The checkboxes live **inside the shared prescription card**, which appears on
  both Home and the Training page. Both render whichever date the Home day
  strip has selected. The strip is still the date **picker** — it is how Ryan
  looks at another day — it just no longer makes that day editable. The click
  handler is given the date the card was rendered for, never `today()`, and
  `toggleExercise()` re-checks that date against `today()` before writing.
- **Stored as `d.exerciseLogs{}`**, keyed by date:
  `{ touched: true, checked: ["Goblet Squat", ...] }`
- Exercises are stored **by name, not by index**, so reordering `schedule.js`
  cannot silently re-point a tick at a different movement. Only names still on
  that day's card are counted, so a renamed or removed exercise is ignored
  rather than inflating the total.

**`touched` and `checked` are still two different facts, but only one of them
scores now.**

| Stored state | Meaning | Score (post-epoch) |
|---|---|---|
| no record | the day was never opened | **0** |
| `{touched:true, checked:[]}` | the day was opened, nothing got ticked | **0** |
| `{touched:true, checked:[…]}` | what was actually done | `checked/total × 100` (+50 for a recorded session, capped at 100) |

The first two rows used to score differently — no record meant "assumed done"
and fell through to the schedule fallback. **They are the same now: an empty
card is 0 either way** (§9.5).

**`touched` is still written and must not be removed** (§1.4). It is still set
on the first tap and never cleared, and the frozen pre-epoch path
(`legacyTrainingScore()`) still reads it to reproduce old scores exactly. Do
not "simplify" it away by inferring it from `checked.length`, and do not delete
the field on the grounds that current scoring ignores it.

#### Home renders the same card read-only

The prescription card mounts on both Home and Training, and Home is a
scrolling page — a checkbox that responded to a tap while Ryan scrolled past
it on the way to something else would silently log an exercise he never did.
**On Home the checkboxes are visible and accurate but genuinely inert; on
Training they are fully interactive, unchanged.**

- **One component, one parameter.** `renderPrescription(ds, containerId,
  interactive)` in `pages/training.js` takes a third argument; anything other
  than the literal `false` is treated as interactive, so the existing
  2-argument Training call sites needed no change. Home is the only caller
  that passes `false`. There is no forked "read-only prescription card" —
  that would be a second copy of ~80 lines to keep in sync forever.
- **Genuinely inert, not disabled-looking-but-clickable.** When
  `interactive` is `false`, each exercise button renders with the native
  `disabled` attribute **and no `onclick` attribute at all** — there is
  nothing for a tap to fire, not a click handler that checks a flag and
  no-ops. `styles/components.css` adds `.rx-ex-toggle:disabled{cursor:default;
  pointer-events:none}` so it doesn't even look pressable.
- Nothing else about the card changes in read-only mode — the same checked
  state and the same progress line still render; only the ability to change
  anything is removed. (The card used to render a deviation banner too. That
  went with the deviation control — §9.6.)

### 9.5 Training scoring — rewritten 2026-08-12

#### The rule: empty checkboxes mean it did not happen

**There is no assumed-done default for training.** One formula, applied to
every non-rest day — whether the program is running, paused, or not started:

```
score = min(100, (checked / total) * 100 + (startedActivity ? 50 : 0))
```

There is no `touched` branch and no separate paused branch.

**Rest days score 100.** Checkboxes and API activity are skipped entirely.

#### Worked examples — a 12-exercise day

| Situation | Score |
|---|---|
| No boxes, no Google Health activity | **0** |
| No boxes, a run recorded in Google Health | **50** |
| 6 of 12 boxes, no activity | **50** |
| 6 of 12 boxes plus a recorded run | **100** |
| All 12 boxes, no activity | **100** |
| All 12 boxes plus a recorded run | **100** (capped, never above) |
| Rest day | **100** |

#### Rest days read the schedule's own flag, never the weekday

`calcTrainingScore()` used to compute
`const isRestDay = new Date(ds+'T12:00:00').getDay()===0` — hardcoded Sunday.
**That was a live bug.** `HOME_SCHEDULE` (the interim routine, active while
Alsruhe has not been started) marks **both day 6 (Saturday) and day 0 (Sunday)**
`rest:true`. Saturdays therefore fell through to the fallback with
`isRestDay=false` and scored **60** instead of 80.

The rule now is `getActiveScheduleForDate(ds).rest` → 100. **Never infer a rest
day from the weekday number again.** Only the schedule knows which days are rest
days, and there are two schedules with different answers.

#### The same-day lock

**A training day's checkboxes are editable only on that date, local civil day.**
At local midnight the day locks permanently. No grace window, no override, no
admin escape hatch. Ryan asked for this explicitly and accepted the
consequence: a dead phone costs a real training day.

- Editable when `ds === today()` (`js/util.js`, local — §12). Nothing else.
- **Past and future days still render in full, read-only.** They are not hidden
  and the card is not blanked — Ryan needs to see the exercise list.
- **Implemented by reusing the existing read-only path, not a second one.**
  `renderPrescription(ds, containerId, interactive)` already emits genuinely
  inert buttons when `interactive === false`: native `disabled`, no `onclick`
  attribute at all, plus `.rx-ex-toggle:disabled{pointer-events:none}` (§9.4).
  The Training page passes `ds === today()`; Home still passes `false` always.
- **Defence in depth.** `toggleExercise(ds, idx)` itself returns early when
  `ds !== today()`, before touching the store. The render side is the UI; this
  is the guarantee. A future session that changes the render must not be able
  to silently reopen the write path.
- The card's state line reports the lock. No confirmation dialogs.

#### The epoch — existing history is frozen

**`STRICT_TRAINING_FROM = '2026-08-12'`**, a module-level constant in
`js/derive.js`.

| Dates | Path |
|---|---|
| `>= STRICT_TRAINING_FROM` | the formula above. **Deviations are never read.** |
| `< STRICT_TRAINING_FROM` | `legacyTrainingScore()` — the old behaviour, frozen and unchanged |

`legacyTrainingScore()` keeps the whole previous body: `scheduleFallbackScore()`
for untouched days, the touched ratio, the `missed`-outranks-checkboxes rule,
the paused branch, rest days at 80 — **and the hardcoded-Sunday bug above,
deliberately left in place.** Fixing it there would change scores Ryan has
already seen, which is precisely what the freeze prevents.

**Why freeze rather than rescore:** those days were logged under a different
contract. Ryan was told an untouched day counted as done, so he did not tick
them. Rewriting them as zeros would make the app lie about his past.

Pre-epoch days are also **always locked**, because they are not `today()` — the
same-day rule already covers them; no separate check exists or is needed.

#### This changes what the training pillar measures

*It is no longer "did I train" but "did I train and log it the same day." That
is deliberate. A future session that reads untouched-scores-zero as a bug and
restores the fallback is causing drift, not fixing one.*

#### What survived the rewrite

- **`touched` is still written** by `toggleExercise()` and is still in the
  schema (§1.4). `exerciseLog()` / `exerciseProgress()` still return it. Post-
  epoch scoring simply never reads it; `legacyTrainingScore()` does.
- **`scheduleFallbackScore()` and `deviationType()` are kept, legacy-only, and
  commented as such.** `scheduleFallbackScore()` must **not** be reintroduced
  into post-epoch scoring — it is the "assumed done" behaviour this rewrite
  removed.
- **Pause still holds the program week (§9.1).** Only its scoring effect is
  gone. There is no pause branch in the current path.

#### What counts as an API activity

**Only a deliberately started, tracked exercise session.** A run, a ride, a
session the user actively began in the health app. **The deliberate start IS the
signal** — it is the user saying "this was training".

**Elevated heart rate alone never counts.** Not a brisk walk, not stairs, not a
stressful meeting.

**There is no duration threshold and no heart-rate threshold, and adding one is
not an improvement.** A future session will be tempted to "fix" this by
accepting, say, 20 minutes above 120bpm. That is drift. A threshold makes the
app guess at intent; the start button already recorded it. A 6-minute deliberate
session counts. An hour of accidentally-elevated HR does not.

**BUILT (§6).** `hasStartedActivity()` in `derive.js` reads
`getCachedVitals(ds).startedActivities` (js/api.js) — populated server-side by
`aggregate_day()` in `server/google_health.py` from the Google Health
`exercise` data type. That a dataPoint exists there at all **is** the
deliberate-start signal; the function does not, and must not, inspect
duration or heart-rate fields on those entries. It returns `false` whenever
nothing is known — cache not yet primed, server unreachable, or genuinely no
session that day — never a fabricated positive (§1.7).

Because it is false whenever the server has nothing for a day, **a day with no
boxes ticked and no recorded session scores 0** — paused or not. That is
expected and accepted. Do not build a neutral or excluded state to hide it.

### 9.6 The deviation control — REMOVED 2026-08-12

**There is no deviation control anywhere in the app.** The "Log a Deviation"
tray on the Training page — five buttons, `Completed` / `Missed` / `Swapped` /
`Make-up` / `Planned Skip` — was removed, along with the swap `<select>` panel
that went with `Swapped`. **There is no replacement control.**

**Per-exercise checkboxes (§9.4) are now the entire record of a training day.**
Tick what you did. That is the whole interface.

**Why it went:** it was dead weight from an older design. Five day-level labels
sat on top of a per-exercise record that already said the same thing more
precisely, and two of them (`Completed`, `Makeup`) changed no score at all.
Ryan decided the checkboxes are the record and the labels are noise.

#### What was deleted

- `index.html`: the `#training-deviation-tray` mount and its section title.
- `pages/training.js`: `DEV_TYPES`, `SWAP_OPTIONS`, `swapAreaOpen`,
  `renderDeviationTray()`, `trainingSetDeviation()`, `trainingSaveSwap()`, and
  **all five deviation banners** that used to render at the top of the
  prescription card. The card displays no deviation of any kind now.
- `pages/home.js`: `setDeviation()` and `saveSwap()` — the last write path in
  the app — plus the day strip's `missed`/`completed` dot-colour overrides.
- `app.js`: the four `window.*` bindings for those functions.
- `pages/calendar.js`: the `missed`-forces-a-red-dot lookup. Calendar dots
  colour by session category only.
- `styles/components.css`: `.deviation-tray`, `.deviation-tray-label`,
  `.dev-btn-grid`, `.dev-btn`, `.dev-icon`, `.dev-label`, `.active-btn`,
  `.missed-btn`, `.skip-btn`, `.dev-swap-area`. Each was grepped repo-wide
  first; none had another user.

#### What was NOT deleted — this distinction is load-bearing

**`d.deviations` remains in the schema (§1.4).** Nothing about the stored data
changed. Every record Ryan already logged is preserved byte-for-byte.

- `app.js`'s migration guard still backfills `d.deviations` onto older stores.
- `store.js`'s `known` array still lists `deviations`, so an old backup still
  passes the import sanity check.
- `derive.js`'s `historyDays()` still enumerates its keys, so old deviation
  dates still count toward "how much history does the app have".
- `deviationType()` and `getWorkoutForDate()` still read it.

**The rule is: the key stopped being *written*, not removed.** Post-epoch
training scoring never reads it (§9.5); the frozen pre-epoch path still does,
which is what keeps Ryan's existing history scoring exactly as it always did.

**Do not restore this tray**, and do not read the absence of a write path as a
gap awaiting a fix. An earlier session did remove the tray from Home without a
new home for the write path and correctly flagged *that* as an accident. This
is the opposite: a deliberate removal of the whole concept.

##### The find-and-replace trap

`index.html` contained **two** sections titled `Log a Deviation`. The one on
`#page-training` was removed. The one on `#page-fasting`, above
`#fasting-fail-container`, is the **Fasting Fail button (§7.1)** — a completely
different control, Ryan's only way to record a broken fast, and it stays. Edit
these by element id. A global find-and-replace on the heading text destroys the
fasting control.

---

## 10. Health Status

- **Manual:** height, bodyweight, waist circumference, tested 1RMs (§10.1).
- **Auto from API:** body fat %, VO2 max, HRV.
- **Derived:** 7-day rolling bodyweight trend, Training Max (§10.1), relative
  strength (each Training Max ÷ bodyweight).

**VO2 max is available from the Versa 2.** Fitbit calls it **Cardio Fitness
Score**, which is why a search for "VO2 max" in their docs comes up empty — the
metric is there under a marketing name.

**BUILT (§6).** Body fat %, VO2 max and HRV render from
`getCachedVitals(today()).bodyFatPct/.vo2Max/.hrv` (Health Status page,
`renderAwaiting()` in `js/pages/health.js`). Any of the three the API hasn't
supplied a value for yet still renders as an em-dash under "Awaiting Sync" —
never a zero, which would read as a measurement of zero (§1.7).

**Bodyweight displays as the 7-day rolling average, not the daily value.** Daily
weight is mostly water and produces misleading noise.

Hormone indices (HGH, Testosterone, Cortisol Pressure) are **behavioral
correlations, not medical claims**, and must always be labeled as such. Never
present a clinical value.

### 10.1 1RM, Training Max, and the Personal Records page

#### The number Ryan enters is a 1RM. The number the program runs on is a TM.

```
TM = 1RM × 0.85          (TM_PERCENT_OF_1RM in derive.js)
```

**1RM is stored. TM is derived at render time** (§1.3) — it is never written to
`metracker_v2`.

#### Every prescribed weight is a percentage OF TM, never of 1RM

`PROGRESSION[].pct` and `SPEED_PCT` in `schedule.js` are **TM percentages**.
`mainLiftRx()` in `derive.js` is the **only** place they are applied, and it is
fed `trainingMax()`.

**THIS IS THE FAILURE MODE TO AVOID.** If a percentage is ever applied to a raw
1RM, every working weight jumps by `1/0.85` — about **18%**. Worked example: a
400 lb squat 1RM gives a 340 lb TM. Week 11 prescribes 95%:

| | Calculation | Prescribed |
|---|---|---|
| Correct — from TM | `round5(340 × 0.95)` | **325 lb** |
| Wrong — from 1RM | `round5(400 × 0.95)` | 380 lb |

That 55 lb gap is an injury, not a rounding error.

The mirror-image bug is **double-scaling**: applying 0.85 here *and* again
downstream, which makes every session 15% too light and quietly stalls the
program. **Apply the factor exactly once**, in `trainingMaxInfo()`.

TM is deliberately left **unrounded**; `round5()` is applied once, to the final
working weight, exactly as it was before 1RM existed.

#### Legacy Training Maxes

The old `targets.tm_*` values are **never deleted** (§1.4). Resolution order per
lift:

1. A logged 1RM exists → `TM = latest 1RM × 0.85`. Source `'1rm'`.
2. No 1RM, but a legacy `tm_*` → use that typed TM as-is. Source `'legacy'`.
3. Neither → TM is 0 and the card reads "set TM". Source `'none'`.

The Log page's Training Max card shows which lifts are still on a legacy value.
**A lift driven by a 1RM renders there as text with no input at all** — that is
load-bearing, not cosmetic: `saveTargets()` writes every `tm_*` input it can
find, so leaving a disabled input showing the *derived* TM would let a save
overwrite the stored legacy value with a derived one. No element, no write.

#### The Personal Records page

`js/pages/prs.js`, reached from a nav row on the **Training page** — not the
drawer, because §11 protects drawer structure and 1RMs are training data.

- **Scope is the four main lifts only:** back squat, overhead press, deadlift,
  bench press. Not assistance work, not accessories.
- **Every value is a tested 1RM Ryan logged himself.**
- **DO NOT ADD REP-MAX ESTIMATION.** No Epley, no Brzycki, no "5 × 275 means
  your max is about 310". Decided explicitly: the big four get tested and
  logged. An estimated max would silently drive every prescribed weight in the
  program through TM, and §1.7 does not let an estimate wear the same clothes as
  a measurement.
- **Stored as `d.oneRepMaxes{}`**, keyed by lift (`squat`, `ohp`, `dl`,
  `bench`), each an **append-only** array of `{lbs, date}`.
- **Entries append; they never overwrite.** The history is the point — progress
  across twelve weeks is the thing worth seeing.
- **"Current" is the newest entry by date**, not by insertion order, so a
  backdated entry lands in the history without displacing a more recent max.
- Dates come from `today()` in `util.js`, which is local (§12).

---

## 11. Do not touch without explicit instruction

- ~~PIN gate logic~~ **Removed 2026-08-11 — see §2.2.** There is no PIN gate
  to protect any more. Do not restore one without asking Ryan.
- Drawer structure
- `metracker_v2` schema (additive keys only)
- **Fasting timer and phase logic** — `calcFastHrs()`, `getPhase()`,
  `startFastTimer()`. The *protocol* (§7) is a separate thing and has been
  changed; the engine that measures a running fast has not.
- Scoring weights — 25% each: fasting, sleep, training, diet
- ~~Supplement list — Himalayan salt, CoQ-10, Magnesium Threonate~~
  **Superseded by §8.1: the supplement list is user-editable data now.** The
  three names above are seed values, not constants.

---

## 12. Session checklist

1. `git pull` before anything. Never edit from a stale copy.
2. Read this file.
3. Confirm `.gitignore` still covers `client_secret*.json` and `env.txt`.
   Never move secrets into the repo, even temporarily.
4. Make the change. Keep the diff confined to the files it belongs in.
5. Verify no new color literals; `tokens.css` unchanged unless that was the task.
6. Commit and push to `main`. Report the commit hash.
7. State plainly what you could **not** verify.

### Environment notes
- Windows, `core.autocrlf = true`. Git prints "LF will be replaced by CRLF" on
  most commits. **Normal, not an error.** A naive byte comparison of a local file
  against GitHub will show every line as changed — that is line endings, not
  content. Normalize before diffing, or the diagnosis will be wrong.
- **ES modules require HTTP. Double-clicking `index.html` yields a blank page.**
  Browsers refuse to load `<script type="module">` over `file://`, so opening the
  file directly fails with a CORS error and no UI renders. This is not a bug and
  does not need "fixing" — §2 serves the app over HTTP anyway. To run it locally:

  ```
  cd C:\Users\Ryan\Desktop\Me-Tracker; python -m http.server 8123
  ```

  then open `http://127.0.0.1:8123/index.html`.
- **Calendar days are local, never UTC.** `today()` and `dateStr()` in
  `js/util.js` format with `getFullYear`/`getMonth`/`getDate` on purpose.
  `toISOString()` converts to UTC first, which from 20:00 Eastern onward stamps
  logs with tomorrow's date. Do not "simplify" them back. A deviation's
  `timestamp` is a separate thing — an instant, correctly stored as UTC ISO.
- Never read, print, or copy the contents of the secrets files.
