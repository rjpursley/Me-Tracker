// ---------------------------------------------------------------------------
// pages/home.js — Day strip, consistency score, deviation tray, status grid.
//
// ARCHITECTURE.md §1.1: silence = compliance. The deviation tray is how a
// missed day gets recorded; an untouched day is treated as adherent. Taps are
// spent on deviations, not confirmations.
//
// Moved verbatim from index.html. No markup or logic changed.
//
// NOTE ON IMPORT CYCLE: fasting.js / log.js / etc. import renderHome() from
// here, and this file imports their renderers back. That cycle is safe only
// because every shared symbol is a hoisted `function` declaration. Do not
// convert these to `const fn = () => {}` — that would break the cycle at load.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays } from '../util.js';
import { calcScore, sc, getSleepForDate, getWorkoutForDate, consistencyRows, WEEK_WINDOW_DAYS, MONTH_WINDOW_DAYS } from '../derive.js';
import { getScheduleForDate, WCOLORS } from '../schedule.js';
import { renderPrescription } from './training.js';
import { renderFastingStatus } from './fasting.js';

let selectedDate=today();

export function getSelectedDate(){return selectedDate;}

export function buildDayStrip(){
  const strip=document.getElementById('day-strip');const now=new Date();const days=[];for(let i=-7;i<=7;i++)days.push(addDays(now,i));
  const d=db();
  strip.innerHTML=days.map(dt=>{
    const ds=dateStr(dt);const dow=['Su','Mo','Tu','We','Th','Fr','Sa'][dt.getDay()];const sched=getScheduleForDate(ds);const isToday=ds===today();const isSelected=ds===selectedDate;
    const dev=d.deviations&&d.deviations[ds];let dotStyle=`background:${WCOLORS[sched.category]||'#6b6b8a'}`;if(dev&&dev.type==='missed')dotStyle='background:var(--danger)';if(dev&&dev.type==='completed')dotStyle='background:var(--accent5)';
    const abbr=sched.rest?'REST':sched.category.substring(0,3).toUpperCase();
    return `<div class="day-card${isToday?' is-today':''}${isSelected?' selected':''}" onclick="selectDay('${ds}')"><span class="dc-dow">${dow}</span><span class="dc-num">${dt.getDate()}</span><span class="dc-type">${abbr}</span><div class="dc-dot" style="${dotStyle}"></div></div>`;
  }).join('');
  setTimeout(()=>{const cards=strip.querySelectorAll('.day-card');const idx=days.findIndex(dt=>dateStr(dt)===selectedDate);if(idx>=0&&cards[idx])cards[idx].scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});},50);
}

export function selectDay(ds){selectedDate=ds;buildDayStrip();renderHomeDayContent();}

export function renderHome(){buildDayStrip();renderHomeDayContent();}

export function renderHomeDayContent(){
  const ds=selectedDate;const isToday=ds===today();const dt=new Date(ds+'T12:00:00');const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('rx-section-label').textContent=isToday?"Today's Prescription":dayNames[dt.getDay()]+' — '+dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const score=calcScore(ds);
  document.getElementById('top-score').textContent=score.total||'—';
  renderScoreBox();
  renderPrescription(ds);renderFastingStatus(ds);renderDeviationState(ds);renderStatusGrid(ds);
}

// ---------------------------------------------------------------------------
// Consistency Score box — ARCHITECTURE.md §4.
//
// Every row is a nav button except Score, which is the aggregate and goes
// nowhere. Each row shows week average / month average. Rows stay 0/0 until
// enough history exists; see WEEK_WINDOW_DAYS / MONTH_WINDOW_DAYS in derive.js.
//
// The numbers are averages over a window and are NOT tied to the day selected
// in the strip above. The selected day's own score is the number in the topbar.
// ---------------------------------------------------------------------------
const SCORE_ROWS=[
  {key:'total',    label:'Score',    nav:null},
  {key:'training', label:'Training', nav:['training','Training']},
  {key:'diet',     label:'Dietary',  nav:['diet','Dietary']},
  {key:'sleep',    label:'Sleep/HR', nav:['body','Sleep / HR']},
  {key:'fast',     label:'Fasting',  nav:['fasting','Fasting']},
  // Health has no scored pillar. See the session report — rather than invent a
  // health score that ARCHITECTURE.md never defines, the row renders as a nav
  // button with no numbers.
  {key:null,       label:'Health',   nav:['health','Health Status']}
];

function scoreNums(pair){
  if(!pair)return `<span class="score-row-nums score-row-pending">—<span class="score-row-sep">/</span>—</span>`;
  const w=pair.weekReady?`<span style="color:${sc(pair.week)}">${pair.week}</span>`:`<span class="score-row-pending">0</span>`;
  const m=pair.monthReady?`<span style="color:${sc(pair.month)}">${pair.month}</span>`:`<span class="score-row-pending">0</span>`;
  return `<span class="score-row-nums">${w}<span class="score-row-sep">/</span>${m}</span>`;
}

export function renderScoreBox(){
  const rows=consistencyRows();
  let html=`<div class="score-box"><div class="score-box-head"><span>Consistency</span><span>Wk / Mo</span></div>`;
  SCORE_ROWS.forEach(r=>{
    const nums=scoreNums(r.key?rows[r.key]:null);
    if(!r.nav){
      html+=`<div class="score-row score-row-display"><span class="score-row-label">${r.label}</span>${nums}<span class="score-row-chev"></span></div>`;
    }else{
      html+=`<button class="score-row" onclick="showPage('${r.nav[0]}','${r.nav[1]}')"><span class="score-row-label">${r.label}</span>${nums}<span class="score-row-chev">›</span></button>`;
    }
  });
  if(rows.historyDays<MONTH_WINDOW_DAYS){
    const need=rows.historyDays<WEEK_WINDOW_DAYS?WEEK_WINDOW_DAYS-rows.historyDays:MONTH_WINDOW_DAYS-rows.historyDays;
    const which=rows.historyDays<WEEK_WINDOW_DAYS?'week':'month';
    html+=`<div class="score-box-foot">Averages stay at 0 until there is enough history — ${need} more day${need===1?'':'s'} for the ${which} figure.</div>`;
  }
  html+=`</div>`;
  document.getElementById('score-box').innerHTML=html;
}

export function renderDeviationState(ds){
  const d=db();const dev=d.deviations&&d.deviations[ds];const devType=dev&&dev.type;
  ['completed','missed','swapped','makeup','skipped'].forEach(t=>{const btn=document.getElementById('dev-'+t);if(btn){btn.classList.toggle('active-btn',devType===t);if(t==='missed')btn.classList.toggle('missed-btn',true);if(t==='skipped')btn.classList.toggle('skip-btn',true);}});
  if(dev&&dev.note){document.getElementById('dev-note-area').style.display='block';const ni=document.getElementById('dev-note-text');if(ni)ni.value=dev.note;}else{document.getElementById('dev-note-area').style.display='none';}
}

export function renderStatusGrid(ds){
  const d=db();const sched=getScheduleForDate(ds);const w=getWorkoutForDate(ds);const sl=getSleepForDate(ds);const meals=d.meals.filter(m=>m.date===ds);
  const tp=Math.round(meals.reduce((a,m)=>a+(+m.protein||0),0)),ts=Math.round(meals.reduce((a,m)=>a+(+m.sugar||0),0));
  const slHrs=+(sl&&sl.hours)||0;const sleepGoal=+(d.targets&&d.targets.sleep)||8;const sugarGoal=+(d.targets&&d.targets.sugar)||10;const protGoal=+(d.targets&&d.targets.protein)||180;
  const sleepSub=sl&&sl._default?`~${slHrs}h assumed · Fitbit pending`:`Quality ${sl.quality}/5${sl.deep?' · '+sl.deep+'h deep':''}`;
  document.getElementById('status-grid').innerHTML=[
    {label:'Session',icon:'🏋️',val:w?w.type:sched.rest?'Active Rest':'Planned',sub:sched.session,status:w?'good':'neutral'},
    {label:'Sleep',icon:'😴',val:slHrs.toFixed(1)+'h',sub:sleepSub,status:slHrs>=sleepGoal?'good':slHrs>=6?'warn':'bad'},
    {label:'Protein',icon:'🥩',val:tp+'g',sub:'of '+protGoal+'g target',status:tp>=protGoal?'good':tp>protGoal*.5?'warn':'bad'},
    {label:'Sugar',icon:'🚫',val:ts+'g',sub:ts===0?'Clean — no impact':ts<=sugarGoal?'Under limit':'Over limit!',status:ts===0?'good':ts<=sugarGoal?'warn':'bad'}
  ].map(c=>`<div class="status-card ${c.status}"><div class="status-card-label">${c.label}</div><div class="status-card-icon">${c.icon}</div><div class="status-card-val">${c.val}</div><div class="status-card-sub">${c.sub}</div></div>`).join('');
}

export function setDeviation(type){
  const d=db();d.deviations=d.deviations||{};const current=d.deviations[selectedDate]||{};
  if(current.type===type)delete d.deviations[selectedDate];else d.deviations[selectedDate]={...current,type,timestamp:new Date().toISOString()};
  save(d);renderDeviationState(selectedDate);renderPrescription(selectedDate);buildDayStrip();renderStatusGrid(selectedDate);
}

export function toggleSwapArea(){const el=document.getElementById('dev-swap-area');el.style.display=el.style.display==='block'?'none':'block';}

export function toggleNoteArea(){const el=document.getElementById('dev-note-area');el.style.display=el.style.display==='block'?'none':'block';}

export function saveSwap(){const d=db();d.deviations=d.deviations||{};const swap=document.getElementById('dev-swap-select').value;d.deviations[selectedDate]={...d.deviations[selectedDate],type:'swapped',swap,timestamp:new Date().toISOString()};save(d);document.getElementById('dev-swap-area').style.display='none';renderHomeDayContent();buildDayStrip();}

export function saveNote(){const d=db();d.deviations=d.deviations||{};const note=document.getElementById('dev-note-text').value;d.deviations[selectedDate]={...d.deviations[selectedDate],note,timestamp:new Date().toISOString()};save(d);document.getElementById('dev-note-area').style.display='none';renderPrescription(selectedDate);}
