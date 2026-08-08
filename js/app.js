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
import { renderHealth } from './pages/health.js';
import { renderBody, logSleep, logHR } from './pages/vitals.js';
import { renderDiet, logMeal } from './pages/dietary.js';
import { initLogForms, setLogType, logWorkout, saveTargets } from './pages/log.js';
import { logFast, startActiveFast, stopActiveFast } from './pages/fasting.js';

// --- Drawer + navigation (moved verbatim from index.html) ------------------

function toggleDrawer(){const d=document.getElementById('drawer'),o=document.getElementById('drawer-overlay'),b=document.getElementById('hamburger-btn');const open=d.classList.toggle('open');o.classList.toggle('open',open);b.classList.toggle('open',open);}

function closeDrawer(){document.getElementById('drawer').classList.remove('open');document.getElementById('drawer-overlay').classList.remove('open');document.getElementById('hamburger-btn').classList.remove('open');}

function showPage(id,title){closeDrawer();document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.querySelectorAll('.drawer-item').forEach(b=>b.classList.remove('active'));document.getElementById('page-'+id).classList.add('active');document.getElementById('nav-'+id).classList.add('active');document.getElementById('topbar-title').textContent=title;if(id==='home')renderHome();if(id==='calendar')renderCalendar(getCalView());if(id==='health')renderHealth();if(id==='body')renderBody();if(id==='diet')renderDiet();if(id==='log')initLogForms();}

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

// Additive schema guard, moved verbatim from index.html.
(function(){const d=db();if(!d.deviations){d.deviations={};save(d);}})();

renderHome();
