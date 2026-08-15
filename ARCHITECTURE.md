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
Vision-derived macros are guesses. They render visually distinct from measured
data. The app never presents an estimate with the same confidence as a barcode
lookup or a scale reading.

The hormone indices used to be the other example here. They were **deleted**
rather than relabelled (§10.0): when an estimate has no criterion variable at
all — nothing it could ever be checked against — a label is not enough, and the
honest move is to not show the number.

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
│   ├── foods.py            # BUILT (§13) — the food library + the 120-day purge
│   └── barcode.py          # BUILT (§13.6) — Open Food Facts lookup, typed digits only
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

### Every score-box destination carries a back button — there is no history stack

**Added 2026-08-12.** All five score-box destinations — `#page-training`,
`#page-diet`, `#page-body`, `#page-fasting`, `#page-health` — open with a back
button as the **first element on the page, above everything including the
vitals header mounts.** It reuses the existing `.back-btn` / `.back-chev`
pattern `#page-prs` already had; nothing new was styled.

```html
<button class="back-btn" onclick="showPage('home','Me-Tracker')"><span class="back-chev">‹</span>Home</button>
```

**The destination is static. There is no history stack and must not be one.**
Three of these five (Dietary, Sleep/HR, Health Status) are also reachable from
the drawer, and the button still goes Home from there. That is intended — a
back button that guessed where you came from would need state this app
deliberately does not keep, and Home is the honest answer either way.

- **`#page-prs` keeps its own button pointing at Training** (§10.1) — it is the
  one page whose parent is not Home. Do not change it.
- **No back button on `#page-home`, `#page-calendar` or `#page-log`.** Home has
  nowhere to go; the other two are drawer-only pages with no parent.
- Drawer markup and `showPage()` behaviour are untouched (§11).

Verified at a 393pt viewport: all five buttons measure 44px tall (the `.back-btn`
minimum, §1.5), all five land on Home with the topbar reading "Me-Tracker",
from **both** the score box and the drawer where applicable.

**Two deliberate third levels, and only two.**

| Third level | Why it sits there |
|---|---|
| **Training → Personal Records** (§10.1) | The drawer was the natural home for a rarely-used logging page, but §11 protects drawer structure; 1RMs are training data. Logging a tested max happens roughly once per 12-week cycle, so one level deeper costs nothing daily. |
| **Dietary → Meal Tracker** (§13) | Added 2026-08-12. Counting servings is daily, but it belongs *under* Dietary because that is where its macros land. Ryan made this call explicitly; §4 says a third level requires a decision, and this is the record of it. |

Both are reached from a `.score-box` / `.score-row` nav row on their parent
page — the same component the score box itself uses — and both carry a back
button up **one** level: Records → Training, Meal Tracker → Dietary. The full
path is **Home → Dietary → Meal Tracker**, with a back button at every step.

**This is still not a licence to nest further.** A fourth level, or a third one
somewhere else, is a conversation with Ryan.

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
   timestamp — see §6.2 on why this one exception exists), the day's heart
   rate as 5-minute buckets (`hrSeries`, §6.12), minutes per device-defined
   HR zone, workout avg/peak HR, sleep stage totals, steps, weight, body
   fat %, HRV, VO2 max, and the list of started exercise sessions.
   `GET /api/vitals/*` (§6.3) only ever returns this aggregate.
   Raw intraday samples are cached server-side under `server/data/raw/` for
   about 7 days for debugging (`purge_old_raw()`), then deleted, and are
   never served to the client.

   **`hrSeries` does not breach this rule, and a future session should not
   read it as one.** The rule says the browser gets aggregates rather than
   raw samples. A 5-minute bucket carrying `{at, avg, max, n}` *is* an
   aggregate: a full day reduces from ~8,500–17,000 raw samples to at most
   288 objects, roughly 13 KB. What is forbidden is shipping the sample
   stream itself, and that is still forbidden.

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

#### Two sync tiers — the nightly, and an hourly today-only top-up

**Added 2026-08-12.** Before it, 04:15 was the only sync that ever fired, so
the app's numbers were only ever as fresh as 04:15. The nightly's trailing
3-day window does include "today", but at 04:15 today is four hours old and
nearly empty. Measured at 21:15 that evening, the stored day read **8 steps**
with a latest heart rate from **04:04** — today's steps, HR and activities
were effectively blank all day, every day.

| | Nightly | Hourly |
|---|---|---|
| When | 04:15 local, once | On the hour, 06:00–23:00 local (18 runs) |
| Window | trailing `SYNC_RANGE_DAYS` (3) days | **today only** |
| Data types | all 10 | **`steps`, `heart_rate`, `exercise`** |
| Writes | whole-day overwrite | field-level merge (below) |

**The nightly is unchanged** — same time, same 3-day window, same ten types.
That window exists because sleep and HRV settle late (§6.3 above) and none of
that reasoning is affected.

**The hourly is today-only on purpose.** Re-pulling two already-settled days
eighteen times a day is waste; the nightly owns that window.

**Only three types, because only three move during a waking day.** `steps`,
`heart_rate`, and `exercise` (which feeds `hasStartedActivity()`, §9.5).
Sleep, HRV, resting HR, weight, body fat and VO2 max are daily-settling
figures Google finishes computing overnight — pulling them hourly costs pages
and returns the same answer. `time_in_heart_rate_zone` is the one type in
neither list: it does accumulate during the day, but nothing in the client
reads it live (§6.2 calls it "a separate, historical field for later
graphing"), so it stays with the nightly. Adding it later is a one-line
change to `HOURLY_SYNC_TYPES`.

**A partial pull must not write a whole day — this is the load-bearing part.**
`aggregate_day()` always builds a complete day summary, so a three-type pull
produces one where the other seven fields are null. Writing that over the
stored day would erase the sleep, resting HR and HR-zone figures the nightly
wrote for today at 04:15 — every hour, all day. `sync_range(type_keys=…)`
therefore merges **field by field** via `merge_day()`, driven by
`TYPE_OWNS_FIELDS` in `google_health.py` (the server-side twin of §6.9's
"every metric has ONE owning source" table). Two rules there:

- A full sync (`type_keys=None`) does **not** go through `merge_day()` at all.
  It overwrites the day exactly as it always did, so the nightly's behaviour
  is provably untouched.
- A partial sync replaces only the fields owned by types that **actually
  returned data for that day**. A type whose pull failed and a type that came
  back empty are both left alone: keeping a slightly stale value costs one
  hour, whereas overwriting costs a real measurement. The nightly full sync
  rewrites the whole day anyway, so anything genuinely removed upstream is
  corrected within a day.

**Local civil time, and it survives DST (§12).** `_next_hourly_run()` in
`server/app.py` is a pure function of a naive **local** datetime — no UTC
anywhere — so the schedule can be tested directly instead of by waiting an
hour. Every iteration re-reads the wall clock and re-checks the window rather
than assuming the time slept equals the time scheduled, so the long
23:00→06:00 sleep self-corrects on both DST nights instead of drifting.

**Failure is non-fatal and non-destructive.** A failed hourly leaves the store
untouched (§6.5's forced-credential-failure precedent) and the loop survives
to try again next hour. Every attempt is logged to `sync.log` with the same
per-type page/row detail as the nightly and a `hourly:` / `nightly:` /
`manual:` label, so a loop that silently stops firing leaves a **visible gap
in the log**, not just numbers that quietly stop moving.

#### The client side — Sync now, and refreshing on foreground

**Added 2026-08-12, client only.** `triggerSync()` and `fetchVitalsDay()` had
been exported from `js/api.js` since §6 was built and were **called by
nothing** — the server could sync on demand and the app had no way to ask.

**Sync now lives on the Health Status page**, directly under the "Awaiting
Sync" panel, because that panel is the thing that goes stale and this is the
control that fixes it. (The drawer was the alternative and was rejected: it
holds navigation and backup/restore, and a sync button there would be
invisible from the page whose numbers it refreshes.) `runSync()` in
`js/pages/health.js`:

- Re-primes the cache and re-renders on success, so the new numbers appear
  **without a reload**.
- Says so plainly on failure, and says the numbers did not change. It never
  presents a stale reading as fresh (§1.7).
- Shows `GET /api/sync/status`'s `lastWriteUtc` as a "Server data last
  written" line, in local time. That is the **server's** last write, not this
  browser's last fetch — the honest answer to "how old is this".
- Guards double-taps twice: the button carries `disabled` while a sync is in
  flight, and `runSync()` itself returns early on a `syncBusy` flag. Same
  defence-in-depth split as the same-day lock (§9.4) — the attribute is UI,
  the flag is the guarantee.

**The cache re-primes when the app returns to the foreground.** It used to be
primed once at boot and never again, so a session left open overnight showed
yesterday's numbers indefinitely — and Ryan opens this app from his pocket.
A `visibilitychange` listener in `js/app.js` now handles it, at **two
speeds, deliberately**:

- The **re-render** runs on every return to the foreground. It is local, costs
  nothing, and it is what re-evaluates the same-day lock — so a day rollover is
  caught **even with the server down or Tailscale off**.
- The **network re-prime** is debounced to once a minute, so flicking between
  apps does not fire a range fetch each time. Measured: six rapid switches
  produce exactly one fetch; three more inside the window produce none.

The Log Entry page is deliberately excluded from the foreground re-render: it
displays no synced value, and `initLogForms()` resets its date inputs to today,
which would quietly rewrite a date Ryan had typed but not yet saved.

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

#### Every metric has ONE owning source — check this table before wiring a read

The §6.9 bug happened because nothing recorded which source owns which number,
so a page could read the wrong one and nobody noticed. A full audit of every
manual-array read in the client (2026-08-12) produced this. **It is the
authority; if code disagrees with it, the code is wrong.**

| Metric | Owner | Manual store | Synced field | Rule |
|---|---|---|---|---|
| Sleep | **API** | `d.sleeps` (retired, §6.11) | `sleep.asleepMinutes ?? sleep.totalMinutes` | synced → manual → 7h |
| Resting HR *(zone table)* | **API** | — | `restingHR` | API only, per §5 |
| Resting/workout HR *(Vitals display)* | manual | `d.hrs` | `restingHR`, `workout.avgHR` | manual → synced |
| Steps | **API** | — | `steps` | API only |
| Live HR / zone | **API** | — | `latestHR` | API only (§6.2) |
| Started activity | **API** | — | `startedActivities` | API only (§9.5) |
| Body fat / VO2 max / HRV | **API** | — | `bodyFatPct`, `vo2Max`, `hrv` | API only, per §10 |
| Bodyweight / waist / height / age | **manual** | `d.body.*` | `weightLbs` exists but is **unused by design** (§10) | manual only |
| Workout type/category | **manual** | `d.workouts` | `startedActivities[].activityType` — **not equivalent**, see below | manual only |
| Meals / macros | **manual** | `d.meals` | **none** — no nutrition type is pulled | manual only |
| Fasts | **manual** | `d.fasts` | **none** | manual only |

**Two entries are deliberately asymmetric and must not be "made consistent":**

- **Resting HR has two different rules on purpose.** The Karvonen zone table
  reads the API only, because §5 says so — a hand-typed one-off must not shift
  the training zones. The Vitals page's 15-day average lets a manual entry win,
  because that card is a log of what Ryan recorded. They answer different
  questions over different windows. *(Known consequence: a hand-logged resting
  HR shows on the Vitals card but does not move the zone table. Flagged for
  Ryan; changing it is a §5/§11 decision, not a cleanup.)*
- **Bodyweight is manual even though `weightLbs` exists.** §10 assigns it to
  manual entry, and Google currently returns zero weight rows anyway.

**`d.workouts` and `startedActivities` are NOT the same fact.** Google reports
`WALKING` / `WEIGHTS` / `RUNNING` / `OUTDOOR_BIKE` / `SPORT`; the app scores on
`Resistance` / `HIIT` / `Zone 2` / `Bodyweight` / `Wtd Walk` / `Mobility` /
`Active Rest`. Mapping one to the other means guessing intensity Google never
reported — deciding whether a run was Zone 2 or HIIT — which is exactly the
inference §9.5 forbids. `startedActivities` is used only for the boolean
"was a session started", and that is all it should ever be used for.

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
fix during a display bug. **Resolved 2026-08-12 — see §6.10.**

### 6.10 Awake time is recorded, not counted as sleep

**The bug (§6.9's open item, fixed 2026-08-12).** `sleep.totalMinutes` summed
every `stagesSummary` bucket including `AWAKE`, so every stage-tracked night
read high — systematically and in one direction only. Sleep is 25% of the
consistency score, so this had been quietly inflating it.

**Ryan's decision: awake time is real and gets recorded, not folded into sleep
— and old days are not rewritten.**

#### Three fields, additive (§1.4)

| Field | Meaning |
|---|---|
| `totalMinutes` | **Unchanged.** Every stage bucket summed, awake included. |
| `asleepMinutes` | Every bucket **except** `AWAKE`. |
| `awakeMinutes` | The `AWAKE` bucket alone. |

They always reconcile: `totalMinutes == asleepMinutes + awakeMinutes`. Awake is
subtracted from the total rather than summed from the non-awake buckets,
specifically so that identity cannot drift.

Worked case, 2026-08-08 (two records that night, one CLASSIC nap + one STAGES
main sleep): `totalMinutes 572`, `asleepMinutes 560`, `awakeMinutes 12`.

#### The read rule: prefer `asleepMinutes`, fall back to `totalMinutes`

`derive.js`'s `getSleepForDate()` and `pages/vitals.js`'s `resolveDay()` both
use `asleepMinutes ?? totalMinutes`. Days aggregated before this change have no
`asleepMinutes` and fall through to `totalMinutes`, reproducing exactly what
they scored before.

**THE PRESENCE OF THE FIELD IS THE BOUNDARY.** There is deliberately **no epoch
constant** here (unlike training's `STRICT_TRAINING_FROM`, §9.5) and **no
migration**. Do not add either.

#### History was deliberately NOT re-aggregated

**No backfill was run and none should be.** Ryan declined the history rewrite:
the corrected figure matters going forward, and re-aggregating the past would
change numbers he has already seen. The nightly sync's trailing 3-day window
(§6.3) naturally re-aggregates recent days with the new code; everything older
keeps its original shape indefinitely. **That inconsistency is the intended
outcome, not a gap to fill.** If a future session is tempted to backfill so the
data "looks consistent", that is the rewrite that was declined.

Verified at the time of the change: all 46 stored days still lacked
`asleepMinutes`, and sleep scores across a 10-date spread were byte-identical
before and after.

#### CLASSIC vs STAGES — measured, not assumed

Google returns two record shapes, and both occur in Ryan's data:

| Type | Buckets | `awakeMinutes` |
|---|---|---|
| `STAGES` | `AWAKE` / `LIGHT` / `DEEP` / `REM` | real, 8–32 min observed |
| `CLASSIC` | a single `ASLEEP` total | **0** |

**CLASSIC does not hide awake time inside its single total** — checked against
live records, where Google's own `summary.minutesAwake` is `0` on every CLASSIC
night. So on those nights `asleepMinutes == totalMinutes` and the correction is
a no-op, which is right rather than a missing case.

**Deep sleep on a CLASSIC night is `null`, not `0` (fixed 2026-08-14).**
`getSleepForDate()` used to default the deep figure to `0` when the stage map
had no `DEEP` key, which rendered as "0.0h" on the Driving Factors row — a
measurement of zero deep sleep, which is a different and much worse claim than
"stages were never tracked". It is now `null` and renders "— not tracked"
there, matching the "deep n/a" the Vitals history has always shown. **A genuine
`0` on a staged night is preserved** — `??` falls through only on
null/undefined. Deep sleep reaches **no score**: `sleepScore` is hours and
quality only, and the hormone indices that once read it are gone (§10.0).

#### DECISION 2026-08-14: the `asleepMinutes` fallback is EPOCHED, not fixed

A diagnostic that day quantified the cost of the fallback precisely, and Ryan
chose to leave it. Recorded so it is not "discovered" and fixed later:

- **23 of 28 stored days** carry no `asleepMinutes` and score off
  `totalMinutes`; 22 of those carry an `AWAKE` bucket.
- **252 awake minutes** in total are counted as sleep, mean 11.5 min/day.
- **16 days would move** if corrected: eleven by 1 point of the Sleep pillar,
  three by 2, one by 3, and 2026-06-19 by 5 (32 awake minutes). Maximum effect
  on a total day score is 1.25 points.

**The decision is to accept that and move forward, not to re-sync history.**
The boundary stays where it is: presence of the field. Do not add an epoch
constant, do not backfill, and do not re-aggregate old days to "fix" this.

Excluding `AWAKE` reproduces Google's own `summary.minutesAsleep` almost
exactly (482→474 vs 474; 433→421 vs 421; 477→463 vs 463; one case off by a
single minute, 441 vs 442, from Google's own rounding). The stage buckets are
used rather than `summary.minutesAsleep` so the three stored fields reconcile
arithmetically.

#### Surfaced, not just stored

The Vitals sleep-history rows show awake time where the field exists —
`7.0h · 1.4h deep · 12m awake`. A day without the field shows nothing extra,
never a fabricated `0m awake` (§1.7).

### 6.11 Manual sleep entry retired — the API is authoritative for sleep

**Decided 2026-08-12.** Ryan does not hand-log sleep; the watch measures it.
The Log Sleep form on the Log Entry page is **retired**, using the same pattern
as the daily fast goal (§7.1): `is-retired` rows, a `tag-inactive` badge, every
input `disabled`, and a `form-note` saying why.

**Precedence for sleep is now: synced → manual → the 7h assumption.**

This is the one pillar where the API outranks a manual log. It is a deliberate
inversion of the §1.1 note that "a manual log always wins", and it is scoped to
sleep alone — leaving the form live while ignoring what it wrote would be worse
than removing it, because a control that writes data nothing reads is a trap.

**`d.sleeps` is not dead and was not deleted (§1.4):**

- Existing entries are preserved and still render in Sleep / HR history.
- They are still the **fallback** for a night the watch has no record of —
  a real case, since Google holds no sleep at all for 2026-07-30 → 08-05
  (§6.9). An old manual row for such a night still scores.
- `logSleep()` is left in place. A write path is not deleted in the same commit
  that disables its trigger; that is how a capability gets lost by accident.

**Both readers were changed together** — `derive.js`'s `getSleepForDate()` and
`pages/vitals.js`'s `resolveDay()`. Changing only the page would have made the
displayed number differ from the scored one, which is precisely the failure
§6.9 records. If one of these is ever changed, change the other in the same
commit.

#### Scope limit — this applies to sleep and nothing else

**Manual HR entry is NOT retired.** `d.hrs`, the Log HR form and its
manual-wins precedence are untouched and still fully functional. The same goes
for meals, workouts and everything else Ryan still logs by hand. A future
session that "makes the pillars consistent" by extending this inversion is
causing drift — the asymmetry is the decision.

**Consequence Ryan accepted:** with the form retired, a night the watch missed
*going forward* cannot be recorded by hand and falls to the 7h assumption
(§1.1). Old manual rows still work; new ones cannot be created.

### 6.12 `hrSeries` — the day's heart rate in 5-minute buckets

**Added 2026-08-12.** The server was already paying to fetch every heart-rate
sample of the day — measured at 21 pages / 8,475 samples for a single day
(§6.6), 10,459 samples for 2026-08-11 — and then throwing all of it away:
`aggregate_day()` reduced the whole pull to one `latestHR` (§6.2), and the raw
samples purged after ~7 days. Ryan wants to line an exercise checkbox timestamp
up against his heart rate after the fact, and that needs a series, not one
reading.

**The shape.** A new additive field on each day's aggregate, a list ascending
by time:

```json
"hrSeries": [ {"at": "2026-08-11T09:00", "avg": 79, "max": 83, "n": 46}, … ]
```

| Key | Meaning |
|---|---|
| `at` | **Local civil time**, `YYYY-MM-DDTHH:MM`, aligned to the wall clock (:00, :05, :10 …). Deliberately **no `Z` and no offset** — it is a wall-clock reading, not an instant. |
| `avg` | Mean bpm in the bucket, rounded to a whole beat |
| `max` | Highest bpm in the bucket |
| `n` | How many raw samples went into it |

288 buckets for a full 24 hours, against ~8,500–17,000 raw samples.

**`latestHR` is untouched and is NOT derived from this** (§1.4, §6.2). It is
still the single most recent *raw* sample of the day, which is a different
number from the last bucket's `avg` or `max`. Two fields, two meanings.
Verified byte-identical across eight days before and after this change.

**`at` is local; `latestHR.at` is UTC.** That asymmetry is correct and must not
be "made consistent" — a bucket answers *when on the clock*, `latestHR`
answers *which instant*.

**Bucketing follows §6.7's boundary rule, in the time dimension.** The local
hour and minute come from Google's own `sampleTime.civilTime.time`, never from
the bare UTC timestamp — a 22:30 Eastern sample has a UTC hour of 02:30 the
next day, which would scatter every evening reading into the following
morning's buckets. **`civilTime.time` omits zero-valued fields**: a sample at
00:00:01 arrives as `{"seconds": 1}` with no `hours` and no `minutes`, so a
missing component means **zero**, not "unknown". Reading it as unknown and
dropping the sample would silently delete the midnight hour from every day.
Confirmed against live rows, not assumed.

**Empty buckets are absent, never zero-filled** (§1.7). A stretch where the
watch was off the wrist is a gap and must stay a gap; a bucket reading 0 bpm
would be a measurement of a stopped heart. Measured on real days: 2026-08-05
has a 400-minute gap (00:00–06:35), 2026-08-11 a 70-minute one (20:40–21:45).

**A partial day is expected and correct.** The hourly sync (§6.3) at 14:00
pulls the whole civil day, which so far contains samples only up to 14:00, so
the series ends at 14:00. The next sync recomputes the same day from a longer
pull and the series simply reaches further. **Nothing appends** — there is no
incremental state to get out of step. Verified end to end: 48 → 166 → 272
buckets across three successive syncs, each result a strict extension of the
one before it, earlier buckets unchanged.

**No backfill was run, and old days do not have the field.** Every consumer
must treat its absence as "no series for that day" — never an error, and never
an empty chart claiming zero heart rate. The presence of the field is the
boundary, exactly as with `asleepMinutes` (§6.10); there is no epoch constant
and no migration.

**If a backfill is ever wanted, read this first.** Re-syncing the stored range
(2026-05-17 → today) costs about **394 pages / 392,000 heart-rate rows**, which
took **2 minutes 12 seconds** when it was actually run on 2026-08-11 — cheap.
The trap is not cost. **It would also rewrite those days' sleep figures**,
because the same re-aggregation now emits `asleepMinutes`/`awakeMinutes` — the
history rewrite §6.10 records Ryan as having explicitly declined. A backfill
that fills in `hrSeries` cannot avoid that side effect without new code.
§6.8's "multi-hour run" warning is about the full 2021+ history, which is a
different and much larger thing.

**Size, measured.** ~13.6 KB of compact JSON per full day (~25 KB as stored,
indented); 202–284 buckets on real days. A year is ~4.7 MB served / ~8.6 MB on
disk, against a whole-store size of 28 KB for the 46 days that predate this.
Disk is a non-issue. The number that matters is the client's: `primeVitalsCache()`
fetches a **15-day range on every app open** (and, since the client-side commit,
on every foreground), so once 15 days have accumulated the field that request
grows from ~9 KB to ~200 KB. Not fatal over Tailscale, but it is the figure to
watch. **No retention rule and no endpoint change was implemented** — both are
Ryan's call.

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

### 8.0 The Meal Tracker — counting servings of saved foods

**Built 2026-08-12.** This is HANDOFF §5's "food rotation checklist".
`js/pages/meals.js`, reached from a nav row at the bottom of the Dietary page
(§4).

**Barcode lookup was added 2026-08-13** — see §13.6 (server) and §13.7 (the
review card). **Vision is still not built, and there is deliberately no stub
button for it.** A camera-based barcode read is not part of the barcode path
either, and must not be added to it: §13.6 records why a vision model must
never decode a barcode.

**Three new additive top-level keys** in `metracker_v2` (§1.4):
`d.foodCounts`, `d.foodLibrary`, `d.foodLibraryFetchedAt`.

#### The counter

One row per library item — `[ADD] [REMOVE]  2  RXBAR Chocolate Sea Salt` — with
the item's own `servingText` under the name, so it is always clear what one
press means. ADD increments, REMOVE decrements with a **floor of 0**. Buttons
measure 48×84px, clear of the 44pt minimum (§1.5).

**Counts are per local civil day via `today()` (§12) and apply to TODAY ONLY.**
There is no date picker and no retroactive editing on this page.

```js
d.foodCounts["2026-08-12"] = {
  "fd_abc123": { count: 2, name: "...", servingText: "...", macros: {...} }
}
```

**COUNTING WORKS FULLY OFFLINE.** Every ADD and REMOVE writes localStorage and
nothing else; nothing about the counter waits on a server response. ADD also
fires `POST /api/foods/{id}/used` **fire-and-forget** — that call only pushes
the item's purge date out (§13.5), and its failure must never block or undo the
local count.

An item counted today that has since left the library still gets a row, marked
as such. Its macros are still in today's total, so hiding it would leave Ryan
with numbers he cannot account for.

**Amended 2026-08-13 (§13.9): a DELETE from this phone no longer lands there.**
Deleting a library item erases today's count for it, so there is no orphaned
count left to render. That row now covers only the cases where an item left the
library some other way — the server's 120-day purge (§13.5), a delete on another
browser, or a delete whose response was lost — where today's count is genuinely
still counting.

**Amended again the same day (§13.9.3):** an orphan **at 0** is not rendered at
all (no macros, no library entry, nothing to act on), an orphan **with servings**
carries its own **Delete**, and **ADD is disabled on it**. Not rendering a row
never erases anything — see §13.9.3's rule against sweeping orphans
automatically.

#### THE SNAPSHOT RULE — this is the load-bearing part

**An item's per-serving macros are COPIED into the day's record the first time
it is added that day.** From then on that day is independent of the library: its
macros are computed from **its own snapshot**, never by looking the item up in
`d.foodLibrary`.

Two things depend on it, and both are reasons this app already exists in the
shape it does:

1. **It makes the server's 120-day purge safe (§13.5).** Deleting a library item
   cannot change a past day's numbers.
2. **It stops a later correction to a label from silently rewriting past
   scores** — the same reasoning §6.10 records for declining the sleep backfill.

**DO NOT "normalise" `d.foodCounts` into an id reference.** That single change
is what would make the purge start rewriting history.

A count that drops to 0 **keeps** its entry and its snapshot, so re-adding the
same item later that day cannot silently re-snapshot from a library that was
edited in between.

#### The snapshot carries `extras` and `flags` too (added 2026-08-13)

§13.8's two capture groups are snapshotted at the **same moment and by the same
rule** as `macros` — two keys added beside it, the existing shape untouched:

```js
d.foodCounts["2026-08-13"]["fd_abc123"] = {
  count: 1, name: "...", servingText: "...",
  macros: {...}, extras: {caffeine: 160, ...}, flags: {additives: {...}, novaGroup: 4}
}
```

**Without this the purge and any later label edit would silently rewrite a past
day's caffeine and additives** — exactly what the snapshot rule exists to stop.
Verified: with a day counted, editing the library item to caffeine 999 and then
**deleting it outright** left the day's snapshot **byte-identical** and its
intake figures unchanged.

**Days counted before this have neither key. Absence is the boundary** — a
reader must treat a missing group as "not known for that day", **never as zero
and never by looking the item up in the library now.** No migration, no
backfill, same rule as `asleepMinutes` (§6.10) and `times` (§9.4).

An item with no extras and no flags adds **no keys at all**, so a hand-typed
food still produces exactly the record shape it did yesterday. Verified: scores
and macros across a 10-date spread — including a day in the old format and a day
in the new one — were **byte-identical** before and after this change (2,341
characters each way, first differing index −1).

Verified: with an item counted, doubling every macro on the library item left
today's Dietary totals and the stored snapshot **byte-identical**; deleting a
library item that had counts on a past day left that day's record and its score
unchanged.

#### Macro wiring — one read path

`derive.js`'s **`dayMacros(ds)`** is now the single source for a day's macros:
`d.meals` **plus** `sum(count × snapshot macro)` across `d.foodCounts[ds]`.
**`d.meals` still works and is not replaced** — the two are added together.

The same function feeds the Dietary page's four cards, `calcScore()`, and the
30-day consistency chart, so they cannot disagree. Three separate readers of the
same fact is precisely the shape of the §6.9 bug, and this is the fix applied in
advance rather than after.

- **Only protein / fat / carbs / sugar feed the score.** Calories, fiber and
  sodium are displayed on the Meal Tracker page and never scored. **Scoring
  weights are untouched (§11).**
- **A null macro contributes nothing and is NOT treated as 0** (§1.7). Blank in
  the form means "not printed on the label".
- A day with neither a logged meal nor a counted serving is still a **gap** in
  the chart, never a zero (§8.3).

Verified: a 12P/9F/24C/13S item moved today's totals by exactly `+0`, `+12/9/24/13`
and `+36/27/72/39` at counts 0, 1 and 3, with hand-logged meals still counting
alongside. With `d.foodCounts` empty, scores across a 10-date spread were
identical before and after the change.

#### The library, and the offline path

**The server owns the library (§13.1). The phone keeps a read-only MIRROR.**

- On page open the page **renders from the mirror first, always**, so it paints
  instantly and works with the server down. The `GET /api/foods` refresh happens
  in the background and only ever improves what is already on screen.
- Create / update / delete go to the server, and the mirror is refreshed **from
  the response**.
- **If the server is unreachable, the app says so plainly and says the change
  was NOT saved** (§1.7). Writes are **never queued locally** and the mirror is
  **never allowed to diverge** — it is a cache, not a second source of truth.
- **If the mirror is empty AND the server is unreachable**, the page says so and
  points Ryan at the Dietary page's existing Log Meal form as the fallback —
  never a blank page and never a bare error.

Verified with the server stopped: the page rendered from the mirror, ADD/REMOVE
kept working and persisted across a reload, a library edit failed with a plain
message, the mirror did not move by a single byte, and no queue key appeared in
the store. Emptying the mirror with the server still down produced the stated
fallback message on a page with 1,164 characters of content, not a blank one.

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

**THE ON-SCREEN SUGGESTIONS WERE RETIRED 2026-08-15 (§14.3).** They rendered
under the four flat target inputs on the Dietary page, and those inputs are
gone — a suggestion is a suggestion *for a field*, and there is no longer a
field on that page to suggest into. `renderMacroSuggestions()` in `dietary.js`
went with them.

**`macroSuggestions()` in `derive.js` SURVIVES and must not be deleted.** It
still supplies the carbs figure that the carbs progress bar falls back to when
Ryan never set a carb target, and the reasoning below — especially about what
must never feed it — is still live. What follows describes the formulas, which
are unchanged; the "renders beside the input" part is history.

Under each Macro Target input the Dietary page showed a suggested value derived
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

### 8.4 The intake chart — caffeine and additives

**Built 2026-08-13.** One chart on the Dietary page, below the macro graph,
behind its own toggle in the same pattern as §8.3. **Default collapsed.**

**CAPTURE, NOT JUDGEMENT.** Two lines and three numbers, deliberately thin:

- 30 days of **7-day rolling average** for **caffeine (mg/day)** and **additive
  count (per day)**, on two y-axes.
- A summary line above it: the current 7-day averages for caffeine, additive
  count, and **NOVA-4 items per day**.

**THERE IS NO THRESHOLD, NO WARNING COLOUR AND NO "TOO MUCH" LINE.** That
decision has not been made and must not be invented in a chart config — it is a
conversation with Ryan once he has seen real numbers. **Minerals are captured
and visible per item but are NOT charted here;** charting them is a later call.
**Nothing here is scored** (§11).

#### THE AVERAGE IS A RATE OVER LOGGED DAYS, NOT A SUM OVER SEVEN

Dividing by seven calendar days would make **forgetting to log look like
consuming less** — the same lie §8.3 refuses for macros. The divisor is the
number of days in the window that actually have data **for that metric**, and
the card says how many that was, in words, on screen.

**Below `INTAKE_MIN_DAYS` (3) a window shows nothing, not 0.** A "7-day average"
computed from one day is noise wearing a trend's clothing. Verified: windows
with 1, 1 and 2 known days all returned `null`.

**Known-ness is per metric, not per day.** A day can be known for additives and
unknown for NOVA — an item whose `novaGroup` OFF never recorded still carries an
additives list. Each of the three figures therefore has its own divisor, and the
card prints all three.

**Gaps come from two places and both are gaps, never zeroes:**

1. A day with nothing counted at all.
2. A day counted **before §13.8 shipped**, whose snapshot has no `extras` or
   `flags`. **The card says so explicitly** when any fall in the window —
   *"1 day in this window was counted before caffeine and additives were
   recorded, so it is a gap here — not a zero."*

**A genuine measured zero is NOT a gap.** A product whose label says 0 mg
caffeine counts as a known day contributing 0. That is the whole reason §13.8
keeps null and 0 apart, and it is what stops "days I drank no coffee" from
quietly vanishing out of the divisor.

#### Worked, against a controlled spread

Seven days ending today: 100 mg, *(no entry)*, 200 mg, *(legacy day)*, **0 mg
measured**, 300 mg, 302 mg.

```
caffeine  (100 + 200 + 0 + 300 + 302) / 5 logged days = 180.4 mg/day
additives (  2 +   1 + 0 +   3 +   5) / 5 logged days =   2.2 /day
NOVA-4    (  1 +   0 +       1 +   1) / 4 KNOWN days  =   0.75/day
```

The NOVA divisor is **4, not 5**: the 0 mg day's item had `novaGroup: null`, so
that day is known for additives and unknown for NOVA. All three matched
hand-computation exactly.

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
  `{ touched: true, checked: ["Goblet Squat", ...], times: {"Goblet Squat": "2026-08-13T03:25:06.614Z", ...} }`
- Exercises are stored **by name, not by index**, so reordering `schedule.js`
  cannot silently re-point a tick at a different movement. Only names still on
  that day's card are counted, so a renamed or removed exercise is ignored
  rather than inflating the total.

#### `times` — when each box was ticked (added 2026-08-12)

A third, **additive** sibling key (§1.4). `touched` and `checked` are unchanged
in shape and in meaning; nothing was renamed or retyped. It exists so a future
feature can line a tick up against that day's `hrSeries` (§6.12). **This commit
stores and displays only — there is no chart and no analysis.**

| Operation | Effect on `times` |
|---|---|
| Tick | writes `times[name] = new Date().toISOString()` |
| **Untick** | **DELETES `times[name]`** |
| Re-tick | writes a **fresh, later** stamp |

**INVARIANT: `times` may never contain a key that is not also in `checked`.**
It holds by construction — `toggleExercise()` in `js/pages/training.js` is the
one and only write path — and it is asserted in verification, not assumed.
Measured: 8 mixed tick/untick operations produced 0 orphaned keys after every
single operation, on every stored day.

The converse is deliberately allowed: `checked` may contain a name with no
entry in `times`. That is what a day ticked earlier today, before this shipped,
looks like.

##### The UTC-vs-local asymmetry against `hrSeries` is deliberate

`times[name]` is a **UTC ISO instant** (`2026-08-13T03:25:06.614Z`).
`hrSeries.at` is **local wall clock with no offset and no `Z`** (§6.12).
**These must not be made consistent.** A bucket answers *when on the clock*; a
tick answers *which instant*. Converting either to match the other destroys the
thing it was chosen to record. This is the same shape of intentional asymmetry
§6.12 already records between `hrSeries.at` and `latestHR.at`, and the same
split `util.js` documents: a calendar **day** is local, an **instant** is UTC.

**Local time is produced for DISPLAY ONLY**, by `tickTimeLabel()` in
`pages/training.js`, which renders `HH:MM` 24-hour local. Never `toISOString()`
for display — measured live at 23:25 local on 2026-08-12, the stored stamp
reads `03:25` and belongs to 2026-08-13 in UTC. Printing that is the §12 date
bug in a new costume.

##### Absence is the boundary

Days logged before this commit have **no `times` key** and render **exactly** as
they did before — no timestamp line, **not an em dash, not `00:00`** (§1.7).
There is **no migration, no backfill, no epoch constant** (unlike training's
`STRICT_TRAINING_FROM`, §9.5) **and no default of `{}`** — the same rule
`asleepMinutes` follows in §6.10. `derive.js`'s `exerciseLog()` returns
`times: null`, never `{}`, so a caller can still tell "this day predates
timestamps" from "this day has timestamps, none for this exercise".

A day gains a `times` key only when a tick actually lands on it, and the
same-day lock means that can only ever be today. Unticking the last timestamped
exercise removes the key again rather than leaving an empty `{}` behind.

Verified: a pre-existing day's card HTML is **byte-identical** before and after
this change, on both Home and Training (2,649 characters each way, first
differing index −1).

##### What this commit did not touch

The same-day lock (§9.5) is unchanged. `toggleExercise()` still returns early
when `ds !== today()` **before** touching the store, and Home's read-only path
still emits no `onclick` attribute and a native `disabled`. Measured after the
change: a tap on a locked day left `metracker_v2` byte-identical and still
raised the refusal notice; Home's card renders 3 buttons, 0 `onclick`
attributes, 3 disabled.

The timestamp renders on **both** Home (read-only) and Training through the
same `renderPrescription()`. It is not forked. New styling is `.rx-ex-time` in
`styles/components.css`, using `--muted` — **no new colour literal** (§1.6).

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

##### The silent-refusal hole — fixed 2026-08-12

**The lock is decided at RENDER time from `today()`, and nothing used to
re-render.** Leave the app open overnight — which is exactly what a phone in a
gym bag does — and yesterday's card was still on screen rendered *interactive*,
every button carrying a live `onclick`. The write guard above refused
correctly, but it refused **silently**: the box did not tick, nothing said why,
and it looked like a broken app.

Both halves were fixed, and both were needed:

- **The `visibilitychange` re-render (§6.3) re-evaluates the lock**, so a
  rolled-over day comes back rendered locked instead of falsely interactive.
  Verified: a stale card with 3 live `onclick` handlers and 0 disabled buttons
  became 0 handlers and 5 disabled buttons after one foreground event, **with
  no tap**.
- **`toggleExercise()`'s refusal is now visible** — a brief plain line in the
  card's progress row, "That day is closed — boxes can only be ticked on the
  day itself." Muted styling, no dialog, no colour change, and it clears itself
  after six seconds or on the next successful tick. Verified: the tap left
  `metracker_v2` **byte-identical**.

**The lock itself was not weakened.** Same-day only, no grace window. This was
about honest feedback, not access.

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

- **Manual:** height, age, bodyweight, waist circumference, blood pressure /
  SpO₂ / pulse (§10.2), tested 1RMs (§10.1), dated targets (§14).
- **Auto from API:** HRV.
- **Derived:** 7-day rolling bodyweight trend, Training Max (§10.1).

**BUILT (§6).** HRV renders from `getCachedVitals(today()).hrv` as the fourth
cell of the Body summary (`renderBodySummary()` in `js/pages/health.js`). With
no value it is an em-dash labelled "no reading" — never a zero, which would read
as a measurement of zero (§1.7). A Versa 2 frequently produces no HRV figure for
a night; that is a gap, not a measurement.

**Bodyweight displays as the 7-day rolling average, not the daily value.** Daily
weight is mostly water and produces misleading noise.

### 10.0 Removed 2026-08-14 — Hormone Indices, and Awaiting Sync

#### Hormone Indices (HGH, Testosterone, Cortisol Pressure) — DELETED

`calcHGH()`, `calcTest()` and `calcCortisol()` are gone from `js/derive.js`, and
the three cards, the "Estimates from behavioral data only" banner and the
`cortisol-warning` block are gone from `index.html`.

**Why: there was no criterion variable.** Each function ran sleep, fasting,
workout type and sugar through a hand-tuned ladder of magic numbers and printed
the result as `HGH 72/100` beside a progress bar. **Not one blood test has ever
been taken against which any of the three outputs could be checked.** Nothing
about them was validated, falsifiable, or even wrong in a way anyone could
notice. Labelling them "behavioral correlations" underneath did not fix that —
a number with a hormone's name, a /100 scale and a bar reads as a measurement
however the caption is worded, and §1.7 does not allow an estimate to wear the
same clothes as a measurement.

**A phantom modifier went with them, and it is recorded so it is not rebuilt.**
`renderHealth()` contained:

```js
if(cort>60){ hghD=hgh-10; testD=test-10; modText='−10 cortisol drag'; }
else if(cort>30) modText='−5 cortisol drag';
```

The second branch **set the label and never subtracted anything.** For every
cortisol score between 31 and 60 the page displayed "−5 cortisol drag" under an
unmodified number. The label described a calculation that did not exist.

**DO NOT REINTRODUCE THESE WITHOUT REAL LAB DATA to fit against.** A behavioural
proxy is a legitimate thing to build once there is a measurement to regress it
on. Until then it is invention with a clinical name attached.

**The Driving Factors card survived** and is now the section's own content. It
was always the honest half — five plainly-labelled behavioural facts with a
good/bad dot each and no arithmetic pretending to be a measurement. The Cortisol
row was dropped with the indices (it was the one row whose value came from a
computation rather than a logged fact); the other five thresholds are unchanged.
Its container id is still `hgh-factors` — legacy, **deliberately not renamed**,
since §1.4's additive rule applies to DOM ids other code references.

#### Awaiting Sync — DELETED

The panel held body fat %, VO2 max and HRV. **Body fat and VO2 max have no
source device.** Ryan wears a Versa 2 and owns no smart scale, so both were
permanently `null` and the panel could only ever render two em-dashes under a
heading promising they were on their way. A section that can never populate is
not honest reporting, it is furniture.

HRV moved up into the Body summary, which is now 2×2 rather than three across —
four cells on a 393pt screen leaves ~85px each, which crushes the value onto a
separate line from its unit (§1.5).

**If a smart scale is ever added, body fat returns as a real field.** VO2 max is
available from the Versa 2 in principle — Fitbit calls it **Cardio Fitness
Score**, which is why searching their docs for "VO2 max" comes up empty — but
nothing in the current sync populates it.

### 10.2 Blood pressure, SpO₂ and pulse — `d.body.vitals`

Dated readings Ryan takes in the evening with a cuff and an oximeter. Stored
additively beside `weights` and `waists`:

```js
d.body.vitals = [
  { date: '2026-08-14', systolic: 128, diastolic: 82, spo2: 97, pulse: 64 }
]
```

#### THE APP DOES NOT INTERPRET THESE

**No hypertension staging. No normal/elevated/high label. No colour coding by
threshold. No scoring — §11 is untouched by this feature.** Blood pressure
staging is a clinical judgement that depends on context this app does not have:
posture, cuff size, time of day, medication, what last month looked like.
Printing "Stage 1 Hypertension" under a number would be exactly the overclaim
§10.0 deleted the hormone indices for. **Store the numbers, show the numbers.**

#### Every field is independently nullable

Ryan may take blood pressure without the oximeter or the other way round. **An
absent field is omitted from the record** — not written as `null`, not written
as `0` (§1.4, §1.7). A record with no non-null field is not saved at all.

**Half a blood pressure is the one exception, added 2026-08-15.** A lone
systolic means nothing clinically and nothing to Ryan reading it back in six
months, so a save is rejected unless the **resulting record** carries both
numbers. The test is on the result rather than on the form, so correcting one
half of a reading already stored for that date still works — the merge below
supplies the other half. SpO₂ and pulse remain independent of both and of each
other.

#### One record per date, and saves into it MERGE

> **CHANGED 2026-08-15. It used to REPLACE.** Replacing quietly destroyed the
> whole point of independent field saves: logging SpO₂ in the afternoon and
> pulse in the evening left a record holding only the pulse.

Re-saving the same date **merges into** that record: the fields actually entered
are written and **every other key is left exactly as it was**. A field never
entered is still simply not a key. Still one record per date — unlike
`weights`/`waists`, which **append by design** and are unaffected, because two
weigh-ins in one day are two real readings while these are point-in-time.

**A consequence worth knowing:** a field cannot be cleared back to absent
through the form. Re-entering it overwrites it; there is no "unrecord this"
control, and inventing one was not asked for.

#### Ranges are typo guards, not medical judgements

| Field | Accepted |
|---|---|
| `systolic` | 60–260 mmHg |
| `diastolic` | 30–160 mmHg |
| `spo2` | 50–100 % |
| `pulse` | 25–220 bpm |

A value outside these is **rejected with a visible message and nothing is
written** — not the vitals record, and not the bodyweight or waist entered in
the same submission. A mistyped `1280/82` that got stored would sit in the
history forever looking like something that happened.

### 10.3 Independent field saves — and why carry-forward was rejected

**Built 2026-08-15.** Log Measurements stays **one card with one Save button** —
it was not split up. What changed is that every field is independently optional
in the same submission: **two fields filled and six blank is a complete, valid
save**, and a save with nothing filled writes nothing and says so.

#### ############ A BLANK FIELD IS ABSENT. IT IS NEVER CARRIED FORWARD ############

**Ryan explicitly asked for "if left blank, assume the previous numbers." It was
not built, he accepted the correction, and this paragraph exists so it is not
reintroduced later as a convenience feature.**

A carried-forward SpO₂ is **a reading he never took, stored indistinguishably
from one he did.** Once written it is unfalsifiable — nothing in the record says
which numbers were measured and which were inherited. That is the same defect
class as `awakeMinutes` counted as sleep (§6.10) and every em-dash rule in §1.7.

#### Showing the last known value IS done — that is a different thing

The Latest Readings card falls back **per field** to the most recent record that
carries it, **with its age attached**: `SpO₂ 97%, 3 days ago`. This supersedes
§10.2's original "never borrows a value from an older record" — an em-dash where
a real reading exists three days back throws away something true.

> **Displaying the last known value is honest. Storing it as today's is not.**
> The date travels with the number, and nothing is written. A field with no
> reading anywhere still shows `—` and "not taken".

#### The save receipt names the gap as it is created

After a save the card shows, **derived and never hardcoded**:

> Saved: SpO₂ 98%, pulse 61 bpm. Not recorded: bodyweight, waist, blood pressure.
> Blank fields stay blank — nothing was carried over from an earlier reading.

Both lists come from what was actually written. **A known gap said out loud
today is worth far more than a mystery hole in a chart in three weeks.** The
receipt replaced an `alert('Measurement saved!')`, which said nothing about what
had been left out. Errors — a range rejection, half a blood pressure, an empty
form — render in the same place rather than as an `alert()`.

#### Height and age are the one exception, because they are profile state

They are **not dated measurements**: there is one current height and one current
age. Their inputs are **prefilled from what is stored** so they need no
re-entry, they keep their own `onchange` handlers, and the Save button also
writes them — **but only when actually present**, and they appear in the receipt
only when they genuinely changed.

### 10.1 1RM, Training Max, and the Personal Records page

**Relative Strength moved to this page 2026-08-14**, out of Health Status. Every
number in it is a **derived** Training Max ÷ the rolling bodyweight, so it reads
the lifts this page already owns; on Health Status it sat among body
measurements with no lift context anywhere near it. `relativeStrength()` in
`derive.js` is unchanged by the move and still reads the **derived** TM, never a
stored one. `renderPRs()` renders it after the PR cards.

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

---

## 13. The food library — server-owned, and a deliberate exception to §1.2

**Built 2026-08-12.** `server/foods.py` plus five endpoints in `server/app.py`.
A persistent store of the items Ryan eats often, each carrying the macros off
its package label. This is the "food rotation checklist" HANDOFF §5 specified,
built without vision or barcode — those are still a later, separate job.

### 13.1 The ownership rule — read this before touching anything else here

**§1.2 says localStorage is the source of truth and the server owns nothing.
THIS IS THE ONE EXCEPTION, agreed with Ryan, and it is recorded as an exception
rather than quietly softening §1.2.**

| Thing | Owner | Why |
|---|---|---|
| The food **library** | **The server**, authoritative, persists indefinitely | A reference table, not a measurement |
| The phone's **mirror** (`d.foodLibrary`) | A read-only **cache** | So the page opens instantly and works offline |
| The daily **counts** (`d.foodCounts`) | **localStorage**, per §1.2, never sent to the server | They feed the Dietary score |

**Why the exception is safe:** the library is a reference table. Losing it costs
Ryan some retyping. Losing a day's counts would change his score, which is
exactly what §1.2 exists to protect — so the counts stay where every other
scored fact lives.

**THERE IS NO COUNTS ENDPOINT AND THERE MUST NOT BE ONE.** Verified: `/api/counts`
and `/api/foodCounts` both 404.

**The mirror is a cache, never a second source of truth.** A client whose write
fails must say so and leave the mirror alone — never queue the write locally,
never let the mirror drift from the server (§13.5, §1.7).

### 13.2 Storage and item shape

`server/data/foods.json`, already gitignored via `server/data/`. **No data file
is ever committed.**

```json
{
  "id": "fd_<uuid4hex12>",
  "name": "RXBAR Chocolate Sea Salt",
  "servingText": "1 bar (52g)",
  "macros": {"protein": 12, "fat": 9, "saturatedFat": 3.5, "carbs": 24,
             "sugar": 13, "calories": 210, "fiber": 5, "sodium": 260},
  "confidence": "high",
  "createdAt": "<UTC ISO>", "updatedAt": "<UTC ISO>", "lastUsedAt": "<UTC ISO or null>"
}
```

- **`saturatedFat` joined the macros 2026-08-14 (§14.1)** — same rules as every
  other macro, and **never inferred from total fat**.
- **Which macros the Dietary score reads is decided by §14.1's weights**, not
  here: calories, protein, sodium, sugar, fiber and saturated fat carry weight;
  **total fat and carbs are captured and displayed but never scored**, because
  carbs are the arithmetic residual of the other three. This sentence used to
  name protein/fat/carbs/sugar as "the four the score reads" — that was the
  pre-v2 formula. §11 still protects the four PILLAR weights, which are a
  different thing entirely.
- **Any macro may be `null`, meaning "not printed on the label". Never `0`.**
  Zero is a measurement of zero (§1.7). A value that is present but not a
  non-negative number is a **400**, not a silent `null` — quietly discarding a
  typo would store "no data" for something Ryan believes he entered.
- **`confidence` is `"high"`** for a hand-typed item, per §8's tiers.
  **`"exact"` was previously reserved for "a future Open Food Facts hit" and
  rejected outright; that future arrived with §13.6 and it is accepted now —
  but only on an item that carries a `barcode`.** The lookup is what makes it
  exact, so an `"exact"` with no barcode is still recorded as `"high"`.
- **The server generates `id`, `createdAt` and `updatedAt`.** A client cannot
  set them.

#### Four additive fields from the barcode path (§13.6, §13.7)

```json
"barcode": "0857777004096", "basis": "converted",
"servingGrams": 52, "servingSource": "off"
```

| Field | Meaning |
|---|---|
| `barcode` | The **canonical** code (§13.6), digits |
| `basis` | `converted` / `per_serving` / `per_100g` — how the stored per-serving macros were arrived at |
| `servingGrams` | Grams in one serving. Strictly positive |
| `servingSource` | `off` (OFF knew it) / `label` (Ryan typed grams) / `divided` (net weight ÷ servings per container) |

- **THE STORED MACROS ARE ALWAYS PER SERVING**, in every case. `basis` records
  provenance, not what unit the numbers are in.
- **ABSENCE IS THE BOUNDARY** (§1.4). Items that predate this have none of these
  keys, and **nothing backfills them** — they are omitted from a stored record
  rather than written as nulls, so "hand-typed, before barcodes" stays
  distinguishable. No migration, no epoch constant, same rule as
  `asleepMinutes` (§6.10) and `times` (§9.4).
- **A `PUT` leaves a key it does not mention alone**, rather than clearing it.
  These four are provenance, like `createdAt` — and the Meal Tracker's plain
  Edit form knows nothing about them, so a PUT that dropped an item's barcode
  because the edit form never heard of it would be silent data loss.
- **`basis: "per_100g"` with no `servingGrams` is a 400.** Storing per-100 g
  numbers behind a counter that counts servings (§8.0) is the exact silent
  inflation §13.6 exists to prevent. The client disables Save as well — that is
  the UI, this is the guarantee (§9.4's split).

### 13.3 Endpoints

Same-origin, no CORS, loopback bind unchanged (§2).

| Route | Method | Returns |
|---|---|---|
| `/api/foods` | GET | `{items:[...], updatedAt}` |
| `/api/foods` | POST | create — `{item, items, updatedAt}` |
| `/api/foods/{id}` | PUT | update — bumps `updatedAt` **only** |
| `/api/foods/{id}` | DELETE | `{deleted, items, updatedAt}` |
| `/api/foods/{id}/used` | POST | sets `lastUsedAt = now`; called on ADD |

`updatedAt` at the envelope level is the newest `updatedAt` across the library,
or `null` when it is empty. Every mutating route returns the whole library so a
client can refresh its mirror from the response rather than re-fetching.

**`PUT` replaces the editable fields wholesale** (name, serving text, macros)
and carries `createdAt` and `lastUsedAt` through untouched — an edit is not a
use. **`/used` sets `lastUsedAt` and nothing else**: bumping `updatedAt` there
would make every mirror look stale after lunch.

**`confidence` and the four §13.6 fields follow a different rule: a key the
payload does not MENTION is left alone.** They are provenance, not label text,
and the Meal Tracker's Edit form has never sent any of them. For a hand-typed
item this is identical to the old behaviour (`high` either way) — but without
it, fixing a typo in an Open Food Facts item's name silently demoted it from
`exact` to `high` and dropped its barcode. Confidence is still re-checked
against the **merged** barcode, so explicitly clearing the barcode still
downgrades the tier. Verified both ways.

**A missing or malformed `foods.json` yields an EMPTY library, never a 500.**
Same reasoning as `_load_daily_store()` in `google_health.py`, and the
unreadable file is left on disk rather than overwritten.

### 13.4 Writes are atomic

`_save_items()` writes to a temp file **in the same directory** (so the swap is
a same-filesystem rename) and `os.replace()`s it onto `foods.json` — the same
pattern `_save_daily_store()` already uses. A crash mid-write cannot leave a
truncated library.

**Tested by actually forcing it**, not just by reading the code: a fault
injected halfway through the temp-file write left `foods.json`
**byte-identical**, the library still parsed, and the next successful write
cleaned up the stale temp file.

A `threading.Lock` serialises read-modify-write, because the purge runs on a
worker thread out of the nightly loop while request handlers run on FastAPI's
threadpool.

### 13.5 The 120-day purge

**`FOOD_PURGE_DAYS = 120`**, a named module constant in `foods.py`, never a
literal at the call site.

- An item whose `lastUsedAt` is **strictly older** than 120 days is deleted; so
  is one whose `lastUsedAt` is `null` and whose `createdAt` is strictly older
  than 120 days.
- **Runs ONCE PER DAY inside the existing nightly loop in `server/app.py` at
  04:15. NO NEW SCHEDULER WAS ADDED** — that loop already fires exactly once a
  day, which is exactly the cadence the purge wants. It sits in its own
  `try`/`except` so a failed purge is never reported as a failed sync and a
  failed sync never skips the purge.
- **Every removal is logged by name and id** to `server/logs/sync.log`, the log
  file the server already keeps, so a deletion is never silent.
- **An item whose timestamps cannot be read is KEPT, and the fact is logged.**
  Deleting on ambiguity is how silent data loss starts.

Verified against a spread of ages: 0 / 119 / **120 exactly** / 121 / 365 days
since last use, plus null-`lastUsedAt` items created 0 / 119 / 120 / 121 days
ago, plus one recently-used item created 900 days ago, plus one with unreadable
timestamps. Exactly three were selected — 121-day-used, 365-day-used, and
121-day-created-never-used. **120 days exactly survives; 121 does not.**

#### Purging is safe ONLY because the client snapshots macros

The Meal Tracker page copies an item's macros into `d.foodCounts[date][id]` the
first time it is added that day (§8, "the snapshot rule"). A day's macros are
computed from **its own snapshot**, never by looking the item up in the library.
That is what makes deleting a library item harmless to history — and it is also
what stops a later correction to a label from silently rewriting past scores.

**If a future session ever "normalises" `d.foodCounts` into an id reference,
this purge starts rewriting history and must be turned off first.**

---

### 13.6 Barcode lookup — Open Food Facts

**Built 2026-08-13.** `server/barcode.py` plus one endpoint in `server/app.py`.
This is the "barcode → Open Food Facts" step §8 has always put first in the
order of attempt, and HANDOFF §5 specified.

> **Numbering note:** the build brief called this "§13.1". That number was
> already the ownership rule above, and it is cited by name in `foods.py`,
> `app.py` and §8.0 — renumbering would have caused exactly the drift this file
> exists to stop. It landed at §13.6 instead. There is nothing else to read into
> the number.

#### The endpoint

```
GET /api/barcode/{code}
```

**It returns a CANDIDATE FOR REVIEW. It creates nothing.** The client shows what
came back, Ryan checks it against the package in his hand, and only then does
the **existing** `POST /api/foods` (§13.3) save it. There is deliberately no
second create path and no "save on lookup" shortcut.

| Outcome | HTTP | Body |
|---|---|---|
| A candidate | 200 | `{found:true, barcode, matchedAs, name, brand, servingText, servingGrams, packageGrams, basis, macros, sodiumSource}` |
| OFF has no such product | **200** | `{found:false, barcode, reason}` |
| The typed digits are not a barcode | 400 | `{detail}` — **no upstream call is made** |
| OFF timed out, refused, or was unreachable | 502 | `{detail}` |

**"Not found" is a 200 on purpose.** A product Open Food Facts does not have is
a normal, frequent outcome — not an error — and the client turns it straight
into manual entry with the barcode kept. Only a genuine upstream *failure* is a
502, and a failure never returns a partial or fabricated product (§1.7).

Upstream is `https://world.openfoodfacts.org/api/v2/product/{barcode}.json`,
with a descriptive `User-Agent` per OFF's stated policy and an **8-second**
timeout. **No API key, no auth, no secrets** — nothing in `barcode.py` reads
`.metracker/`. **Nothing upstream is cached to disk.**

**The User-Agent deliberately carries no personal contact details.** OFF asks
callers to identify themselves; it gets the app name, version and repo URL.
Ryan's email is not published to a third party's request logs to satisfy a
courtesy header.

#### ############ VISION MUST NEVER DECODE A BARCODE ############

**Typed digits only. No camera, no live scanning, no image decoding, and no
Ollama anywhere in this path.**

This is not a scope note, it is a correctness rule. A vision model that misreads
one digit **does not fail** — it returns a *different product's* macros, with
full confidence, and nothing downstream can tell. Every other failure mode in
this feature is visible; that one is silent, and it would poison the library
permanently because §8.0's snapshot rule then copies those macros into a day's
record.

§8's order of attempt is **barcode → label OCR → plate estimate**: deterministic
lookup first, inference only after, and the two never blurred. A camera-based
barcode path is a separate, later build with its own decision — it is not an
incremental improvement to this one.

#### Normalisation — load-bearing

- Whitespace and hyphens are stripped. **Anything else left over is rejected**,
  not silently discarded — dropping a stray character could turn one product's
  code into another's.
- **8, 12 or 13 digits only.** Any other length is rejected *without calling
  upstream*.
- A 12-digit UPC-A is tried **as-is and zero-padded to 13** (EAN-13).
- `matchedAs` reports which form was asked with: `ean13`, `upc12`,
  `ean13-padded`, `ean8`.

##### MEASURED, AND IT CONTRADICTS THE BRIEF THAT ASKED FOR IT

The build brief said US 12-digit products "routinely miss without the pad". That
was checked against live data rather than assumed, and **it is not true of
today's API**:

| Asked with | HTTP | `code` returned |
|---|---|---|
| `857777004096` (12) | 200 | `0857777004096` |
| `0857777004096` (13) | 200 | `0857777004096` |

Six US 12-digit codes, both forms each, twelve requests: **every one resolved,
and every one came back keyed to the 13-digit form.** OFF does key on 13
digits — that half is confirmed — but its API zero-pads the request itself, so
the pad never *rescues* a lookup.

**The pad attempt was kept anyway**, because it costs one request only when the
first form misses, and it is real insurance if that server-side normalisation
ever changes. **But do not expect to see `matchedAs: "ean13-padded"` in
practice, and do not treat its absence as a bug.**

##### The stored barcode is the CANONICAL code, not what Ryan typed

Because OFF answers a 12-digit request with the 13-digit `code`, **that** is
what the endpoint reports and what the client stores. Storing the 12 typed
digits would mean the same product looked up later in its 13-digit form did not
match the item already in the library — a hole straight through the duplicate
guard (§13.7).

The canonical code is adopted **only when it is the same number** (an integer
comparison, so leading zeros are irrelevant). A code that is genuinely different
is not silently accepted.

#### ############ THE SERVING-SIZE PROBLEM — THE WHOLE FEATURE ############

**OFF reports nutriments per 100 g, and only sometimes also per serving. The
Meal Tracker counter counts SERVINGS (§8.0).** Getting this wrong does not look
like a bug: it silently inflates or deflates every macro Ryan eats, in one
direction, forever.

**THE SERVER NEVER GUESSES A SERVING SIZE.** It never assumes 100 g is a
serving, and it never returns per-100 g figures while labelling them
per-serving. It reports what OFF has, what OFF lacks, and which case applies.
Deciding what to do about a missing serving size is the client's job, with Ryan
in the loop (§13.7).

| Case | Condition | `basis` | Macros returned |
|---|---|---|---|
| 1 | `serving_quantity` present (grams/serving) | `converted` | `per100g × serving_quantity ÷ 100`, `servingGrams` set |
| 2 | no `serving_quantity`, but `*_serving` nutriments exist | `per_serving` | used as-is, `servingGrams` **null** |
| 3 | neither, but `product_quantity` present | `per_100g` | **UNCONVERTED per 100 g**, `packageGrams` set |
| 4 | neither, and no `product_quantity` | `per_100g` | **UNCONVERTED per 100 g**, both null |

Cases 3 and 4 share a `basis`; **`packageGrams` is what tells them apart**, and
all it buys is that the client can offer the servings-per-container route
without Ryan re-typing the net weight.

**Case 2 returns null `servingGrams` deliberately.** Knowing the macros of a
serving is not the same as knowing what it weighs, and inventing a weight is
precisely what this module refuses to do.

`packageGrams` is reported **whenever OFF has it**, in every case, because it is
a fact about the product. It is only *acted on* in the per-100 g case.

##### How the cases actually distribute — measured over 2,396 real products

| `basis` | Count | Share |
|---|---|---|
| `converted` | 1,799 | 75.1% |
| `per_100g` — case 3 (`packageGrams` known) | 470 | 19.6% |
| `per_100g` — case 4 (nothing) | 127 | 5.3% |
| **`per_serving`** | **0** | **0%** |

**Case 2 did not occur once.** OFF *derives* its `*_serving` values from
`*_100g × serving_quantity`, so per-serving values essentially never exist
without a `serving_quantity` — which makes it case 1. The branch is kept
(the brief asked for it, it is cheap, and OFF's derivation rule is not a
promise), but **it is effectively dead code, and a future session should not be
surprised to find it never runs.** It was verified by removing
`serving_quantity` from a real record.

**Roughly a quarter of lookups land on per-100 g**, so the client's two
serving-size routes (§13.7) are not an edge case — they are the normal path
every fourth scan.

##### A converted figure can differ slightly from OFF's own per-serving value

Case 1 recomputes from per-100 g rather than reading `*_serving`, per the
brief's ordering. OFF rounds its stored per-serving values, so the two can
disagree in the last decimal — Coca-Cola converts to `34.98 g` carbs where OFF's
own `carbohydrates_serving` says `35`. That is rounding, not an error, and the
review card lets Ryan overwrite either way.

#### Field mapping

| Me-Tracker | Open Food Facts |
|---|---|
| `protein` | `proteins` |
| `fat` | `fat` |
| `carbs` | `carbohydrates` |
| `sugar` | `sugars` |
| `fiber` | `fiber` |
| `calories` | **`energy-kcal`** |
| `sodium` | `sodium`, else derived from `salt` |

**CALORIES COME FROM `energy-kcal`, NEVER FROM `energy`.** OFF's `energy` is
kilojoules. Verified on a real record: the RXBAR reports `energy-kcal_100g 385`
and `energy_100g 1610` — using the wrong one turns a 200 kcal bar into 837.

**Any field absent upstream is `null`, NEVER `0`** (§1.7). Measured across the
same 2,396 products: fiber missing on 29.5%, sugar and sodium on 6.1%, protein
on 5.5%, calories on 5.1% — while **1,075 genuine measured zeros were kept as
`0`**. A half-missing panel is the common case, not the exception, and it must
come back half-null.

#### Salt → sodium

OFF usually carries **salt in grams**, and both its salt and sodium fields are
in **grams** while this app stores sodium in **milligrams**.

```
sodium_mg = sodium_g × 1000                    sodiumSource = "sodium"
sodium_mg = (salt_g ÷ 2.5) × 1000              sodiumSource = "salt"
```

`sodiumSource` is reported because a derived figure is arithmetic on a label
value, not a label value.

**The 2.5 constant is confirmed against real data, not taken on trust.** On 519
of 556 products carrying both fields (93.3%), `salt ÷ 2.5` reproduces OFF's own
sodium value exactly. End to end on the RXBAR: `0.865 ÷ 2.5 × 0.52 × 1000 =
179.92 mg`, identical to the sodium-sourced answer of `179.9 mg`.

##### OFF's own salt and sodium fields sometimes contradict each other

**4.0% of those products (22 of 556) disagree by more than 10%**, and the
pattern says the *sodium* field is the bad one — a unit slip of exactly 1000×,
someone typing milligrams into a grams field:

| Product | `salt_100g` | `sodium_100g` | `salt ÷ 2.5` |
|---|---|---|---|
| Thunfisch Filets | 0.89 | 0.000354 | 0.356 |
| Natural Cottage Cheese | 0.52 | 0.000208 | 0.208 |
| Sriracha Sauce | 7.8 | 0.134 | 3.12 |

**`sodium` is still preferred when present**, per the brief. Three things make
that safe rather than reckless, and a future session should weigh all three
before "fixing" it:

1. **Sodium is never scored** (§13.2). It is displayed only, so a wrong value
   cannot move the Dietary score or any pillar.
2. Every macro is **editable on the review card before anything is saved**
   (§13.7), and `sodiumSource` is shown.
3. Picking a winner automatically means guessing which of two upstream numbers
   is right, which is the same class of decision this whole module refuses to
   make about serving sizes.

**Flagged for Ryan as an open call**, not fixed silently: preferring `salt` when
the two disagree by more than ~10× would catch these, at the cost of overriding
a value OFF actually reports.

#### What this endpoint does not touch (§13.6)

`google_health.py`, the sync loops and every pre-existing route are untouched.
Verified after the change: `/api/health`, `/api/foods`, `/api/sync/status`,
`/api/vitals/{date}`, `/api/vitals?from=&to=`, `/`, `/index.html`, `/js/*`,
`/styles/*` all still answer 200; `/api/counts` and `/api/foodCounts` still 404
(§13.1); and `server/data/` was **byte-identical** before and after a full test
run.

---

### 13.7 The review card — nothing is saved until Ryan taps Save

**Built 2026-08-13, client side.** `js/pages/meals.js`, in the Meal Tracker's
library section, alongside the manual add form that was already there.

#### The flow

```
[ barcode digits ] [ Look Up ]
        |
        +-- found      -> REVIEW CARD -> Ryan checks/edits -> [Save] -> POST /api/foods
        +-- not found  -> plain message + the manual form, BARCODE KEPT
        +-- 400 / 502  -> plain message, NOTHING shown, manual entry still there
```

**A LOOKUP WRITES NOTHING.** It produces a card. Verified: after a lookup that
was then cancelled, `metracker_v2` was byte-identical and `foods.json` hashed
identically (`861D74DD…`) before and after.

**The review card replaces the add form while it is open**, rather than sitting
above it. Two Save buttons on one phone screen meaning two different things is a
mis-tap waiting to happen, and the card is the thing Ryan is being asked to
check.

**Saving goes through the EXISTING `POST /api/foods`** (or `PUT` for the
duplicate case). There is no second create path.

**Every macro on the card is editable and what Ryan leaves is what gets saved.**
Verified: upstream protein 12 edited to 13 on the card stored as 13.

#### The per-100g case — two routes, one output

About one lookup in four (§13.6). The card says plainly that the numbers are per
100 grams and offers two routes. **Both produce the same single output: GRAMS
PER SERVING.**

| Route | Inputs | `servingSource` |
|---|---|---|
| **A** | Serving size in grams, typed off the panel | `label` |
| **B** | Net weight ÷ servings per container | `divided` |

- Route B's net weight is **prefilled from `packageGrams`** when the lookup knew
  it, so Ryan does not re-type a number the server already has. He can overwrite
  it.
- The card shows the resulting grams per serving and **recomputes every macro
  live from the per-100g figures**, so the converted numbers can be checked
  against the panel before saving.
- **The macro fields start EMPTY and are cleared again if the serving size
  becomes invalid.** A per-serving column that no longer matches any serving is
  the kind of quietly wrong number this whole feature exists to prevent — so it
  never LOOKS right either, not just "Save is blocked".
- **Blank, zero, negative and non-numeric servings-per-container all produce
  NOTHING** — never `Infinity`, never `NaN`. One `positiveNum()` gate every
  serving-size figure passes through. Verified for each: no number, Save
  disabled, no `Infinity`/`NaN` anywhere in the card.
- **Save stays disabled until one route has produced a number.** The server
  refuses it too (§13.2) — the button is the UI, the 400 is the guarantee.

Worked, on real Nutella data (per 100 g: protein 6.3, fat 30.9, carbs 57.5,
sugar 56.3, calories 539, fiber **null**, sodium 43 mg):

| | Route A: 40 g typed | Route B: 400 g ÷ 10 |
|---|---|---|
| grams/serving | 40 | 40 |
| protein | 6.3 × 40/100 = **2.52** | **2.52** |
| fat | 30.9 × 0.4 = **12.36** | **12.36** |
| carbs | 57.5 × 0.4 = **23** | **23** |
| sugar | 56.3 × 0.4 = **22.52** | **22.52** |
| calories | 539 × 0.4 = **215.6** | **215.6** |
| fiber | **blank** (null upstream) | **blank** |
| sodium | 43 × 0.4 = **17.2** | **17.2** |

##### ROUTE B CARRIES REAL ROUNDING SLOP — THIS WAS RYAN'S EXPLICIT CALL

Manufacturers round servings per container. "About 4 servings" on a 340 g jar
could be anything from 3.5 to 4.4, so the grams-per-serving it divides out to is
approximate in a way route A's printed number is not. **Ryan asked for route B
anyway, knowing this. It is a deliberate choice, not an oversight**, and the
card says so on screen. Do not "fix" it by removing the route.

##### Only grams per serving is stored

**The net weight and the servings-per-container are NOT persisted.** They are
inputs to a calculation, not facts worth keeping, and **a future session must
not be able to recompute from them** — a stored "4 servings" would invite
exactly the re-derivation that makes the rounding slop compound. Only
`servingGrams` survives.

**The stored macros are the CONVERTED per-serving values. The per-100g figures
are not stored.** Verified on a saved route-B item: 12 keys total, none of them
a net weight, a servings count or a `packageGrams`.

`servingText` defaults to an honest `1 serving (40g)` and is editable; once Ryan
types in it, recalculation stops overwriting it.

#### The duplicate guard

**A scanned duplicate is the most likely way this library gets junked up**, so a
barcode already in the library never creates a second item. The card says which
item it is and its Save button becomes **Update “that item”**.

**Compared by numeric value, not string.** `barcodeKey()` strips leading zeros,
because that is the only difference between a UPC-A and its EAN-13 — an item
saved from the 12-digit form must still match a later 13-digit lookup. Verified:
saved by typing 12 digits, looked up again as 13, caught as a duplicate, library
count unchanged at 2, one item with that barcode.

The same guard covers the **not-found** path: if Ryan already typed that product
in himself, he gets that item open for editing and a message saying why, not a
blank form that would create a second copy.

#### Not found, and the server being down

- **Not found** — a plain message, and the manual add form with the **barcode
  retained** as a chip, so the panel is typed once and the code is kept.
  **Confidence stays `high`**: a hand-typed panel is hand-typed whether or not a
  barcode is attached to it. Only a lookup earns `exact`.
- **Server unreachable / 400 / 502** — says so plainly, shows **no card and no
  numbers**, and the manual form is still fully available (§1.7). Verified with
  `fetch` forced to reject: honest message, no card, `metracker_v2` unchanged.

#### Confidence

**A saved Open Food Facts result is `exact`** (§8) — in all four cases,
including a per-100g candidate Ryan converted himself, because the *lookup* was
deterministic. A hand-typed item stays `high`.

#### What this did not touch

The counter, `d.foodCounts`, the snapshot rule (§8.0) and scoring are all
unchanged. `index.html` was not touched — the page mounts already existed. All
`fetch()` stays in `js/api.js` (`lookupBarcode()`). **No new colour literals**
(§1.6): every new style in `components.css` uses existing tokens.

Verified at a 393pt viewport: all 12 review-card inputs measure 44px and the
five buttons 44–48px (§1.5), with no horizontal overflow. All ten pages render,
the Meal Tracker → Dietary → Home back chain works, and a full sweep of every
barcode branch produced **zero JavaScript errors and zero `console.error`
calls**. Non-2xx API responses do appear in the browser's network log as
`Failed to load resource` lines — those are the deliberate 400/502 answers being
handled and displayed, not exceptions.

---

### 13.8 Additives, caffeine and micronutrients — capture, not display

**Built 2026-08-13.** Two additive groups on both the lookup response
(`barcode.py`) and the stored library item (`foods.py`).

**THE POINT IS CAPTURE. The data starts accumulating now so it can be analysed
later.** §8.4's chart is deliberately thin, and **none of this is scored** — the
four pillars at 25% each are untouched (§11). Everything here is display-only.

#### Group A — `extras`: six numbers, per serving, in milligrams

`caffeine`, `potassium`, `calcium`, `iron`, `magnesium`, `zinc`.

- **They convert by exactly the same serving-size logic as the macros** (§13.6's
  four cases). The identical `factor` is applied; there is no special case for
  them anywhere, and a future session must not add one.
- **Auto-filled from a lookup where OFF has them, TYPEABLE BY HAND otherwise** —
  Ryan can read caffeine off a can OFF has never heard of.
- **Absent upstream is `null`, never `0`** (§1.7). This matters more here than
  for macros because coverage is so poor: most products have none of these, and
  a blank must read as "OFF does not know", never "contains none".

##### Units — measured, not assumed

OFF normalises all six into **grams** in the base nutriments object and says so
in a `<field>_unit` key. **Across 800 real products, every single occurrence of
all six read `"g"` — not one exception.** Grams → milligrams is therefore a flat
**×1000**, the same conversion sodium already makes.

A value arriving in any other unit returns **null rather than a guessed
conversion**: a 1000× error in a caffeine figure is worse than a blank. *That
guard has never once fired against real data* — it is insurance, not a hot path.
A **missing** `_unit` still converts, because `_100g`/`_serving` are OFF's own
normalised grams either way.

Worked, live:

| Product | raw `_100g` | × 1000 | × serving | reported |
|---|---|---|---|---|
| Monster, 473.18 g | caffeine 0.0338 g | 33.81 mg | × 4.73176 | **160 mg** |
| Red Bull, 250 g | caffeine 0.032 g | 32 mg | × 2.5 | **80 mg** |
| RXBAR, 52 g | potassium 0.712 g | 712 mg | × 0.52 | **370.24 mg** |
| RXBAR, 52 g | iron 0.00208 g | 2.08 mg | × 0.52 | **1.08 mg** |
| Twix, 43.1 g | calcium 0.08 g | 80 mg | × 0.431 | **34.48 mg** |

160 mg for a 16 oz Monster and 80 mg for a 250 ml Red Bull are both the real
figures off the can, which is the check that matters.

##### Fill rates — measured across 2,300 real products

**Coverage is poor and that is not a bug.** The counts below are "OFF has *a*
value"; the bracketed figure is how many of those are a **genuine measured
zero** rather than a real quantity.

| | Energy drinks (n=100) | Protein bars/powders (n=300) | Everything else (n=1,900) |
|---|---|---|---|
| caffeine | **37.0%** | 20.0% *(59 of 60 are 0)* | 8.5% *(147 of 161 are 0)* |
| potassium | 6.0% | 21.7% *(8 are 0)* | 4.8% *(32 are 0)* |
| calcium | 7.0% | 23.7% *(10 are 0)* | 13.5% *(26 are 0)* |
| iron | 2.0% | 37.3% *(47 are 0)* | 15.1% *(155 are 0)* |
| magnesium | 7.0% | 28.3% *(54 are 0)* | 14.1% *(140 are 0)* |
| zinc | 2.0% | 23.7% *(58 are 0)* | 10.7% *(149 are 0)* |

**Caffeine on energy drinks — 37% — is the only cell that is much use**, and it
is the one Ryan cares about. Outside that category, caffeine "coverage" is
almost entirely genuine zeros: in the broad sample only **14 of 1,900** products
carry a real non-zero caffeine figure. **Hand-typing will be the normal path for
caffeine**, which is exactly why the field is typeable.

#### Group B — `flags`: descriptive, lookup-only

```json
"flags": {
  "additives": {"count": 5, "tags": ["e330", "e331"],
                "names": ["E330 - Citric acid", "E331 - Sodium citrates"]},
  "novaGroup": 4
}
```

- **FLAGS DO NOT SCALE WITH SERVING SIZE.** An additive is present or it is not;
  half a serving does not contain half an E330. Nothing here is multiplied by
  anything. Verified identical across all four bases.
- **FLAGS ARE NEVER HAND-TYPED.** A hand-entered item has **unknown** additives,
  not zero additives. The client offers no way to enter them, and the server
  refuses them on an item with no barcode — the same tie that governs `exact`
  confidence (§13.2), for the same reason: a lookup is evidence, a typed guess
  is not. Clearing an item's barcode clears its flags with it.
- OFF's language prefix is stripped (`en:e129` → `e129`).
- `count` is always **derived from the stored tags**, never taken from a client.

##### `additives_original_tags`, not `additives_tags`

`additives_tags` additionally carries broader **parent** tags — Red Bull US
lists both `e500` and `e500ii` for one additive — which inflates the count.
`additives_original_tags` is what OFF actually detected, and **it matches OFF's
own `additives_n` exactly** on every product checked (Monster 5=5, Red Bull EU
4=4, Red Bull US 2=2, Twix 8=8). The expanded list does not.

##### THE TWO ADDITIVES STATES MUST NOT COLLAPSE

| Stored | Means |
|---|---|
| `additives` **absent / null** | OFF has **no additives data**. Unknown. |
| `{count: 0, tags: [], names: []}` | OFF **positively reports none**. |

**These are different facts.** Both occur in real data and both were found:
a Quest bar has `additives_tags: null` (unknown); RXBAR and Nutella have `[]`
(positively none). Across the 2,300-product sample: **2.3–11% unknown** and
**5–41% positively none**, depending on category. Do not "tidy" the first into
the second.

##### Names come from OFF's taxonomy, and are never invented

The product record carries **bare codes only** — measured. Human names come from
OFF's taxonomy endpoint (`/api/v2/taxonomy?tagtype=additives&tags=en:e330`),
which returns `"E330 - Citric acid"`. OFF's string is kept **verbatim**;
reformatting it risks mangling names that legitimately contain a dash.

**Names are a convenience, not the fact.** The codes are what was looked up. A
taxonomy call that fails, times out or returns nothing leaves names `null` and
**never fails the lookup**. One call per lookup (the endpoint takes a
comma-separated list), only when there are additives, and only for codes not
already resolved. Resolved names are memoised **in memory for the process
only** — §13.6's "nothing cached to disk" still holds; additive names are static
reference data and re-asking on every lookup would be pure waste.

#### Storage

`extras` and `flags` are additive item fields alongside the §13.6 four.

- **Existing items lack both. Absence is the boundary — no migration, no
  backfill.** An item with all six extras blank stores **no `extras` key at
  all**, rather than six nulls.
- **A `PUT` leaves a key it does not mention alone**, the same rule the barcode
  fields follow — the plain Edit form sends no `flags`, and a PUT that wiped an
  item's additives because that form never heard of them would be the silent
  data loss already fixed once for `barcode` (§13.3).
- A present-but-unusable value is a **400**, not a silent null: negative
  caffeine, non-numeric caffeine, `novaGroup: 9` and a non-list `tags` all
  reject.

---

### 13.9 Deleting a library item — today is erased, history is not

**Built 2026-08-13, client only** (`js/pages/meals.js`). Ryan trims this list
often, and an item that lingered in the counter after a delete was the problem
this fixes. **No server change and no schema change** — `foods.py`, every
endpoint and every stored shape are untouched.

#### What a delete does, in order

| Step | Effect |
|---|---|
| 1. Confirm gate | A one-digit keypad naming the consequence (§13.9.2) |
| 2. `DELETE /api/foods/{id}` | **The server goes first, always** |
| 3. Server confirmed **or 404** | `delete d.foodCounts[today()][id]` — the entry goes entirely |
| 4. Mirror | Refreshed from the DELETE's own response body — or re-fetched, on the 404 path |

**SERVER FIRST IS THE LOAD-BEARING PART.** The server delete and the local erase
are two separate writes. **If the server delete fails, NEITHER happens** — the
message says plainly that nothing was deleted and that today's count is
unchanged (§1.7), exactly like every other library write on this page. Erasing
locally on a failed delete would leave the item in the library with its servings
silently gone from today's total, which is the worse of the two failure shapes.

#### 13.9.1 A DELETE IS IDEMPOTENT — 404 IS SUCCESS, NOT FAILURE

**Added 2026-08-13, after this bit Ryan for real.**

Server-first handles a server *refusal* correctly. It did **not** handle the
server deleting successfully and the **response being lost** — a Tailscale blip,
a backgrounded tab, a timeout. `requestJSON()` reports that as
`{ok:false, status:0}`, the client bailed before the erase, and the item was gone
from `foods.json` with today's count **stranded** in `d.foodCounts[today()]` as
an orphan (§8.0).

**And a retry could not fix it.** `DELETE /api/foods/{id}` raises
`FoodNotFound` → **404** for an id the library no longer has, the client read
that as failure too, and the count could never be cleared. *The code treated
reaching the goal state as an error.*

**THE RULE: a 404 on DELETE means the library does not contain that item, which
is exactly what the delete asked for. It is treated as success.** The local erase
proceeds identically. **Every other non-ok status is unchanged** — nothing
deleted, nothing erased, an honest message.

Two details that matter:

- **A 404 body carries no library snapshot**, so `adoptLibrary()` is not called
  with it. The library is **re-fetched** (`refreshLibrary()`, the same call the
  page open uses) and adopted from that.
- **If the re-fetch fails, the mirror is left alone and the message says so. The
  local erase is NOT undone.** A stale mirror is a display problem; re-stranding
  the count would put Ryan back in the state this path exists to get him out of.

The 404 path says something different from the clean one, because it happened
for a different reason: *"That food was already gone from the server. Today's
count has been cleared."*

#### 13.9.2 The confirm gate — the keypad, not `confirm()`

Delete used a native `confirm()`. It now uses an **in-page keypad gate** modelled
on the training pause gate (§9.2) and reusing its `.keypad-*` styles verbatim —
same reasoning §9.2 already records: a confirm sheet is one tap away from the
same accident, rendered right where the thumb is already travelling. Deliberate-
action protection, **not security**.

- **One digit, not three.** Pause and Start are one-way decisions about a
  12-week program; a food can be retyped in a minute. One digit stops a pocket
  mis-tap while staying quick enough that Ryan will still trim the list.
- **A fresh random digit every time it opens**, so the entry cannot become
  muscle memory.
- **The gate replaces the page while it is open** — the same reasoning the
  review card records (§13.7). It renders in the counter mount, which is the top
  of the page, so it is on screen whether Delete was tapped on an orphan row up
  there or a library row further down.
- **A wrong digit clears the entry, says so, and leaves the gate OPEN** with the
  same challenge. Cancel closes it. **Both write nothing, locally or on the
  server** — measured byte-identical.
- It states the consequence **before** the keypad: the item name, then the
  today's-count sentence when there is a count, then the earlier-days sentence.
  Same wording as the message the delete itself uses — one text, one place.

**There are now two keypad gates in two files** (`training.js`, `meals.js`).
§9.2 anticipated this and said to extract one to `js/components/` when a second
consumer appeared. **That extraction was deliberately NOT done here** — the two
differ in length, copy and commit action, and refactoring the gate that guards
the one-way "Start program" transition was out of scope for a delete fix. It is
the obvious next cleanup and is flagged, not forgotten.

#### 13.9.3 Orphan rows — shown when they count, never swept

An **orphan** is an id with a count today whose item is not in the mirror. After
§13.9.1 the honest causes are the 120-day purge, a delete on another browser, and
a delete whose response was lost.

| Rule | Why |
|---|---|
| An orphan **with servings** renders, marked, with **Delete** | Its macros are in today's total; without a Delete there is no way to clear it — the exact dead end §13.9.1 describes |
| An orphan **at 0** does not render | No macros, no library entry, nothing to act on — pure noise. **Its stored entry is left alone; not rendering is a display decision, not an erase** |
| A **library** item at 0 still renders | Different rule, and it stays (§8.0): the entry is kept so a same-day re-add cannot re-snapshot from an edited library |
| **ADD is disabled on an orphan row** | `mealAdd()` already refuses and explains; this stops the dead tap looking live. REMOVE stays enabled |
| The orphan's Delete is the **same** `mealDeleteFood()` | Same gate, same code path, same 404 handling. **There is no second delete path, no "clear" button, and there must not be one** |

##### ############ NEVER AUTO-ERASE AN ORPHAN ############

**No code may clear orphan counts automatically — not on load, not on render,
not after a fetch.** The mirror is a cache: with the server unreachable at boot
it can be stale or, on a fresh phone, **empty**, and then *every* counted item
reads as an orphan. An automatic sweep would silently destroy a real day's log
because Tailscale was flaky.

Every erase is a deliberate tap through the gate. Measured: opening the page with
the mirror force-emptied left `d.foodCounts` **byte-identical**; the only key a
page open writes is `foodLibraryFetchedAt`.

#### EARLIER DAYS ARE NOT TOUCHED — this is not negotiable

Only the `today()` key of `d.foodCounts` is read and only that key is written.
Every other date keeps its snapshots **byte for byte**, and their totals re-derive
to the same numbers forever. This is §13.5's snapshot rule and the whole reason
the 120-day purge is safe: **deleting an item today must never rewrite history.**

A loop over `d.foodCounts`, or anything that finds an id across dates, is the
change that breaks this. There is no such loop and there must not be one.

**The purge does not erase counts either.** It is server-side and the client is
not involved (§13.5); a purged item that somehow still has a count today keeps
that count and renders as an orphan row (§8.0). Only an explicit delete erases.

#### An entry at 0 is erased too

A count that drops to 0 normally **keeps** its entry and snapshot, so a re-add
the same day cannot re-snapshot from a library edited in between (§8.0). On a
delete that reasoning is spent: the item is gone from the library, so there is
nothing to re-add, and a re-created item gets a **new server-side id** anyway.

#### Re-adding starts fresh — no resurrection, no tombstone

Saving the product again — by hand, or by looking the same barcode up — creates
a **new library item with a new id**, so it appears in the counter at **0 for
today**. The erased count does not come back and nothing records that it ever
existed. Nothing here should ever add a tombstone.

#### The gate names the consequence

With a count of 3 today:

> **Delete "Monster Energy 16oz"?**
>
> Today you have counted 3 of these. Deleting erases today's 3 logged servings
> and their macros from today's total.
>
> Earlier days are not affected — every day already counted keeps its own record
> exactly as it is.
>
> Type this number to delete it.  **7**

**At a count of 0 the first sentence is simply absent** — there is nothing extra
to say, so nothing extra is said.

#### Measured

A 3-count delete against a **real server** (an isolated copy of `app.py` +
`foods.py` on a throwaway port, its own `foods.json`): today's counted macros
moved by exactly three servings (carbs 186→24, sugar 175→13, calories 840→210,
sodium 1370→260, servings 4→1); `d.foodCounts` changed on **one date only**,
today's; the other nine dates in a 10-date spread had **byte-identical** macros,
caffeine/additive figures and scores; today's score moved 47→60, entirely the
diet pillar (10→60) reacting to the erased sugar.

**The lost-response bug, reproduced end to end:** the item was deleted from
`foods.json` out of band, the page reopened, and it appeared as an orphan row
with its count of 1, ADD disabled, Delete present. Deleting it drew a real
**404** from the real server, which the new path treated as success: the count
cleared, the message read *"That food was already gone from the server. Today's
count has been cleared,"* and the earlier day holding the same item stayed
**byte-identical**.

**With the server stopped**, a delete of a library item and of an orphan both
left `metracker_v2` **byte-identical** (first differing index −1), the mirror
untouched and the message honest. A wrong digit and Cancel likewise wrote
nothing.

---

### 13.10 The counter is today-only, and the per-item history is kept on purpose

Two separate facts that a future session will be tempted to conflate.

**DISPLAY: the Meal Tracker shows today and only today.** The counter is built
from `today()` (§12, local civil day) — the same boundary as training's same-day
lock (§9.5). There is no date picker, no retroactive editing, and **no
earlier-day view of any kind** — not itemised, not a totals line. Earlier days
surface only as aggregates elsewhere: the Dietary page's four cards, the 30-day
macro chart (§8.3), the caffeine and additive chart (§8.4), and the score.

**STORAGE: every past day keeps its full per-item snapshots, indefinitely.**
`d.foodCounts[date][id]` — count, name, serving text, macros, `extras`, `flags` —
is retained for every date, exactly as written on the day.

##### ############ DO NOT COLLAPSE STORAGE INTO DAILY TOTALS ############

**The per-item detail is retained deliberately so later analysis stays
possible.** "Which product drove that caffeine week" and "what did the day a
score dropped actually consist of" are answerable only from the items. A future
session that sees a today-only page and concludes the per-item history is dead
weight — replacing it with a stored daily total, purging old dates, or
"normalising" it — is destroying data that cannot be recovered, in exchange for
kilobytes. **Every day's totals are DERIVED at render time from the snapshots
(§1.3), never stored, never cached**, so re-deriving from the same snapshots
gives the same numbers forever. That property is what makes the retention
worth having.

##### An earlier-day totals line was specified but NOT built

A 2026-08-13 brief asked for earlier days to render "a totals line only, no item
rows". **That was not implemented, and the reason is recorded here so it is not
read as an omission:** there is no earlier-day view in the Meal Tracker to
collapse — the page has been today-only since it was built (§8.0), so the
described change had nothing to act on. Building one would be a **new screen**,
not a display rule, and it would need a date picker §8.0 explicitly rules out.
That is a decision for Ryan, not a session's judgment call.

### 13.11 Three views of one library — meal prep and usage frequency

Ryan's library has grown past the point where scrolling it to find the thing he
eats every morning is reasonable. So the counter (§8.0) now shows **the same
library three ways**, on one page, above the full list:

| Section | Membership | Order |
|---|---|---|
| **Most Commonly Used** | `useCount > 0`, top 9 | `useCount` descending, ties by name |
| **Meal Prep** | `mealPrep === true` | the library's own order |
| **Every food** | everything | unchanged |

##### ############ ALL THREE ARE DERIVED. THERE IS NO SECOND LIST ############

Nothing here is stored — not in `localStorage`, not on the server, not as an
ordering field on an item. Each section is a **pure function of one field over
the mirror**, recomputed on every render (§1.3), and **nothing can be manually
inserted into either shortlist**. A future session that adds a "pinned order",
a stored top-N, or a hand-sortable list has replaced a derivation with state
that can go stale and disagree with the data it claims to summarise.

##### ############ THE TWO SHORTLISTS NEVER READ EACH OTHER ############

`mostUsedItems()` reads `useCount` and nothing else. `mealPrepItems()` reads
`mealPrep` and nothing else. **Neither may reorder, promote into, exclude from,
or otherwise mutate the other, in either direction.** Using a meal-prep item
does not move it in Most Commonly Used; ticking the meal-prep box does not
either; a high use count pins nothing to Meal Prep. There is no shared state for
one to write into — that is the point, and it is what keeps "pinned by hand" and
"earned by use" from quietly becoming the same list.

**An item can appear in both. That is an overlap, not a merge** — a meal-prep
item Ryan eats daily belongs in both answers, and suppressing it from one
*because* it is in the other would be exactly the cross-list coupling this rule
forbids.

##### `useCount` is a signal, NOT a serving count

`mark_used()` bumps it on every ADD that reaches the server, alongside
`lastUsedAt`. **It counts pings that arrived, not servings eaten**, and the two
diverge every time Ryan counts a serving with Tailscale down. That is
acceptable *because it only orders a shortlist*. It is **not scored (§11)**, and
**nothing the client derives from `d.foodCounts` may read it** — the servings
are local data (§1.2) and remain the only authority on what was eaten.

**Absence is the boundary (§1.4), as everywhere else in §13.** Items predating
the counter have no `useCount` and **nothing backfills one** — there is no way
to know how often they were eaten before, and a `0` would claim "never". A newly
created item is not given one either (created is not used, the same reason
`lastUsedAt` starts null); the key appears on the first ADD. The first bump on
an old item writes `1`, not an estimate. That undercount self-corrects; an
invented starting number would not.

**Only `mark_used()` ever writes it.** `update_item()` deliberately excludes it
from its merge, so no edit form can be made to set it — an edit is not a use.

##### The meal-prep group

`mealPrep` (True or **absent — `False` is never stored**), plus
`mealPrepServings` and `mealPrepDays`, both strictly positive. Editable from the
Meal Tracker's add/edit form like any other additive group, merged with the same
"a key the payload does not mention is left alone" rule as the barcode fields —
so a save from the barcode review card, which knows nothing about meal prep,
cannot silently un-flag an item.

**Clearing the flag clears the two figures with it**, the same tie `flags` has
to a barcode: servings-per-batch on something Ryan does not batch-cook describes
nothing. **None of it is scored (§11)**; it decides one section's membership and
touches no macro, count or score.

### 13.12 One-time consumed — counted today, never saved

The review card (§13.7) carries a second button beside Save: **One-time**. For
the thing eaten once and never again — a birthday cake slice in the break room,
a sample, a petrol-station purchase. Saving those to the library means they sit
in the counter for four months until the purge (§13.5) notices, and Ryan has to
remember to delete each one.

| | Save to library | One-time |
|---|---|---|
| Snapshots into today's counts | on first ADD | **immediately, count 1** |
| Creates a server item | yes | **no — no request at all** |
| Persists past today | yes | **no** |
| Needs cleaning up later | eventually | **nothing to clean up** |

It writes **one entry into `d.foodCounts[today()]`**, built by the same
`snapshotMacros()` / `snapshotExtras()` / `snapshotFlags()` helpers a normal ADD
uses, so the entry is the same shape as every other and **every reader of
`d.foodCounts` treats it identically** — the Dietary score included, with no
special case anywhere. **It makes no network call whatsoever**: no POST, no
`/used` ping, no mirror change. Nothing persists beyond today's snapshot, which
is precisely why there is nothing to purge.

**It is gated on exactly the same condition as Save**, and that matters *more*
here, not less: a per-100g candidate with no serving size (§13.7) has blank
macros on the card, and unlike a bad library item there would be **no row to go
back and fix** — the snapshot is the only copy.

##### The `ot_` id prefix is the marker

The entry gets a local id — `ot_` + timestamp + random — that the server has
never issued and never will (it mints `fd_` + hex). **Nothing with this prefix
is ever sent to the server.** That prefix is what makes three things correct:

- **The `/used` ping is skipped.** Firing a request at an id we invented could
  only earn a 404, and a real 404 in the log would stop meaning anything.
- **The counter row says the truth.** A one-time entry has no library item *by
  design*, so it lands in the same "counted but not in the mirror" bucket as an
  orphan (§8.0) and must be told apart from one — they look identical in storage
  and mean opposite things. An orphan says "no longer in the library" and has
  ADD disabled; **a one-time row says so plainly and keeps ADD working**, because
  its entry and snapshot already exist and a second serving needs no lookup.
- **Delete is purely local.** `runDelete()` short-circuits before the DELETE:
  the server would answer 404, which that path reads as "already gone" and would
  report as such — telling Ryan about a server that was never involved (§1.7).

The stored entry also carries `oneTime: true`. That is not what the code keys
off — the id is — but it is what explains, months later, why a day has a count
with no library item behind it.

**"Add to Library" is unchanged.** One-time is an addition beside it, not a
replacement, and deliberately not the primary button: the library is still the
normal answer.

#### TWO ENTRY POINTS, ONE IMPLEMENTATION — added 2026-08-15

The button used to exist **only** on the barcode review card, which was
backwards. A scanned item *has* a barcode and is the easy case to keep
permanently. The thing that actually wants one-time treatment — a restaurant
plate, a homemade dish, something from a petrol station — **has no barcode at
all** and can only be reached through the manual Add-a-food form.

That form now carries the same button, styled `btn-secondary` exactly as the
card's is. **Both call `writeOneTimeEntry()` in `meals.js` and there is exactly
one copy of the snapshot logic.** The two callers read completely different
sources — the card reads the `scan` module state, the form reads its inputs
through `readForm()` — and each hands over a plain
`{name, servingText, macros, extras, flags}`. **Do not fork this.** Two copies
of a snapshot writer drift, and a drifted snapshot writes a day that no longer
matches every other day.

Everything above is unchanged for both: a fresh `newOneTimeId()`, a full
snapshot, **no server request of any kind**, no library item, no `useCount`
increment, and the same delete behaviour and wording.

##### The default name is `Manually Added Nutrients`

Ryan tracks **nutrients rather than foods**, so the common case must need no
typing. The field stays editable because several of these in one day would
otherwise be indistinguishable in the counter, and a blank name is **never**
blocked — it submits as the default.

**It is a PLACEHOLDER on the input, not a prefilled value, and that distinction
is load-bearing.** This form is also the Add-to-library form. A real value
sitting in that box would let a mistap on "Add to library" create a permanent
library item called "Manually Added Nutrients". A placeholder shows the same
words, needs the same zero typing, and cannot be submitted by the library path —
which still refuses a blank name. The placeholder is only shown in add mode; the
edit form keeps its own example text.

##### Two gates, and only two

- **At least one macro figure is required.** This is §13.12's existing reasoning
  applied to the new entry point: an entry with no numbers puts a serving on
  today's total carrying nothing, and unlike a bad library item there is no row
  to go back and fix — the snapshot is the only copy.
- **Not available while editing a library item.** In edit mode the form is bound
  to an existing item and its primary button reads "Save changes"; a one-time
  snapshot taken from a half-finished edit of a different food is incoherent, and
  the secondary slot is already that edit's Cancel.

A blank *name* is not a gate. Only the numbers are.

## 14. Dated targets — `d.targetHistory`

### The bug this fixes

`calcScore(ds)` read **`d.targets` — one undated object** — for every date it
was ever asked about. So **every historical day was graded against whatever the
goals happen to be right now.** Raise the protein target tonight and every past
day silently re-grades: a day that scored 92 in June becomes an 82, with no
record that anything changed and no way to recover the old number.

**This is precisely the failure the food-macro snapshot rule exists to prevent
(§13, §8.0):** a past day's numbers must be computed from what was true *then*,
never from a lookup in present-day state. The food library learned that lesson
in §13; the targets had not, and it was live until 2026-08-14.

### The rule: a change takes effect the NEXT day

`effectiveFrom` is **always the day after the save.** Ryan logs his measurements
in the evening; a target changed at 8pm must not retroactively re-grade the day
he has just finished living. **The day of the change is scored against the
targets that were already in force while he lived it.**

### Shape

```js
d.targetHistory = [
  { effectiveFrom:'2026-08-15', mode:'cut', calories:2250,
    protein:{min:175,max:190}, fat:{min:70,max:85}, saturatedFatMax:22,
    carbs:{min:180,max:220},
    sugarMax:35, fiber:{min:30,max:35}, sodiumMax:2300,
    potassium:3400, calcium:1000, iron:8, magnesium:420, zinc:11,
    caffeineMax:400, savedAt:'<UTC ISO>' }
]
```

`saturatedFatMax` is the **fourteenth** field and was added 2026-08-15, after
the other thirteen — **entries written before that date do not have the key at
all, and nothing backfills them.** See §14.4.

Sorted ascending by `effectiveFrom`. **Append-only: entries are never edited and
never deleted.** Editing one would re-grade the days it governed, which is the
bug above wearing a different hat. Two entries may legitimately share an
`effectiveFrom` (two saves the same day); `Array.sort` is stable, so the
**last-appended wins**, and both the resolver and the editor apply that same
rule.

`mode` is fixed to `'cut'`. There is deliberately **no maintain/cut toggle** —
one mode was asked for, and building the switch would be inventing a feature.

### `targetsFor(ds)` — `js/derive.js`

Returns the last entry whose `effectiveFrom <= ds`, or **`null` when `ds`
predates the first entry.**

**`null` is correct and callers must handle it.** It means *this day was never
governed by a target set* — **it does not mean the targets were zero.**
`calcScore()` falls back to the legacy `d.targets`, which is exactly what those
days were scored against when they were lived, so **no history moved when this
shipped** (§1.4).

### `d.targets` is not migrated, not deleted, not written

The legacy flat object stays exactly as it is. It still serves the Log page's
**sleep goal and Training Maxes**, and it is still the fallback above. **The
Targets panel never writes to it.** The boot-time schema guard backfills
`d.targetHistory` as an **empty array, never seeded from `d.targets`** —
stamping today's goals onto history as though they had always applied is the
bug, not the fix.

**Its NUTRITION fields are now READ-ONLY — nothing in the app edits them any
more, and nothing should (§14.3).**

### Scoring reads exactly what it read before

> **SUPERSEDED BY §14.1 (2026-08-14).** The two paragraphs below describe the
> formula as it stood the day dated targets shipped, and are kept as the record
> of what changed when. **A governed day is now graded by v2's six weighted
> nutrients.** Only days predating the first history entry still use the
> sugar-and-protein formula described here.

**The Dietary formula is unchanged.** It still reads **sugar and protein only**,
and the sugar thresholds are still the hardcoded 10/25 they have always been.
The single change is *where the protein goal comes from*: the dated set's
`protein.min` when the day was governed by one, the legacy flat target
otherwise.

**Sleep is not in the dated set.** `d.targetHistory` carries the fourteen
nutrition fields and no sleep goal, so the Sleep pillar still reads
`d.targets.sleep`. Inventing a dated sleep field would be building a schema that
was not asked for.

#### Whether the Dietary score should read MORE than sugar and protein is an OPEN DECISION FOR RYAN

> **ANSWERED 2026-08-14 — see §14.1.** Ryan decided it, and six nutrients are
> now scored. The paragraph below is the record of the question, not the current
> state. **The rule it states still binds: a future session must not expand or
> re-weight the Dietary formula on its own judgement.**

Eleven of the thirteen stored targets currently feed **nothing**. That is
deliberate: they are captured and displayed now, and what the score does with
them is a scoring change, which §11 protects. **A future session must not expand
the Dietary formula on its own judgement.**

### The Targets panel — Health Status

**Fourteen** editable rows since 2026-08-15 (§14.4), Target beside Today, in the
schema's order — `saturatedFatMax` sits directly under Fat rather than at the
end of the list, because the two are one decision read two ways and six
micronutrients between them would bury it. **Position is display order only;
nothing resolves a target by index.** Today's
actuals come from `dayMacros(today())` for the macros and from
`foodCountExtras(today())` for the six micronutrients. Since 2026-08-14 the
**band visual (§14.2) leads this section** and this editor sits below it.

**A micronutrient with no data renders `—`, never `0` and never a 0% bar**
(§1.7). Coverage of these six is poor — most Open Food Facts items carry none of
them — so a total is usually a **partial sum**, and each row says so:
`450 mg · 3 of 4 items`. `foodCountExtras()` gained an additive `coverage` key
for this; nothing existing changed.

**Seeding shows, it does not write.** On first render with an empty history the
form is prefilled with the starting values, but **nothing is stored until Save**
— until then `targetsFor()` still returns `null` and every day still falls back
to the legacy object.

#### Save is gated by a change preview, then a keypad

On Save the panel lists **every field that differs from the latest saved set**,
as `Protein 175–190 g → 180–195 g`, followed by:

> Takes effect 2026-08-15. Today is scored against your current targets.

Confirming requires typing a **one-digit challenge** on the same
`.pause-card`/`.keypad-*` gate the training pause uses (§9.2) — **not
`confirm()`**, for the reason §9.2 already records. Cancel and a wrong digit
both write nothing and leave the challenge in place.

**If no field changed, nothing is written and the panel says so** — an
append-only list that gained an identical row on every Save press would make
"when did this change" unanswerable.

**The editor diffs against the latest SAVED set, including one still pending.**
It deliberately does not use `targetsFor(today())`: because a save is always
effective tomorrow, a form rebuilt from what is *in force* would snap back to
the old numbers the instant Ryan saved — looking exactly as though the save had
been discarded — and the duplicate guard would then happily append a second
entry for the same `effectiveFrom`. Scoring is unaffected: `calcScore()` still
goes through `targetsFor()`, which still ignores anything dated later than the
day being scored. A pending set is labelled as not yet in force.

### 14.1 Dietary scoring v2 — six weighted nutrients

Until 2026-08-14 the Dietary pillar read **sugar and protein only**. It now
grades six nutrients against the target set that governed that day, resolved
through `targetsFor(ds)`.

#### §11 is not touched

**The four pillar weights stay at 25% each.** Everything in this section is
internal to the Dietary quarter — it changes what that quarter reads, not how
the four are combined. Do not confuse the two weightings.

#### The weights — they sum to exactly 100

| Nutrient | Weight | Shape | Target |
|---|---|---|---|
| Calories | 25 | band | set `calories` ±10% (2250 → 2025–2475) |
| Protein | 25 | floor | set `protein.min` (175 g), **no upper penalty** |
| Sodium | 15 | ceiling | set `sodiumMax` (2300 mg) |
| Sugar (total) | 15 | ceiling | set `sugarMax` (35 g) |
| Fiber | 10 | band | set `fiber.min`–`fiber.max` |
| Saturated fat | 10 | ceiling | set `saturatedFatMax`, **falling back to the 22 g constant on entries that predate the field (§14.4)** |
| Total fat | 0 | display only | set `fat.min`–`fat.max` |
| Carbs | 0 | display only | set `carbs.min`–`carbs.max` |

Bounds are read from **the day's own target set** wherever that set carries the
field, so a dated target change moves the grading with it. Two places where the
code and the schema do not line up, recorded rather than smoothed over:

- **Calories** are stored as one number; the band is derived as ±10%
  (`CALORIE_BAND_PCT` in `derive.js`).
- **Saturated fat had no field in §14's original thirteen-field target schema**
  — that schema predates the nutrient, and the ceiling was the bare constant
  `SATURATED_FAT_MAX_DEFAULT = 22` for one day. **Ryan took that decision on
  2026-08-15 and `saturatedFatMax` is a real dated field now (§14.4).** The
  constant survives as the fallback for entries written before it existed, and
  for nothing else.

#### Why carbs and total fat are unscored

**Carbs are the arithmetic residual of calories, protein and fat.** Scoring them
would count the same decision twice — once directly, once through the calories
band — so one choice could mark the day down twice. Total fat is display-only
for the same reason, with **saturated fat carrying the part of it that is
actually a health question** at weight 10.

**Both are still captured and still displayed.** Do not promote either into the
weighted sum without a reason recorded here, and do not drop their capture.

#### `gradeNutrient(value, {lo, hi})` — one function, three shapes

| Shape | Condition | Scores 100 when | Reaches 0 at |
|---|---|---|---|
| **band** | `lo` and `hi` both set | `lo <= v <= hi` | `lo x 0.5` below, `hi x 1.5` above |
| **floor** | `hi` absent | `v >= lo` | `lo x 0.5`. **No upper penalty at any value** |
| **ceiling** | `lo` absent | `v <= hi` | `hi x 1.5` |

Linear between. Clamped 0–100. **Rounded only at display**, so a weighted mean
is never assembled out of pre-rounded parts.

Verified boundaries: protein 250 g against a 175 g floor scores **100**, not a
penalty; 131.25 g scores 50; 87.5 g scores 0. Sodium 5,019 mg against a 2,300 mg
ceiling scores **0** — its zero point is 3,450.

**Returns `null`, not 0, for a value that is not a number**, and also when there
is no bound to grade against.

#### A null nutrient is DROPPED. An unlogged day is ZERO. These are opposites.

This is the part most likely to be misread later, so it is stated twice.

**A nutrient with no data for the day scores `null` and leaves BOTH the
numerator and the denominator.** The remaining weights renormalise to 100. A day
where sodium was never stated scores out of 85 points of weight, not out of 100
with a zero in it. Verified: a day meeting every target with sodium absent scores
**100 on a denominator of 85** — grading it 0 would have produced 85.

**A day with no food logged scores Dietary = 0.** Not null, not skipped, not
renormalised across the other three pillars. This matches the training rule
exactly (§9.5): **empty means it never happened.** Without it, an unlogged day
would score 100 on every ceiling and grade as a perfect diet for eating nothing.

> **A missing FIELD is missing information. A missing DAY is a missed
> behaviour.** The first is dropped; the second is zero.

**"No food logged" means no counted servings AND no legacy Log Meal entry.** A
day with legacy meals but no ADDs is *not* empty: it has real protein and sugar
figures, its unknown nutrients drop out under the rule above, and it scores on
what it actually knows. Zeroing it would punish Ryan for using the older form,
which is still live on the Dietary page.

#### Historical days keep the old method

Days predating `d.targetHistory[0].effectiveFrom` continue to fall back to
`d.targets` and continue to score on the **old sugar-and-protein formula**.
`targetsFor(ds)` returning `null` is the signal, and `dietaryDetail()` returns
`null` on exactly the same condition.

**Do not retro-apply v2.** Those days were lived against different goals under a
different rule, and re-grading them is the precise failure §14 exists to stop.
Verified: a day before the first entry still scores 60 on the old formula.

#### `saturatedFat`

A macro like any other (§13.2): **nullable, per serving, in grams.** Populated
from Open Food Facts `saturated-fat_100g` and scaled by **the same `factor`**
that §13.6's four cases already compute for every other macro — there is
deliberately no second conversion path for it.

**Never inferred as a fraction of total fat. Never backfilled.** Snapshots in
`d.foodCounts` written before 2026-08-14 have no `saturatedFat` key and keep it
that way; they read as "not known for that day", which is the truth.

`foodCountMacros()` gained an additive **`known`** map for this — true for a
field only when at least one counted item actually carried a figure. The total
alone cannot answer "zero or gap": it is `0` both when nothing was eaten and
when nothing stated the value. A **genuine measured 0 counts as known.**

#### KNOWN LIMITATION: sugar is scored on TOTAL sugar

**Whole fruit and added sugar are penalised identically.** A banana and a
spoonful of table sugar move the 35 g ceiling by the same amount.

This is a real and understood shortcoming, accepted because **Open Food Facts
carries `added-sugars` far too patchily to score on** — scoring a field absent
for most products would renormalise it away on exactly the days it mattered.

**An RXBar is the case that will expose it:** high total sugar, no added sugar,
and it grades as though the two were the same thing. Promoting added sugar to a
scored row is **a decision for Ryan** once coverage is good enough to judge —
not a change to make on a session's own judgment.

### 14.2 The target band visual — Health Status

Replaces the plain Target/Today list as the section's lead. It reads **the same
`dietaryDetail()` the score itself is built from** (§6.9's one-read-path rule),
so the ring and the Home score box cannot disagree.

- **Hero ring.** A 104px donut of the day's Dietary score, the score at 30px in
  the centre and `DIETARY` at 11px beneath. Arc length is the score.
- **One line of derived text** naming what cost the most and what held the score
  up — e.g. *"Sodium scored zero. Sugar and fiber carried the day."* Cost is
  **weighted**, so the sentence names what actually moved the number. It is
  derived every render and **nothing about it is hardcoded.** It also states the
  coverage when the score is standing on partial information.
- **Eight rows** in the table order above. The label line is name + weight
  suffix + today's actual, right-aligned and coloured by that row's score. The
  track is 14px tall, 3px radius, neutral. The **target zone** is a translucent
  green band; the **marker** is a 4px bar at the actual value.
- **Axis maximum** is `hi x 1.5` for ceilings and bands (the point the score
  reaches 0) and `lo x 2` for floors, which have no upper bound. The marker
  clamps at 100% and the value gains a caret so an off-scale
  reading is visible rather than silently pinned. The indicator is `▸`.
- **Colours are existing tokens only (§1.6):** `accent5` at 90+, `warn` 50–89,
  `danger` below 50, `muted` for the two unscored rows. The target zone is
  `accent5` at CSS opacity rather than a new translucent green literal — that is
  what keeps this inside §1.6.
- **The two unscored rows are grey and carry no weight suffix**, so they read as
  information rather than as a failed target.
- **A nutrient with no data shows an em-dash and NO MARKER AT ALL.** The target
  zone still renders, so the row reads "here is the target, no reading today".
  Drawing a marker at zero would assert a measurement of zero.
- **No interaction.** No tooltips, no tap-to-expand, no animation.

**The editor stays below the visual.** It is the only way targets get set, and
it covers the six micronutrients the eight-row visual does not show.

#### Three states, and the middle one is the day-one case

`dietaryDetail(today())` returning `null` means no dated set governs today.
There are two genuinely different reasons for that, and until 2026-08-15 they
rendered identically — as a plain text block, with no visual at all:

| State | What renders |
|---|---|
| A dated set is in force | The full visual: ring, score, eight rows, markers |
| **Nothing in force, but an entry is PENDING** | **The full visual in a PREVIEW state — zones, no markers, no score** |
| `d.targetHistory` is empty | The plain text block, unchanged |

**Why the preview exists.** A save is *always* effective tomorrow (§14), so on
the day Ryan first sets targets there is nothing in force — which means **the
band visual was guaranteed to be invisible on the day it shipped**, and on
everyone's first day, which is exactly when he would go looking for it.

**What it draws, and what it must never draw:**

- **All eight rows with their target zones**, read from the pending entry.
- **No markers on any row, and no score in the ring.** This is the load-bearing
  half. Today is **not** graded against these numbers — it is still on the
  previous targets — and a marker sitting inside or outside a green band would
  claim otherwise. Same reasoning as the em-dash rule above: drawing a position
  asserts a measurement.
- **The ring is an empty track with `—` in the centre**, never `0`. A zero is a
  score, and the worst one; the absence of a score is a different fact (§1.7).
- **One line of text:** *"Not in force until 2026-08-16. Today is scored on your
  previous targets."* **The date is read off the pending entry**, never
  hardcoded and never `tomorrowStr()` — a set saved days ago is still pending
  until its own date, and quoting "tomorrow" then would be wrong.

**Which entry is previewed:** the pending one that takes effect **first**, since
that is the set about to govern. Entries sharing an `effectiveFrom` resolve
**last-appended wins**, the same rule `targetsFor()` and the editor apply.

**The zones come from `derive.js`'s `dietTargetRows(t)`, not from geometry
re-derived in `health.js`.** That function returns the same row shape
`dietaryDetail()` does with `value`/`score` null throughout, so `bandRowHtml()`
draws it with no changes and the bounds logic stays in one place (§6.9). **It is
not a scoring path** and must never be treated as one: it answers "what do these
targets look like", never "how did this day do".

### 14.3 The flat nutrition target inputs were retired — 2026-08-15

**There were two places to set nutrition targets and only one of them worked.**

`index.html` carried the original flat inputs — `target-protein`, `target-fat`,
`target-carbs`, `target-sugar` on the Dietary page, and `ft-protein` on the
**drawer's Log Entry page** — all wired to `saveTargets()`, all writing to the
undated `d.targets`. **None of those writes reached `d.targetHistory`, so none
of them moved the v2 score.** Editing one changed a number on screen and changed
nothing else, which is worse than having no field at all (§1.7).

`target-carbs` was worse still: `saveTargets()` never had a carbs branch, so
**that input never persisted anything at any point in its life.**

#### What was removed

The five inputs, their four `.macro-suggest` siblings (§8.2), the
`suggest-basis` note that explained them, `renderMacroSuggestions()` in
`dietary.js`, the `target-*` value-loading loop in `renderDiet()`, the
`ft-protein` line in `initLogForms()`, and the now-unused `.macro-suggest` CSS.
A comment stands where each block was. The Dietary page's "Macro Targets"
section is now a single `.form-note` pointing at Health Status → Targets.

#### `d.targets` SURVIVES — and must never be re-exposed as an editing surface

- **§1.4 forbids deleting the key**, and it is not deleted.
- **Days predating `d.targetHistory[0].effectiveFrom` still score from it**
  through the pre-v2 path (§14.1). It is a **historical read path**, and the
  numbers in it are what those days were actually lived against.
- `dietary.js` still reads `targets.protein` / `.fat` / `.sugar` / `.carbs` for
  the four **progress bars** on the Dietary page. Reading is fine. Writing is
  what stopped.

**Putting a nutrition target input back on any page — even a disabled or
read-only one — re-creates the bug this removed.** A field showing numbers that
govern nothing is still misleading; that is why nothing replaced them.

#### What was deliberately NOT touched

- **`saveTargets()` is completely unchanged.** The sleep goal, the disabled fast
  goal and the four legacy Training Max inputs still call it, so the function is
  still load-bearing. Its lookups for the five removed ids are now no-ops — every
  one is guarded by `if(el&&el.value)` — and **they were left in place rather
  than pruned**, because touching that function for cosmetics risks the TM path
  §10.1 depends on.
- **`targets.sleep` and `targets.daily` are a separate concern and are out of
  scope.** Sleep is deliberately not in the dated set (§14), so the Log page's
  sleep goal is a **live, current setting** — not a legacy one. The fast goal
  stays disabled and labelled inactive per §7.1.

### 14.4 `saturatedFatMax` — the last undated ceiling, now dated

Saturated fat is scored at weight 10 (§14.1), but its 22 g ceiling lived in
`derive.js` as `SATURATED_FAT_MAX_DEFAULT`. **It was the only scored nutrient
whose target was a constant rather than a dated entry** — which reproduced, for
one row, exactly the bug §14 was built to eliminate: change the constant and
every historical day silently re-grades against the new value.

It is the **fourteenth field** in the entry shape, seeded at `22`, and
`gradeNutrient` reads its ceiling from `targetsFor(ds)` exactly as the other
five scored nutrients do. It participates in the existing next-day effective
rule and the existing keypad confirm gate — no new patterns were introduced.

#### ABSENCE IS THE BOUNDARY — no backfill, no epoch date

**Entries written before 2026-08-15 have no `saturatedFatMax` key and nothing
fills one in.** An entry **without** the key grades against the constant, which
is exactly what those days were scored against when they were lived; an entry
**with** it uses its own value. **The presence of the key is the whole test** —
the same rule `asleepMinutes` (§6.10) and the food snapshots' `saturatedFat`
(§14.1) already follow.

There is deliberately **no migration and no epoch constant** here. Do not add
either, and do not "tidy up" old entries by writing 22 into them: that would be
a rewrite of history dressed as consistency.

`SATURATED_FAT_MAX_DEFAULT` therefore **stays in `derive.js` permanently** and
is now exported, so the Targets panel's seed and its placeholder read the same
number the fallback uses and the two cannot drift.

#### What the editor shows for an entry that predates the field

The row's input is **blank, with `22` as a PLACEHOLDER** — a value Ryan can see
but has not set — plus a note saying it is graded against 22 g and why. A
placeholder is never submitted, so **opening the panel and pressing Save on an
untouched form still writes nothing**, and the duplicate guard is unaffected.
Filling it in produces a normal diff row: `Saturated fat max — → 18 g`.

#### The Today column reads `known`, not the bare total — ALL EIGHT ROWS

> **CLOSED 2026-08-15.** This was recorded here as open for one day: the
> saturated fat cell read `known` while the other seven printed a bare total, so
> the panel asserted "you ate 0 g of fiber" and "we don't know your saturated
> fat" side by side. The first claim was false. All eight rows read `known` now
> and the per-row `useKnown` opt-in is gone.

`dayMacros()` returns `0` for a macro nothing counted today stated, so a bare
read prints `0 g` — a measurement of zero, which is a different and much worse
claim than "nothing you counted said" (§1.7). The rows consult
`dayMacros().known` and show `—` instead, matching the band visual directly
above them.

**A genuine measured `0` still renders `0`.** Black coffee really does have 0 g
of protein, and `known` is true for a field an item actually stated as zero. The
distinction preserved is **"stated as zero" versus "never stated"** — never
collapse the two.

Verified: a day with no counted items reads `—` across all eight; a day counting
only black coffee reads `0 g` for protein and `—` for fiber and saturated fat,
which that item does not state. **Display only — `calcScore()` and
`dietaryDetail()` were untouched**, and both already used `known`.

#### Three more instances of the same coercion — OPEN, deliberately not fixed here

The grep that closed the item above found the same "0 means absent" collapse in
three other places. They are recorded rather than fixed, because each changes
what an existing screen displays and that is Ryan's call, not a drive-by edit
during a different job. **This is the fourth-and-following instances of a bug
class this project keeps producing; the honest read is that any new code
printing a macro total should consult `known` from the start.**

| Where | What it claims | Why it is wrong |
|---|---|---|
| `dietary.js` — the four "Today's Macros" cards | `0` for protein / fat / carbs / sugar on a day nothing was logged | Reads `dayMacros()` totals directly. An unlogged day renders four confident zeroes with progress bars at 0%. |
| `dietary.js` — the sugar-damage banner | "No sugar — HGH protected ✓" on a day nothing was logged | Keys off `ts===0`. This is the **strongest** of the three: it awards a green tick for a day with no food record at all. |
| `meals.js` — the combined-total sentence under the Meal Tracker totals | `protein 0g · fat 0g · …` | The card three lines above it already reads `known` correctly; only this trailing sentence does not. |

A fourth, related but distinct: **`health.js`'s Driving Factors "Sugar today"
row** shows `0g` with a **good** dot on an unlogged day, and separately reads
`d.meals` alone — so it ignores counted servings entirely. That second half is a
**§6.9 two-read-path problem**, not just a display coercion, and is the more
serious of the two faults.
