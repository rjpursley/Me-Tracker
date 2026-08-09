// ---------------------------------------------------------------------------
// components/vitals-header.js — Live HR, HR zone, today's steps.
//
// ARCHITECTURE.md §4 pins this to the top of the Main Page, and §9 pins the
// SAME component to the top of the Training page. One renderer, mounted twice
// by container id — not two copies that drift apart.
//
// Listed in the ARCHITECTURE.md §3 tree under js/components/. It lives outside
// pages/ precisely because it belongs to no single page. It imports nothing, so
// it cannot participate in an import cycle.
//
// ---------------------------------------------------------------------------
// NO DATA SOURCE EXISTS YET.
//
// Every value renders as an em-dash placeholder. There is no server (§3), no
// Google Health sync (§6), and therefore no live HR, no resting HR, and no step
// count. Do NOT fill these with sample numbers to "see how it looks" — a fake
// bpm on a health console is indistinguishable from a real one at a glance, and
// §1.7 requires estimates to be visually distinct from measurements. A number
// with no source is worse than an estimate.
//
// The component deliberately stays visible rather than hiding until data
// arrives, so the gap is obvious rather than silent.
//
// WHEN THE SERVER LANDS: the zone is Karvonen off heart-rate reserve (§5), and
// restingHR comes from dailyRestingHeartRate via the API, recalculated weekly.
// It is never hardcoded. Do not substitute a %MHR formula.
// ---------------------------------------------------------------------------

const PLACEHOLDER = '—';

export function renderVitalsHeader(containerId){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML =
    `<div class="vitals-header" aria-label="Live vitals, not yet connected">` +
      `<div class="vh-item">` +
        `<div class="vh-label">Heart Rate</div>` +
        `<div class="vh-value">${PLACEHOLDER}</div>` +
        `<div class="vh-unit">bpm</div>` +
      `</div>` +
      `<div class="vh-item">` +
        `<div class="vh-label">Zone</div>` +
        `<div class="vh-value">${PLACEHOLDER}</div>` +
        `<div class="vh-unit">Karvonen</div>` +
      `</div>` +
      `<div class="vh-item">` +
        `<div class="vh-label">Steps</div>` +
        `<div class="vh-value">${PLACEHOLDER}</div>` +
        `<div class="vh-unit">today</div>` +
      `</div>` +
      `<div class="vh-note">Awaiting sync — no data source connected yet</div>` +
    `</div>`;
}
