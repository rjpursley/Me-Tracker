// ---------------------------------------------------------------------------
// pages/training.js — The prescription card (today's session).
//
// Renders into #rx-container, which currently sits on the Home page. It lives
// here because it is training content: when the score-box nav of
// ARCHITECTURE.md §4 gets built, the Training page is already in place.
//
// Moved verbatim from index.html. No markup or logic changed.
//
// NOT YET BUILT (§9): per-exercise checkboxes, live HR/zone/steps header.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today } from '../util.js';
import { getScheduleForDate, CATEGORY_COLORS, CATEGORY_BORDER, CATEGORY_COLOR_TEXT, PROGRESSION } from '../schedule.js';
import { programWeek, mainLiftRx, openPause, pausedDays } from '../derive.js';
import { renderVitalsHeader } from '../components/vitals-header.js';

// The Training page reached from the score box (§4). Currently the vitals
// header, the program pause control and today's prescription; §9 lists what
// else belongs here once built.
export function renderTrainingPage(){
  renderVitalsHeader('vitals-header-training');
  renderProgramPause();
  renderPrescription(today(),'training-rx-container');
}

// ---------------------------------------------------------------------------
// Program pause — ARCHITECTURE.md §9. TRAINING ONLY.
//
// Pausing holds the 12-week program clock so unpausing resumes at the same
// week. It changes nothing about fasting, sleep or dietary scoring. There is
// no global pause and this control must never become one.
//
// THE CONFIRMATION GATE IS DELIBERATE-ACTION PROTECTION, NOT SECURITY.
// A random 3-digit challenge renders above a numeric keypad with a cancel
// button, and the pause commits only on an exact match. Its whole job is to
// make a pocket mis-tap impossible; anyone holding the phone can read the
// number off the screen, which is fine — that is not the threat.
//
// DO NOT simplify this to confirm(). A confirm dialog is one tap away from the
// same accident, and Safari renders it as a system sheet the thumb is already
// travelling toward. A new number is generated every time the gate opens, so
// the entry cannot become muscle memory.
//
// While the gate is open nothing is written. Cancel and a wrong code both
// leave the store untouched.
// ---------------------------------------------------------------------------

// null when the gate is closed, else {action:'pause'|'resume', code, entry, msg}.
// Deliberately module state, not stored: an abandoned gate must not survive.
let gate=null;

function newChallenge(){return String(Math.floor(100+Math.random()*900));}

export function renderProgramPause(){
  const el=document.getElementById('training-pause');
  if(!el)return;
  el.innerHTML=gate?gateHtml():cardHtml();
}

function cardHtml(){
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
  const verb=gate.action==='pause'?'pause':'resume';
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
      if(action==='pause')pauseProgram();else resumeProgram();
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
