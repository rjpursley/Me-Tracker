// ---------------------------------------------------------------------------
// util.js — Date and formatting helpers shared by every other module.
//
// This file is NOT in the ARCHITECTURE.md §3 tree. It exists because both
// store.js and schedule.js need today()/dateStr(), and if those helpers lived
// in derive.js the imports would form a cycle. Keeping them at the bottom of
// the dependency graph means every module can import them safely.
//
// Moved verbatim from index.html. No logic changed.
// ---------------------------------------------------------------------------

export function pad(n){return String(n).padStart(2,'0');}
export function today(){return new Date().toISOString().slice(0,10);}
export function dateStr(dt){return dt.toISOString().slice(0,10);}
export function addDays(dt,n){const d=new Date(dt);d.setDate(d.getDate()+n);return d;}
