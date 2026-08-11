// ---------------------------------------------------------------------------
// components/vitals-header.js — Live HR, HR zone, today's steps.
//
// ARCHITECTURE.md §4 pins this to the top of the Main Page, and §9 pins the
// SAME component to the top of the Training page. One renderer, mounted twice
// by container id — not two copies that drift apart.
//
// DATA SOURCE: server/google_health.py via api.js's synchronous in-memory
// cache (§6) — see getCachedVitals()/cacheStatus() in api.js. This function
// stays fully synchronous on purpose, exactly like every other renderer in
// the app; app.js primes the cache once at boot (and can re-prime after a
// sync) and calls this again once that resolves. Nothing here ever awaits a
// fetch itself.
//
// FALLBACK RULE (§1.7, §4): if the server has never been reached, or has no
// reading for today, every value renders as the em-dash placeholder — NEVER
// a stale number presented as current. There is no cache of "yesterday's
// live HR" standing in for today's; a missing value stays missing.
//
// ZONE is Karvonen (§5): tanakaMaxHR(age) and weeklyRestingHR() in derive.js,
// never a %MHR formula, never a hardcoded resting HR. Age has no other home
// in the schema and is entered on the Health Status page (d.body.age); with
// no age on file the zone can't be computed and stays a placeholder too —
// never guessed.
// ---------------------------------------------------------------------------

import { getCachedVitals, cacheStatus } from '../api.js';
import { today } from '../util.js';
import { currentZone, karvonenZones, getAge } from '../derive.js';

const PLACEHOLDER = '—';

export function renderVitalsHeader(containerId){
  const el = document.getElementById(containerId);
  if(!el) return;

  const ds = today();
  const v = getCachedVitals(ds);
  const status = cacheStatus();

  const hr = (v && v.latestHR && +v.latestHR.bpm > 0) ? Math.round(+v.latestHR.bpm) : null;
  const zTable = karvonenZones(ds);              // null only if age or resting HR is unknown
  const zone = hr!=null ? currentZone(hr, ds) : null; // null if zTable is null, OR hr is below Zone 1
  const steps = (v && +v.steps >= 0 && v.steps !== null) ? Math.round(+v.steps) : null;

  const liveCls = ' vh-live';
  const hrHtml = hr!=null ? `<span class="${liveCls.trim()}">${hr}</span>` : PLACEHOLDER;
  const zoneVal = zone ? `<span class="${liveCls.trim()}">Z${zone.stage}</span>` : (zTable ? '<Z1' : PLACEHOLDER);
  const zoneUnit = zone ? zone.name : (zTable ? 'Below zone 1' : 'Karvonen');
  const stepsHtml = steps!=null ? `<span class="${liveCls.trim()}">${steps.toLocaleString()}</span>` : PLACEHOLDER;

  let note;
  if(!status.primed && !v) note = 'Connecting to server…';
  else if(!v) note = 'Awaiting sync — no data yet for today';
  else if(hr==null) note = 'Synced, but no heart-rate reading yet today';
  else if(!zTable && getAge()==null) note = 'Set your age on Health Status to see your zone';
  else if(!zTable) note = 'Resting HR not yet known — zone unavailable';
  else if(!zone) note = 'Resting — below Zone 1';
  else note = 'Live as of last sync';

  el.innerHTML =
    `<div class="vitals-header" aria-label="Live vitals">` +
      `<div class="vh-item">` +
        `<div class="vh-label">Heart Rate</div>` +
        `<div class="vh-value">${hrHtml}</div>` +
        `<div class="vh-unit">bpm</div>` +
      `</div>` +
      `<div class="vh-item">` +
        `<div class="vh-label">Zone</div>` +
        `<div class="vh-value">${zoneVal}</div>` +
        `<div class="vh-unit">${zoneUnit}</div>` +
      `</div>` +
      `<div class="vh-item">` +
        `<div class="vh-label">Steps</div>` +
        `<div class="vh-value">${stepsHtml}</div>` +
        `<div class="vh-unit">today</div>` +
      `</div>` +
      `<div class="vh-note">${note}</div>` +
    `</div>`;
}
