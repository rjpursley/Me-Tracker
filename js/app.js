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

import { db, save, exportData, importData, seedSupplements } from './store.js';
// No date helpers imported any more: the boot prime's window maths moved into
// api.js's primeRecentVitals() so three callers share one definition.
import { primeRecentVitals } from './api.js';

import {
  renderHome, renderHomeDayContent, buildDayStrip, selectDay
} from './pages/home.js';
import { renderCalendar, setCalView, getCalView } from './pages/calendar.js';
import { renderHealth, saveBodyHeight, saveBodyAge, logBodyMeasurement, runSync,
         saveTargetHistory, targetGateKey, targetGateBack, targetGateCancel } from './pages/health.js';
import { renderBody, logSleep, logHR } from './pages/vitals.js';
import { renderDiet, logMeal, addSupplement, deleteSupplement, moveSupplement, toggleMacroChart,
         toggleIntakeChart } from './pages/dietary.js';
import { openMeals, mealAdd, mealRemove, mealSaveFood, mealEditFood, mealCancelEdit, mealDeleteFood,
         mealDeleteGateKey, mealDeleteGateBack, mealDeleteGateCancel,
         mealBarcodeTyped, mealBarcodeLookup, mealScanRecalc, mealScanEdited, mealScanServingTouched,
         mealScanRoute, mealScanCancel, mealScanSave, mealScanOneTime, mealAddOneTime,
         mealClearPendingBarcode } from './pages/meals.js';
import { initLogForms, setLogType, logWorkout, saveTargets } from './pages/log.js';
import { logFast, startActiveFast, stopActiveFast, renderFastingPage, toggleFastFail, saveFastFailNote } from './pages/fasting.js';
import { renderTrainingPage, openPauseGate, closePauseGate, pauseGateKey, pauseGateBack, toggleExercise } from './pages/training.js';
import { renderPRs, logOneRM } from './pages/prs.js';
import { renderVitalsHeader } from './components/vitals-header.js';

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
  renderPageById(id);
}

// Extracted from showPage() so the foreground refresh below can re-render
// whatever page is already open without navigating to it. One list of
// page-to-renderer, not two.
function renderPageById(id){
  if(id==='home')renderHome();
  if(id==='training')renderTrainingPage();
  if(id==='prs')renderPRs();
  if(id==='fasting')renderFastingPage();
  if(id==='calendar')renderCalendar(getCalView());
  if(id==='health')renderHealth();
  if(id==='body')renderBody();
  if(id==='diet')renderDiet();
  // openMeals() paints from the local mirror FIRST and only then refreshes it
  // from the server, so the page is instant and works with the server down.
  if(id==='meals')openMeals();
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
// NO window.setDeviation / window.saveSwap / window.trainingSetDeviation /
// window.trainingSaveSwap. The deviation control was removed (§9.6); the four
// functions those names pointed at no longer exist. The stored d.deviations
// key is untouched — see the migration guard at the bottom of this file.

window.setCalView=setCalView;
window.setLogType=setLogType;
window.saveTargets=saveTargets;

window.runSync=runSync;
window.saveBodyHeight=saveBodyHeight;
window.saveBodyAge=saveBodyAge;
window.logBodyMeasurement=logBodyMeasurement;
// Dated targets (§14). saveTargetHistory() only OPENS the confirm gate; the
// entry is appended by targetGateKey() on a matching digit and by nothing else.
window.saveTargetHistory=saveTargetHistory;
window.targetGateKey=targetGateKey;
window.targetGateBack=targetGateBack;
window.targetGateCancel=targetGateCancel;

window.openPauseGate=openPauseGate;
window.closePauseGate=closePauseGate;
window.pauseGateKey=pauseGateKey;
window.pauseGateBack=pauseGateBack;
window.toggleExercise=toggleExercise;
window.logOneRM=logOneRM;
window.addSupplement=addSupplement;
window.deleteSupplement=deleteSupplement;
window.moveSupplement=moveSupplement;
window.toggleMacroChart=toggleMacroChart;
window.toggleIntakeChart=toggleIntakeChart;

window.mealAdd=mealAdd;
window.mealRemove=mealRemove;
window.mealSaveFood=mealSaveFood;
window.mealEditFood=mealEditFood;
window.mealCancelEdit=mealCancelEdit;
window.mealDeleteFood=mealDeleteFood;
// The delete confirm gate (§13.9) — the same keypad pattern as the training
// pause gate, and the only way a delete commits. Nothing is written while it is
// open; a wrong digit and Cancel both leave the store and the library alone.
window.mealDeleteGateKey=mealDeleteGateKey;
window.mealDeleteGateBack=mealDeleteGateBack;
window.mealDeleteGateCancel=mealDeleteGateCancel;
// The barcode path (§13.6, §13.7). A lookup writes nothing; only mealScanSave()
// creates or updates anything, and only from an explicit tap.
window.mealBarcodeTyped=mealBarcodeTyped;
window.mealBarcodeLookup=mealBarcodeLookup;
window.mealScanRecalc=mealScanRecalc;
window.mealScanEdited=mealScanEdited;
window.mealScanServingTouched=mealScanServingTouched;
window.mealScanRoute=mealScanRoute;
window.mealScanCancel=mealScanCancel;
window.mealScanSave=mealScanSave;
// One-time consumed (§13.12). Writes ONE local entry into today's counts and
// makes no server call at all — no create, no /used ping, nothing to purge.
window.mealScanOneTime=mealScanOneTime;
window.mealAddOneTime=mealAddOneTime;
window.mealClearPendingBarcode=mealClearPendingBarcode;

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
  if(!d.exerciseLogs||typeof d.exerciseLogs!=='object'||Array.isArray(d.exerciseLogs)){d.exerciseLogs={};changed=true;}
  if(!d.oneRepMaxes||typeof d.oneRepMaxes!=='object'||Array.isArray(d.oneRepMaxes)){d.oneRepMaxes={};changed=true;}
  // SEED ONCE (§8.1). Only when the key is absent — an existing empty array
  // means Ryan deleted them all, and re-seeding would bring them back.
  if(!Array.isArray(d.supplements)){d.supplements=seedSupplements();changed=true;}
  // Additive: a store that predates the not-started/running/paused split gets
  // programStart backfilled to null (NOT to PROGRAM_START) — a store gaining
  // this field for the first time must read as "not started", not silently
  // become "already running since a hardcoded date". See derive.js.
  if(!('programStart' in d)){d.programStart=null;changed=true;}
  // Meal Tracker (§13). foodCounts is the day's servings — LOCAL data that
  // feeds the score (§1.2). foodLibrary is a read-only mirror of the server's
  // library, and foodLibraryFetchedAt is when it was last refreshed. All three
  // are additive and backfill empty, never with invented content.
  if(!d.foodCounts||typeof d.foodCounts!=='object'||Array.isArray(d.foodCounts)){d.foodCounts={};changed=true;}
  if(!Array.isArray(d.foodLibrary)){d.foodLibrary=[];changed=true;}
  if(!('foodLibraryFetchedAt' in d)){d.foodLibraryFetchedAt=null;changed=true;}
  // Dated targets (§14). Backfills EMPTY, never from d.targets — an empty
  // history means "no day was ever governed by a dated set", which is the
  // truth, and targetsFor() correctly returns null so every existing day keeps
  // falling back to the legacy flat object it was actually scored under.
  // MIGRATING d.targets IN HERE WOULD BE THE BUG: it would stamp today's goals
  // onto history as though they had always applied.
  if(!Array.isArray(d.targetHistory)){d.targetHistory=[];changed=true;}
  if(changed)save(d);
})();

renderHome();

// ---------------------------------------------------------------------------
// Prime the Google Health vitals cache (ARCHITECTURE.md §6) — one range
// fetch on boot, covering enough trailing days for weeklyRestingHR()'s 7-day
// window (derive.js) plus the Vitals page's 15-day averages. Every reader
// (vitals-header.js, derive.js's hasStartedActivity/getSleepForDate) is
// synchronous against whatever's already cached, so the first paint uses
// placeholders and this re-renders once the fetch actually resolves — never
// the other way around, which would mean showing something before knowing
// whether the server has anything at all (§1.7).
//
// The window itself (VITALS_PRIME_DAYS) and the date maths now live in
// api.js's primeRecentVitals(), because the foreground refresh below and the
// Sync now button need the identical window.
// ---------------------------------------------------------------------------
function currentPageId(){
  const active = document.querySelector('.page.active');
  return active ? active.id.replace(/^page-/, '') : null;
}

// Re-render everything that can show synced data or a date-dependent state.
// Home is always re-rendered because it owns the day strip and the score box
// even when it isn't the visible page.
function rerenderAfterRefresh(){
  renderVitalsHeader('vitals-header-home');
  renderVitalsHeader('vitals-header-training');
  renderHome();
  const id = currentPageId();
  // 'log' is deliberately skipped: it shows no synced value at all, and
  // initLogForms() resets the date inputs to today, which would quietly
  // rewrite a date Ryan had typed but not yet saved.
  //
  // 'meals' is skipped for the SAME reason: it shows no synced value either,
  // and openMeals() clears the add/edit form and any in-flight message, which
  // would silently discard a food Ryan had typed but not yet saved. Its counter
  // re-renders on every ADD/REMOVE anyway, so nothing goes stale for long.
  if(id && id !== 'home' && id !== 'log' && id !== 'meals') renderPageById(id);
}

primeRecentVitals().then(rerenderAfterRefresh);

// ---------------------------------------------------------------------------
// Refresh when the app comes back to the foreground.
//
// The cache used to be primed once, at boot, and never again. Ryan opens this
// app from his pocket: a session left open overnight showed yesterday's
// numbers indefinitely, and — worse — yesterday's training card still rendered
// as if it were editable, because the same-day lock (§9.5) is decided at
// RENDER time from today(). The write guard in toggleExercise() refused
// correctly, but silently. See the block comment in pages/training.js.
//
// TWO SPEEDS, ON PURPOSE:
//   - The RE-RENDER runs on every return to the foreground. It is local,
//     costs nothing, and it is what re-evaluates the lock — so a day rollover
//     is caught even with the server down or Tailscale off.
//   - The NETWORK re-prime is debounced to once a minute. Flicking between
//     apps for a few seconds must not fire a range fetch each time.
// ---------------------------------------------------------------------------
const FOREGROUND_REPRIME_MIN_MS = 60000;
let lastReprimeAt = Date.now();   // boot's prime counts as the first one
let repriming = false;

document.addEventListener('visibilitychange', function(){
  if(document.visibilityState !== 'visible') return;
  rerenderAfterRefresh();
  const now = Date.now();
  if(repriming || (now - lastReprimeAt) < FOREGROUND_REPRIME_MIN_MS) return;
  repriming = true;
  lastReprimeAt = now;
  primeRecentVitals().then(function(){
    repriming = false;
    rerenderAfterRefresh();
  }, function(){
    // primeRecentVitals() never rejects (api.js fails soft), but a stuck flag
    // would disable refreshing for the rest of the session — belt and braces.
    repriming = false;
  });
});
