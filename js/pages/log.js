// ---------------------------------------------------------------------------
// pages/log.js — The Log Entry page: form switching, workout logging, targets.
//
// This file is NOT in the ARCHITECTURE.md §3 tree. Like calendar.js it exists
// because the drawer's "Log Entry" page exists today and §4 keeps the drawer
// unchanged. The individual save handlers live with their domain
// (fasting.js, vitals.js, dietary.js); what stays here is the page shell,
// the workout form, and the shared targets card.
//
// Moved verbatim from index.html. No logic changed.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today } from '../util.js';
import { mainLiftStatus } from '../derive.js';
import { startFastTimer } from './fasting.js';
import { renderHome } from './home.js';

// ---------------------------------------------------------------------------
// The legacy Training Max card — ARCHITECTURE.md §10.1.
//
// TM is now DERIVED from a tested 1RM (TM = 1RM * 0.85), entered on the Records
// page. These direct-entry inputs are the old way, kept because §1.4 forbids
// deleting targets.tm_*.
//
// A LIFT WITH A 1RM RENDERS AS TEXT WITH NO INPUT AT ALL. That is deliberate
// and load-bearing: saveTargets() below writes every tm_* input it can find, so
// leaving a disabled input on screen showing the DERIVED TM would let a save
// overwrite the legacy stored value with a derived one. No element, no write.
//
// A lift with no 1RM keeps its editable input, so old data keeps working and
// the card doubles as the list of lifts still needing a 1RM.
// ---------------------------------------------------------------------------
export function renderLegacyTMs(){
  const el=document.getElementById('legacy-tm-card');
  if(!el)return;
  const tgts=db().targets||{};
  el.innerHTML=mainLiftStatus().map(l=>{
    const inputId='ft-'+l.tmKey.replace('_','-');
    if(l.source==='1rm'){
      return `<div class="form-row is-retired">`+
        `<div class="form-label">${l.name} TM (lbs) <span class="tag-inactive">from 1RM</span></div>`+
        `<div class="target-row"><span class="target-label">Training Max</span><span class="target-val">${Math.round(l.tm*10)/10} lb</span></div>`+
        `<div class="form-note">1RM ${l.oneRM} lb set ${l.date} → TM ${Math.round(l.tm*10)/10} lb. Update it on the Records page.</div>`+
      `</div>`;
    }
    const val=tgts[l.tmKey]!=null?String(tgts[l.tmKey]):'';
    const note=l.source==='legacy'
      ? 'No 1RM logged yet — still using this typed TM. Add a tested 1RM on the Records page and it will take over.'
      : 'No 1RM and no TM. The prescription card will read "set TM" until one exists.';
    return `<div class="form-row">`+
      `<div class="form-label">${l.name} TM (lbs) <span class="tag-inactive">needs 1RM</span></div>`+
      `<input type="number" id="${inputId}" placeholder="e.g. 315" value="${val}" onchange="saveTargets()">`+
      `<div class="form-note">${note}</div>`+
    `</div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// DEPRECATED: targets.daily — the "Daily fast goal (hours)" field.
//
// It no longer affects any score. Fasting is binary (§7.1): silence means the
// fast held, the Fasting Fail button marks a break, and there is no
// hours-completed grading. Dividing logged hours by this goal is exactly the
// behaviour that was removed.
//
// THE STORED VALUE IS KEPT — §1.4 makes the schema additive-only, so
// targets.daily stays in localStorage and is still loaded into the input below
// so the old number remains visible. The input is disabled in index.html and
// labelled "inactive".
//
// DO NOT rewire this into scoring. If a future session wants an hours target
// again, that is a conversation with Ryan, not a reconnection of a dead wire.
// ---------------------------------------------------------------------------
export function initLogForms(){const d=db(),tgts=d.targets||{},ts=today();['fast-date','workout-date','sleep-date','meal-date','hr-date'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=ts;});if(tgts.daily)document.getElementById('ft-daily').value=tgts.daily;if(tgts.sleep)document.getElementById('ft-sleep').value=tgts.sleep;if(tgts.protein)document.getElementById('ft-protein').value=tgts.protein;
  // renderLegacyTMs() owns the four TM rows and their values now — it decides
  // per lift whether there is an input at all. Do not also set them here.
  renderLegacyTMs();
  if(d.activeFast){document.getElementById('fast-active-display').style.display='block';document.getElementById('fast-start-btn-wrap').style.display='none';document.getElementById('fast-stop-btn-wrap').style.display='block';startFastTimer();}}

export function setLogType(t,btn){document.querySelectorAll('[id^=form-]').forEach(f=>f.style.display='none');document.querySelectorAll('.toggle-row .toggle-btn').forEach(b=>b.classList.remove('active'));document.getElementById('form-'+t).style.display='block';if(btn)btn.classList.add('active');}

export function logWorkout(){const d=db();d.workouts.push({type:document.getElementById('workout-type').value,duration:document.getElementById('workout-duration').value,notes:document.getElementById('workout-notes').value,date:document.getElementById('workout-date').value||today()});save(d);alert('Workout logged!');renderHome();}

export function saveTargets(){const d=db();d.targets=d.targets||{};const allFields={daily:'ft-daily',sleep:'ft-sleep',protein:'ft-protein',fat:'target-fat',sugar:'target-sugar',tm_squat:'ft-tm-squat',tm_ohp:'ft-tm-ohp',tm_dl:'ft-tm-dl',tm_bench:'ft-tm-bench'};Object.entries(allFields).forEach(([k,id])=>{const el=document.getElementById(id);if(el&&el.value)d.targets[k]=el.value;});['target-protein','target-fat','target-sugar'].forEach(id=>{const el=document.getElementById(id);if(el&&el.value){if(id==='target-protein')d.targets.protein=el.value;if(id==='target-fat')d.targets.fat=el.value;if(id==='target-sugar')d.targets.sugar=el.value;}});save(d);renderHome();}
