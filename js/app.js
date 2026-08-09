// ---------------------------------------------------------------------------
// app.js — Entry point. Wires the modules to the shell in index.html.
//
// This file is NOT in the ARCHITECTURE.md §3 tree. A module-based app needs one
// entry script, and putting that bootstrap inline in index.html would defeat
// "index.html is shell only". It owns no domain logic — only navigation,
// drawer, and the window bindings below.
//
// WHY THE window.* ASSIGNMENTS: index.html uses inline onclick="" attributes
// throughout. Inline handlers resolve against the global scope, but ES modules
// have their own scope, so imported functions are invisible to them. Exposing
// them on window keeps the existing HTML working byte-for-byte. Rewriting every
// handler to addEventListener would have been a behaviour change, which this
// split explicitly was not allowed to make.
// ---------------------------------------------------------------------------

import { db, save, exportData, importData } from './store.js';

import {
  renderHome, renderHomeDayContent, buildDayStrip, selectDay,
  setDeviation, toggleSwapArea, toggleNoteArea, saveSwap, saveNote
} from './pages/home.js';
import { renderCalendar, setCalView, getCalView } from './pages/calendar.js';
import { renderHealth, saveBodyHeight, logBodyMeasurement } from './pages/health.js';
import { renderBody, logSleep, logHR } from './pages/vitals.js';
import { renderDiet, logMeal } from './pages/dietary.js';
import { initLogForms, setLogType, logWorkout, saveTargets } from './pages/log.js';
import { logFast, startActiveFast, stopActiveFast, renderFastingPage, toggleFastFail, saveFastFailNote } from './pages/fasting.js';
import { renderTrainingPage, openPauseGate, closePauseGate, pauseGateKey, pauseGateBack } from './pages/training.js';

// --- Drawer + navigation (moved verbatim from index.html) ------------------

function toggleDrawer(){const d=document.getElementById('drawer'),o=document.getElementById('drawer-overlay'),b=document.getElementById('hamburger-btn');const open=d.classList.toggle('open');o.classList.toggle('open',open);b.classList.toggle('open',open);}

function closeDrawer(){document.getElementById('drawer').classList.remove('open');document.getElementById('drawer-overlay').classList.remove('open');document.getElementById('hamburger-btn').classList.remove('open');}

function showPage(id,title){
  closeDrawer();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.drawer-item').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  // Training and Fasting are reached from the score box, not the drawer, so
  // they have no nav- item to highlight. Guard rather than assume one exists.
  const nav=document.getElementById('nav-'+id);
  if(nav)nav.classList.add('active');
  document.getElementById('topbar-title').textContent=title;
  // The score box sits below the fold, so a row tap can land mid-page on the
  // destination. Start every page at the top.
  window.scrollTo(0,0);
  if(id==='home')renderHome();
  if(id==='training')renderTrainingPage();
  if(id==='fasting')renderFastingPage();
  if(id==='calendar')renderCalendar(getCalView());
  if(id==='health')renderHealth();
  if(id==='body')renderBody();
  if(id==='diet')renderDiet();
  if(id==='log')initLogForms();
}

// --- Backup / restore (ARCHITECTURE.md §2.1) -------------------------------

function handleExport(){
  exportData();
  closeDrawer();
}

function handleImportPick(){
  document.getElementById('import-file-input').click();
}

function handleImportFile(ev){
  const file = ev.target.files && ev.target.files[0];
  importData(file, function(){
    closeDrawer();
    showPage('home','Me-Tracker');
  });
  // Reset so picking the same file twice still fires a change event.
  ev.target.value = '';
}

// --- Expose the inline-onclick handlers -------------------------------------

window.toggleDrawer=toggleDrawer;
window.closeDrawer=closeDrawer;
window.showPage=showPage;

window.selectDay=selectDay;
window.setDeviation=setDeviation;
window.toggleSwapArea=toggleSwapArea;
window.toggleNoteArea=toggleNoteArea;
window.saveSwap=saveSwap;
window.saveNote=saveNote;

window.setCalView=setCalView;
window.setLogType=setLogType;
window.saveTargets=saveTargets;

window.saveBodyHeight=saveBodyHeight;
window.logBodyMeasurement=logBodyMeasurement;

window.openPauseGate=openPauseGate;
window.closePauseGate=closePauseGate;
window.pauseGateKey=pauseGateKey;
window.pauseGateBack=pauseGateBack;

window.toggleFastFail=toggleFastFail;
window.saveFastFailNote=saveFastFailNote;

window.logFast=logFast;
window.startActiveFast=startActiveFast;
window.stopActiveFast=stopActiveFast;
window.logWorkout=logWorkout;
window.logSleep=logSleep;
window.logMeal=logMeal;
window.logHR=logHR;

// --- Boot -------------------------------------------------------------------

document.getElementById('btn-export-data').addEventListener('click', handleExport);
document.getElementById('btn-import-data').addEventListener('click', handleImportPick);
document.getElementById('import-file-input').addEventListener('change', handleImportFile);

// Additive schema guard. Backfills new top-level keys onto stores written by an
// older version. Never rewrites or migrates an existing key (§1.4).
(function(){
  const d=db();let changed=false;
  if(!d.deviations){d.deviations={};changed=true;}
  if(!d.fastDeviations){d.fastDeviations={};changed=true;}
  if(!d.body){d.body={};changed=true;}
  if(!Array.isArray(d.programPauses)){d.programPauses=[];changed=true;}
  if(changed)save(d);
})();

renderHome();
