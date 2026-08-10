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
import { today, esc } from '../util.js';
import { getScheduleForDate, CATEGORY_COLORS, CATEGORY_BORDER, CATEGORY_COLOR_TEXT, PROGRESSION } from '../schedule.js';
import { programWeek, mainLiftRx, openPause, pausedDays, isPaused, exerciseLog, exerciseProgress } from '../derive.js';
import { renderVitalsHeader } from '../components/vitals-header.js';
import { renderHome, getSelectedDate, setDeviation, saveSwap } from './home.js';

// The Training page reached from the score box (§4). Vitals header, the
// program pause control, today's (or the selected) prescription, and the
// deviation control; §9 lists what else belongs here once built.
export function renderTrainingPage(){
  renderVitalsHeader('vitals-header-training');
  renderProgramPause();
  const ds=getSelectedDate();
  updateTrainingSectionLabel(ds);
  renderPrescription(ds,'training-rx-container');
  renderDeviationTray();
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

// ---------------------------------------------------------------------------
// Per-exercise checkboxes — ARCHITECTURE.md §9.4.
//
// A commercial gym produces genuine partial completion: the rack is taken, the
// hour runs out. Ticking records what was actually accomplished.
//
// THE CHECKBOXES RENDER INSIDE THE SHARED PRESCRIPTION CARD, which means they
// appear both on the Training page (today) and on the Home page (whichever day
// the strip has selected). That is deliberate: retroactive ticking is allowed
// with no time limit, and the Home day strip is the date picker that already
// exists. Building a second one on the Training page would be a worse version
// of it.
//
// The handler is given the DATE it was rendered for, never today(), so a tick
// always lands on the day the card is showing.
// ---------------------------------------------------------------------------

// The "3 of 12" line above the exercises. It exists to make the untouched vs
// touched-but-empty distinction visible, because the two look identical on the
// card — every box unticked — but score 100 and 0 respectively.
function progressHtml(prog,log,dormant){
  let state,cls;
  if(dormant){state='Program dormant — ticks are recorded but do not count while paused';cls=' is-dormant';}
  else if(!log.touched){state='Not started — an untouched day counts as done';cls='';}
  else if(prog.checked===prog.total){state='All done';cls=' is-done';}
  else state=`${prog.total-prog.checked} still open`,cls=' is-partial';
  return `<div class="rx-progress${cls}"><span class="rx-progress-count">${prog.checked} of ${prog.total}</span><span class="rx-progress-state">${state}</span></div>`;
}

// Toggle one exercise on one date. Writes {touched, checked[]} additively.
//
// `touched` is set on the FIRST tap and never cleared — unticking everything
// leaves the day marked as worked, which is what makes "touched but empty"
// score 0 instead of reverting to the assumed-done default.
export function toggleExercise(ds,idx){
  const ex=(getScheduleForDate(ds).exercises||[])[idx];
  if(!ex)return;
  const d=db();
  if(!d.exerciseLogs||typeof d.exerciseLogs!=='object'||Array.isArray(d.exerciseLogs))d.exerciseLogs={};
  const cur=d.exerciseLogs[ds];
  const checked=Array.isArray(cur&&cur.checked)?cur.checked.slice():[];
  const at=checked.indexOf(ex.name);
  if(at>=0)checked.splice(at,1);else checked.push(ex.name);
  d.exerciseLogs[ds]={touched:true,checked};
  save(d);
  // Re-render whichever page the tap came from. Home owns the day strip, the
  // score box and the status grid, all of which move when a box is ticked.
  if(document.getElementById('page-training').classList.contains('active'))renderTrainingPage();
  else renderHome();
}

// ---------------------------------------------------------------------------
// Deviation control — RESTORED here, on the Training page (§1.1, §9.5).
//
// It used to live in a tray on the Home page. A prior session removed that
// tray as UI cleanup without giving the write path a new home, which left
// d.deviations with no way to be set by tapping anything — an open gap
// flagged explicitly in ARCHITECTURE.md. This is that fix. It lives here,
// next to the exercise checkboxes, because this is where Ryan already is
// when recording what actually happened in a session.
//
// SAME TYPES, SAME STORED SHAPE. setDeviation() and saveSwap() are the exact
// functions home.js already has — imported and called directly below, not
// reimplemented. No note input: notes are deprecated (see the comment above
// renderPrescription).
//
// OPERATES ON getSelectedDate(), NOT today(). That is the same "selected
// date" the Home day strip sets and the same date renderPrescription() (and
// therefore the checkboxes) is now rendered against on this page — see
// renderTrainingPage() above. Marking a day Missed and looking at that same
// day's checkboxes are always talking about the same date, and retroactive
// marking works exactly like retroactive ticking: pick a day on Home's
// strip, then act on it from here.
// ---------------------------------------------------------------------------

const DEV_TYPES=[
  {type:'completed',icon:'✓',label:'Completed',cls:''},
  {type:'missed',icon:'✗',label:'Missed',cls:' missed-btn'},
  {type:'swapped',icon:'↔',label:'Swapped',cls:''},
  {type:'makeup',icon:'⟳',label:'Make-up',cls:''},
  {type:'skipped',icon:'⏭',label:'Planned Skip',cls:' skip-btn'}
];

const SWAP_OPTIONS=['Resistance','Zone 2','Bodyweight','Wtd Walk','HIIT','Mobility','Other'];

// Open only right after Swapped is tapped ON, not on every re-render — a
// checkbox tick elsewhere on the page must not reopen a panel Ryan closed.
let swapAreaOpen=false;

function renderDeviationTray(){
  const el=document.getElementById('training-deviation-tray');
  if(!el)return;
  const ds=getSelectedDate();
  const dev=(db().deviations||{})[ds];
  const devType=dev&&dev.type;
  const btns=DEV_TYPES.map(d=>`<button class="dev-btn${d.cls}${devType===d.type?' active-btn':''}" onclick="trainingSetDeviation('${d.type}')"><span class="dev-icon">${d.icon}</span><span class="dev-label">${d.label}</span></button>`).join('');
  let swapHtml='';
  if(devType==='swapped'&&swapAreaOpen){
    const opts=SWAP_OPTIONS.map(o=>`<option value="${o}"${dev.swap===o?' selected':''}>${o}</option>`).join('');
    swapHtml=`<div style="margin-top:8px"><div class="form-label">What did you do instead?</div><select id="training-dev-swap-select">${opts}</select><button class="btn btn-primary" style="margin-top:8px" onclick="trainingSaveSwap()">Save Swap</button></div>`;
  }
  el.innerHTML=`<div class="deviation-tray-label">Log a Deviation</div><div class="dev-btn-grid">${btns}</div>${swapHtml}`;
}

// Wraps setDeviation(): that function only knows how to redraw Home's own
// containers (§ its own comment), so this also refreshes the Training page's
// prescription card and the tray itself. Toggle-off (tapping the already-
// active button) is setDeviation()'s existing behaviour, unchanged here — it
// clears the deviation, which is what "clearing returns the day to the
// checkbox ratio" means in the verification notes.
export function trainingSetDeviation(type){
  const ds=getSelectedDate();
  const wasActive=(((db().deviations||{})[ds])||{}).type===type;
  setDeviation(type);
  swapAreaOpen=(type==='swapped'&&!wasActive);
  renderPrescription(ds,'training-rx-container');
  renderDeviationTray();
}

export function trainingSaveSwap(){
  const sel=document.getElementById('training-dev-swap-select');
  saveSwap(sel?sel.value:'Other');
  swapAreaOpen=false;
  renderPrescription(getSelectedDate(),'training-rx-container');
  renderDeviationTray();
}

// containerId lets the same prescription card mount on Home and on the
// Training page without a second copy of the renderer.
// Deviation notes are DEPRECATED: the note input was removed and nothing writes
// `note` any more. Existing notes stay in storage and still render here, so the
// value is HTML-escaped on the way out — it used to be injected raw. Do not
// delete the field from stored records; §1.4 forbids it.
export function renderPrescription(ds,containerId){
  const sched=getScheduleForDate(ds);const d=db();const dev=d.deviations&&d.deviations[ds];const catColor=CATEGORY_COLOR_TEXT[sched.category]||'var(--text)';const catBg=CATEGORY_COLORS[sched.category]||'transparent';const catBorder=CATEGORY_BORDER[sched.category]||'var(--border)';const dayName=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(ds+'T12:00:00').getDay()];
  const wk=programWeek(ds);const phase=PROGRESSION[wk-1].phase;
  let html=`<div class="rx-card" style="border-color:${catBorder};background:${catBg}"><div class="rx-header"><div><div class="rx-day-label">${dayName}</div><div class="rx-session-name">${sched.session}</div><div class="rx-week-tag">Week ${wk} of 12 · ${phase}</div></div><div class="rx-category-tag" style="color:${catColor};background:rgba(0,0,0,.2);border:1px solid ${catBorder}">${sched.category}</div></div>`;
  if(dev&&dev.type==='missed')html+=`<div style="padding:0 16px 16px"><div class="alert err" style="margin:0">✗ Missed</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${esc(dev.note)}</div>`:''}</div>`;
  else if(dev&&dev.type==='swapped')html+=`<div style="padding:0 16px 16px"><div class="alert warn" style="margin:0">↔ Swapped to: ${dev.swap||'other'}</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${esc(dev.note)}</div>`:''}</div>`;
  else if(dev&&dev.type==='completed')html+=`<div style="padding:0 16px 16px"><div class="alert success" style="margin:0">✓ Marked Completed</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${esc(dev.note)}</div>`:''}</div>`;
  else if(dev&&dev.type==='skipped')html+=`<div style="padding:0 16px 16px"><div class="alert" style="margin:0;background:rgba(107,107,138,.1);border-color:var(--muted);color:var(--muted)">⏭ Planned skip</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${esc(dev.note)}</div>`:''}</div>`;
  else if(dev&&dev.type==='makeup')html+=`<div style="padding:0 16px 16px"><div class="alert info" style="margin:0">⟳ Make-up session</div>${dev.note?`<div style="font-size:12px;font-family:var(--font-mono);color:var(--muted);margin-top:8px">${esc(dev.note)}</div>`:''}</div>`;
  if(sched.rest)html+=`<div class="rx-rest-day"><div class="rx-rest-icon">🌿</div><div class="rx-rest-text">Full Rest — total recovery</div><div class="rx-rest-sub">Zero structured lifting or high-intensity cardio · hydration, protein, sleep</div></div>`;
  else if(sched.exercises&&sched.exercises.length){
    const rx=mainLiftRx(sched,ds);
    const log=exerciseLog(ds);const prog=exerciseProgress(ds);const dormant=isPaused(ds);
    // Index into sched.exercises is what the handler receives; the NAME is what
    // gets stored. Passing the index keeps apostrophes ("World's Greatest
    // Stretch") out of the inline onclick attribute entirely.
    let idx=-1;
    const blocks=[];sched.exercises.forEach(ex=>{let b=blocks[blocks.length-1];if(!b||b.name!==ex.block){b={name:ex.block,items:[]};blocks.push(b);}b.items.push(ex);});
    html+=`<div class="rx-exercises">`;
    html+=progressHtml(prog,log,dormant);
    blocks.forEach(b=>{
      const isGiant=/Giant Set/i.test(b.name);
      html+=`<div class="rx-block-head">${b.name}</div>`;
      b.items.forEach((ex,i)=>{
        idx++;
        const marker=isGiant?String.fromCharCode(65+i):(i+1);
        const done=log.checked.includes(ex.name);
        let line='';
        if(ex.main&&rx)line=`<div class="rx-main-line${rx.weight==='set TM'?' rx-no-tm':''}"><div class="rx-main-rx">Week ${rx.week} — ${rx.phase} — ${rx.setsReps} @ ${rx.pctLabel} — ${rx.weight}</div><div class="rx-main-meta">Rest ${rx.rest} · ${rx.objective}</div></div>`;
        html+=`<button type="button" class="rx-exercise-item rx-ex-toggle${done?' is-done':''}" aria-pressed="${done?'true':'false'}" onclick="toggleExercise('${ds}',${idx})">`+
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
