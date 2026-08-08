// ---------------------------------------------------------------------------
// pages/health.js — Health Status: hormone indices and autophagy phase.
//
// ARCHITECTURE.md §10: HGH, Testosterone and Cortisol Pressure are BEHAVIOURAL
// CORRELATIONS, NOT MEDICAL CLAIMS. The "Estimates from behavioral data only"
// banner in index.html is load-bearing — do not remove it, and never present a
// clinical value.
//
// Moved verbatim from index.html. No logic changed.
//
// NOT YET BUILT (§10): manual height / bodyweight / waist entry, body fat %,
// VO2 max, HRV, 7-day rolling bodyweight trend, relative strength.
// ---------------------------------------------------------------------------

import { db } from '../store.js';
import { today, dateStr, addDays } from '../util.js';
import { getSleepForDate, calcFastHrs, getWorkoutForDate, calcHGH, calcTest, calcCortisol, getPhase } from '../derive.js';

export function renderHealth(){
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
