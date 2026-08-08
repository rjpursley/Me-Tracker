// ---------------------------------------------------------------------------
// pages/vitals.js — Sleep / HR / Steps. Mounted as the "Body" page.
//
// Moved verbatim from index.html. No logic changed.
//
// PRE-EXISTING COLOUR LITERALS: the Chart.js config below uses raw hex and rgba
// values. Chart.js draws to <canvas> and cannot resolve CSS var() strings, so
// these could not simply be swapped for tokens during the split. Flagged in the
// session report against ARCHITECTURE.md §1.6 — needs a decision, not a
// silent "fix".
//
// NOT YET BUILT (§4): 3-days-max history on screen; longer ranges as graphs
// and averages only. Step count is still a placeholder ("Fitbit soon").
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays } from '../util.js';
import { renderHome } from './home.js';

let bodyChartInstance=null;

export function renderBody(){
  const d=db(),now=new Date();const labels=[],sleepData=[],hrData=[];
  for(let i=14;i>=0;i--){const dt=addDays(now,-i);const ds=dateStr(dt);labels.push((dt.getMonth()+1)+'/'+dt.getDate());const sl=d.sleeps.find(s=>s.date===ds);const hr=d.hrs.find(h=>h.date===ds);sleepData.push(sl?+(sl.hours):null);hrData.push(hr?+(hr.resting):null);}
  const rhrVals=hrData.filter(v=>v!==null);const whrArr=d.hrs.filter(h=>h.workout).map(h=>+h.workout);
  document.getElementById('avg-rhr').textContent=rhrVals.length?Math.round(rhrVals.reduce((a,b)=>a+b,0)/rhrVals.length):'—';document.getElementById('avg-whr').textContent=whrArr.length?Math.round(whrArr.reduce((a,b)=>a+b,0)/whrArr.length):'—';
  const ctx=document.getElementById('body-chart').getContext('2d');if(bodyChartInstance)bodyChartInstance.destroy();
  bodyChartInstance=new Chart(ctx,{data:{labels,datasets:[{type:'bar',label:'Sleep (h)',data:sleepData,backgroundColor:'rgba(79,216,196,.35)',borderColor:'#4fd8c4',borderWidth:1,yAxisID:'y'},{type:'line',label:'Resting HR',data:hrData,borderColor:'#f76a8a',backgroundColor:'transparent',tension:.35,pointRadius:3,pointBackgroundColor:'#f76a8a',yAxisID:'y2',borderDash:[4,3]}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{position:'left',ticks:{color:'#6b6b8a',font:{size:9}},grid:{color:'rgba(255,255,255,.04)'},title:{display:true,text:'Sleep h',color:'#6b6b8a',font:{size:9}}},y2:{position:'right',ticks:{color:'#6b6b8a',font:{size:9}},grid:{display:false},title:{display:true,text:'HR bpm',color:'#6b6b8a',font:{size:9}}},x:{ticks:{color:'#6b6b8a',font:{size:8},maxRotation:45,autoSkip:false},grid:{color:'rgba(255,255,255,.02)'}}}}});
  const sleeps=[...d.sleeps].reverse().slice(0,10);document.getElementById('sleep-history').innerHTML=sleeps.length?sleeps.map(s=>`<div class="history-item"><span class="history-date">${s.date}</span><span style="flex:1">${(+s.hours).toFixed(1)}h · ${s.deep?(+s.deep).toFixed(1)+'h deep':'? deep'}</span><span class="tag ${+s.quality>=4?'green':+s.quality>=3?'teal':'red'}">${s.quality}/5</span></div>`).join(''):'<div style="text-align:center;color:var(--muted);font-size:13px;padding:10px 0;font-family:var(--font-mono)">No sleep data yet</div>';
  const hrs=[...d.hrs].reverse().slice(0,10);document.getElementById('hr-history').innerHTML=hrs.length?hrs.map(h=>`<div class="history-item"><span class="history-date">${h.date}</span><span>Rest: <strong>${h.resting||'—'}</strong> bpm${h.workout?' · WO: '+h.workout+' bpm':''}</span></div>`).join(''):'<div style="text-align:center;color:var(--muted);font-size:13px;padding:10px 0;font-family:var(--font-mono)">No HR data yet</div>';
}

export function logSleep(){const d=db(),hours=document.getElementById('sleep-hours').value;if(!hours){alert('Please enter hours slept');return;}d.sleeps.push({hours,deep:document.getElementById('sleep-deep').value,quality:document.getElementById('sleep-quality').value,date:document.getElementById('sleep-date').value||today()});save(d);alert('Sleep logged!');renderHome();}

export function logHR(){const d=db(),resting=document.getElementById('hr-resting').value,workout=document.getElementById('hr-workout').value;if(!resting&&!workout){alert('Enter at least one HR value');return;}d.hrs.push({resting,workout,date:document.getElementById('hr-date').value||today()});save(d);alert('Heart rate logged!');renderHome();}
