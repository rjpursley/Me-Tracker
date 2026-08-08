// ---------------------------------------------------------------------------
// pages/calendar.js — Week / month calendar view.
//
// This file is NOT in the ARCHITECTURE.md §3 tree. The Calendar page exists in
// the drawer today, and §4 says the drawer is unchanged, so its code needs a
// home. Splitting it across the documented page modules would have scattered
// one screen over several files for no benefit.
//
// Moved verbatim from index.html. No logic changed.
// ---------------------------------------------------------------------------

import { db } from '../store.js';
import { today } from '../util.js';
import { getScheduleForDate, WCOLORS } from '../schedule.js';

let currentCalView='week';

export function getCalView(){return currentCalView;}

export function renderCalendar(view){
  const d=db(),now=new Date();const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];let days=[];
  if(view==='week'){for(let i=0;i<7;i++){const dt=new Date(now);dt.setDate(now.getDate()+i);days.push(dt);}document.getElementById('cal-range-label').textContent='Next 7 days';}
  else{const yr=now.getFullYear(),mo=now.getMonth();const first=new Date(yr,mo,1),last=new Date(yr,mo+1,0);for(let i=0;i<first.getDay();i++)days.push(null);for(let i=1;i<=last.getDate();i++)days.push(new Date(yr,mo,i));document.getElementById('cal-range-label').textContent=first.toLocaleDateString('en-US',{month:'long',year:'numeric'});}
  let html='<div class="cal-grid">';dayNames.forEach(n=>html+=`<div class="cal-day-name">${n}</div>`);
  days.forEach(dt=>{if(!dt){html+='<div class="cal-day empty"></div>';return;}const ds=dt.toISOString().slice(0,10),isToday=ds===today();const sched=getScheduleForDate(ds);const dev=d.deviations&&d.deviations[ds];const fast=d.fasts.find(f=>f.date===ds);const dotColor=WCOLORS[sched.category]||'#f7c46a';html+=`<div class="cal-day${isToday?' today':''}"><span class="cal-day-num" style="color:${isToday?'var(--accent)':'var(--text)'}">${dt.getDate()}</span><div class="cal-dots"><div class="cal-dot" style="background:${dev&&dev.type==='missed'?'var(--danger)':dotColor}"></div>${fast?'<div class="cal-dot" style="background:#4fd8c4;opacity:.5"></div>':''}</div><div class="cal-abbr">${sched.rest?'REST':sched.category.substring(0,3)}</div></div>`;});
  html+='</div>';document.getElementById('cal-container').innerHTML=html;
}

export function setCalView(v){currentCalView=v;document.getElementById('cal-week-btn').classList.toggle('active',v==='week');document.getElementById('cal-month-btn').classList.toggle('active',v==='month');renderCalendar(v);}
