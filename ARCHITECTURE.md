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
The governing intent is unchanged: no log for a day means the plan was followed.
Do not add "did you do X today?" prompts. Do not default anything to incomplete.
**Taps are spent on deviations, not confirmations.**

What that means differs per pillar, so state it per pillar rather than as one
rule. Each pillar has its own default and its own controls:

| Pillar   | Unlogged day | Control |
|----------|--------------|---------|
| Fasting  | Assumed held — scores 100 | Fasting Fail button (§7.1). **No pause exists.** |
| Sleep    | 7h assumed | API overrides the assumption once it lands (§6) |
| Training | Assumed done — schedule fallback | Per-exercise checkboxes (§9.4), **pausable** (§9.1). Full rules in §9.5 |
| Dietary  | Nothing assumed | Macros count only when supplied |

- **Fasting.** The fast is assumed to have held unless the Fail button is
  pressed. Unlogged scores 100; only a `fastDeviations` record marking the day
  broken drops it to 0. Binary, per §7.1 — no hours-completed grading.
- **Sleep.** 7h is assumed when there is no data. The API overrides that
  assumption; it does not compete with it.
- **Training.** A day nobody touched is assumed to have happened and scores by
  the schedule fallback. Once a checkbox is tapped the day is scored on what was
  actually ticked. Pausable — see §9.1. **Full rules in §9.5.**
- **Dietary.** Nothing is assumed. Macros are counted only when supplied,
  because there is no defensible default for food that wasn't logged.

**Pause is training only.** Pausing holds the 12-week program clock and touches
nothing else — fasting, sleep and dietary scoring carry on unchanged. **There is
no global pause and must not be one.** Each pillar gets its own control with its
own ruleset; a single switch that suspended everything would make the number
mean "Ryan wasn't measuring" rather than "Ryan wasn't doing it."

**Scoped exception — training only.** Per-exercise checkboxes exist (§9.4)
because a commercial gym produces genuine partial completion (equipment in use,
time ran out). Checkboxes are **unchecked-but-counted-as-done by default**: an
untouched day still scores as full compliance. Ticking records what was
accomplished — and once a day has been touched at all, it is scored on the
ticks. This exception does not extend to fasting, sleep, or diet.

**Deviation notes are deprecated.** The free-text note on a training deviation
is no longer written. Notes already in storage are **preserved and still
rendered** — §1.4 forbids deleting the field. The Fasting Fail note (§7.1) is a
different control and stays.

**The deviation control lives on the Training page, next to the exercise
checkboxes — not on Home.** The "Log a Deviation" tray was removed from Home in
one session and restored here in the next, because that is where Ryan already
is when recording what actually happened in a session. It is **the only UI in
the app that writes `d.deviations`** — `calendar.js` only reads them, and Home
carries no deviation control of any kind. `setDeviation()` and `saveSwap()`
still live in `home.js` (they redraw Home's own containers when called), but
Training's `trainingSetDeviation()` / `trainingSaveSwap()` are what's actually
wired to a tap, calling those two directly and then refreshing Training's own
prescription card and tray. Same five types, same stored shape, no note input.
It operates on `getSelectedDate()` — the Home day strip's selection — so
retroactive marking works the same way retroactive checkbox ticking does: pick
a day on Home's strip, then act on it from Training.

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

**One deliberate third level: Training → Personal Records** (§10.1). It is the
only one, and it was a choice between two rules. The drawer was the natural home
for a rarely-used logging page, but §11 protects drawer structure; 1RMs are
training data, so they sit behind Training. Logging a tested max happens roughly
once per 12-week cycle, so burying it one level deeper costs nothing daily.
**This is not a licence to nest further.** If a third level is ever wanted
again, that is a conversation with Ryan.

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

**The protocol below replaced the original 18:6 / 36hr Fri–Sun / quarterly
60–72hr scheme. The quarterly 60–72hr fast was removed entirely — do not
reintroduce it.**

| Fast | When | Window |
|---|---|---|
| Daily 18:6 | every day | eat **12:30–18:30** local, fast the rest |
| Weekly 24hr | every Saturday | **Sat 18:30 → Sun 18:30** |
| Deload 48hr | **program weeks 4 and 8 only** | **Fri 18:30 → Sun 18:30** |

**No extended fast in week 12.** Week 12 is the test week, and you never test a
1RM off a fast. Week 12 keeps the weekly 24hr and gets no 48hr. The check is
written explicitly in `isDeloadFastWeek()` even though 12 is not in
`DELOAD_WEEKS`, so the rule is visible in code rather than an accident of the
array's contents.

**Paused: the weekly 24hr runs, the 48hr never does.** While the program is
dormant there is no program week (§9.1), so "is this week 4?" has no answer.
`isDeloadFastWeek()` returns `false` when paused and `fastPlan()` reports
`week: null`. It must not throw and must not silently pick a week.

`PROGRAM_START` is a Monday, so a program week runs Mon–Sun — the Friday,
Saturday and Sunday of one 48hr window always share the same program week. No
window straddles a boundary.

### 7.0 Where the protocol lives
The schedule is `fastPlan(date)` in `derive.js`, returning
`{kind, protocol, headline, detail, week, paused}` with `kind` one of
`daily` / `weekly24` / `deload48`. It is pure derivation (§1.3).

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
prescription card (today's, or the selected day's — see §9.6) with a checkbox
per exercise, and the deviation control (§9.6).

**Training scoring is defined in §9.5.** That section is the authority; if the
code disagrees with it, the code is wrong.

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

**While paused, a non-rest day scores by the paused branch in §9.5** — API
activity only, checkboxes ignored. Since the API check is stubbed, that means
**0 today**. There is deliberately **no neutral or excluded state**.

*Historical note, so the record is straight:* an earlier revision of this file
implied pause already forced training to 0. It never did. Before §9.5 landed,
pause had **no effect whatsoever** on the training score — a paused Monday
scored 100 exactly like a running one, because `getWorkoutForDate()` assumed the
scheduled session regardless. Pause only ever moved the week number. The paused
branch in §9.5 is what actually connects the two.

### 9.2 Pause confirmation gate — built

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

The gate lives in `pages/training.js` because pause is the only thing that uses
it today. If a second pillar ever needs one, extract it to `js/components/` then
— not before.

### 9.3 Not yet built

- A live data source for the vitals header and for §9.5's activity check. Both
  wait on the server (§3) and the Google Health sync (§6).

### 9.4 Per-exercise checkboxes — built

One checkbox per exercise, grouped by block (warm-up → giant set → assistance →
finisher), matching `{name, equip, detail, block}` in `schedule.js`.

- **Retroactive ticking is allowed with no time limit.** Any date the app can
  render a prescription card for can be edited.
- The checkboxes live **inside the shared prescription card**, which appears on
  both Home and the Training page. Both now render whichever date the Home day
  strip has selected — Training switched from a hardcoded `today()` to
  `getSelectedDate()` when the deviation control needed the same date the
  checkboxes already use (§9.6). The Home day strip *is* the date picker for
  retroactive edits — do not build a second one. The click handler is given the
  date the card was rendered for, never `today()`.
- **Stored as `d.exerciseLogs{}`**, keyed by date:
  `{ touched: true, checked: ["Goblet Squat", ...] }`
- Exercises are stored **by name, not by index**, so reordering `schedule.js`
  cannot silently re-point a tick at a different movement. Only names still on
  that day's card are counted, so a renamed or removed exercise is ignored
  rather than inflating the total.

**`touched` and `checked` are two different facts.** This is the part that is
easy to get silently wrong:

| Stored state | Meaning | Score |
|---|---|---|
| no record | the day was never opened | assumed done — schedule fallback |
| `{touched:true, checked:[]}` | the day was worked, nothing got done | **0** |

Both render as a card with every box empty. Tick a box and untick it and
`touched` **stays true** — the day does not revert to assumed-done. Do not
"simplify" this by inferring `touched` from `checked.length`.

### 9.5 Training scoring — built

**Rest days are unaffected by all of this.** Checkboxes, pause and API activity
are skipped entirely and the original schedule fallback applies (a rest day
scores 80).

**Program active, non-rest day:**

| Case | Score |
|---|---|
| **Marked `missed`** | **0 — outranks everything below** |
| Never touched | assume the session happened — schedule fallback, unchanged |
| Touched | `(checked / total) * 100` |
| Started API activity that day | **+50** |
| — | **capped at 100** |

**A `missed` deviation forces the pillar to 0 regardless of checkbox state.**
Saying "I missed this session" is a direct statement about the day; ticks are
just the residue of tapping through a card. Without this rule, marking a day
Missed *and* ticking every box scored 100, which is nonsense.

This applies to **`missed` only**. The other deviation types are unchanged:
`swapped` still scores by the category swapped to, and
`completed` / `skipped` / `makeup` do not override the boxes. An untouched
missed day already scored 0 through the fallback, so that case did not move.

Worked examples on a 12-exercise day: all boxes = 100. Touched with zero boxes
and no activity = 0. Half the boxes, no activity = 50. Half the boxes plus an
activity = 100. Zero boxes plus an activity = 50.

**Program paused, non-rest day:**

- **Checkboxes are ignored entirely.**
- Any started API activity = **100**. No activity = **0**.

The schedule fallback is the original category table — Resistance/HIIT 100,
Zone 2/Bodyweight 85, Weighted Walk 70, Mobility 60, Active Rest 80 on a rest
day and 60 otherwise, and 0 for a day with a `missed` deviation.

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

**The check is stubbed.** `hasStartedActivity()` in `derive.js` returns `false`
unconditionally, with a TODO naming the Google Health server task (§6) that will
implement it. It is deliberately **not** stubbed with sample data — a fabricated
activity on a health console is worse than no number (§1.7). It should query
sessions/activities with an explicit start, **not** heart-rate samples.

Because it is always false today, **paused days score 0 for training**. That is
expected and accepted. Do not build a neutral or excluded state to hide it.

### 9.6 Deviation control — built, lives here

**This is the only UI in the app that writes `d.deviations`.** It sits on the
Training page, alongside the exercise checkboxes — not on Home. `calendar.js`
only reads deviations; it has no control of its own, and neither does Home.

- Same five types as before it moved — `completed`, `missed`, `swapped`,
  `makeup`, `skipped` — and the same stored shape:
  `d.deviations[date] = {type, swap?, timestamp}`. No note input; deviation
  notes are deprecated (§1.1).
- `setDeviation()` and `saveSwap()` still live in `home.js` and are called
  directly, unmodified, from `pages/training.js` — they were already correct
  and there was no reason to duplicate them. They only know how to redraw
  Home's own containers, though, so `trainingSetDeviation()` /
  `trainingSaveSwap()` wrap them to also refresh Training's prescription card
  and the tray itself.
- Tapping the already-active type clears the deviation (existing toggle
  behaviour in `setDeviation()`, unchanged) — a day marked Missed returns to
  its checkbox ratio, or to the schedule fallback if it was never touched.
- **Operates on `getSelectedDate()`, the same "selected date" the Home day
  strip sets and the checkboxes already render against** (§9.4). Retroactive
  marking works exactly like retroactive ticking: pick a day on Home's strip,
  then act on it from Training. Setting a deviation on one date does not touch
  any other date's score.

*History, so the record stays straight:* the tray originally lived on Home. A
session that cleaned up the Home page removed it without giving the write path
anywhere else to live, which meant nothing in the app could set a deviation by
tapping — flagged at the time as an open gap, not a design decision. This
section replaces that gap note now that the control has a home.

---

## 10. Health Status

- **Manual:** height, bodyweight, waist circumference, tested 1RMs (§10.1).
- **Auto from API:** body fat %, VO2 max, HRV.
- **Derived:** 7-day rolling bodyweight trend, Training Max (§10.1), relative
  strength (each Training Max ÷ bodyweight).

**VO2 max is available from the Versa 2.** Fitbit calls it **Cardio Fitness
Score**, which is why a search for "VO2 max" in their docs comes up empty — the
metric is there under a marketing name. Keep it as a trackable field awaiting
sync. It renders as an em-dash under "Awaiting Sync" until §6 lands. Do not drop
it on the assumption the hardware cannot produce it.

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

- PIN gate logic
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
