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

export function init(){return{fasts:[],workouts:[],sleeps:[],meals:[],hrs:[],targets:{},activeFast:null,deviations:{}};}
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
