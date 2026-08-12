// ---------------------------------------------------------------------------
// pages/home.js — Day strip, consistency score, day content.
//
// ARCHITECTURE.md §1.1: each pillar has its own default and its own control.
// There is no deviation tray here and no deviation write path anywhere in the
// app any more (§9.6) — for training, the per-exercise checkboxes on the
// prescription card are the whole record.
//
// Moved verbatim from index.html. No markup or logic changed.
//
// NOTE ON IMPORT CYCLE: fasting.js / log.js / etc. import renderHome() from
// here, and this file imports their renderers back. That cycle is safe only
// because every shared symbol is a hoisted `function` declaration. Do not
// convert these to `const fn = () => {}` — that would break the cycle at load.
// ---------------------------------------------------------------------------

// No store.js import: with setDeviation()/saveSwap() gone (§9.6) this file
// neither reads nor writes localStorage directly — everything it renders comes
// through derive.js.
import { today, dateStr, addDays } from '../util.js';
import { calcScore, sc, consistencyRows, getActiveScheduleForDate, WEEK_WINDOW_DAYS, MONTH_WINDOW_DAYS } from '../derive.js';
import { WCOLORS } from '../schedule.js';
import { renderPrescription } from './training.js';
import { renderFastingStatus } from './fasting.js';
import { renderVitalsHeader } from '../components/vitals-header.js';

let selectedDate=today();

export function getSelectedDate(){return selectedDate;}

export function buildDayStrip(){
  const strip=document.getElementById('day-strip');const now=new Date();const days=[];for(let i=-7;i<=7;i++)days.push(addDays(now,i));
  strip.innerHTML=days.map(dt=>{
    const ds=dateStr(dt);const dow=['Su','Mo','Tu','We','Th','Fr','Sa'][dt.getDay()];const sched=getActiveScheduleForDate(ds);const isToday=ds===today();const isSelected=ds===selectedDate;
    // The dot is the session category, full stop. It used to be overridden to
    // danger/accent5 by a 'missed'/'completed' deviation; both overrides went
    // with the deviation control (§9.6).
    let dotStyle=`background:${WCOLORS[sched.category]||'#6b6b8a'}`;
    const abbr=sched.rest?'REST':sched.category.substring(0,3).toUpperCase();
    return `<div class="day-card${isToday?' is-today':''}${isSelected?' selected':''}" onclick="selectDay('${ds}')"><span class="dc-dow">${dow}</span><span class="dc-num">${dt.getDate()}</span><span class="dc-type">${abbr}</span><div class="dc-dot" style="${dotStyle}"></div></div>`;
  }).join('');
  setTimeout(()=>{const cards=strip.querySelectorAll('.day-card');const idx=days.findIndex(dt=>dateStr(dt)===selectedDate);if(idx>=0&&cards[idx])cards[idx].scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});},50);
}

export function selectDay(ds){selectedDate=ds;buildDayStrip();renderHomeDayContent();}

export function renderHome(){renderVitalsHeader('vitals-header-home');buildDayStrip();renderHomeDayContent();}

export function renderHomeDayContent(){
  const ds=selectedDate;const isToday=ds===today();const dt=new Date(ds+'T12:00:00');const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('rx-section-label').textContent=isToday?"Today's Prescription":dayNames[dt.getDay()]+' — '+dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const score=calcScore(ds);
  document.getElementById('top-score').textContent=score.total||'—';
  renderScoreBox();
  // interactive=false: Home is a read-only view of the prescription card.
  // Scrolling past it must not accidentally toggle an exercise — Training is
  // where the checkboxes are meant to be tapped (§9.4/§9.6).
  renderPrescription(ds,undefined,false);renderFastingStatus(ds);
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

// ---------------------------------------------------------------------------
// THE DEVIATION WRITE PATH IS GONE — ARCHITECTURE.md §9.6.
//
// setDeviation() and saveSwap() lived here. They were the last two functions
// in the app that wrote d.deviations, and they are deleted along with the
// Training-page tray that was calling them. The five deviation types
// (completed / missed / swapped / makeup / skipped) are no longer a concept
// the UI can express at all.
//
// THE STORED DATA IS UNTOUCHED (§1.4). d.deviations remains a top-level key,
// app.js's migration guard still backfills it, and every record Ryan has
// already logged is preserved exactly as written. It is still READ by
// derive.js (deviationType(), getWorkoutForDate()) so existing history keeps
// scoring the way it always did — only the write path is gone.
//
// This is deliberate and is not a gap awaiting a new home for the control.
// ---------------------------------------------------------------------------
