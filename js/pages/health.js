// ---------------------------------------------------------------------------
// pages/health.js — Health Status: hormone indices and autophagy phase.
//
// ARCHITECTURE.md §10: HGH, Testosterone and Cortisol Pressure are BEHAVIOURAL
// CORRELATIONS, NOT MEDICAL CLAIMS. The "Estimates from behavioral data only"
// banner in index.html is load-bearing — do not remove it, and never present a
// clinical value.
//
// BUILT (§10): manual height / bodyweight / waist entry, the 7-day rolling
// bodyweight trend, and relative strength (each derived Training Max ÷ the
// rolling bodyweight — see §10.1, it reads the derived TM, not a stored one).
//
// NOT YET BUILT (§10): body fat %, VO2 max and HRV. All three come from the
// Google Health API (§6), which has no server yet, so they render as
// em-dashes under "Awaiting Sync" — never as zeroes, which would read as a
// measurement of zero.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays } from '../util.js';
import { getSleepForDate, calcFastHrs, getWorkoutForDate, calcHGH, calcTest, calcCortisol, getPhase,
         rollingBodyweight, latestWaist, relativeStrength, BODYWEIGHT_WINDOW_DAYS } from '../derive.js';

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

// Body fat %, VO2 max and HRV come from the Google Health API (§10), which does
// not exist yet. They render as em-dashes labelled "awaiting sync" — never as
// zeroes, which would read as a measurement of zero.
function renderAwaiting(){
  const items=[{label:'Body Fat',unit:'%'},{label:'VO2 Max',unit:'ml/kg/min'},{label:'HRV',unit:'ms'}];
  document.getElementById('body-awaiting').innerHTML =
    '<div class="awaiting-panel">' +
    items.map(i=>`<div class="vh-item"><div class="vh-label">${i.label}</div><div class="vh-value">—</div><div class="vh-unit">${i.unit}</div></div>`).join('') +
    '<div class="vh-note">Awaiting sync — comes from Google Health, not yet connected</div>' +
    '</div>';
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
  const bodyNow=db().body||{};
  const hEl=document.getElementById('health-height');if(hEl&&bodyNow.height)hEl.value=bodyNow.height;
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
