// ---------------------------------------------------------------------------
// pages/training.js — The prescription card (today's session).
//
// Renders into #rx-container, which currently sits on the Home page. It lives
// here because it is training content: when the score-box nav of
// ARCHITECTURE.md §4 gets built, the Training page is already in place.
//
// NOTE ON IMPORT CYCLE: home.js imports renderPrescription from here, and this
// file imports renderHome back so a ticked checkbox can refresh the day strip
// and score box. That cycle is safe only because every shared symbol is a
// hoisted `function` declaration — the same rule home.js and fasting.js follow.
// Do not convert these to `const fn = () => {}`.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today } from '../util.js';
import { CATEGORY_COLORS, CATEGORY_BORDER, CATEGORY_COLOR_TEXT, PROGRESSION } from '../schedule.js';
// isPaused is no longer imported: the prescription card used to render a
// "ticks do not count while paused" state line, and pause no longer changes
// how a day scores (§9.5). openPause()/pausedDays() are still used by the
// program pause card below — pause itself is untouched (§9.1).
import { programWeek, mainLiftRx, openPause, pausedDays, isProgramStarted, getActiveScheduleForDate, exerciseLog, exerciseProgress } from '../derive.js';
import { renderVitalsHeader } from '../components/vitals-header.js';
import { renderHome, getSelectedDate } from './home.js';

// The Training page reached from the score box (§4). Vitals header, the
// program pause control, and today's (or the selected) prescription. The
// per-exercise checkboxes on that card are the whole record of a training
// day now — the deviation tray that used to sit below it is gone (§9.6).
export function renderTrainingPage(){
  renderVitalsHeader('vitals-header-training');
  renderProgramPause();
  const ds=getSelectedDate();
  updateTrainingSectionLabel(ds);
  // THE SAME-DAY LOCK (§9.4). Training used to hardcode `true` here. A day's
  // checkboxes are editable ONLY on that date; every other day renders through
  // the SAME read-only path Home already uses, so past and future days are
  // still fully visible, just inert. Home continues to pass false always.
  renderPrescription(ds,'training-rx-container',ds===today());
}

// Mirrors renderHomeDayContent()'s label in home.js: "Today's Prescription"
// when the selected date is today, the day name + date otherwise. Without
// this the section title would keep reading "Today's" for a past day pulled
// up via Home's day strip.
function updateTrainingSectionLabel(ds){
  const el=document.getElementById('training-rx-section-label');
  if(!el)return;
  const isToday=ds===today();
  const dt=new Date(ds+'T12:00:00');
  const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  el.textContent=isToday?"Today's Prescription":dayNames[dt.getDay()]+' — '+dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

// ---------------------------------------------------------------------------
// Program start / pause — ARCHITECTURE.md §9. TRAINING ONLY.
//
// THREE DISTINCT STATES: not started, running, paused.
//
// Not started: Alsruhe has never begun. There is no week number — programWeek()
// returns null, and the card offers Start instead of Pause. Starting sets
// today as the program's start date; week 1 then means week 1, not a
// meaningless calendar-days count from a hardcoded constant.
//
// Pausing holds the 12-week program clock so unpausing resumes at the same
// week. It changes nothing about fasting, sleep or dietary scoring. There is
// no global pause and this control must never become one.
//
// THE CONFIRMATION GATE IS DELIBERATE-ACTION PROTECTION, NOT SECURITY.
// A random 3-digit challenge renders above a numeric keypad with a cancel
// button, and the action commits only on an exact match. Its whole job is to
// make a pocket mis-tap impossible; anyone holding the phone can read the
// number off the screen, which is fine — that is not the threat. Start uses
// the SAME gate as pause/resume, deliberately: this is a decision Ryan should
// not trigger by mis-tap either.
//
// DO NOT simplify this to confirm(). A confirm dialog is one tap away from the
// same accident, and Safari renders it as a system sheet the thumb is already
// travelling toward. A new number is generated every time the gate opens, so
// the entry cannot become muscle memory.
//
// While the gate is open nothing is written. Cancel and a wrong code both
// leave the store untouched.
// ---------------------------------------------------------------------------

// null when the gate is closed, else {action:'pause'|'resume'|'start', code,
// entry, msg}. Deliberately module state, not stored: an abandoned gate must
// not survive.
let gate=null;

function newChallenge(){return String(Math.floor(100+Math.random()*900));}

export function renderProgramPause(){
  const el=document.getElementById('training-pause');
  if(!el)return;
  el.innerHTML=gate?gateHtml():cardHtml();
}

function cardHtml(){
  if(!isProgramStarted()){
    return `<div class="pause-card">`+
      `<div class="pause-state">Program not started</div>`+
      `<div class="pause-sub">Training the interim home routine until Alsruhe begins.</div>`+
      `<button class="pause-btn" onclick="openPauseGate('start')">Start program</button>`+
      `<div class="pause-hint">Starting sets today as Week 1, day 1. Fasting, sleep and dietary scoring are unaffected either way.</div>`+
    `</div>`;
  }
  const open=openPause();
  const ds=today();
  const wk=programWeek(ds);
  if(open){
    // "Dormant", not "week N of 12 · running" — the program is not advancing,
    // and the page has to say so rather than let a frozen number imply it.
    const days=pausedDays(ds);
    return `<div class="pause-card is-paused">`+
      `<div class="pause-state">Program dormant</div>`+
      `<div class="pause-sub">Held at week ${wk} of 12 · paused ${days} day${days===1?'':'s'} · since ${open.start}</div>`+
      `<button class="pause-btn is-paused" onclick="openPauseGate('resume')">Resume program</button>`+
      `<div class="pause-hint">Weeks do not advance while dormant. Fasting, sleep and dietary scoring are unaffected — pause is training only.</div>`+
    `</div>`;
  }
  return `<div class="pause-card">`+
    `<div class="pause-state">Program running</div>`+
    `<div class="pause-sub">Week ${wk} of 12</div>`+
    `<button class="pause-btn" onclick="openPauseGate('pause')">Pause program</button>`+
    `<div class="pause-hint">Pausing holds the program week until you resume. It does not touch fasting, sleep or dietary scoring.</div>`+
  `</div>`;
}

function gateHtml(){
  const verb=gate.action; // 'pause' | 'resume' | 'start' — all read fine as-is
  const slots=[0,1,2].map(i=>`<span class="keypad-slot${gate.entry.length>i?' is-filled':''}">${gate.entry[i]||''}</span>`).join('');
  const keys=['1','2','3','4','5','6','7','8','9'].map(k=>`<button class="keypad-key" onclick="pauseGateKey('${k}')">${k}</button>`).join('');
  return `<div class="pause-card">`+
    `<div class="pause-state">Confirm ${verb}</div>`+
    `<div class="pause-sub">Type this number to ${verb} the program.</div>`+
    `<div class="keypad-code">${gate.code}</div>`+
    `<div class="keypad-entry">${slots}</div>`+
    (gate.msg?`<div class="keypad-msg">${gate.msg}</div>`:'')+
    `<div class="keypad">${keys}`+
      `<span class="keypad-spacer"></span>`+
      `<button class="keypad-key" onclick="pauseGateKey('0')">0</button>`+
      `<button class="keypad-key keypad-alt" onclick="pauseGateBack()">⌫</button>`+
    `</div>`+
    `<button class="pause-btn keypad-cancel" onclick="closePauseGate()">Cancel</button>`+
  `</div>`;
}

// A fresh challenge every time, so the code can never be entered from memory.
export function openPauseGate(action){
  gate={action,code:newChallenge(),entry:'',msg:''};
  renderProgramPause();
}

export function closePauseGate(){
  gate=null;
  renderProgramPause();
}

export function pauseGateBack(){
  if(!gate)return;
  gate.entry=gate.entry.slice(0,-1);gate.msg='';
  renderProgramPause();
}

export function pauseGateKey(k){
  if(!gate||gate.entry.length>=3)return;
  gate.entry+=k;gate.msg='';
  if(gate.entry.length===3){
    if(gate.entry===gate.code){
      const action=gate.action;
      gate=null;
      if(action==='pause')pauseProgram();
      else if(action==='resume')resumeProgram();
      else if(action==='start')startProgram();
      renderTrainingPage();
      return;
    }
    // Wrong code writes nothing. The challenge stays put for the retry — a
    // number that moved mid-attempt would punish a fumbled thumb twice.
    gate.entry='';gate.msg='That is not the number shown. Nothing changed.';
  }
  renderProgramPause();
}

// Append-only (§1.4): opening a pause pushes a record, resuming closes the last
// open one. Neither ever rewrites an earlier entry.
function pauseProgram(){
  const d=db();
  if(!Array.isArray(d.programPauses))d.programPauses=[];
  if(d.programPauses.some(p=>p&&p.start&&!p.end))return; // already dormant
  d.programPauses.push({start:today(),end:null});
  save(d);
}

function resumeProgram(){
  const d=db();
  if(!Array.isArray(d.programPauses))return;
  for(let i=d.programPauses.length-1;i>=0;i--){
    const p=d.programPauses[i];
    if(p&&p.start&&!p.end){p.end=today();save(d);return;}
  }
}

// Writes the explicit program start date (§9.0) — a one-way transition out of
// "not started". Distinct from PROGRAM_START (schedule.js), which is now only
// a malformed-data fallback, never a semantic "already running" signal.
function startProgram(){
  const d=db();
  if(typeof d.programStart==='string'&&d.programStart)return; // already started — no-op
  d.programStart=today();
  save(d);
}

// ---------------------------------------------------------------------------
// Per-exercise checkboxes — ARCHITECTURE.md §9.4.
//
// A commercial gym produces genuine partial completion: the rack is taken, the
// hour runs out. Ticking records what was actually accomplished.
//
// THE CHECKBOXES RENDER INSIDE THE SHARED PRESCRIPTION CARD, which means they
// appear both on the Training page and on the Home page, for whichever day the
// Home day strip has selected. The strip is still how Ryan LOOKS at another
// day; it no longer makes that day editable.
//
// RETROACTIVE TICKING IS NOT ALLOWED (§9.5). A day's boxes can be changed only
// on that date, local civil day. At midnight it locks permanently — no grace
// window, no override. Past and future days still render in full, read-only.
//
// The handler is given the DATE it was rendered for, never today(), so a tick
// always lands on the day the card is showing — and toggleExercise() then
// re-checks that date against today() before it writes anything.
// ---------------------------------------------------------------------------

// The "3 of 12" line above the exercises.
//
// Its old job was to make untouched vs touched-but-empty visible, because the
// two looked identical but scored 100 and 0. That distinction is gone from
// scoring (§9.5) — an empty card is 0 either way — so the line now reports the
// two things that DO still matter: how much is ticked, and whether the day can
// still be edited.
//
// `editable` is the same-day lock (§9.4): true only when the card is showing
// today. Plain, unemotional wording; no confirmation dialogs anywhere near it.
function progressHtml(prog,log,editable,ds){
  let state,cls;
  if(!editable){
    state=prog.checked?'Locked — this day is closed':'Locked — nothing was logged on this day';
    cls=' is-locked';
  }
  else if(prog.checked===prog.total&&prog.total>0){state='All done';cls=' is-done';}
  else if(!prog.checked){state='Nothing ticked yet — an empty day scores 0. Editable until midnight.';cls='';}
  else state=`${prog.total-prog.checked} still open · editable until midnight`,cls=' is-partial';
  // The refusal notice (see toggleExercise). Same muted style as the state
  // line — plain, no dialog, no alarm colour, and it clears itself.
  const notice=(lockNotice&&lockNotice.ds===ds)?`<span class="rx-progress-state">${lockNotice.msg}</span>`:'';
  return `<div class="rx-progress${cls}"><span class="rx-progress-count">${prog.checked} of ${prog.total}</span><span class="rx-progress-state">${state}</span>${notice}</div>`;
}

// ---------------------------------------------------------------------------
// THE SILENT-REFUSAL BUG — fixed 2026-08-12.
//
// The lock is decided at RENDER time from today(). Leave the app open
// overnight — which is exactly what a phone in a gym bag does — and yesterday's
// card is still on screen rendered interactive, because nothing re-rendered it
// when the date rolled over. toggleExercise()'s guard correctly refused to
// write, but it refused SILENTLY: the box did not tick and nothing said why.
// That looks like a broken app, and Ryan had no way to tell the difference.
//
// Two halves, and both were needed:
//   - app.js re-renders on visibilitychange, so a rolled-over day comes back
//     rendered locked instead of falsely interactive.
//   - this notice, so the one tap that lands on a stale card before that
//     happens gets an honest answer.
//
// THE LOCK ITSELF IS NOT WEAKENED. Same-day only, no grace window (§9.5, Ryan's
// explicit decision). This is about honest feedback, not access.
// ---------------------------------------------------------------------------
let lockNotice=null;      // {ds, msg} — module state; a notice must not outlive the page
let lockNoticeTimer=null;
const LOCK_NOTICE_MS=6000;

function showLockNotice(ds){
  lockNotice={ds,msg:'That day is closed — boxes can only be ticked on the day itself.'};
  if(lockNoticeTimer)clearTimeout(lockNoticeTimer);
  lockNoticeTimer=setTimeout(function(){lockNotice=null;lockNoticeTimer=null;rerenderAfterToggle();},LOCK_NOTICE_MS);
  rerenderAfterToggle();
}

// Re-render whichever page the tap came from. Home owns the day strip, the
// score box and the status grid, all of which move when a box is ticked.
function rerenderAfterToggle(){
  if(document.getElementById('page-training').classList.contains('active'))renderTrainingPage();
  else renderHome();
}

// Toggle one exercise on one date. Writes {touched, checked[]} additively.
//
// ############ THE SAME-DAY LOCK — DEFENCE IN DEPTH (§9.4) ############
// A day is editable only on that date, local civil day. renderPrescription()
// already refuses to emit an onclick for any other day, which is the UI half of
// the rule. THIS GUARD IS THE GUARANTEE: it returns before touching the store,
// so a future session that changes the render cannot silently reopen the write
// path. Do not remove it on the grounds that "the buttons are disabled anyway".
//
// today() is local civil day (util.js, §12). Never toISOString().
//
// `touched` is still written on the first tap and never cleared. Post-epoch
// scoring no longer reads it, but the frozen legacy path does (§9.5) and §1.4
// forbids dropping the field.
export function toggleExercise(ds,idx){
  // Refuses to write, exactly as before — but now it SAYS so instead of doing
  // nothing visible. The re-render inside showLockNotice() also repaints the
  // card through the read-only path, so a stale interactive card from before a
  // midnight rollover corrects itself on the first tap.
  if(ds!==today()){showLockNotice(ds);return;}
  const ex=(getActiveScheduleForDate(ds).exercises||[])[idx];
  if(!ex)return;
  const d=db();
  if(!d.exerciseLogs||typeof d.exerciseLogs!=='object'||Array.isArray(d.exerciseLogs))d.exerciseLogs={};
  const cur=d.exerciseLogs[ds];
  const checked=Array.isArray(cur&&cur.checked)?cur.checked.slice():[];
  const at=checked.indexOf(ex.name);
  if(at>=0)checked.splice(at,1);else checked.push(ex.name);
  d.exerciseLogs[ds]={touched:true,checked};
  save(d);
  // A successful tick clears any lingering refusal notice — it is no longer
  // true, and leaving it up would be its own kind of lie.
  if(lockNotice){lockNotice=null;if(lockNoticeTimer){clearTimeout(lockNoticeTimer);lockNoticeTimer=null;}}
  rerenderAfterToggle();
}

// ---------------------------------------------------------------------------
// THE DEVIATION CONTROL WAS REMOVED FROM THIS PAGE — ARCHITECTURE.md §9.6.
//
// A tray of five buttons (Completed / Missed / Swapped / Make-up / Planned
// Skip) used to sit below the prescription card and write d.deviations. It is
// gone, along with DEV_TYPES, the swap <select> panel, trainingSetDeviation()
// and trainingSaveSwap(). THERE IS NO REPLACEMENT CONTROL: the per-exercise
// checkboxes on the card above are now the entire record of what happened on
// a training day.
//
// THE STORED KEY REMAINS (§1.4). d.deviations is still in the schema, still
// backfilled by app.js's migration guard, still listed in store.js's import
// sanity check, and every record Ryan has already logged is preserved
// byte-for-byte. What changed is that NOTHING IN THE UI WRITES IT ANY MORE.
//
// Do not "restore" this tray. Its removal was a decision, not a regression —
// the same mistake in reverse to the one ARCHITECTURE.md §9.6 used to record.
// ---------------------------------------------------------------------------

// containerId lets the same prescription card mount on Home and on the
// Training page without a second copy of the renderer. `interactive` is the
// ONE parameter controlling whether the checkboxes actually toggle — Home
// passes false so the card is visible and accurate but genuinely inert;
// Training passes true. This is deliberately the same renderer, not a fork
// (ARCHITECTURE.md §9.4/§9.6 and the Home read-only rule both depend on it).
// Anything other than the literal `false` is treated as interactive, so
// existing 2-argument callers keep working unchanged.
//
// NO DEVIATION BANNER. This card used to open with one of five banners
// ("✗ Missed", "↔ Swapped to: …", and so on) read from d.deviations. All five
// went with the control that wrote them (§9.6). The card no longer displays a
// deviation of any kind, and does not read d.deviations at all.
export function renderPrescription(ds,containerId,interactive){
  const editable=interactive!==false;
  const sched=getActiveScheduleForDate(ds);const catColor=CATEGORY_COLOR_TEXT[sched.category]||'var(--text)';const catBg=CATEGORY_COLORS[sched.category]||'transparent';const catBorder=CATEGORY_BORDER[sched.category]||'var(--border)';const dayName=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(ds+'T12:00:00').getDay()];
  // wk is null while the program has not been started (derive.js
  // programWeek()) — the interim home routine has no week number at all, not
  // week 1 and not a computed one. Nothing below may throw on that null.
  const wk=programWeek(ds);const phase=(wk!=null)?PROGRESSION[wk-1].phase:null;
  const weekTag=(wk!=null)?`Week ${wk} of 12 · ${phase}`:'Program not started';
  let html=`<div class="rx-card" style="border-color:${catBorder};background:${catBg}"><div class="rx-header"><div><div class="rx-day-label">${dayName}</div><div class="rx-session-name">${sched.session}</div><div class="rx-week-tag">${weekTag}</div></div><div class="rx-category-tag" style="color:${catColor};background:rgba(0,0,0,.2);border:1px solid ${catBorder}">${sched.category}</div></div>`;
  if(sched.rest)html+=`<div class="rx-rest-day"><div class="rx-rest-icon">🌿</div><div class="rx-rest-text">Full Rest — total recovery</div><div class="rx-rest-sub">Zero structured lifting or high-intensity cardio · hydration, protein, sleep</div></div>`;
  else if(sched.exercises&&sched.exercises.length){
    const rx=mainLiftRx(sched,ds);
    const log=exerciseLog(ds);const prog=exerciseProgress(ds);
    // Index into sched.exercises is what the handler receives; the NAME is what
    // gets stored. Passing the index keeps apostrophes ("World's Greatest
    // Stretch") out of the inline onclick attribute entirely.
    let idx=-1;
    const blocks=[];sched.exercises.forEach(ex=>{let b=blocks[blocks.length-1];if(!b||b.name!==ex.block){b={name:ex.block,items:[]};blocks.push(b);}b.items.push(ex);});
    html+=`<div class="rx-exercises">`;
    html+=progressHtml(prog,log,editable,ds);
    blocks.forEach(b=>{
      const isGiant=/Giant Set/i.test(b.name);
      html+=`<div class="rx-block-head">${b.name}</div>`;
      b.items.forEach((ex,i)=>{
        idx++;
        const marker=isGiant?String.fromCharCode(65+i):(i+1);
        const done=log.checked.includes(ex.name);
        let line='';
        if(ex.main&&rx)line=`<div class="rx-main-line${rx.weight==='set TM'?' rx-no-tm':''}"><div class="rx-main-rx">Week ${rx.week} — ${rx.phase} — ${rx.setsReps} @ ${rx.pctLabel} — ${rx.weight}</div><div class="rx-main-meta">Rest ${rx.rest} · ${rx.objective}</div></div>`;
        // Home renders this card with editable=false: no onclick attribute at
        // all (nothing to fire) plus the native `disabled` attribute, so a tap
        // is genuinely inert rather than merely styled to look that way.
        // Training always renders editable=true, unchanged.
        const clickAttr=editable?` onclick="toggleExercise('${ds}',${idx})"`:'';
        const disabledAttr=editable?'':' disabled';
        html+=`<button type="button" class="rx-exercise-item rx-ex-toggle${done?' is-done':''}" aria-pressed="${done?'true':'false'}"${clickAttr}${disabledAttr}>`+
          `<span class="rx-ex-box">${done?'✓':''}</span>`+
          `<span class="rx-ex-num">${marker}</span>`+
          `<div style="flex:1"><div class="rx-ex-name">${ex.name}</div><div class="rx-ex-equip">${ex.equip}</div>${ex.detail?`<div class="rx-ex-detail">${ex.detail}</div>`:''}${line}</div>`+
        `</button>`;
      });
    });
    html+=`</div>`;
  }
  html+=`</div>`;document.getElementById(containerId||'rx-container').innerHTML=html;
}
