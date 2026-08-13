# Me-Tracker — Handoff

**Purpose:** ARCHITECTURE.md records *what* was decided. This records *why*,
what was tried and rejected, and what remains. Read both.

Written 2026-08-11. Ryan is not a programmer — explain findings plainly.

---

## 1. Where the project actually stands

**Built and working:**
- Full client: Home, Training, Dietary, Vitals, Fasting, Health Status,
  Personal Records, Calendar, Log Entry.
- Server on the Alienware R5 (FastAPI, 127.0.0.1:8123), served over Tailscale
  at `https://desktop-1g38tar.tail865703.ts.net`.
- Google Health API sync — OAuth, pagination, daily aggregation, nightly at
  04:15. Real data flowing.
- Scoring across four pillars at 25% each.
- Export/import backup.

**Built but unproven:**
- Boot persistence. The scheduled task has a 30s delay and retry loop but
  **has never survived a real reboot test**. Use *Restart*, not shutdown —
  Fast Startup (hiberboot) is enabled and is a documented cause of
  `AtStartup` triggers not firing.
- `/api/health` returning `secrets_readable: true` under a genuine boot
  launch. Under SYSTEM, `Path.home()` resolves to the system profile, not
  `C:\Users\Ryan`. `METRACKER_SECRETS_DIR` is set in the launcher to
  compensate — that fix has never run in the conditions it was written for.

**Built since this file was written (2026-08-12 / 08-13):**
- The food rotation checklist — the Meal Tracker page and the server-owned food
  library (ARCHITECTURE.md §8.0, §13).
- Barcode lookup (`server/barcode.py`) — Open Food Facts, **typed digits only**,
  with a review-before-save card (ARCHITECTURE.md §13.6, §13.7).

**Not built:**
- Ollama vision (`server/vision.py`) — plate photos and label OCR.
- **Camera/live barcode scanning. This is deliberately not "the next small
  step" on the barcode work** — ARCHITECTURE.md §13.6 records why a vision
  model must never decode a barcode: a misread digit returns a different
  product's macros with full confidence, silently.

---

## 2. Decisions that were reversed, and why

A future session that doesn't know these will re-propose the rejected option.

**"Silence = compliance" was retired as a single global rule.** It never
applied uniformly and the phrase caused confusion. What exists now is four
separate per-pillar rules:

- **Training — checkboxes are the record.** Tick what you did. Half the boxes
  is half compliance.
  **UPDATED 2026-08-12 — the nuance below was reversed.** It used to read: "a
  day never touched at all still scores by the schedule fallback, because
  forgetting to log is not the same as not training." That is no longer true.
  **Empty checkboxes now mean it did not happen, full stop** — an untouched
  day scores 0, exactly like a touched-and-emptied one. Ryan decided the
  distinction was doing more harm than good: it meant the app scored him for
  sessions it had no evidence of. The trade he accepted is that the pillar now
  measures "did I train *and log it the same day*", and a day is editable only
  on the day itself. `touched` is still stored (it drives the frozen pre-epoch
  scoring path) but no longer changes anything going forward.
  See ARCHITECTURE.md §9.5.
- **Fasting — assumed held.** Only the Fail button drops it. Binary.
- **Sleep — 7h assumed** when no data; the API overrides.
- **Dietary — nothing assumed.** Macros count only when supplied.

Do not collapse these back into one rule, and do not describe the app as
"silence = compliance" — that framing is retired.

**Per-exercise checkboxes exist because a commercial gym produces genuine
partial completion** (equipment in use, time ran out) that day-level logging
cannot express. Training only.

**Hosting moved from GitHub Pages to Tailscale.** The PIN gate existed
because the app was on a public URL. Once hosting moved, the PIN guarded
nothing and was removed. Do not restore it.

**Storage stayed in localStorage.** Considered moving to a server database
when the server was added. Rejected: this is a consistency tracker, not a
system of record, and the server is a sidecar. Do not "upgrade" it.

**1RM replaced direct TM entry.** TM is derived at `1RM × 0.85`. All
percentages read from TM. **This is a safety constraint** — applying a
percentage to a raw 1RM makes every working weight ~18% heavy.

**Fasting protocol has now been cut back twice.** First rewrite: the original
36hr Fri→Sun crossed two barbell days, so it became daily 18:6 plus a weekly
24hr on the rest day plus a 48hr on deload weeks 4 and 8, and the quarterly
60–72hr was dropped.
**2026-08-12: cut again, to intermittent fasting only.** Daily 18:6
(12:30–18:30), every day, no variation by weekday or program week. The weekly
24hr and the 48hr deload are both gone, along with `isDeloadFastWeek()`, the
never-in-week-12 rule and the paused-program `week: null` edge case that only
existed to serve the deload check.
**Three extended fasts have now been removed across three decisions. Do not
reintroduce any of them** (ARCHITECTURE.md §7). Fasting *scoring* was left
alone deliberately — still binary, still assumed-held, still only the Fail
button drops it.

**Karvonen over %MHR for heart rate zones.** %MHR put Zone 2 at 106–124 bpm;
Karvonen puts it at 131–143. Training at the lower band builds little aerobic
base. If a future session "corrects" this back, that is drift.

**"Not started" was added as a state distinct from "paused."** A paused
program still displayed "Week 2 of 12" for a program never begun. Three
states now: not started, running, paused.

---

## 3. Bugs found, and the pattern behind them

**Three separate UTC date bugs.** `toISOString()` in `today()` filed evening
entries a day ahead (7pm in winter, 8pm in summer). A third copy lurked in
`calendar.js`. Then the same class of bug appeared server-side in
`_bucket_by_day()`, where UTC timestamps put evening activity on the wrong
day — producing *different totals* for the same date depending on whether it
was fetched singly or in a range.

**The pattern: any code that derives a calendar day from a timestamp is
suspect.** Always local civil day. On the server, prefer Google's own
`civilStartTime`/`civilEndTime` — but note those are *not* populated for
`exercise` or `sleep` despite the schema declaring them, so those two compute
locally from the UTC offset.

**The black screen.** Two causes stacked. `index.html` had no cache headers
at all (the middleware only covered `.js`/`.css`), so phones served a stale
shell indefinitely without revalidating. And `prompt()` in the PIN gate can
*hang* rather than throw on iOS in standalone mode, blocking render before
anything paints. Both fixed.

**PowerShell BOM stripping.** Editing `.ps1` files removed their UTF-8 BOM,
causing Windows to read them in cp1252. An em dash inside a string then
decoded into a smart quote, which PowerShell's parser treats as a string
terminator — silently corrupting the script. Keep the BOM; keep em dashes out
of string literals in those files.

**Google Health API filter grammar.** The first real sync 400'd on every data
type. The authoritative source is the discovery document at
`https://health.googleapis.com/$discovery/rest?version=v4` — not the
narrative docs, which are incomplete. Numeric fields arrive as JSON *strings*.

---

## 4. Working method that has been effective

- **Discuss before prompting.** Design questions get settled in conversation,
  then a single well-scoped prompt goes to Claude Code. Prompts that skip
  this produce work that needs redoing.
- **Measure, don't assert.** Several confident claims — including from the
  planning side — turned out wrong when checked. Pause did *not* score 0.
  Deviations were *not* set elsewhere. The correct move each time was for CC
  to verify current behaviour before changing it.
- **Every prompt ends with: report what you could NOT verify.** This has
  surfaced more real issues than the verification itself.
- **One task per prompt, one commit per step.** Makes a bad change reviewable
  and revertable.
- **CC cannot restart the SYSTEM-owned server.** It tests on a throwaway port
  and Ryan restarts via elevated PowerShell.

---

## 5. Next up

**Immediate:**
1. **Reboot test.** Restart (not shutdown), wait 90s, load the URL untouched.
   Check `/api/health` for `secrets_readable: true`. Read
   `server/logs/boot.log` either way.
2. ~~**Remove the "Completed" deviation button.**~~ **SUPERSEDED 2026-08-12 —
   done, and then some.** The whole deviation tray is gone, not just the
   Completed button: all five types, the swap panel, both write functions and
   the five card banners. Per-exercise checkboxes are the entire record of a
   training day now. `d.deviations` is still stored and still read by the
   frozen pre-epoch scoring path; nothing writes it. See ARCHITECTURE.md §9.6.

**Specified, not built — manual long-fast button:**

Ryan wants a way to mark a longer fast completed by hand — something like a
**"Completed a 24-hour fast"** button. This is wanted *because* the scheduled
protocol shrank to daily 18:6 only on 2026-08-12 (ARCHITECTURE.md §7): the
weekly 24hr and the 48hr deload are no longer scheduled, so an extended fast
Ryan actually does has no place to be recorded as such.

**Deliberately NOT built in the 2026-08-12 session.** Do not build it without
talking to Ryan first — the open questions are what it writes (a new additive
top-level key? an entry in `d.fasts`?) and whether it affects the fasting
score, which is currently binary and must stay that way unless Ryan says
otherwise (§7.1). Note the Log Entry page's fast-type `<select>` already
offers 24h / 36h / 48h and still works; this would be a one-tap version of
something that is currently a small form.

**Food rotation checklist — BUILT 2026-08-12/13.** The specification below is
kept as the record of what was asked for; ARCHITECTURE.md §8.0, §13, §13.6 and
§13.7 describe what actually exists. Barcode capture is built (typed digits);
label OCR is not.

Ryan eats from a fixed rotation. A checklist of those foods with known macros
bypasses vision entirely for everyday meals — exact numbers, not estimates.

- Checklist of saved foods; tick what was eaten, quantities sum into the
  day's macros.
- Add / edit / delete.
- **Capture happens once, at save time.** Ryan supplies a barcode and/or a
  photo of the nutrition panel; the server extracts macros and serving size.
  After that the item is reused forever with no camera involved.
- **Serving size comes off the package label** — it is printed there. No unit
  system to design; store the label's own serving text plus a quantity
  multiplier.
- **Unpackaged staples** (eggs, produce) use one representative brand's
  numbers as a standing approximation. Natural variance exceeds anything a
  vision estimate would add. Label these as approximate.
- Order of attempt for capture: barcode → Open Food Facts, then label OCR.
  Deterministic before inference, always.
- Store additively as a new top-level key.

**Then — vision and barcode:**
- Ollama `minicpm-v:latest` shares VRAM with a trading bot. **Jobs run
  20:30–03:55 only.** Photos upload immediately, queue server-side, macros
  appear next morning. Do not add a "process now" button.
- Photos delete on confirmation or a 48-hour timer, whichever comes first.
- Confidence tiers: `exact` (barcode), `high` (label OCR), `low` (plate
  estimate). Low-confidence sugar scores as a range, not a point value.

**Known open items:**
- Fitbit → Google Health sync history is patchy: steady 2021–2024, a ~20
  month gap, choppy May–July 2026, steady from July 30. Backfill covered
  2026-05-17 onward only; the full 2021+ history exists if ever wanted.
- Weight, body fat and VO2 max return zero rows — likely not logged, or the
  Versa 2 isn't reporting Cardio Fitness. Left null, not fabricated.
- The `<select>` in the deviation swap panel is 40px, under the 44pt minimum.
  Pre-existing global style, app-wide.
- Nothing has ever been visually reviewed on the iPhone by anyone other than
  Ryan. CC measures pixel dimensions; it cannot see.

---

## 6. Constraints that are not negotiable

- Vanilla JS, ES modules, no framework, no build step, no npm.
- `metracker_v2` schema is additive-only. Never rename, retype, or remove.
- Derive at render time; store only what cannot be recomputed.
- All colour from `styles/tokens.css`. Chart.js configs are the documented
  exception (canvas cannot resolve `var()`).
- Secrets live in `C:\Users\Ryan\.metracker\`, outside the repo. Never read,
  print, log, or move them.
- Estimates are visually distinct from measurements. Hormone indices are
  behavioural correlations, never clinical values.
- Mobile-first: 393pt screen, 44pt minimum tap targets.
