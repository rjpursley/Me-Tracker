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
// exerciseLogs is an OBJECT keyed by date:
//   {touched:true, checked:[name,...], times:{name:'<UTC ISO>', ...}}
//
// `times` was ADDED 2026-08-12 as a third sibling key (§9.4). `touched` and
// `checked` are unchanged in shape and meaning. A tick writes times[name]; an
// UNTICK DELETES it; a re-tick writes a fresh stamp — so `times` can never
// hold a name that is not also in `checked`.
//
// THE VALUE IS A UTC ISO INSTANT, deliberately unlike hrSeries.at, which is
// local wall clock (§6.12). Convert to local for display only.
//
// ABSENCE IS THE BOUNDARY. Days logged before that commit have no `times` key
// at all and are never given one — no migration, no backfill, no default {}.
//
// `touched` and `checked` are two DIFFERENT FACTS. They used to score
// differently — no record meant "assumed done" and fell through to the schedule
// fallback, while {touched:true, checked:[]} scored 0. AS OF 2026-08-12 BOTH
// SCORE 0: empty checkboxes mean it did not happen (ARCHITECTURE.md §9.5).
//
// `touched` IS STILL WRITTEN AND MUST NOT BE REMOVED (§1.4). It is set on the
// first tap and never cleared, and derive.js's frozen legacyTrainingScore()
// still reads it to reproduce pre-epoch scores exactly. Do not "simplify" it
// away by inferring it from checked.length, and do not drop the field on the
// grounds that current scoring ignores it.
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
// ---------------------------------------------------------------------------
// Meal Tracker — three new additive keys (ARCHITECTURE.md §8, §13).
//
// foodCounts  OBJECT keyed by date, then by food id:
//   {"2026-08-12": {"fd_abc123": {count, name, servingText, macros}}}
//
//   THE macros ARE A SNAPSHOT, per serving, copied in the FIRST time that item
//   is added on that day. From then on the day is independent of the library:
//   its macros are computed from its own snapshot, NEVER by looking the item up
//   in foodLibrary. That is what makes the server's 120-day purge (§13.5) safe
//   and what stops a later label correction from rewriting a past score. DO NOT
//   normalise this into an id reference.
//
//   A count that drops to 0 KEEPS its entry and its snapshot, so re-adding the
//   same item later the same day cannot silently re-snapshot from an edited
//   library. It contributes no macros at 0.
//
//   The one thing that REMOVES an entry is deleting that item from the library
//   (§13.9), and it only ever touches TODAY's date. Every earlier date keeps its
//   snapshots byte for byte — that is the rule the 120-day purge depends on.
//
//   These counts are LOCAL DATA and are never sent to the server (§1.2). There
//   is no counts endpoint and there must not be one.
//
//   AN ENTRY WHOSE ID STARTS 'ot_' IS A ONE-TIME CONSUMED ITEM (§13.12) and
//   carries oneTime:true beside its snapshot. It was counted for that day and
//   deliberately never saved to the library, so no server item has ever existed
//   behind it — the server mints 'fd_' ids and has never heard of this one. It
//   is the SAME SHAPE as every other entry and every reader treats it the same;
//   only the Meal Tracker's own rendering and delete paths care, and they read
//   the prefix. DO NOT "repair" one of these by creating a library item for it,
//   and do not confuse it with an orphan (§8.0) — an orphan lost its library
//   item, this one never had one.
//
// foodLibrary          ARRAY — a READ-ONLY MIRROR of the server's food library.
//                      A cache, never a second source of truth. If a write to
//                      the server fails, the app says so and the mirror is left
//                      alone; writes are never queued locally.
// foodLibraryFetchedAt STRING (UTC ISO instant) or null — when the mirror was
//                      last refreshed from the server. An instant, so UTC (§12).
// ---------------------------------------------------------------------------
// targetHistory  ARRAY of dated target sets (§14), ascending by effectiveFrom,
//                APPEND-ONLY. derive.js's targetsFor(ds) resolves which set
//                governed a given day. Empty means no day has ever been
//                governed by one, and callers fall back to `targets` below.
//
// targets        THE LEGACY FLAT OBJECT. NOT migrated into targetHistory, NOT
//                deleted, and NOT written by the Targets panel (§1.4). It still
//                serves the Log page's fields and is still the fallback for
//                days predating the first history entry — which is exactly what
//                those days were scored against when they were lived.
export function init(){return{fasts:[],workouts:[],sleeps:[],meals:[],hrs:[],targets:{},targetHistory:[],activeFast:null,deviations:{},fastDeviations:{},body:{},programPauses:[],exerciseLogs:{},oneRepMaxes:{},supplements:seedSupplements(),programStart:null,foodCounts:{},foodLibrary:[],foodLibraryFetchedAt:null};}
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
