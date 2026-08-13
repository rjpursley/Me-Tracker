// ---------------------------------------------------------------------------
// pages/health.js — Health Status: hormone indices and autophagy phase.
//
// ARCHITECTURE.md §10: HGH, Testosterone and Cortisol Pressure are BEHAVIOURAL
// CORRELATIONS, NOT MEDICAL CLAIMS. The "Estimates from behavioral data only"
// banner in index.html is load-bearing — do not remove it, and never present a
// clinical value.
//
// BUILT (§10): manual height / age / bodyweight / waist entry, the 7-day
// rolling bodyweight trend, and relative strength (each derived Training Max
// ÷ the rolling bodyweight — see §10.1, it reads the derived TM, not a
// stored one). Age lives here (d.body.age) because it has no other home in
// the schema and Karvonen zones (§5, derive.js) need it.
//
// BUILT (§6, §10): body fat %, VO2 max and HRV now come from the Google
// Health API via api.js's cache (getCachedVitals()), read for today's date.
// Still rendered under "Awaiting Sync" with an em-dash whenever the cache has
// no value for today — never a zero, which would read as a measurement of
// zero (§1.7) — the section heading stays accurate either way since a field
// with no synced value really is still "awaiting sync".
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays, esc } from '../util.js';
import { getSleepForDate, calcFastHrs, getWorkoutForDate, calcHGH, calcTest, calcCortisol, getPhase,
         rollingBodyweight, latestWaist, relativeStrength, BODYWEIGHT_WINDOW_DAYS } from '../derive.js';
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

function renderBodySummary(){
  const body=db().body||{};
  const rb=rollingBodyweight();
  const waist=latestWaist();
  const weightSub = rb.avg!=null
    ? rb.count+' weigh-in'+(rb.count===1?'':'s')+' · '+BODYWEIGHT_WINDOW_DAYS+'-day avg'
    : (rb.latest ? 'none in last '+BODYWEIGHT_WINDOW_DAYS+' days · last '+rb.latest.date : 'not logged yet');
  const cells=[
    {label:'Bodyweight', val: rb.avg!=null?rb.avg.toFixed(1):'—', unit:'lbs', sub:weightSub},
    {label:'Height',     val: body.height?String(+body.height):'—', unit:'in', sub: body.height?'manual entry':'not set'},
    {label:'Waist',      val: waist?String(+waist.inches):'—',      unit:'in', sub: waist?waist.date:'not logged yet'}
  ];
  document.getElementById('body-summary').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">' +
    cells.map(c=>`<div class="card" style="text-align:center;padding:12px"><div class="card-title" style="margin-bottom:4px">${c.label}</div><div class="stat-big" style="font-size:26px">${c.val}</div><div class="stat-sub">${c.unit}</div><div class="stat-sub" style="font-size:10px;margin-top:4px">${c.sub}</div></div>`).join('') +
    '</div>';
}

// Body fat %, VO2 max and HRV come from the Google Health API (§6) via
// api.js's cache, read for today's date. Any field the API hasn't supplied a
// value for yet renders as an em-dash under "Awaiting Sync" — never a zero,
// which would read as a measurement of zero (§1.7).
function renderAwaiting(){
  const v=getCachedVitals(today());
  const items=[
    {label:'Body Fat', unit:'%',          val: v&&v.bodyFatPct!=null ? v.bodyFatPct : null},
    {label:'VO2 Max',  unit:'ml/kg/min',  val: v&&v.vo2Max!=null     ? v.vo2Max     : null},
    {label:'HRV',      unit:'ms',         val: v&&v.hrv!=null        ? v.hrv        : null}
  ];
  const anySynced=items.some(i=>i.val!=null);
  document.getElementById('body-awaiting').innerHTML =
    '<div class="awaiting-panel">' +
    items.map(i=>`<div class="vh-item"><div class="vh-label">${i.label}</div><div class="vh-value"${i.val!=null?' style="color:var(--accent2)"':''}>${i.val!=null?i.val:'—'}</div><div class="vh-unit">${i.unit}</div></div>`).join('') +
    `<div class="vh-note">${anySynced?'Synced '+v.date:'Awaiting sync — comes from Google Health'}</div>` +
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

function renderRelativeStrength(){
  const rows=relativeStrength();
  const bw=rollingBodyweight().avg;
  let html='';
  if(bw==null) html+='<div class="stat-sub" style="margin-bottom:10px">Log a bodyweight to see relative strength.</div>';
  html+=rows.map(r=>{
    let val;
    if(r.ratio!=null) val=`<span style="color:var(--accent)">${r.ratio.toFixed(2)}×</span>`;
    else if(!r.tm) val='<span class="score-row-pending">set TM</span>';
    else val='<span class="score-row-pending">set bodyweight</span>';
    return `<div class="target-row"><span class="target-label">${r.name}${r.tm?' · '+r.tm+' lb':''}</span><span class="target-val">${val}</span></div>`;
  }).join('');
  document.getElementById('relative-strength').innerHTML=html;
}

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

export function logBodyMeasurement(){
  const w=document.getElementById('health-weight').value;
  const wa=document.getElementById('health-waist').value;
  if(!w&&!wa){alert('Enter a bodyweight or a waist measurement');return;}
  const d=db();
  d.body=d.body||{};d.body.weights=d.body.weights||[];d.body.waists=d.body.waists||[];
  const date=document.getElementById('health-measure-date').value||today();
  if(w)d.body.weights.push({date,lbs:w});
  if(wa)d.body.waists.push({date,inches:wa});
  save(d);
  document.getElementById('health-weight').value='';
  document.getElementById('health-waist').value='';
  alert('Measurement saved!');
  renderHealth();
}

export function renderHealth(){
  renderBodySummary();renderAwaiting();renderRelativeStrength();
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
  const l7=[];for(let i=6;i>=0;i--){const wk=getWorkoutForDate(dateStr(addDays(new Date(),-i)));if(wk)l7.push(wk);}
  const hgh=calcHGH(sl,fastHrs,w,sugar);const test=calcTest(sl,fastHrs,w,sugar,l7);const cort=calcCortisol(sl,sugar,w,l7,fastHrs);
  let cortLabel='Low';if(cort>75)cortLabel='High';else if(cort>55)cortLabel='Elevated';else if(cort>30)cortLabel='Moderate';
  let hghD=hgh,testD=test,modText='';if(cort>60){hghD=Math.max(0,hgh-10);testD=Math.max(0,test-10);modText='−10 cortisol drag';}else if(cort>30)modText='−5 cortisol drag';
  document.getElementById('hgh-val').textContent=hghD+'/100';document.getElementById('hgh-bar').style.width=hghD+'%';document.getElementById('test-val').textContent=testD+'/100';document.getElementById('test-bar').style.width=testD+'%';document.getElementById('cort-val').textContent=cort+'/100';document.getElementById('cort-label-text').textContent=cortLabel;document.getElementById('cort-indicator').style.left=Math.min(95,cort)+'%';
  const m1=document.getElementById('hgh-modifier'),m2=document.getElementById('test-modifier');if(modText){m1.textContent=modText;m1.style.color='var(--warn)';m2.textContent=modText;m2.style.color='var(--warn)';}else{m1.textContent='';m2.textContent='';}
  document.getElementById('cortisol-warning').innerHTML=cort>60?'<div class="alert err" style="margin-top:8px">⚠ High cortisol — consider recovery: sleep, rest day, reduce stimulants.</div>':'';
  const factors=[{name:'Deep sleep',val:(+(sl&&sl.deep)||0).toFixed(1)+'h',good:(+(sl&&sl.deep)||0)>=1.5},{name:'Total sleep',val:(+(sl&&sl.hours)||0).toFixed(1)+'h'+(sl._default?' (assumed)':''),good:(+(sl&&sl.hours)||0)>=7.5},{name:'Fasting',val:fastHrs>0?fastHrs.toFixed(1)+'h':'None today',good:fastHrs>=16},{name:'Workout',val:w?w.type:'None logged',good:!!w&&w.type!=='Active Rest'},{name:'Sugar today',val:sugar+'g',good:sugar<10},{name:'Cortisol',val:cortLabel,good:cort<=30}];
  document.getElementById('hgh-factors').innerHTML=factors.map(f=>`<div class="factor-row"><div class="factor-icon ${f.good?'good':'bad'}"></div><div class="factor-name" style="flex:1;color:var(--muted);font-size:13px">${f.name}</div><div style="font-size:13px">${f.val}</div></div>`).join('');
  const phase=getPhase(fastHrs);document.getElementById('autophagy-phase').textContent=phase.name;document.getElementById('autophagy-hrs').textContent=fastHrs>0?fastHrs.toFixed(1)+' hours fasted':'Start a fast to track phase';for(let i=1;i<=4;i++)document.getElementById('ps'+i).className='phase-seg'+(i<=phase.idx+1?' active':'');
}
