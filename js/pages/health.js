// ---------------------------------------------------------------------------
// pages/health.js — Health Status: body measurements, driving factors, phase.
//
// ############ THE HORMONE INDICES WERE DELETED (2026-08-14) ############
//
// This page used to headline three cards — HGH, Test, Cortisol — computed by
// derive.js's calcHGH/calcTest/calcCortisol. They are gone, along with the
// "Estimates from behavioral data only" banner that tried to make them safe.
// See the block comment where they used to live in derive.js, and §10: there
// was never a criterion variable, so nothing about them could be checked. DO
// NOT REINTRODUCE THEM WITHOUT REAL LAB DATA.
//
// The Driving Factors card SURVIVED the deletion and now stands on its own. It
// was always the honest half: five plainly-labelled behavioural facts with a
// good/bad dot each, no arithmetic pretending to be a measurement. Its
// container id is still `hgh-factors` — legacy, deliberately NOT renamed
// (§1.4 applies to DOM ids other code references just as it does to schema
// keys; index.html and this file are the only two places it appears).
//
// BUILT (§10): manual height / age / bodyweight / waist entry, the 7-day
// rolling bodyweight trend, and dated blood-pressure / SpO2 / pulse records
// (§10.2). Age lives here (d.body.age) because it has no other home in the
// schema and Karvonen zones (§5, derive.js) need it.
//
// HRV comes from the Google Health API via api.js's cache (getCachedVitals()),
// read for today's date, and renders as a cell in the Body summary. An absent
// reading is an em-dash, never a zero (§1.7) — a Versa 2 frequently produces
// no HRV figure for a night, and that is "no reading", not a measured 0.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
// dateStr/addDays went with the indices — the only thing that needed them here
// was the 7-day workout window calcTest()/calcCortisol() consumed.
import { today, esc } from '../util.js';
import { getSleepForDate, calcFastHrs, getWorkoutForDate, getPhase,
         rollingBodyweight, latestWaist, BODYWEIGHT_WINDOW_DAYS } from '../derive.js';
import { getCachedVitals, triggerSync, fetchSyncStatus, primeRecentVitals } from '../api.js';
import { renderVitalsHeader } from '../components/vitals-header.js';
import { renderHome } from './home.js';

// ---------------------------------------------------------------------------
// Body composition — ARCHITECTURE.md §10.
//
// Measurements live under the additive d.body key:
//   d.body = { height: '71', weights: [{date, lbs}], waists: [{date, inches}] }
// No existing key is read or written by any of this.
// ---------------------------------------------------------------------------

// ############ FOUR CELLS, 2x2 — NOT FOUR ACROSS ############
//
// The grid is 1fr 1fr, deliberately. At 393pt a four-column row leaves each
// cell about 85px wide, which crushes a two-digit value and its unit onto
// separate lines and truncates the sub-label. Two columns of two is the layout
// that actually fits the phone this app is built for (§1.5).
//
// HRV joined this card when the "Awaiting Sync" panel was deleted (2026-08-14).
// Body fat and VO2 max went with that panel: NO CONNECTED DEVICE WRITES THEM.
// Ryan wears a Versa 2 and owns no smart scale, so both were permanently null
// and the panel could only ever render two em-dashes under a heading promising
// they were on their way. That is not honest reporting, it is furniture. If a
// smart scale is ever added, body fat comes back as a real field.
function renderBodySummary(){
  const body=db().body||{};
  const rb=rollingBodyweight();
  const waist=latestWaist();
  const v=getCachedVitals(today());
  const weightSub = rb.avg!=null
    ? rb.count+' weigh-in'+(rb.count===1?'':'s')+' · '+BODYWEIGHT_WINDOW_DAYS+'-day avg'
    : (rb.latest ? 'none in last '+BODYWEIGHT_WINDOW_DAYS+' days · last '+rb.latest.date : 'not logged yet');
  const cells=[
    {label:'Bodyweight', val: rb.avg!=null?rb.avg.toFixed(1):'—', unit:'lbs', sub:weightSub},
    {label:'Height',     val: body.height?String(+body.height):'—', unit:'in', sub: body.height?'manual entry':'not set'},
    {label:'Waist',      val: waist?String(+waist.inches):'—',      unit:'in', sub: waist?waist.date:'not logged yet'},
    // '—' WHEN NULL, NEVER 0 (§1.7). A Versa 2 frequently produces no HRV
    // reading for a night — that is "no reading", not a measurement of zero
    // milliseconds, and the sub-label says which of the two this is.
    {label:'HRV',        val: v&&v.hrv!=null?String(v.hrv):'—',     unit:'ms', sub: v&&v.hrv!=null?'synced '+v.date:'no reading'}
  ];
  document.getElementById('body-summary').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
    cells.map(c=>`<div class="card" style="text-align:center;padding:12px"><div class="card-title" style="margin-bottom:4px">${c.label}</div><div class="stat-big" style="font-size:26px">${c.val}</div><div class="stat-sub">${c.unit}</div><div class="stat-sub" style="font-size:10px;margin-top:4px">${c.sub}</div></div>`).join('') +
    '</div>';
}

// ---------------------------------------------------------------------------
// Sync now — ARCHITECTURE.md §6.3.
//
// WHY THIS PAGE: `triggerSync()` and `fetchVitalsDay()` had been exported from
// api.js since §6 was built and were called by nothing — the server could sync
// but the app could not ask it to. This control sits directly under the
// "Awaiting Sync" panel because that panel is the thing that goes stale, and
// this is what fixes it. (The drawer was the alternative and was rejected: the
// drawer is navigation plus backup/restore, and a sync button there would be
// invisible from the page whose numbers it refreshes.)
//
// THREE RULES, all of them §1.7 in spirit — never imply data is fresher than
// it is:
//   1. A failure says so, plainly, and says the numbers did not change.
//   2. "Server data last written" reports the SERVER's own last write
//      (GET /api/sync/status's lastWriteUtc), not when this browser last
//      fetched. It answers "how old is this data" honestly even when the sync
//      button has never been pressed.
//   3. A sync in flight disables the button, so a double-tap cannot fire two
//      overlapping pulls. `busy` is checked as well, because a disabled
//      attribute is a UI state and this is the guarantee (same defence-in-depth
//      pattern as toggleExercise()'s lock, §9.4).
// ---------------------------------------------------------------------------

// Module state, deliberately not stored: an in-flight sync must not survive a
// reload, and a result message is about one button press.
let syncBusy = false;
let syncMsg = null;        // {text, kind:'info'|'err'|'success'}
let syncStatus = null;     // last {lastWriteUtc, daysStored} seen, or null

function lastWrittenLabel(){
  if(!syncStatus || !syncStatus.lastWriteUtc) return 'unknown — the server has not answered';
  const t = new Date(syncStatus.lastWriteUtc);
  if(isNaN(t.getTime())) return 'unknown';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  let rel;
  if(mins < 1) rel = 'just now';
  else if(mins < 60) rel = mins + ' min ago';
  else if(mins < 1440) rel = Math.round(mins / 60) + ' hr ago';
  else rel = Math.round(mins / 1440) + ' day' + (Math.round(mins / 1440) === 1 ? '' : 's') + ' ago';
  // Local time, per §12 — the server hands back a UTC instant and the phone
  // renders it where Ryan is standing.
  return t.toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) + ' · ' + rel;
}

export function renderSyncPanel(){
  const el = document.getElementById('sync-panel');
  if(!el) return;
  const cls = syncMsg ? ('alert ' + (syncMsg.kind === 'success' ? 'success' : syncMsg.kind === 'err' ? 'err' : 'info')) : '';
  const stored = syncStatus && syncStatus.daysStored != null
    ? syncStatus.daysStored + ' day' + (syncStatus.daysStored === 1 ? '' : 's') + ' stored on the server'
    : '';
  el.innerHTML =
    '<div class="card">' +
      `<button class="btn btn-primary" onclick="runSync()"${syncBusy ? ' disabled' : ''}>` +
        (syncBusy ? 'Syncing…' : 'Sync now') +
      '</button>' +
      (syncMsg ? `<div class="${cls}" style="margin-top:10px">${esc(syncMsg.text)}</div>` : '') +
      `<div class="form-note">Server data last written: ${esc(lastWrittenLabel())}</div>` +
      (stored ? `<div class="form-note">${esc(stored)}</div>` : '') +
    '</div>';
}

// Fire-and-forget: the panel renders immediately with whatever is known and
// updates when the server answers. Never throws (api.js's contract).
function refreshSyncStatus(){
  return fetchSyncStatus().then(function(s){
    syncStatus = s;
    renderSyncPanel();
    return s;
  });
}

export async function runSync(){
  if(syncBusy) return;                       // the guarantee, not just the disabled attribute
  syncBusy = true;
  syncMsg = {text:'Syncing with Google Health…', kind:'info'};
  renderSyncPanel();

  const res = await triggerSync();            // no dates: this primes explicitly below
  if(!res){
    // Server down, Tailscale off, or a non-200. Say so and say the numbers on
    // screen did not change — never leave a stale reading looking fresh.
    syncBusy = false;
    syncMsg = {text:'Sync failed — the server did not answer. Nothing on this screen has changed.', kind:'err'};
    renderSyncPanel();
    return;
  }

  const primed = await primeRecentVitals();
  await refreshSyncStatus();
  syncBusy = false;

  const days = (res.daysWritten || []).length;
  if(res.errors && res.errors.length){
    syncMsg = {text:'Sync finished with ' + res.errors.length + ' problem' +
                    (res.errors.length === 1 ? '' : 's') + ': ' + res.errors[0], kind:'err'};
  }else if(!primed){
    syncMsg = {text:'The server synced, but this app could not re-read the data. Reload to be sure.', kind:'err'};
  }else{
    syncMsg = {text:'Synced ' + days + ' day' + (days === 1 ? '' : 's') +
                    (res.start && res.end ? ' (' + res.start + ' to ' + res.end + ')' : '') + '.', kind:'success'};
  }

  // Re-render off the refreshed cache so the new numbers are on screen without
  // a reload. renderHome() re-does the score box, the day strip and the home
  // vitals header; the Training header is the only other mounted consumer.
  renderHome();
  renderVitalsHeader('vitals-header-training');
  renderHealth();
}

// renderRelativeStrength() MOVED TO pages/prs.js, 2026-08-14 — it reads derived
// Training Maxes, which is that page's subject, not this one's (§10.1).
// rollingBodyweight() is still imported here: renderBodySummary() uses it.

export function saveBodyHeight(){
  const d=db();d.body=d.body||{};
  const h=document.getElementById('health-height').value;
  if(h!=='')d.body.height=h;
  save(d);renderHealth();
}

// Age has no other home in the schema (§6, §5 in ARCHITECTURE.md) — stored
// additively as d.body.age, alongside height. Needed for the Karvonen zone's
// Tanaka maxHR term (derive.js's tanakaMaxHR()/getAge()); with no age on file
// the live vitals header's Zone value stays a placeholder rather than guess.
export function saveBodyAge(){
  const d=db();d.body=d.body||{};
  const a=document.getElementById('health-age').value;
  if(a!=='')d.body.age=a;
  save(d);renderHealth();
}

// ---------------------------------------------------------------------------
// Blood pressure, SpO2 and pulse — ARCHITECTURE.md §10.2.
//
// Stored additively under d.body.vitals, a new key beside weights/waists:
//   d.body.vitals = [{date, systolic, diastolic, spo2, pulse}]
//
// ############ THE APP DOES NOT INTERPRET THESE ############
//
// No hypertension staging, no normal/elevated/high label, no colour by
// threshold, and NOTHING HERE FEEDS A SCORE (§11 — the four pillar weights are
// untouched by this whole feature). Blood pressure staging is a clinical
// judgement that depends on context this app does not have — posture, cuff
// size, time of day, medication, what the reading was last month. Printing
// "Stage 1 Hypertension" under a number would be exactly the overclaim the
// hormone indices were deleted for. Store the numbers; show the numbers.
//
// ############ EVERY FIELD IS INDEPENDENTLY NULLABLE ############
//
// Ryan may take BP without the oximeter or the other way round. An absent field
// is OMITTED FROM THE RECORD — not written as null, not written as 0 (§1.4,
// §1.7). A record with no non-null field is not saved at all.
//
// ONE RECORD PER DATE. Re-saving the same date REPLACES that record rather than
// appending a second — unlike weights/waists, which append by design. These are
// point-in-time readings Ryan takes once in the evening, and two rows for one
// date would leave "the latest reading" ambiguous.
// ---------------------------------------------------------------------------

// A value is a typo, not a measurement, when it lands outside these. Rejected
// loudly rather than stored — a mistyped 1280/82 that got saved would sit in
// the history forever looking like something that happened.
const VITAL_RANGES={
  systolic: {min:60,  max:260, label:'Systolic',  unit:'mmHg'},
  diastolic:{min:30,  max:160, label:'Diastolic', unit:'mmHg'},
  spo2:     {min:50,  max:100, label:'SpO₂',      unit:'%'},
  pulse:    {min:25,  max:220, label:'Pulse',     unit:'bpm'}
};
const VITAL_KEYS=Object.keys(VITAL_RANGES);

// The most recent record by date, or null. Sorted here rather than assuming the
// array is ordered — records are keyed by a date Ryan types, so they can be
// entered out of order.
function latestBodyVitals(){
  const list=((db().body||{}).vitals)||[];
  const clean=list.filter(r=>r&&r.date);
  if(!clean.length)return null;
  return clean.slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)[0];
}

function renderBodyVitals(){
  const el=document.getElementById('body-vitals-latest');
  if(!el)return;
  const r=latestBodyVitals();
  if(!r){
    el.innerHTML='<div class="card"><div class="form-note">No blood pressure, SpO₂ or pulse logged yet. '+
                 'Add one below — every field is optional.</div></div>';
    return;
  }
  // A field the record does not carry renders '—'. NEVER 0, and never a
  // borrowed value from an older record: this card reports one reading.
  const cells=VITAL_KEYS.map(k=>{
    const m=VITAL_RANGES[k];
    const v=r[k];
    const has=(v!==null&&v!==undefined&&v!=='');
    return `<div class="card" style="text-align:center;padding:12px">`+
      `<div class="card-title" style="margin-bottom:4px">${m.label}</div>`+
      `<div class="stat-big" style="font-size:26px">${has?esc(String(v)):'—'}</div>`+
      `<div class="stat-sub">${m.unit}</div>`+
      `<div class="stat-sub" style="font-size:10px;margin-top:4px">${has?'logged':'not taken'}</div>`+
    `</div>`;
  }).join('');
  el.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+cells+'</div>'+
    `<div class="form-note">Reading from ${esc(r.date)}. These are recorded and shown only — `+
    `the app does not interpret them and they do not affect any score.</div>`;
}

export function logBodyMeasurement(){
  const w=document.getElementById('health-weight').value;
  const wa=document.getElementById('health-waist').value;

  // Read and validate the four new fields BEFORE writing anything, so a typo in
  // the pulse box cannot leave a bodyweight half-saved. Same all-or-nothing
  // shape the library writes on the Meal Tracker use (§1.7).
  const vitals={};
  for(const k of VITAL_KEYS){
    const el=document.getElementById('health-'+k);
    const raw=((el&&el.value)||'').trim();
    if(raw==='')continue;                       // absent, not zero — omitted below
    const num=Number(raw);
    const m=VITAL_RANGES[k];
    if(!isFinite(num)){
      alert(m.label+' must be a number.');return;
    }
    if(num<m.min||num>m.max){
      // SAY WHAT WAS EXPECTED AND SAY NOTHING WAS SAVED. A value this far out is
      // a typo; storing it would corrupt the history silently.
      alert(m.label+' of '+raw+' '+m.unit+' is outside the plausible range ('+
            m.min+'–'+m.max+' '+m.unit+'). Nothing was saved — check the number.');
      return;
    }
    vitals[k]=num;
  }
  const anyVital=VITAL_KEYS.some(k=>k in vitals);

  if(!w&&!wa&&!anyVital){alert('Enter a bodyweight, a waist measurement, or a blood pressure / SpO₂ / pulse reading');return;}

  const d=db();
  d.body=d.body||{};d.body.weights=d.body.weights||[];d.body.waists=d.body.waists||[];
  const date=document.getElementById('health-measure-date').value||today();
  // UNCHANGED. Weights and waists still append exactly as before.
  if(w)d.body.weights.push({date,lbs:w});
  if(wa)d.body.waists.push({date,inches:wa});

  if(anyVital){
    if(!Array.isArray(d.body.vitals))d.body.vitals=[];
    // ONE RECORD PER DATE — replace in place if this date already has one.
    // Only the fields actually entered are written; the rest are simply not
    // keys on the record (§1.4).
    const rec={date,...vitals};
    const i=d.body.vitals.findIndex(r=>r&&r.date===date);
    if(i>=0)d.body.vitals[i]=rec;else d.body.vitals.push(rec);
  }

  save(d);
  document.getElementById('health-weight').value='';
  document.getElementById('health-waist').value='';
  VITAL_KEYS.forEach(k=>{const el=document.getElementById('health-'+k);if(el)el.value='';});
  alert('Measurement saved!');
  renderHealth();
}

export function renderHealth(){
  renderBodySummary();renderBodyVitals();
  // Paint the panel from what is already known, then ask the server for a
  // fresher answer — same placeholder-then-update pattern the vitals header
  // uses (§9.3), never a number before there is a source for it.
  renderSyncPanel();
  refreshSyncStatus();
  const bodyNow=db().body||{};
  const hEl=document.getElementById('health-height');if(hEl&&bodyNow.height)hEl.value=bodyNow.height;
  const ageEl=document.getElementById('health-age');if(ageEl&&bodyNow.age)ageEl.value=bodyNow.age;
  const dEl=document.getElementById('health-measure-date');if(dEl&&!dEl.value)dEl.value=today();
  const d=db(),t=today();const sl=getSleepForDate(t);const todayFasts=d.fasts.filter(f=>f.date===t);const fastHrs=d.activeFast?calcFastHrs({start:d.activeFast.start,date:d.activeFast.date}):(todayFasts.length?Math.max(...todayFasts.map(calcFastHrs)):0);const w=getWorkoutForDate(t);const meals=d.meals.filter(m=>m.date===t);const sugar=meals.reduce((a,m)=>a+(+m.sugar||0),0);
  // FIVE ROWS, NOT SIX. The Cortisol row went with the indices — it was the one
  // entry here whose value came from a computation rather than from a logged
  // fact, and it read 'Moderate'/'High' off thresholds on an unvalidated score.
  // THE OTHER FIVE THRESHOLDS ARE UNCHANGED, deliberately: they are the same
  // behavioural facts, judged the same way, and this deletion is not the place
  // to re-tune them.
  const factors=[{name:'Deep sleep',val:(+(sl&&sl.deep)||0).toFixed(1)+'h',good:(+(sl&&sl.deep)||0)>=1.5},{name:'Total sleep',val:(+(sl&&sl.hours)||0).toFixed(1)+'h'+(sl._default?' (assumed)':''),good:(+(sl&&sl.hours)||0)>=7.5},{name:'Fasting',val:fastHrs>0?fastHrs.toFixed(1)+'h':'None today',good:fastHrs>=16},{name:'Workout',val:w?w.type:'None logged',good:!!w&&w.type!=='Active Rest'},{name:'Sugar today',val:sugar+'g',good:sugar<10}];
  document.getElementById('hgh-factors').innerHTML=factors.map(f=>`<div class="factor-row"><div class="factor-icon ${f.good?'good':'bad'}"></div><div class="factor-name" style="flex:1;color:var(--muted);font-size:13px">${f.name}</div><div style="font-size:13px">${f.val}</div></div>`).join('');
  const phase=getPhase(fastHrs);document.getElementById('autophagy-phase').textContent=phase.name;document.getElementById('autophagy-hrs').textContent=fastHrs>0?fastHrs.toFixed(1)+' hours fasted':'Start a fast to track phase';for(let i=1;i<=4;i++)document.getElementById('ps'+i).className='phase-seg'+(i<=phase.idx+1?' active':'');
}
