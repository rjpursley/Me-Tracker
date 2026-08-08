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
import { startFastTimer } from './fasting.js';
import { renderHome } from './home.js';

export function initLogForms(){const d=db(),tgts=d.targets||{},ts=today();['fast-date','workout-date','sleep-date','meal-date','hr-date'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=ts;});if(tgts.daily)document.getElementById('ft-daily').value=tgts.daily;if(tgts.sleep)document.getElementById('ft-sleep').value=tgts.sleep;if(tgts.protein)document.getElementById('ft-protein').value=tgts.protein;
  Object.entries({tm_squat:'ft-tm-squat',tm_ohp:'ft-tm-ohp',tm_dl:'ft-tm-dl',tm_bench:'ft-tm-bench'}).forEach(([k,id])=>{const el=document.getElementById(id);if(el&&tgts[k])el.value=tgts[k];});if(d.activeFast){document.getElementById('fast-active-display').style.display='block';document.getElementById('fast-start-btn-wrap').style.display='none';document.getElementById('fast-stop-btn-wrap').style.display='block';startFastTimer();}}

export function setLogType(t,btn){document.querySelectorAll('[id^=form-]').forEach(f=>f.style.display='none');document.querySelectorAll('.toggle-row .toggle-btn').forEach(b=>b.classList.remove('active'));document.getElementById('form-'+t).style.display='block';if(btn)btn.classList.add('active');}

export function logWorkout(){const d=db();d.workouts.push({type:document.getElementById('workout-type').value,duration:document.getElementById('workout-duration').value,notes:document.getElementById('workout-notes').value,date:document.getElementById('workout-date').value||today()});save(d);alert('Workout logged!');renderHome();}

export function saveTargets(){const d=db();d.targets=d.targets||{};const allFields={daily:'ft-daily',sleep:'ft-sleep',protein:'ft-protein',fat:'target-fat',sugar:'target-sugar',tm_squat:'ft-tm-squat',tm_ohp:'ft-tm-ohp',tm_dl:'ft-tm-dl',tm_bench:'ft-tm-bench'};Object.entries(allFields).forEach(([k,id])=>{const el=document.getElementById(id);if(el&&el.value)d.targets[k]=el.value;});['target-protein','target-fat','target-sugar'].forEach(id=>{const el=document.getElementById(id);if(el&&el.value){if(id==='target-protein')d.targets.protein=el.value;if(id==='target-fat')d.targets.fat=el.value;if(id==='target-sugar')d.targets.sugar=el.value;}});save(d);renderHome();}
