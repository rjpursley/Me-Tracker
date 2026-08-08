// ---------------------------------------------------------------------------
// pages/fasting.js — Fasting status bar, live timer, and the fast log form.
//
// ARCHITECTURE.md §7 and §11: the fasting timer and phase logic are NOT to be
// touched without explicit instruction. Everything below is moved verbatim
// from index.html — no thresholds, phases or wording changed.
//
// NOT YET BUILT (§7.1): the Fasting Fail button.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, pad } from '../util.js';
import { calcFastHrs, getPhase } from '../derive.js';
import { getScheduleForDate } from '../schedule.js';
import { renderHome } from './home.js';

let activeFastInterval=null;

// The Fasting page reached from the score box (§4).
export function renderFastingPage(){
  renderFastingStatus(today(),'fasting-page-status');
}

// containerId lets the same status bar mount on Home and on the Fasting page.
export function renderFastingStatus(ds,containerId){
  const d=db();const isToday=ds===today();const todayFasts=d.fasts.filter(f=>f.date===ds);let icon='⏱',val='18:6 Window',sub='No fast logged — silence = on track',color='var(--accent2)';const dow=new Date(ds+'T12:00:00').getDay();const is36=(dow===5||dow===6||dow===0);
  if(isToday&&d.activeFast){const hrs=calcFastHrs({start:d.activeFast.start,date:d.activeFast.date});icon='🔥';val=hrs.toFixed(1)+'h active';sub=d.activeFast.type+' · running now';color='var(--accent)';}
  else if(todayFasts.length){const hrs=Math.max(...todayFasts.map(calcFastHrs));val=hrs.toFixed(1)+'h';sub=todayFasts[todayFasts.length-1].type+' · logged';color='var(--accent5)';icon='✓';}
  else if(is36){icon='🌙';val='36hr Fast Window';sub=dow===5?'Begins after dinner tonight':dow===6?'Fast active day 1':'Breaks this morning';}
  document.getElementById(containerId||'fasting-status-container').innerHTML=`<div class="fast-status-bar" style="border-color:rgba(79,216,196,.25);background:rgba(79,216,196,.04)"><div class="fast-status-icon">${icon}</div><div class="fast-status-info"><div class="fast-status-label">Fasting · ${getScheduleForDate(ds).fastLabel}</div><div class="fast-status-val" style="color:${color}">${val}</div><div class="fast-status-sub">${sub}</div></div></div>`;
}

export function logFast(){const d=db(),start=document.getElementById('fast-start').value;if(!start){alert('Please enter a start time');return;}d.fasts.push({type:document.getElementById('fast-type').value,start,end:document.getElementById('fast-end').value,date:document.getElementById('fast-date').value||today()});save(d);alert('Fast logged!');renderHome();}

export function startActiveFast(){const d=db(),now=new Date();d.activeFast={type:document.getElementById('fast-type').value,start:pad(now.getHours())+':'+pad(now.getMinutes()),date:today()};save(d);document.getElementById('fast-active-display').style.display='block';document.getElementById('fast-start-btn-wrap').style.display='none';document.getElementById('fast-stop-btn-wrap').style.display='block';startFastTimer();renderHome();}

export function stopActiveFast(){const d=db();if(!d.activeFast)return;const now=new Date();d.fasts.push({...d.activeFast,end:pad(now.getHours())+':'+pad(now.getMinutes())});d.activeFast=null;save(d);if(activeFastInterval){clearInterval(activeFastInterval);activeFastInterval=null;}document.getElementById('fast-active-display').style.display='none';document.getElementById('fast-start-btn-wrap').style.display='block';document.getElementById('fast-stop-btn-wrap').style.display='none';alert('Fast ended and saved!');renderHome();}

export function startFastTimer(){if(activeFastInterval)clearInterval(activeFastInterval);function tick(){const d=db();if(!d.activeFast)return;const hrs=calcFastHrs({start:d.activeFast.start,date:d.activeFast.date});const s=Math.floor(hrs*3600);const el=document.getElementById('fast-timer');if(el)el.textContent=pad(Math.floor(s/3600))+':'+pad(Math.floor((s%3600)/60))+':'+pad(s%60);const phase=getPhase(hrs);const lbl=document.getElementById('fast-phase-label');if(lbl)lbl.textContent=phase.name;for(let i=1;i<=4;i++){const ps=document.getElementById('lps'+i);if(ps)ps.className='phase-seg'+(i<=phase.idx+1?' active':'');}}tick();activeFastInterval=setInterval(tick,1000);}
