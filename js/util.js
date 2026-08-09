// ---------------------------------------------------------------------------
// util.js — Date and formatting helpers shared by every other module.
//
// This file is NOT in the ARCHITECTURE.md §3 tree. It exists because both
// store.js and schedule.js need today()/dateStr(), and if those helpers lived
// in derive.js the imports would form a cycle. Keeping them at the bottom of
// the dependency graph means every module can import them safely.
//
// ---------------------------------------------------------------------------
// LOCAL DATES, NEVER UTC.
//
// These two functions answer "what calendar day is it where Ryan is standing?"
// They previously used toISOString(), which converts to UTC first. Ryan is on
// US Eastern (UTC-4/-5), so from 20:00 local onwards UTC has already rolled
// over to tomorrow: a meal logged at 21:00 on the 8th was stamped the 9th, and
// the day strip highlighted the wrong card.
//
// getFullYear/getMonth/getDate read the date in the machine's own timezone, so
// they cannot drift. Do NOT "simplify" these back to toISOString().
//
// Note the deliberate split of responsibilities:
//   - A calendar DAY (a log's `date` field) is local. Use these.
//   - An INSTANT (a deviation's `timestamp`) stays UTC ISO, which is correct
//     for a moment in time. Those calls are intentionally untouched.
// ---------------------------------------------------------------------------

export function pad(n){return String(n).padStart(2,'0');}

// YYYY-MM-DD for the given Date, in local time.
export function dateStr(dt){return dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate());}

// YYYY-MM-DD for right now, in local time.
export function today(){return dateStr(new Date());}

export function addDays(dt,n){const d=new Date(dt);d.setDate(d.getDate()+n);return d;}

// ---------------------------------------------------------------------------
// HTML escaping for stored free text.
//
// Every renderer in this app builds markup as a template string and assigns it
// to innerHTML, so any stored text dropped into one is parsed as HTML. Notes
// are the only free text the app has ever written, and they went in raw.
//
// Deviation notes are deprecated — nothing writes them any more — but existing
// notes are still stored and still rendered on the prescription card, so they
// still have to be escaped on the way out. Lives here rather than in a page so
// there is exactly one copy.
// ---------------------------------------------------------------------------
export function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
