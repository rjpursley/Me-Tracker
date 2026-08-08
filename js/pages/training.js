// ---------------------------------------------------------------------------
// pages/training.js — The prescription card (today's session).
//
// Renders into #rx-container, which currently sits on the Home page. It lives
// here because it is training content: when the score-box nav of
// ARCHITECTURE.md §4 gets built, the Training page is already in place.
//
// Moved verbatim from index.html. No markup or logic changed.
//
// NOT YET BUILT (§9): per-exercise checkboxes, live HR/zone/steps header,
// program pause + the 3-digit keypad confirmation gate.
// ---------------------------------------------------------------------------

import { db } from '../store.js';
import { today } from '../util.js';
import { getScheduleForDate, CATEGORY_COLORS, CATEGORY_BORDER, CATEGORY_COLOR_TEXT, PROGRESSION } from '../schedule.js';
import { programWeek, mainLiftRx } from '../derive.js';

// The Training page reached from the score box (§4). Currently the vitals
// header plus today's prescription; §9 lists what else belongs here once built.
export function renderTrainingPage(){
  renderPrescription(today(),'training-rx-container');
}

// containerId lets the same prescription card mount on Home and on the
// Training page without a second copy of the renderer.
export function renderPrescription(ds,containerId){
  const sched=getScheduleForDate(ds);const d=db();const dev=d.deviations&&d.deviations[ds];const catColor=CATEGORY_COLOR_TEXT[sched.category]||'var(--text)';const catBg=CATEGORY_COLORS[sched.category]||'transparent';const catBorder=CATEGORY_BORDER[sched.category]||'var(--border)';const dayName=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(ds+'T12:00:00').getDay()];
  const wk=programWeek(ds);const phase=PROGRESSION[wk-1].phase;
  let html=`<div class="rx-card" style="border-color:${catBorder};background:${catBg}"><div class="rx-header"><div><div class="rx-day-label">${dayName}</div><div class="rx-session-name">${sched.session}</div><div class="rx-week-tag">Week ${wk} of 12 · ${phase}</div></div><div class="rx-category-tag" style="color:${catColor};background:rgba(0,0,0,.2);border:1px solid ${catBorder}">${sched.category}</div></div>`;
  if(dev&&dev.type==='missed')html+=`<div style="padding:0 16px 16px"><div class="alert err" style="margin:0">✗ Missed</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${dev.note}</div>`:''}</div>`;
  else if(dev&&dev.type==='swapped')html+=`<div style="padding:0 16px 16px"><div class="alert warn" style="margin:0">↔ Swapped to: ${dev.swap||'other'}</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${dev.note}</div>`:''}</div>`;
  else if(dev&&dev.type==='completed')html+=`<div style="padding:0 16px 16px"><div class="alert success" style="margin:0">✓ Marked Completed</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${dev.note}</div>`:''}</div>`;
  else if(dev&&dev.type==='skipped')html+=`<div style="padding:0 16px 16px"><div class="alert" style="margin:0;background:rgba(107,107,138,.1);border-color:var(--muted);color:var(--muted)">⏭ Planned skip</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${dev.note}</div>`:''}</div>`;
  else if(dev&&dev.type==='makeup')html+=`<div style="padding:0 16px 16px"><div class="alert info" style="margin:0">⟳ Make-up session</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${dev.note}</div>`:''}</div>`;
  if(sched.rest)html+=`<div class="rx-rest-day"><div class="rx-rest-icon">🌿</div><div class="rx-rest-text">Full Rest — total recovery</div><div class="rx-rest-sub">Zero structured lifting or high-intensity cardio · hydration, protein, sleep</div></div>`;
  else if(sched.exercises&&sched.exercises.length){
    const rx=mainLiftRx(sched,ds);
    const blocks=[];sched.exercises.forEach(ex=>{let b=blocks[blocks.length-1];if(!b||b.name!==ex.block){b={name:ex.block,items:[]};blocks.push(b);}b.items.push(ex);});
    html+=`<div class="rx-exercises">`;
    blocks.forEach(b=>{
      const isGiant=/Giant Set/i.test(b.name);
      html+=`<div class="rx-block-head">${b.name}</div>`;
      b.items.forEach((ex,i)=>{
        const marker=isGiant?String.fromCharCode(65+i):(i+1);
        let line='';
        if(ex.main&&rx)line=`<div class="rx-main-line${rx.weight==='set TM'?' rx-no-tm':''}"><div class="rx-main-rx">Week ${rx.week} — ${rx.phase} — ${rx.setsReps} @ ${rx.pctLabel} — ${rx.weight}</div><div class="rx-main-meta">Rest ${rx.rest} · ${rx.objective}</div></div>`;
        html+=`<div class="rx-exercise-item"><span class="rx-ex-num">${marker}</span><div style="flex:1"><div class="rx-ex-name">${ex.name}</div><div class="rx-ex-equip">${ex.equip}</div>${ex.detail?`<div class="rx-ex-detail">${ex.detail}</div>`:''}${line}</div></div>`;
      });
    });
    html+=`</div>`;
  }
  html+=`</div>`;document.getElementById(containerId||'rx-container').innerHTML=html;
}
