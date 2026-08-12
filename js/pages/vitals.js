// ---------------------------------------------------------------------------
// pages/vitals.js — Sleep / HR / Steps. Mounted as the "Body" page.
//
// PRE-EXISTING COLOUR LITERALS: the Chart.js config below uses raw hex and rgba
// values. Chart.js draws to <canvas> and cannot resolve CSS var() strings, so
// these could not simply be swapped for tokens during the split. Flagged in the
// session report against ARCHITECTURE.md §1.6 — needs a decision, not a
// silent "fix".
//
// BUILT (§4, §6): the history lists below (sleep-history/hr-history) are
// capped at 3 days on screen — "Vitals keeps 3 days of history maximum on
// screen. Longer ranges exist only as graphs and averages, not as scrollable
// detail." The 15-day chart and the three average cards above it ARE that
// longer range, so they keep their existing 15-day window unchanged — only
// the two scrollable lists were capped.
//
// ############ THIS PAGE READS THE GOOGLE HEALTH CACHE (§6.9) ############
//
// FIXED 2026-08-12. Every number on this page used to come from d.sleeps /
// d.hrs — the MANUAL log arrays written by the two forms at the bottom of this
// file — with the single exception of steps, which was wired to
// getCachedVitals() when §6 was built. Ryan has never hand-logged sleep or HR
// (the watch does it), so those arrays were empty and the page rendered a
// blank chart, two em-dashes and "No sleep data yet" while the server was
// serving real values the whole time. Steps rendered because steps was the one
// line that asked the API.
//
// PRECEDENCE, matching derive.js's getSleepForDate() and §6's rule that "the
// API overrides the assumption; it does not compete with it": a manual log
// always wins where one exists, the synced aggregate fills the gap, and
// neither means null — never a guess (§1.7).
//
// Do not "simplify" this back to reading only d.sleeps/d.hrs. That is the bug.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays } from '../util.js';
import { renderHome } from './home.js';
import { getCachedVitals } from '../api.js';

const HISTORY_DAYS_MAX = 3; // §4 — the hard cap on scrollable detail

let bodyChartInstance=null;

// One resolved row per day, merging the manual log with the synced aggregate.
// This is the ONLY place that precedence is decided on this page, so the
// chart, the averages and the two history lists can never disagree about what
// a day's numbers were.
//
// `fromApi` flags exist so the UI can label a synced row rather than dress it
// up as something Ryan typed (§1.7). The API has no equivalent of the manual
// 1-5 `quality` rating, so quality stays null on synced rows — it is NOT
// defaulted to 3 here. (derive.js's getSleepForDate() does substitute a
// neutral 3, but that is for the sleep SCORE's weighting, not for display.)
function resolveDay(d,ds){
  const v=getCachedVitals(ds);
  const sl=(d.sleeps||[]).find(s=>s.date===ds);
  const hr=(d.hrs||[]).find(h=>h.date===ds);
  const apiSleepMin=(v&&v.sleep&&+v.sleep.totalMinutes>0)?+v.sleep.totalMinutes:null;
  const stages=(v&&v.sleep&&v.sleep.stageMinutes)||{};
  // Versa 2 CLASSIC sleep records carry no stage breakdown at all — only an
  // ASLEEP total. Report deep as unknown on those rather than as 0.0h, which
  // would read as a measurement of zero deep sleep (§1.7).
  const apiDeepMin=+(stages.DEEP??stages.deep??stages.Deep??0)||0;
  const manualRest=(hr&&+hr.resting>0)?+hr.resting:null;
  const manualWork=(hr&&+hr.workout>0)?+hr.workout:null;
  const apiRest=(v&&+v.restingHR>0)?+v.restingHR:null;
  const apiWork=(v&&v.workout&&+v.workout.avgHR>0)?+v.workout.avgHR:null;
  return{
    ds,
    sleepHrs: sl?+sl.hours:(apiSleepMin!=null?apiSleepMin/60:null),
    deepHrs:  sl?(+sl.deep>0?+sl.deep:null):(apiDeepMin>0?apiDeepMin/60:null),
    quality:  sl?+sl.quality:null,
    sleepFromApi: !sl&&apiSleepMin!=null,
    resting:  manualRest??apiRest,
    workout:  manualWork??apiWork,
    steps:    (v&&v.steps!=null&&+v.steps>=0)?+v.steps:null
  };
}

const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;

export function renderBody(){
  const d=db(),now=new Date();const labels=[],sleepData=[],hrData=[];const rows=[];
  for(let i=14;i>=0;i--){
    const dt=addDays(now,-i);const ds=dateStr(dt);labels.push((dt.getMonth()+1)+'/'+dt.getDate());
    const r=resolveDay(d,ds);rows.push(r);
    sleepData.push(r.sleepHrs);hrData.push(r.resting);
  }
  const stepVals=rows.map(r=>r.steps).filter(v=>v!=null);
  const rhrVals=rows.map(r=>r.resting).filter(v=>v!=null);
  const whrArr=rows.map(r=>r.workout).filter(v=>v!=null);
  document.getElementById('avg-rhr').textContent=avg(rhrVals)??'—';document.getElementById('avg-whr').textContent=avg(whrArr)??'—';
  const stepsEl=document.getElementById('avg-steps');
  if(stepsEl){
    if(stepVals.length){stepsEl.textContent=Math.round(stepVals.reduce((a,b)=>a+b,0)/stepVals.length).toLocaleString();stepsEl.nextElementSibling.textContent='avg/day · '+stepVals.length+' synced';}
    else{stepsEl.textContent='—';stepsEl.nextElementSibling.textContent='awaiting sync';}
  }
  const ctx=document.getElementById('body-chart').getContext('2d');if(bodyChartInstance)bodyChartInstance.destroy();
  bodyChartInstance=new Chart(ctx,{data:{labels,datasets:[{type:'bar',label:'Sleep (h)',data:sleepData,backgroundColor:'rgba(79,216,196,.35)',borderColor:'#4fd8c4',borderWidth:1,yAxisID:'y'},{type:'line',label:'Resting HR',data:hrData,borderColor:'#f76a8a',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#f76a8a',yAxisID:'y2',borderDash:[4,3]}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{position:'left',ticks:{color:'#6b6b8a',font:{size:9}},grid:{color:'rgba(255,255,255,.04)'},title:{display:true,text:'Sleep h',color:'#6b6b8a',font:{size:9}}},y2:{position:'right',ticks:{color:'#6b6b8a',font:{size:9}},grid:{display:false},title:{display:true,text:'HR bpm',color:'#6b6b8a',font:{size:9}}},x:{ticks:{color:'#6b6b8a',font:{size:8},maxRotation:45,autoSkip:false},grid:{color:'rgba(255,255,255,.02)'}}}}});
  // Both lists now walk the SAME resolved rows as the chart above, newest
  // first, capped at HISTORY_DAYS_MAX (§4). A synced row carries a "synced"
  // tag instead of a x/5 rating, because the API has no quality equivalent and
  // inventing one would present a guess as a measurement (§1.7).
  const empty=msg=>`<div style="text-align:center;color:var(--muted);font-size:13px;padding:10px 0;font-family:var(--font-mono)">${msg}</div>`;
  const sleepRows=rows.filter(r=>r.sleepHrs!=null).slice(-HISTORY_DAYS_MAX).reverse();
  document.getElementById('sleep-history').innerHTML=sleepRows.length?sleepRows.map(r=>{
    const tag=r.quality!=null
      ?`<span class="tag ${r.quality>=4?'green':r.quality>=3?'teal':'red'}">${r.quality}/5</span>`
      :`<span class="tag teal">synced</span>`;
    return `<div class="history-item"><span class="history-date">${r.ds}</span><span style="flex:1">${r.sleepHrs.toFixed(1)}h · ${r.deepHrs!=null?r.deepHrs.toFixed(1)+'h deep':'deep n/a'}</span>${tag}</div>`;
  }).join(''):empty('No sleep data yet');
  const hrRows=rows.filter(r=>r.resting!=null||r.workout!=null).slice(-HISTORY_DAYS_MAX).reverse();
  document.getElementById('hr-history').innerHTML=hrRows.length?hrRows.map(r=>
    `<div class="history-item"><span class="history-date">${r.ds}</span><span>Rest: <strong>${r.resting??'—'}</strong> bpm${r.workout?' · WO: '+r.workout+' bpm':''}</span></div>`
  ).join(''):empty('No HR data yet');
}

export function logSleep(){const d=db(),hours=document.getElementById('sleep-hours').value;if(!hours){alert('Please enter hours slept');return;}d.sleeps.push({hours,deep:document.getElementById('sleep-deep').value,quality:document.getElementById('sleep-quality').value,date:document.getElementById('sleep-date').value||today()});save(d);alert('Sleep logged!');renderHome();}

export function logHR(){const d=db(),resting=document.getElementById('hr-resting').value,workout=document.getElementById('hr-workout').value;if(!resting&&!workout){alert('Enter at least one HR value');return;}d.hrs.push({resting,workout,date:document.getElementById('hr-date').value||today()});save(d);alert('Heart rate logged!');renderHome();}
