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

### 1.1 Silence = compliance
No log for a day means the plan was followed. The app scores an unlogged day as
fully adherent. Do not add "did you do X today?" prompts. Do not default
anything to incomplete. **Taps are spent on deviations, not confirmations.**

**Scoped exception — training only.** Per-exercise checkboxes exist on the
Training page because a commercial gym produces genuine partial completion
(equipment in use, time ran out). Checkboxes are **unchecked-but-counted-as-done
by default**. Ticking records what was accomplished; an untouched day still
scores as full compliance. This exception does not extend to fasting, sleep, or
diet.

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

- Serve with `tailscale serve` — **not** Funnel. Funnel exposes to the public
  internet, which defeats the point. Serve gives HTTPS with a valid certificate
  at `https://alienware.<tailnet>.ts.net`, which iOS Safari needs for a secure
  context.
- Client and API are same-origin. **No CORS, no preflight, no proxy shim.**
- No deploy step. Edit, refresh the phone.
- If Tailscale is off or the machine is down, the app is unreachable. Accepted.

### 2.1 The localStorage origin trap — read before any hosting change
localStorage is scoped to the origin. Data saved under `rjpursley.github.io` is
**invisible** from `alienware.<tailnet>.ts.net`. Not deleted — unreachable.

Therefore **export/import must exist before any origin change**:
- Export: dump `metracker_v2` to a downloadable JSON file.
- Import: load that file back.

This doubles as the backup against iOS evicting site data from
infrequently-visited sites, which it does. Build it early; it is cheap.

### 2.2 The PIN gate
Keep it. Its job changed: it now guards against someone picking up an unlocked
phone, not against someone finding a public URL. It was never real security and
is not claimed to be.

---

## 3. Repo structure

```
Me-Tracker/
├── index.html              # Shell only: PIN gate, topbar, drawer, page mounts
├── ARCHITECTURE.md         # This file
├── .gitignore              # Covers client_secret*.json, env.txt, *.env, etc.
│
├── styles/
│   ├── tokens.css          # :root variables. THE only place colors are defined
│   ├── base.css            # Reset, typography, layout primitives
│   └── components.css      # Cards, bars, keypad, day-strip, checkboxes
│
├── js/
│   ├── store.js            # metracker_v2 read/write, export/import. Schema owner
│   ├── schedule.js         # SCHEDULE, PROGRESSION, PROGRAM_START constants
│   ├── derive.js           # Scoring, program week, HR zones, averages
│   ├── api.js              # Calls to the local server. All fetch() lives here
│   └── pages/
│       ├── home.js
│       ├── training.js
│       ├── dietary.js
│       ├── vitals.js       # Sleep / HR / Steps
│       ├── fasting.js
│       └── health.js       # Health Status
│
├── server/                 # Runs on the Alienware, also serves the client
│   ├── app.py              # FastAPI. Binds the Tailscale interface only
│   ├── google_health.py    # OAuth refresh, paginated pulls, aggregation
│   ├── vision.py           # Ollama minicpm-v job queue
│   ├── barcode.py          # Open Food Facts lookup
│   └── requirements.txt
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

Vitals keeps **3 days of history maximum** on screen. Longer ranges exist only
as graphs and averages, not as scrollable detail.

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

**Why Karvonen:** plain %MHR put Zone 2 at 106–124 bpm; Karvonen puts it near
133–144. Training at the lower band builds little aerobic base. If a future
session "corrects" this back to %MHR, that is drift, not a fix.

**Known artifact:** the legacy Tuesday note hardcodes "120–145 bpm". It is close
to Karvonen output by coincidence, not derived. Replace it with the computed
zone; do not preserve it.

---

## 6. Google Health API

Replaces the Fitbit Web API (deprecated September 2026). Google OAuth 2.0.
The Fitbit account is already migrated to Google sign-in. Integration is
validated and pulling real data.

**Credentials live in `.metracker/` only.** Three values: client ID, client
secret, refresh token.

**Consent screen stays in Testing status** with Ryan as a Test User. This grants
restricted scopes without the production review queue. Refresh tokens for
unverified apps expire periodically; re-running consent is expected maintenance,
not a bug.

### Two rules that silently corrupt data if ignored

1. **Always follow `nextPageToken`.** Responses cap at 5,000 samples; one day of
   5-second HR is roughly 8,700. A sync that ignores pagination returns partial
   days that look complete.

2. **Aggregate on ingest; the browser gets summaries only.** Store per day:
   resting HR, minutes per HR zone, workout avg/peak HR, sleep stage totals,
   steps, weight. Raw intraday samples stay server-side and are discarded after
   about 7 days. At a few hundred bytes per day this is roughly 100KB/year in
   localStorage — trivial against the ~5MB budget.

---

## 7. Fasting

Protocol is hardcoded: **18:6 daily, 36hr Fri–Sun, quarterly 60–72hr.**
Timer and phase logic are not to be touched without explicit instruction.

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

---

## 9. Training page

- Per-exercise checkboxes grouped by block (warm-up → giant set → assistance →
  finisher), matching `{name, equip, detail, block}` in `schedule.js`.
- Live HR + zone + steps pinned at top (same component as Main Page).
- **Program pause** writes to `d.programPauses[]`, an additive array of
  `{start, end}`. `programWeek(date)` subtracts elapsed paused days before
  dividing.
- **Pause confirmation gate:** a random 3-digit challenge renders above a numeric
  keypad with a cancel button. Pause executes only on exact match. This is
  deliberate-action protection, not security. Do not simplify it to a confirm
  dialog.
- **The program is currently paused.** The console functions fully while paused;
  Training shows the program dormant rather than advancing weeks.

---

## 10. Health Status

- **Manual:** height, bodyweight, waist circumference.
- **Auto from API:** body fat %, VO2 max, HRV.
- **Derived:** 7-day rolling bodyweight trend, relative strength (each Training
  Max ÷ bodyweight).

**Bodyweight displays as the 7-day rolling average, not the daily value.** Daily
weight is mostly water and produces misleading noise.

Hormone indices (HGH, Testosterone, Cortisol Pressure) are **behavioral
correlations, not medical claims**, and must always be labeled as such. Never
present a clinical value.

---

## 11. Do not touch without explicit instruction

- PIN gate logic
- Drawer structure
- `metracker_v2` schema (additive keys only)
- Fasting timer and phase logic
- Scoring weights — 25% each: fasting, sleep, training, diet
- Supplement list — Himalayan salt, CoQ-10, Magnesium Threonate

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
- Never read, print, or copy the contents of the secrets files.
