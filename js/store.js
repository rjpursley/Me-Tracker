// ---------------------------------------------------------------------------
// store.js — Owner of the metracker_v2 schema.
//
// ARCHITECTURE.md §1.2: localStorage is the source of truth.
// ARCHITECTURE.md §1.4: the schema is additive-only. Never rename, retype or
// remove a key. New features add new top-level keys.
//
// THIS IS THE ONLY FILE THAT MAY TOUCH localStorage. If another module needs
// data, it imports db() and save() from here.
// ---------------------------------------------------------------------------

import { today } from './util.js';

const DB_KEY = 'metracker_v2';

// Additive only (§1.4). fastDeviations (§7.1), body (§10), programPauses (§9.1)
// and exerciseLogs (§9.4) were appended; no existing key was renamed, retyped
// or removed.
//
// programPauses is an ARRAY of {start, end} — dates as YYYY-MM-DD, end null
// while a pause is open. It is append-only: resuming closes the last entry by
// setting its end, and a later pause pushes a new entry. History is never
// rewritten, so "how long was the program dormant" stays answerable.
//
// exerciseLogs is an OBJECT keyed by date: {touched:true, checked:[name,...]}.
//
// `touched` and `checked` are two DIFFERENT FACTS and the training score
// depends on telling them apart:
//   - no record at all -> the day was never opened, so the session is assumed
//     to have happened and scores by the schedule fallback.
//   - {touched:true, checked:[]} -> the day WAS worked and nothing was done.
//     That scores 0, not 100.
// Ticking a box and then unticking it therefore leaves `touched` true. Do not
// "simplify" this by inferring touched from checked.length — that silently
// turns every abandoned session back into full compliance.
//
// Exercises are stored BY NAME, not by index, so reordering schedule.js cannot
// silently re-point a tick at a different movement. Names are also readable in
// an exported backup.
// oneRepMaxes is an OBJECT keyed by lift ('squat','ohp','dl','bench'), each an
// APPEND-ONLY array of {lbs, date} — tested maxes Ryan logged himself (§10.1).
// A new entry is pushed; an old one is never overwritten, so the history stays
// readable as progress over time.
//
// THE STORED NUMBER IS THE 1RM, NOT THE TRAINING MAX. Training Max is derived
// at render time as 1RM * 0.85 (§1.3, §10.1). The legacy targets.tm_* values
// are kept as a fallback for lifts with no 1RM yet and are never deleted (§1.4).
// supplements is a USER-EDITABLE array of {name, detail, icon} (§8.1).
//
// These three used to be hardcoded rows in index.html. They are SEED DATA now:
// a brand-new store starts with them, and the app.js guard backfills them onto
// a store written before the key existed.
//
// THE SEED RUNS ONLY WHEN THE KEY IS ABSENT. An existing empty array is a valid
// state meaning "Ryan deleted them all" — re-seeding would resurrect entries he
// removed on purpose. Each call returns fresh copies so no two stores share an
// object reference.
export const SEED_SUPPLEMENTS=[
  {name:'Himalayan Salt',      detail:'In water, daily',   icon:'🧂'},
  {name:'CoQ-10',              detail:'Cellular energy',   icon:'⚡'},
  {name:'Magnesium Threonate', detail:'Sleep + cognition', icon:'🧠'}
];
export function seedSupplements(){return SEED_SUPPLEMENTS.map(s=>({...s}));}

// programStart is a STRING (YYYY-MM-DD) once the Alsruhe program has been
// started, or null before that — a third state distinct from paused. Default
// is null, not the PROGRAM_START code constant (schedule.js): a fresh store
// must read as "not started", never as "already running since a hardcoded
// date". See derive.js's programStart()/isProgramStarted()/programWeek().
export function init(){return{fasts:[],workouts:[],sleeps:[],meals:[],hrs:[],targets:{},activeFast:null,deviations:{},fastDeviations:{},body:{},programPauses:[],exerciseLogs:{},oneRepMaxes:{},supplements:seedSupplements(),programStart:null};}
export function db(){try{return JSON.parse(localStorage.getItem(DB_KEY))||init();}catch(e){return init();}}
export function save(d){localStorage.setItem(DB_KEY,JSON.stringify(d));}

// ---------------------------------------------------------------------------
// Export / import — ARCHITECTURE.md §2.1, the localStorage origin trap.
//
// localStorage is scoped to the origin. Data saved under one hostname is
// invisible from another. Moving the app to Tailscale therefore requires a way
// to carry the data across. This also backs up against iOS evicting site data
// from infrequently-visited sites, which it does.
// ---------------------------------------------------------------------------

// Downloads the whole metracker_v2 blob as a dated JSON file.
export function exportData(){
  const raw = localStorage.getItem(DB_KEY) || JSON.stringify(init());
  const blob = new Blob([raw], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'metracker-backup-' + today() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// Reads a previously exported file back in. Confirms before overwriting,
// because this replaces everything. onDone runs only on a successful import.
export function importData(file, onDone){
  if(!file) return;
  const reader = new FileReader();
  reader.onerror = function(){ alert('Could not read that file.'); };
  reader.onload = function(){
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch(e){ alert('That file is not valid JSON — nothing was changed.'); return; }

    if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)){
      alert('That does not look like a Me-Tracker backup — nothing was changed.');
      return;
    }
    // Sanity check: a real backup carries at least one known top-level key.
    const known = ['fasts','workouts','sleeps','meals','hrs','targets','activeFast','deviations'];
    if(!known.some(k => k in parsed)){
      alert('That does not look like a Me-Tracker backup — nothing was changed.');
      return;
    }

    const counts = ['fasts','workouts','sleeps','meals','hrs']
      .filter(k => Array.isArray(parsed[k]))
      .map(k => parsed[k].length + ' ' + k)
      .join(', ');

    if(!confirm('Replace ALL current data with this backup?\n\nThe file contains: ' + (counts || 'no logged entries') + '.\n\nThis cannot be undone.')) return;

    localStorage.setItem(DB_KEY, JSON.stringify(parsed));
    alert('Backup restored.');
    if(onDone) onDone();
  };
  reader.readAsText(file);
}
