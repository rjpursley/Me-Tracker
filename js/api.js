// ---------------------------------------------------------------------------
// api.js — Calls to the local server. ALL fetch() lives here.
//
// ARCHITECTURE.md §3, §6. Client and server are same-origin over Tailscale —
// no CORS, no proxy shim (§2). The server is a sidecar, not the database
// (§1.2): it hands back small daily summaries; localStorage stays the
// source of truth and this file writes nothing to it.
//
// EVERYTHING HERE MUST FAIL SOFT. If the server is stopped, unreachable, or
// returns something unexpected, every function below resolves to null/false/
// empty rather than throwing — a page rendering off this module must be able
// to fall back to its placeholder exactly as if no server existed at all
// (ARCHITECTURE.md §4's vitals header, §1.7: a number with no real source is
// worse than a placeholder). Nothing in this file may throw past its own
// boundary.
//
// IN-MEMORY CACHE ONLY. vitalsCache below is never written to localStorage —
// it is a read-through cache of the server's own daily-summary store,
// rebuilt from the network every page load. This is what lets derive.js's
// hasStartedActivity() (§9.5) stay a synchronous, pure read: it looks in this
// cache rather than awaiting a fetch itself, so it can keep behaving like
// every other derive.js function. If the cache hasn't been primed yet (page
// just loaded, or the last prime failed), every lookup returns "nothing
// known" — never a fabricated value.
// ---------------------------------------------------------------------------

import { today, dateStr, addDays } from './util.js';

export const API_BASE = '';

// How many trailing days the cache is primed with. Enough for
// weeklyRestingHR()'s 7-day window (derive.js) and the Vitals page's 15-day
// averages. It lives here rather than in app.js because three callers need the
// same window now — boot, the foreground refresh, and the Sync now button —
// and three copies of the number is how they drift apart.
export const VITALS_PRIME_DAYS = 15;

// date string -> summary object from GET /api/vitals/{date} (or GET
// /api/vitals?from&to's days map), or explicitly null once a lookup has come
// back "no data for this day" so callers can tell "not fetched yet" apart
// from "fetched, and there's nothing there" if that distinction ever matters.
let vitalsCache = {};
let lastPrimeOk = null;      // null = never tried, true/false after the first attempt
let lastPrimeAt = null;      // Date, when the cache was last successfully refreshed

async function fetchJSON(path){
  try{
    const res = await fetch(API_BASE + path, {headers:{'Accept':'application/json'}});
    if(!res.ok) return null;
    return await res.json();
  }catch(e){
    // Network error, server not running, Tailscale down — all the same to a
    // caller: there is no data right now. Never throw past this function.
    return null;
  }
}

// Fetches a date range and merges it into the in-memory cache. Called once on
// app boot (see app.js) and safe to call again any time — e.g. after a
// manual sync — to pick up freshly-written days.
export async function primeVitalsCache(fromDate, toDate){
  const body = await fetchJSON(`/api/vitals?from=${fromDate}&to=${toDate}`);
  if(!body || typeof body.days !== 'object'){
    lastPrimeOk = false;
    return false;
  }
  Object.keys(body.days).forEach(d => { vitalsCache[d] = body.days[d]; });
  lastPrimeOk = true;
  lastPrimeAt = new Date();
  return true;
}

// Primes the standard trailing window ending today. Returns true/false — never
// throws. Called on boot, whenever the app returns to the foreground, and after
// a manual sync; `today()` is re-read every time, so a session left open across
// midnight primes the NEW day rather than yesterday's window.
export async function primeRecentVitals(){
  const to = today();
  const from = dateStr(addDays(new Date(to + 'T12:00:00'), -(VITALS_PRIME_DAYS - 1)));
  return await primeVitalsCache(from, to);
}

// Synchronous read for derive.js and the UI — never awaits, never fetches.
// Returns the cached summary for a date, or null if nothing is cached for it
// (either never synced, or the cache hasn't been primed this page load yet).
export function getCachedVitals(dateStr){
  return vitalsCache[dateStr] || null;
}

export function cacheStatus(){
  return {primed: lastPrimeOk === true, lastPrimeAt};
}

// A direct single-day fetch, bypassing the cache — used where a page wants a
// guaranteed-fresh read rather than whatever primeVitalsCache() last saw.
// Also updates the cache so later synchronous reads see the same value.
export async function fetchVitalsDay(dateStr){
  const body = await fetchJSON(`/api/vitals/${dateStr}`);
  if(!body) return null;
  if(body.found === false){ vitalsCache[dateStr] = null; return null; }
  vitalsCache[dateStr] = body;
  return body;
}

// GET /api/sync/status — {lastWriteUtc, daysStored} (ARCHITECTURE.md §6.5), or
// null if the server can't be reached. lastWriteUtc is when the SERVER last
// wrote its store, which is the honest answer to "how fresh is this data" — it
// is not a claim about this browser's cache.
export async function fetchSyncStatus(){
  return await fetchJSON('/api/sync/status');
}

// POST /api/sync — a manual sync. Re-primes the cache for the same range
// afterward so a caller sees the results immediately rather than on next
// reload. Returns the server's result object (counts/pages/errors) or null on
// failure; never throws.
export async function triggerSync(fromDate, toDate){
  let body = null;
  try{
    const res = await fetch(API_BASE + '/api/sync', {method:'POST', headers:{'Accept':'application/json'}});
    if(res.ok) body = await res.json();
  }catch(e){ /* server unreachable — nothing to sync, nothing to report */ }
  if(fromDate && toDate) await primeVitalsCache(fromDate, toDate);
  return body;
}
