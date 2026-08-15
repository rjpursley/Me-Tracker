// ---------------------------------------------------------------------------
// derive.js — Scoring, program week, averages.
//
// ARCHITECTURE.md §1.3: derive, never store. Everything in this file is
// computed at render time from what store.js holds. Nothing here writes.
//
// ARCHITECTURE.md §11: scoring weights are 25% each — fasting, sleep,
// training, diet. Do not change without explicit instruction.
//
// Moved verbatim from index.html. No formula changed.
//
// NOT YET IMPLEMENTED: Karvonen HR zones (ARCHITECTURE.md §5). This file is
// their documented home when they get built. Do not put them elsewhere, and
// do not substitute a %MHR formula.
// ---------------------------------------------------------------------------

import { today, dateStr, addDays } from './util.js';
import { db } from './store.js';
import { PROGRESSION, SPEED_PCT, getScheduleForDate, getHomeScheduleForDate, PROGRAM_START } from './schedule.js';
import { getCachedVitals } from './api.js';

// ---------------------------------------------------------------------------
// Consistency-score averaging windows — ARCHITECTURE.md §4.
//
// The score box shows two numbers per row: a week average and a month average.
// Until enough history exists BOTH render 0/0. Suppression was chosen
// deliberately: an "average" computed over three days is noise wearing the
// costume of a trend, and it would read as meaningful when it is not.
//
// WEEK_WINDOW_DAYS  = 7  — a week average needs 7 days of history.
// MONTH_WINDOW_DAYS = 28 — a month average needs 28 days of history.
//
// "History" means days elapsed since the first record of any kind was logged,
// not the number of days that happen to have data. Silence is compliance
// (§1.1), so a quiet day is still a day the app has been running.
// ---------------------------------------------------------------------------
export const WEEK_WINDOW_DAYS = 7;
export const MONTH_WINDOW_DAYS = 28;

// ---------------------------------------------------------------------------
// Program pause — ARCHITECTURE.md §9. TRAINING ONLY.
//
// Pausing stops the 12-week program clock. It does NOT touch fasting, sleep or
// dietary scoring: each pillar has its own control with its own rules, and
// there is no global pause. Do not wire this into calcScore()'s other pillars.
//
// Stored as d.programPauses[] — {start, end}, end null while open. A paused
// span is [start, end): the end date is the day training resumed, so it counts
// as a running day. That convention makes the arithmetic exact — pause on the
// 8th, resume on the 18th, and exactly 10 days are subtracted.
//
// These three read the store but never write. Pausing and resuming live in
// pages/training.js, because §1.3 keeps this file derive-only.
// ---------------------------------------------------------------------------

// Every well-formed pause record, oldest first. Anything without a start is
// ignored rather than repaired — §1.4 forbids rewriting stored data.
export function programPauses(){const d=db();return(Array.isArray(d.programPauses)?d.programPauses:[]).filter(p=>p&&p.start);}

// The currently open pause ({start, end:null}), or null when running.
export function openPause(){const list=programPauses();for(let i=list.length-1;i>=0;i--)if(!list[i].end)return list[i];return null;}

// Was the program dormant on this date?
export function isPaused(ds){const cur=ds||today();return programPauses().some(p=>p.start<=cur&&(!p.end||cur<p.end));}

// Days of pause elapsed on or before `ds`. An open pause is counted up to `ds`
// itself, so a dormant program stops accumulating program weeks live.
export function pausedDays(ds){
  const cur=ds||today();
  return programPauses().reduce((total,p)=>{
    const from=p.start>cur?cur:p.start;
    const to=(p.end&&p.end<cur)?p.end:cur;
    if(to<=from)return total;
    return total+Math.round((new Date(to+'T12:00:00')-new Date(from+'T12:00:00'))/86400000);
  },0);
}

// ---------------------------------------------------------------------------
// Program start — a THIRD, distinct state alongside running and paused.
//
// Not started / running / paused. Not started means Alsruhe has never been
// begun: there is no meaningful week number, and none should be displayed or
// computed. Stored additively as d.programStart — a YYYY-MM-DD string once
// Ryan taps Start, or null before that. A brand-new store (init()) and the
// app.js migration guard both default it to null, NOT to PROGRAM_START — an
// existing store gaining this field for the first time must not silently
// become "already running", which is the exact bug this feature exists to
// fix (a paused/never-started program showing a meaningless week number).
//
// PROGRAM_START (schedule.js) is kept, per §1.4's spirit, but its role is now
// only a last-resort fallback if a stored programStart value is present but
// malformed — so programWeek() below still cannot throw. It is no longer read
// as "the" start date.
// ---------------------------------------------------------------------------

// The stored start date, or null while not started. Malformed stored values
// (not a non-empty string) are treated as absent rather than repaired (§1.4).
export function programStart(){
  const d=db();
  return (typeof d.programStart==='string'&&d.programStart)?d.programStart:null;
}

export function isProgramStarted(){return !!programStart();}

// The schedule actually in effect for a date (ARCHITECTURE.md §9.0): Alsruhe
// once started, otherwise the interim home routine. This is the ONE place
// that decision is made — callers should reach for this instead of
// getScheduleForDate()/getHomeScheduleForDate() directly so the routing rule
// never has to be duplicated.
export function getActiveScheduleForDate(ds){
  return isProgramStarted()?getScheduleForDate(ds):getHomeScheduleForDate(ds);
}

// Elapsed days minus paused days, divided by seven. Unpausing therefore resumes
// at the same program week instead of jumping ahead to wall-clock time.
//
// Returns null while the program has not been started — there is no program
// week to report, and nothing here may throw or silently invent one.
export function programWeek(ds){
  const startStr=programStart();
  if(!startStr)return null;
  let start=new Date(startStr+'T12:00:00');
  if(isNaN(start))start=new Date(PROGRAM_START+'T12:00:00'); // malformed stored value — fall back rather than throw
  const cur=new Date((ds||today())+'T12:00:00');
  if(isNaN(start)||isNaN(cur))return 1;
  const elapsed=Math.floor((cur-start)/86400000)-pausedDays(ds);
  return Math.max(1,Math.min(12,Math.floor(Math.max(0,elapsed)/7)+1));
}

export function round5(v){return Math.round(v/5)*5;}

// ---------------------------------------------------------------------------
// 1RM -> TRAINING MAX — ARCHITECTURE.md §10.1.
//
// ############ READ THIS BEFORE TOUCHING ANY PERCENTAGE MATH ############
//
// Ryan enters a tested ONE-REP MAX. The program is written against a TRAINING
// MAX, and TM IS ALREADY 85% OF 1RM:
//
//     TM = 1RM * 0.85
//
// EVERY PRESCRIBED WEIGHT IN THE PROGRAM IS A PERCENTAGE OF TM, NEVER OF 1RM.
// PROGRESSION[].pct and SPEED_PCT are TM percentages. mainLiftRx() below is the
// ONLY place they are applied, and it must be fed a TM.
//
// THE FAILURE MODE: if a percentage is ever applied to a 1RM instead of a TM,
// every working weight jumps by 1/0.85 — about 18%. Week 11 is 95%, so a 405lb
// deadlift 1RM would prescribe 385lb instead of 325lb. THAT IS AN INJURY, NOT
// A ROUNDING ERROR.
//
// The mirror-image bug is double-scaling: multiplying by 0.85 here AND again
// somewhere downstream, which silently makes every session 15% too light and
// stalls the program. Apply the factor exactly once, here.
//
// If you are adding a new lift or a new percentage, the rule is unchanged:
// derive the TM through trainingMax() and multiply that. Never reach for the
// raw 1RM.
// ---------------------------------------------------------------------------
export const TM_PERCENT_OF_1RM=0.85;

// The four main lifts (§10.1). `tmKey` is the legacy targets key, kept so old
// data keeps working; `key` is the 1RM history key.
export const MAIN_LIFTS=[
  {key:'squat',tmKey:'tm_squat',name:'Back Squat'},
  {key:'ohp',  tmKey:'tm_ohp',  name:'Overhead Press'},
  {key:'dl',   tmKey:'tm_dl',   name:'Deadlift'},
  {key:'bench',tmKey:'tm_bench',name:'Bench Press'}
];

// Every logged 1RM for a lift, oldest first. Malformed rows are ignored rather
// than repaired (§1.4).
export function oneRMHistory(liftKey){
  const d=db();const list=(d.oneRepMaxes||{})[liftKey];
  if(!Array.isArray(list))return[];
  return list.filter(r=>r&&r.date&&+r.lbs>0)
             .slice()
             .sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}

// The current 1RM for a lift: the entry with the newest date. Sort is stable,
// so two entries on the same date resolve to the one added later.
export function latestOneRM(liftKey){
  const h=oneRMHistory(liftKey);
  return h.length?h[h.length-1]:null;
}

// {tm, source, oneRM, date} for one lift, by its LEGACY tmKey.
//
//   source '1rm'    -> derived from a logged 1RM (the intended path)
//   source 'legacy' -> no 1RM yet, falling back to the old targets.tm_* value
//   source 'none'   -> nothing known; tm is 0 and the UI must say "set 1RM"
//
// tm is deliberately NOT rounded here. round5() is applied once, to the final
// working weight, exactly as it was before 1RM existed.
export function trainingMaxInfo(tmKey){
  const lift=MAIN_LIFTS.find(l=>l.tmKey===tmKey);
  const rm=lift?latestOneRM(lift.key):null;
  if(rm)return{tm:+rm.lbs*TM_PERCENT_OF_1RM,source:'1rm',oneRM:+rm.lbs,date:rm.date};
  const legacy=+((db().targets||{})[tmKey])||0;
  if(legacy>0)return{tm:legacy,source:'legacy',oneRM:null,date:null};
  return{tm:0,source:'none',oneRM:null,date:null};
}

// The Training Max to feed percentage math. THIS is what mainLiftRx multiplies.
export function trainingMax(tmKey){return trainingMaxInfo(tmKey).tm;}

// Per-lift summary for the PR page and the legacy targets card: which lifts are
// on a real 1RM and which are still riding a legacy TM.
export function mainLiftStatus(){
  return MAIN_LIFTS.map(l=>{
    const info=trainingMaxInfo(l.tmKey);
    return{key:l.key,tmKey:l.tmKey,name:l.name,tm:info.tm,source:info.source,oneRM:info.oneRM,date:info.date,
           history:oneRMHistory(l.key)};
  });
}

export function mainLiftRx(sched,ds){
  if(!sched||!sched.tmKey)return null;
  // TM, never 1RM — see the block comment above. trainingMax() has already
  // applied the 0.85; do not apply it again here.
  const wk=programWeek(ds),p=PROGRESSION[wk-1];const tm=trainingMax(sched.tmKey);
  if(sched.speed)return{week:wk,phase:p.phase,setsReps:sched.speedSetsReps,pctLabel:SPEED_PCT[0]+'–'+SPEED_PCT[1]+'%',
    weight:tm?round5(tm*SPEED_PCT[0]/100)+'–'+round5(tm*SPEED_PCT[1]/100)+' lbs':'set TM',rest:'90 sec',objective:'Speed & acceleration — flat % all 12 weeks'};
  return{week:wk,phase:p.phase,setsReps:p.setsReps,pctLabel:p.pct+'%',weight:tm?round5(tm*p.pct/100)+' lbs':'set TM',rest:p.rest,objective:p.objective};
}

// ---------------------------------------------------------------------------
// FASTING PROTOCOL — ARCHITECTURE.md §7.
//
// INTERMITTENT FASTING ONLY. ONE PROTOCOL, EVERY SINGLE DAY:
//
//   Daily 18:6, eating window 12:30–18:30 local. No exceptions, no variation
//   by weekday, no variation by program week.
//
// This is the SCHEDULE only. The timer and the phase engine (calcFastHrs,
// getPhase, startFastTimer) are untouched and stay untouched (§11) — this
// block answers "what fast is planned on this date", nothing more. Fasting
// SCORING is also untouched: still binary, still assumed-held, still dropped
// to 0 only by the Fasting Fail button (§7.1, fastBroken()).
//
// ############ REMOVED — DO NOT REINTRODUCE ANY OF THESE ############
//   - the quarterly 60–72hr fast   (removed in an earlier session)
//   - the weekly 24hr fast          (Sat 18:30 -> Sun 18:30)
//   - the 48hr deload fast          (program weeks 4 and 8)
//
// Removed with them: isDeloadFastWeek(), FASTING_PROTOCOL.DELOAD_WEEKS /
// TEST_WEEK / weeklyHours / deloadHours, the never-in-week-12 test-week rule,
// and the paused-program `week: null` special case — that existed ONLY so a
// deload fast could ask "is this week 4?" without a program week to answer
// with. With no week-dependent fast left, there is nothing to special-case.
//
// They are deleted outright rather than left behind a flag, following the same
// reasoning schedule.js records for the old per-weekday `fastLabel`: dead data
// describing a retired protocol is exactly what a future session mistakes for
// the current one.
//
// Ryan can still LOG a longer fast by hand — the Log Entry page's fast-type
// select still offers 16:8 / 18:6 / OMAD / 24h / 36h / 48h, deliberately. What
// shrank is the SCHEDULED protocol, not what can be recorded.
// ---------------------------------------------------------------------------
export const FASTING_PROTOCOL={
  eatOpen:'12:30',
  eatClose:'18:30'
};

// What fast is planned on this calendar date? Always the daily 18:6.
//
// Returns {kind, protocol, headline, detail, week, paused}. The shape is
// unchanged so pages/fasting.js needs no rework, but `kind` is now ALWAYS
// 'daily' — there are no other kinds. `week` and `paused` are kept and
// reported honestly (the program week this date falls in, null while not
// started; whether the program was dormant) even though neither changes the
// plan any more. Purely derived (§1.3); writes nothing.
export function fastPlan(ds){
  ds=ds||today();
  return{
    kind:'daily',
    protocol:'18:6 · eat '+FASTING_PROTOCOL.eatOpen+'–'+FASTING_PROTOCOL.eatClose,
    headline:'18:6 Window',
    detail:'Eat '+FASTING_PROTOCOL.eatOpen+'–'+FASTING_PROTOCOL.eatClose+' · fast the rest',
    week:programWeek(ds),
    paused:isPaused(ds)
  };
}

export function calcFastHrs(fast){if(!fast||!fast.start)return 0;const s=new Date((fast.date||today())+'T'+fast.start);if(isNaN(s))return 0;return Math.max(0,((fast.end?new Date((fast.date||today())+'T'+fast.end):new Date())-s)/3600000);}

// ARCHITECTURE.md §1.1 — silence = compliance. An unlogged day falls back to a
// reasonable default rather than scoring as a failure.
//
// §6: "The API overrides that assumption; it does not compete with it." A
// manual log (Ryan explicitly entering hours on the Vitals page) always wins
// if one exists. Where there is no manual log, the API's sleep data fills the
// gap that used to go straight to the flat 7h assumption; only when NEITHER
// exists does the 7h/_default fallback still apply. quality is a subjective
// 1-5 rating the API has no equivalent for, so API-sourced days get the same
// neutral 3 the old default used — real duration data, neutral quality weight.
// AWAKE TIME IS NOT SLEEP — prefer asleepMinutes, fall back to totalMinutes.
//
// The server used to fold AWAKE minutes into sleep.totalMinutes, inflating
// every stage-tracked night (ARCHITECTURE.md §6.10). aggregate_day() now also
// writes sleep.asleepMinutes (awake excluded) and sleep.awakeMinutes.
//
// THE PRESENCE OF THE FIELD IS THE BOUNDARY. Days aggregated before that
// change have no asleepMinutes, and fall through to totalMinutes — which
// reproduces exactly what they scored before, so no history moves. Days
// aggregated since score off real asleep time. There is deliberately NO epoch
// constant and NO migration; do not add either, and do not re-sync history to
// populate the field (Ryan declined that rewrite).
// THE API IS AUTHORITATIVE FOR SLEEP (§6.11, changed 2026-08-12). The watch
// measures it; the manual Log Sleep form is retired. The synced figure wins
// wherever one exists.
//
// d.sleeps is NOT dead: it is still in the schema (§1.4), old entries are
// preserved, and they are still used as the FALLBACK for a night the watch has
// no record of — which is a real case (Google holds no sleep at all for
// 2026-07-30..08-05, §6.9). Order is therefore: synced, then manual, then the
// flat 7h assumption (§1.1).
//
// This function and pages/vitals.js's resolveDay() must always agree — §6.9
// exists because a page once showed a different number from the one scored.
export function getSleepForDate(ds){
  const v=getCachedVitals(ds||today());
  const sleepMin=(v&&v.sleep)?(v.sleep.asleepMinutes??v.sleep.totalMinutes):null;
  if(sleepMin!=null&&sleepMin>0){
    // DEEP IS null ON A NIGHT THAT WAS NEVER STAGED (§1.7, fixed 2026-08-14).
    // A Versa 2 CLASSIC record carries one ASLEEP bucket and no DEEP/LIGHT/REM
    // at all, so the stage map simply has no deep key. This used to default to
    // 0, which rendered as "0.0h deep" — a measurement of zero deep sleep,
    // which is a different and much worse claim than "not tracked".
    //
    // A GENUINE 0 IS PRESERVED: ?? only falls through on null/undefined, so a
    // staged night that really recorded no deep sleep still reads 0, not null.
    //
    // This reaches NO SCORE. sleepScore below is hours and quality only, and
    // the hormone indices that once read deep were deleted (§10.0). It feeds
    // the Driving Factors row and the Vitals history line, both of which render
    // it as an em-dash / "deep n/a" when null.
    const stages=v.sleep.stageMinutes||{};
    const deepMin=stages.deep??stages.DEEP??stages.Deep??null;
    return{hours:sleepMin/60,deep:deepMin!=null?deepMin/60:null,quality:3,_fromApi:true};
  }
  const logged=db().sleeps.find(s=>s.date===ds);
  if(logged)return logged;
  return{hours:7,deep:1.2,quality:3,_default:true};
}

export function getWorkoutForDate(ds){const d=db();const dev=d.deviations&&d.deviations[ds];if(dev&&dev.type==='swapped'&&dev.swap)return{type:dev.swap,date:ds,_swapped:true};if(dev&&dev.type==='missed')return null;const logged=d.workouts.find(w=>w.date===ds);if(logged)return logged;const sched=getActiveScheduleForDate(ds);if(sched.rest)return{type:'Active Rest',date:ds,_assumed:true};return{type:sched.category,date:ds,_assumed:true};}

// ---------------------------------------------------------------------------
// Per-exercise checkboxes — ARCHITECTURE.md §9.4.
//
// Stored additively under d.exerciseLogs{date} as {touched, checked[]}, with
// exercises identified BY NAME. Reads only; pages/training.js does the writing.
//
// RETROACTIVE TICKING IS NOT ALLOWED — a day is editable only on that date
// (the same-day lock, §9.5). That rule is enforced in pages/training.js, both
// in the renderer and in toggleExercise() itself. Nothing HERE looks at
// today(), deliberately: these are pure reads and must answer honestly about
// any date, including locked ones.
// ---------------------------------------------------------------------------

// {touched, checked[], times} for a date, normalised so callers never see
// undefined.
//
// `times` is the tick-timestamp map added 2026-08-12 (§9.4): exercise name ->
// UTC ISO instant of the tap that ticked it. It is returned as NULL, never as
// {}, when the stored day has no such key — ABSENCE IS THE BOUNDARY. Every day
// logged before that commit has no `times`, and a caller must be able to tell
// "this day predates timestamps" from "this day has timestamps, none of them
// for this exercise". Normalising the absent case to {} would erase that
// difference, which is the same mistake §6.10 records for asleepMinutes.
export function exerciseLog(ds){
  const d=db();const log=(d.exerciseLogs||{})[ds];
  const t=log&&log.times;
  const times=(t&&typeof t==='object'&&!Array.isArray(t))?t:null;
  return{touched:!!(log&&log.touched),checked:Array.isArray(log&&log.checked)?log.checked:[],times};
}

// {touched, checked, total} against the exercises actually scheduled that day.
//
// Only names still on the card are counted. If schedule.js renames or drops an
// exercise, the stale tick is ignored rather than counted, so `checked` can
// never exceed `total` and an old log cannot inflate a score above 100.
export function exerciseProgress(ds){
  const names=(getActiveScheduleForDate(ds).exercises||[]).map(e=>e.name);
  const log=exerciseLog(ds);
  return{touched:log.touched,checked:names.filter(n=>log.checked.includes(n)).length,total:names.length};
}

// ---------------------------------------------------------------------------
// WHAT COUNTS AS A STARTED API ACTIVITY — ARCHITECTURE.md §9.5.
// READ THIS BEFORE CHANGING THE FUNCTION BELOW.
//
// ONLY A DELIBERATELY STARTED, TRACKED EXERCISE SESSION COUNTS. A run, a ride,
// a session the user actively began in the health app. **The deliberate start
// IS the signal** — it is the user saying "this was training".
//
// ELEVATED HEART RATE ALONE NEVER COUNTS. Not a brisk walk, not stairs, not a
// stressful meeting, not mowing the lawn.
//
// THERE IS NO DURATION THRESHOLD AND NO HEART-RATE THRESHOLD, and adding one is
// not an improvement. A future session will be tempted to "fix" this by
// accepting, say, 20 minutes above 120bpm — that is exactly the drift this
// comment exists to stop. A threshold makes the app guess at intent; the start
// button already recorded it. A 6-minute deliberate session counts. An hour of
// accidentally-elevated HR does not.
// ---------------------------------------------------------------------------

// Was a tracked activity STARTED on this date?
//
// IMPLEMENTED against server/google_health.py (§6) via api.js's synchronous
// cache — see getCachedVitals() in api.js. The server's aggregate_day()
// populates startedActivities[] from the Google Health "exercise" data type
// ONE ENTRY PER DATAPOINT THAT EXISTS THERE AT ALL — that a session dataPoint
// exists is itself the deliberate-start signal (see the block comment above,
// and the matching comment beside startedActivities in
// server/google_health.py). This function does not, and must not, look at
// duration or heart-rate fields on those entries — only whether the list is
// non-empty.
//
// Returns false whenever nothing is known for the date: the cache hasn't been
// primed yet, the server is unreachable, or the day really had no started
// session. All three cases must default to false — inventing a "maybe" state
// would put a fabricated positive into a health console (§1.7), and a paused
// day with no known activity scoring 0 is expected and accepted (§9.1/§9.5).
//
// ############ DO NOT ADD A DURATION OR HEART-RATE THRESHOLD HERE ############
// A future session will be tempted to "improve" this by also checking
// activity.durationMinutes or peakHR on the cached entry. Don't. The rule
// above this function and in ARCHITECTURE.md §9.5 is explicit: the deliberate
// start IS the signal, and there is no threshold to add.
export function hasStartedActivity(ds){
  const v=getCachedVitals(ds||today());
  return !!(v&&Array.isArray(v.startedActivities)&&v.startedActivities.length>0);
}

// ---------------------------------------------------------------------------
// KARVONEN HEART RATE ZONES — ARCHITECTURE.md §5. DECIDED. Do not substitute
// a %MHR formula.
//
//   maxHR  = 208 - (0.7 * age)              (Tanaka)
//   HRR    = maxHR - restingHR
//   zoneLo = restingHR + (HRR * pctLo)
//   zoneHi = restingHR + (HRR * pctHi)
//
// restingHR is NEVER hardcoded (§5) — it is the trailing-7-day average of the
// API's daily resting HR (weeklyRestingHR() below), so a single rough night's
// reading can't jerk the live zone around; that is what "recalculated weekly"
// means here. age has no home elsewhere in the schema, so it is stored
// additively as d.body.age (Health Status page, next to height) — see
// getAge(). Either missing means no zone table, never a guessed one.
// ---------------------------------------------------------------------------
export const HR_ZONES=[
  {stage:1,name:'Active Recovery',pctLo:0.50,pctHi:0.60},
  {stage:2,name:'Aerobic Base',   pctLo:0.60,pctHi:0.70},
  {stage:3,name:'Tempo',          pctLo:0.70,pctHi:0.80},
  {stage:4,name:'Threshold',      pctLo:0.80,pctHi:0.90},
  {stage:5,name:'Peak',           pctLo:0.90,pctHi:1.00}
];

export function tanakaMaxHR(age){return 208-(0.7*age);}

// The stored age, or null. Additive: d.body.age, alongside d.body.height.
export function getAge(){
  const a=+((db().body||{}).age);
  return a>0?a:null;
}

// Trailing 7-day average of the API's daily resting HR ending on ds
// (default today). Null if the API has never supplied one in that window —
// callers must render "—", never fall back to a guessed number.
export function weeklyRestingHR(ds){
  ds=ds||today();
  const vals=[];
  for(let i=0;i<7;i++){
    const day=dateStr(addDays(new Date(ds+'T12:00:00'),-i));
    const v=getCachedVitals(day);
    if(v&&+v.restingHR>0)vals.push(+v.restingHR);
  }
  if(!vals.length)return null;
  return Math.round((vals.reduce((a,b)=>a+b,0)/vals.length)*10)/10;
}

// {maxHR, restingHR, hrr, zones:[{stage,name,lo,hi}]}, or null if age or
// resting HR is unavailable. Never a zone table built on a guessed number.
export function karvonenZones(ds){
  const age=getAge();const rhr=weeklyRestingHR(ds);
  if(age==null||rhr==null)return null;
  const mh=tanakaMaxHR(age),hrr=mh-rhr;
  return{
    maxHR:mh,restingHR:rhr,hrr,
    zones:HR_ZONES.map(z=>({stage:z.stage,name:z.name,
      lo:Math.round(rhr+hrr*z.pctLo),hi:Math.round(rhr+hrr*z.pctHi)}))
  };
}

// Which zone a bpm value falls in right now, per karvonenZones(ds). Null if
// zones can't be computed, or bpm is below Zone 1's floor (resting territory,
// not an active zone).
export function currentZone(bpm,ds){
  const z=karvonenZones(ds);
  if(!z||!bpm)return null;
  for(let i=z.zones.length-1;i>=0;i--)if(bpm>=z.zones[i].lo)return{...z.zones[i],zoneCount:z.zones.length};
  return null;
}

// ---------------------------------------------------------------------------
// TRAINING SCORE — ARCHITECTURE.md §9.5.
//
// ############ EMPTY CHECKBOXES MEAN IT DID NOT HAPPEN ############
//
// There is NO assumed-done default for training any more. One formula, applied
// to every non-rest day whether the program is running, paused, or not started:
//
//     score = min(100, (checked / total) * 100 + (startedActivity ? 50 : 0))
//
// No `touched` branch. No separate paused branch. No deviation reads.
//
// REST DAYS SCORE 100, decided by the SCHEDULE'S OWN `rest` FLAG — never by the
// weekday number. See calcTrainingScore() for why that distinction is a bug fix
// and not a stylistic preference.
//
// ############ THE EPOCH ############
//
// Everything above applies from STRICT_TRAINING_FROM onward. Dates before it
// keep the OLD behaviour exactly, in legacyTrainingScore() below, which is
// FROZEN. Those days were logged under a different contract — rewriting them as
// zeros would make the app lie about Ryan's past.
//
// A FUTURE SESSION THAT READS "UNTOUCHED SCORES ZERO" AS A BUG AND RESTORES THE
// SCHEDULE FALLBACK IS CAUSING DRIFT, NOT FIXING IT. This changes what the
// training pillar measures: no longer "did I train" but "did I train and log it
// the same day." That is deliberate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// STRICT_TRAINING_FROM — the epoch. The first date scored by the new rules.
//
// Dates >= this string use the strict formula above; dates < it use the frozen
// legacy path. It is a plain YYYY-MM-DD local civil day (§12), compared as a
// string, which is safe because ISO dates sort lexicographically.
//
// Set to the local civil day this rule shipped, so that no day Ryan had already
// lived under the old contract is retroactively rescored. DO NOT move this date
// backward — that would rewrite history. Moving it forward would exempt days
// that were logged under the new rules. Neither is a maintenance operation;
// both need a conversation with Ryan.
// ---------------------------------------------------------------------------
export const STRICT_TRAINING_FROM='2026-08-12';

// ---------------------------------------------------------------------------
// LEGACY-ONLY, FROZEN — everything from here to the end of
// legacyTrainingScore() exists solely to score dates before
// STRICT_TRAINING_FROM. Do not modify it, do not "improve" it, and do not
// reintroduce any of it into the post-epoch path.
// ---------------------------------------------------------------------------

// LEGACY-ONLY (frozen). The original category-table scoring.
//
// ############ MUST NOT BE REINTRODUCED INTO POST-EPOCH SCORING ############
// This is the "assumed done" fallback the new rules deliberately removed. It
// is reachable only from legacyTrainingScore(). If you find yourself wanting to
// call it from calcTrainingScore(), re-read §9.5 — that is the exact drift the
// epoch exists to prevent.
function scheduleFallbackScore(ds,isRestDay){
  const w=getWorkoutForDate(ds);
  if(!w)return isRestDay?80:0;
  const t=w.type;
  if(t==='Resistance'||t==='HIIT')return 100;
  if(t==='Zone 2'||t==='Bodyweight')return 85;
  if(t==='Wtd Walk')return 70;
  if(t==='Mobility')return 60;
  if(t==='Active Rest')return isRestDay?80:60;
  return 60;
}

// LEGACY-ONLY. The deviation type recorded for a date, or null: 'missed',
// 'swapped', 'completed', 'skipped', 'makeup'.
//
// The UI that wrote these is gone (§9.6) and nothing can produce a new one.
// Its only remaining caller is legacyTrainingScore(). Kept because pre-epoch
// days still carry these records and must keep scoring the way they did.
export function deviationType(ds){
  const d=db();const dev=d.deviations&&d.deviations[ds];
  return(dev&&dev.type)||null;
}

// LEGACY-ONLY, FROZEN. The pre-epoch training score, byte-for-byte the
// behaviour calcTrainingScore() had before STRICT_TRAINING_FROM existed —
// including the hardcoded-Sunday rest-day test, the schedule fallback for
// untouched days, the missed-outranks-checkboxes rule, the paused branch and
// rest days at 80.
//
// ############ DO NOT MODIFY OR "FIX" ANYTHING IN HERE ############
// The Saturday rest-day bug fixed in calcTrainingScore() is still present here
// ON PURPOSE. Correcting it would change scores Ryan has already seen, which is
// exactly what the freeze exists to prevent. This function's only job is to
// reproduce the past, faithfully, including its mistakes.
function legacyTrainingScore(ds){
  const isRestDay=new Date(ds+'T12:00:00').getDay()===0;
  if(getActiveScheduleForDate(ds).rest)return scheduleFallbackScore(ds,isRestDay);
  if(isPaused(ds))return hasStartedActivity(ds)?100:0;
  if(deviationType(ds)==='missed')return 0;
  const p=exerciseProgress(ds);
  if(!p.touched)return scheduleFallbackScore(ds,isRestDay);
  const boxes=p.total?Math.round((p.checked/p.total)*100):0;
  return Math.min(100,boxes+(hasStartedActivity(ds)?50:0));
}

// ---------------------------------------------------------------------------
// END OF THE FROZEN LEGACY PATH. Everything below is current behaviour.
// ---------------------------------------------------------------------------

export function calcTrainingScore(ds){
  ds=ds||today();
  if(ds<STRICT_TRAINING_FROM)return legacyTrainingScore(ds);

  // REST DAYS SCORE 100, READ FROM THE SCHEDULE'S OWN FLAG.
  //
  // ############ NEVER INFER A REST DAY FROM THE WEEKDAY NUMBER ############
  // This used to be `new Date(ds+'T12:00:00').getDay()===0` — hardcoded Sunday.
  // That was a live bug: HOME_SCHEDULE (schedule.js, the interim routine) marks
  // BOTH day 6 (Saturday) and day 0 (Sunday) as rest, so every Saturday fell
  // through to the fallback with isRestDay=false and scored 60 instead of 80.
  // The schedule is the only thing that knows which days are rest days; ask it.
  const sched=getActiveScheduleForDate(ds);
  if(sched.rest)return 100;

  // ONE FORMULA for every non-rest day — running, paused, or not started.
  //
  // No `touched` branch: an untouched day and a touched-but-empty day both have
  // zero boxes ticked and both score 0. `touched` is still WRITTEN and is still
  // read by the legacy path, it just no longer changes anything here.
  //
  // No paused branch either. Pause still holds the program week (§9.1) — that
  // is untouched — but it no longer changes how a day scores.
  const p=exerciseProgress(ds);
  const boxes=p.total?Math.round((p.checked/p.total)*100):0;
  return Math.min(100,boxes+(hasStartedActivity(ds)?50:0));
}

// §7.1 — did the fast break on this date? Stored additively under
// d.fastDeviations{date} as {broke:true, note:''}. Absence means it held.
export function fastBroken(ds){
  const d=db();
  return !!(d.fastDeviations&&d.fastDeviations[ds]&&d.fastDeviations[ds].broke);
}

// ---------------------------------------------------------------------------
// A DAY'S MACROS — d.meals PLUS the Meal Tracker's serving counts (§13, §8).
//
// THE SNAPSHOT RULE IS LOAD-BEARING. Each entry in d.foodCounts[date] carries
// its OWN copy of that item's per-serving macros, taken the first time the item
// was added that day. A day's macros are computed from THAT snapshot and never
// by looking the item up in d.foodLibrary. Two things depend on it:
//
//   1. The server's 120-day purge (§13.5) can delete a library item without
//      touching any past day's numbers.
//   2. Correcting a label today cannot silently rewrite scores Ryan has
//      already seen — the same reasoning §6.10 records for declining the
//      sleep backfill.
//
// DO NOT "normalise" d.foodCounts into an id reference. That is the change
// that makes the purge start rewriting history.
//
// A NULL MACRO CONTRIBUTES NOTHING AND IS NOT TREATED AS 0 (§1.7). "Not
// printed on the label" and "the label says zero" are different facts; only
// the second one is a measurement.
//
// d.meals is NOT replaced and still works exactly as before. The two are
// added together.
// ---------------------------------------------------------------------------
// saturatedFat joined this list 2026-08-14 (§14.1). It sits beside `fat`, is
// nullable exactly like every other macro, and IS NEVER INFERRED AS A FRACTION
// OF TOTAL FAT — a label that does not print it has not told us, and a guess
// derived from total fat would be a fabricated measurement (§1.7).
//
// SNAPSHOTS WRITTEN BEFORE THIS SHIPPED SIMPLY HAVE NO saturatedFat KEY, and
// NOTHING BACKFILLS THEM. They read as "not known for that day", which is the
// truth, and `known` below is what lets a caller tell that apart from a
// measured zero.
export const FOOD_MACRO_FIELDS=['protein','fat','saturatedFat','carbs','sugar','calories','fiber','sodium'];

// Which macros feed the Dietary score is decided by the target set (§14.1),
// not by this constant. It is kept for the pre-v2 path and for callers that
// still ask "which four did the old formula read".
export const SCORED_MACRO_FIELDS=['protein','fat','carbs','sugar'];

// Totals contributed by d.foodCounts[ds] alone: count x snapshot macro.
//
// `known` is ADDITIVE (2026-08-14) and works exactly like foodCountExtras()'s:
// true for a field only when at least one counted item actually carried a
// number for it. THE TOTAL ALONE CANNOT ANSWER "IS THIS A ZERO OR A GAP" —
// out[k] is 0 both when nothing was eaten and when nothing knew the value, and
// §14.1's scoring has to drop the second case from the weighted sum rather than
// grade it. A GENUINE MEASURED 0 COUNTS AS KNOWN, which is the whole point.
export function foodCountMacros(ds){
  const d=db();
  const day=(d.foodCounts&&d.foodCounts[ds]);
  const out={known:{}};FOOD_MACRO_FIELDS.forEach(k=>{out[k]=0;out.known[k]=false;});
  out.servings=0;out.items=0;
  if(!day||typeof day!=='object'||Array.isArray(day))return out;
  Object.keys(day).forEach(id=>{
    const e=day[id];if(!e)return;
    const n=+e.count||0;if(n<=0)return;
    out.servings+=n;out.items++;
    const m=(e.macros&&typeof e.macros==='object')?e.macros:{};
    FOOD_MACRO_FIELDS.forEach(k=>{
      const v=m[k];
      // null / undefined / '' all mean NOT ON THE LABEL — skipped, never
      // added as a zero. An old snapshot with no saturatedFat key lands here.
      if(v===null||v===undefined||v==='')return;
      const num=+v;if(!isFinite(num))return;
      out[k]+=num*n;out.known[k]=true;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// §13.8's two capture groups, read off each day's OWN SNAPSHOT.
//
// THE SNAPSHOT RULE APPLIES TO THESE EXACTLY AS IT DOES TO MACROS. A day's
// caffeine and additives come from what was copied into d.foodCounts[ds] at the
// first ADD that day — NEVER by looking the item up in d.foodLibrary now. That
// is what keeps the 120-day purge (§13.5) and any later label correction from
// rewriting a past day.
//
// ABSENCE IS THE BOUNDARY. Days counted before this shipped have no `extras`
// and no `flags` in their snapshots. They are GAPS — "not known for that day" —
// never zero, and never resolved by a lookup in today's library.
//
// NONE OF THIS IS SCORED (§11). It is captured and displayed only.
// ---------------------------------------------------------------------------
export const FOOD_EXTRA_FIELDS=['caffeine','potassium','calcium','iron','magnesium','zinc'];

// Every counted entry for a day that still has a positive count.
function countedEntries(ds){
  const d=db();
  const day=(d.foodCounts&&d.foodCounts[ds]);
  if(!day||typeof day!=='object'||Array.isArray(day))return [];
  return Object.keys(day).map(id=>day[id]).filter(e=>e&&(+e.count||0)>0);
}

// Totals of the six extras: count x snapshot extra, in mg.
//
// `known` is per field: true only if at least one counted item actually carried
// a number for it. A day where nothing knew its caffeine is a GAP, not 0 mg —
// an RXBAR whose caffeine is null is "not printed on the label", not decaf.
// A GENUINE measured 0 does count as known, which is the whole reason §13.8
// keeps null and 0 apart.
// `coverage` was added 2026-08-14 for §14's Targets panel and is ADDITIVE — a
// new key on the returned object, nothing existing changed. It answers "how
// much of today do I actually know about": {field:{withData, items}}, where
// items is every counted item and withData is how many of them carried a figure
// for that field. Open Food Facts coverage of these six is poor, so a total
// like "192 mg" is usually a PARTIAL SUM, and a panel that showed it against a
// target without saying so would imply Ryan was short when he simply has no
// data. THE TOTAL ALONE IS NOT ENOUGH INFORMATION TO SHOW.
export function foodCountExtras(ds){
  const out={known:{},coverage:{}};
  const entries=countedEntries(ds);
  FOOD_EXTRA_FIELDS.forEach(k=>{out[k]=0;out.known[k]=false;out.coverage[k]={withData:0,items:entries.length};});
  entries.forEach(e=>{
    const n=+e.count||0;
    const x=(e.extras&&typeof e.extras==='object')?e.extras:null;
    if(!x)return;
    FOOD_EXTRA_FIELDS.forEach(k=>{
      const v=x[k];
      if(v===null||v===undefined||v==='')return;   // not known — never 0
      const num=+v;if(!isFinite(num))return;
      out[k]+=num*n;out.known[k]=true;out.coverage[k].withData++;
    });
  });
  return out;
}

// The day's flags, from each entry's own snapshot.
//
// ADDITIVES ARE COUNTED DISTINCTLY ACROSS THE DAY, not per serving. Eating two
// identical bars does not expose Ryan to ten additives; the question worth
// asking is how many DIFFERENT ones he ate. (The brief said "additive count per
// day" without settling this — recorded here because it is a real choice.)
// Flags never scale with servings (§13.8), so multiplying by count would also
// contradict the group's own rule.
//
// nova4 counts ITEMS, not servings, for the same reason.
export function foodCountFlags(ds){
  const tags={};
  let additivesKnown=false,novaKnown=false,nova4=0,items=0;
  countedEntries(ds).forEach(e=>{
    const f=(e.flags&&typeof e.flags==='object')?e.flags:null;
    if(!f)return;
    items++;
    const a=f.additives;
    // The count:0 block means OFF positively reported none — that IS data.
    // A missing/null additives block means unknown and contributes nothing.
    if(a&&typeof a==='object'&&Array.isArray(a.tags)){
      additivesKnown=true;
      a.tags.forEach(t=>{if(t)tags[String(t)]=true;});
    }
    const nova=+f.novaGroup;
    if(isFinite(nova)&&nova>=1&&nova<=4){novaKnown=true;if(nova===4)nova4++;}
  });
  return {additiveCount:Object.keys(tags).length,additivesKnown,
          nova4Items:nova4,novaKnown,flaggedItems:items};
}

// One day of §13.8 intake, with per-metric "is this known at all" flags so a
// chart can draw a GAP rather than a zero (§8.3's rule, applied to these).
export function dayIntake(ds){
  const x=foodCountExtras(ds);
  const f=foodCountFlags(ds);
  return {
    caffeine:x.caffeine, caffeineKnown:x.known.caffeine,
    additiveCount:f.additiveCount, additivesKnown:f.additivesKnown,
    nova4Items:f.nova4Items, novaKnown:f.novaKnown
  };
}

// ---------------------------------------------------------------------------
// THE ROLLING AVERAGE IS A RATE OVER LOGGED DAYS, NOT A SUM OVER SEVEN.
//
// Dividing by 7 calendar days would make FORGETTING TO LOG look like consuming
// less, which is the same lie §8.3 refuses for macros. The divisor is the
// number of days in the window that actually have data for that metric, and the
// card says how many that was.
//
// Below `minDays` the window returns null — nothing, not 0. A "7-day average"
// computed from one day is noise wearing a trend's clothing.
// ---------------------------------------------------------------------------
export const INTAKE_WINDOW_DAYS=7;
export const INTAKE_MIN_DAYS=3;

export function rollingIntake(endDs,windowDays,minDays){
  windowDays=windowDays||INTAKE_WINDOW_DAYS;
  minDays=minDays===undefined?INTAKE_MIN_DAYS:minDays;
  const end=new Date(endDs+'T12:00:00');
  const acc={caffeine:{sum:0,n:0},additives:{sum:0,n:0},nova4:{sum:0,n:0}};
  for(let i=0;i<windowDays;i++){
    const iv=dayIntake(dateStr(addDays(end,-i)));
    if(iv.caffeineKnown){acc.caffeine.sum+=iv.caffeine;acc.caffeine.n++;}
    if(iv.additivesKnown){acc.additives.sum+=iv.additiveCount;acc.additives.n++;}
    if(iv.novaKnown){acc.nova4.sum+=iv.nova4Items;acc.nova4.n++;}
  }
  const avg=a=>a.n>=minDays?a.sum/a.n:null;
  return {
    caffeine:avg(acc.caffeine), caffeineDays:acc.caffeine.n,
    additives:avg(acc.additives), additiveDays:acc.additives.n,
    nova4:avg(acc.nova4), nova4Days:acc.nova4.n,
    minDays
  };
}

// The whole day: hand-logged meals plus counted servings.
//
// `hasData` is what the 30-day chart uses to decide gap-vs-zero (§8.3) — a day
// with neither a meal nor a serving is a GAP, not a zero-protein day.
export function dayMacros(ds){
  const d=db();
  const meals=(d.meals||[]).filter(m=>m&&m.date===ds);
  const fc=foodCountMacros(ds);
  const sum=k=>meals.reduce((a,m)=>a+(+m[k]||0),0);
  // The four the legacy Log Meal form has always carried. A logged meal makes
  // these four KNOWN for the day even if the typed figure was 0 — Ryan entered
  // it, so it is a measurement. It says nothing about the other four.
  const LEGACY_MEAL_FIELDS=['protein','fat','carbs','sugar'];
  const known={};
  FOOD_MACRO_FIELDS.forEach(k=>{
    known[k]=!!(fc.known&&fc.known[k])||(meals.length>0&&LEGACY_MEAL_FIELDS.indexOf(k)>=0);
  });
  return{
    protein:sum('protein')+fc.protein,
    fat:sum('fat')+fc.fat,
    carbs:sum('carbs')+fc.carbs,
    sugar:sum('sugar')+fc.sugar,
    // d.meals has never carried these four, so they come from counted servings
    // only. saturatedFat joins them for exactly the same reason (§14.1) — the
    // legacy form has no field for it and none is being added.
    calories:fc.calories,fiber:fc.fiber,sodium:fc.sodium,saturatedFat:fc.saturatedFat,
    // Per-nutrient "was this actually measured today" (§14.1). Absent from a
    // day means the weighted score drops that nutrient rather than grading it 0.
    known,
    mealCount:meals.length,servings:fc.servings,countedItems:fc.items,
    hasData:meals.length>0||fc.servings>0
  };
}

// ---------------------------------------------------------------------------
// DATED TARGETS — ARCHITECTURE.md §14. targetsFor(ds) resolves the target set
// that was IN FORCE on a given day.
//
// ############ THE BUG THIS FIXES ############
//
// calcScore() used to read d.targets — ONE UNDATED OBJECT — for every date it
// was ever asked about. So every historical day was graded against whatever the
// goals happen to be right now. Raise the protein target tonight and every past
// day silently re-grades: a day Ryan scored 92 on in June becomes an 82, with
// no record that anything changed and no way to get the old number back.
//
// That is precisely the failure the food-macro snapshot rule exists to prevent
// (§13, §8.0): a past day's numbers must be computed from what was true THEN,
// never from a lookup in present-day state. The library learned that lesson;
// the targets had not.
//
// ############ A CHANGE TAKES EFFECT THE NEXT DAY ############
//
// effectiveFrom is ALWAYS the day AFTER the save. Ryan logs his measurements in
// the evening; a target he changes at 8pm must not retroactively re-grade the
// day he has just finished living. The day of the change is scored against the
// targets that were already in force when he lived it.
//
// ############ RETURNING null IS CORRECT AND MUST BE HANDLED ############
//
// null means "ds predates the first entry" — this day was never governed by a
// target set at all. IT DOES NOT MEAN THE TARGETS WERE ZERO. Callers fall back
// to the legacy d.targets, which is exactly what those days were scored against
// when they were lived, so no history moves when this ships (§1.4).
//
// The list is append-only and sorted ascending by effectiveFrom; entries are
// never edited or deleted, because an edited entry would re-grade the days it
// governed and put us straight back in the bug above.
// ---------------------------------------------------------------------------
export function targetsFor(ds){
  const list=db().targetHistory;
  if(!Array.isArray(list)||!list.length)return null;
  const day=ds||today();
  // Sorted here rather than trusting insertion order: a caller must never get a
  // different answer because two entries were appended out of sequence.
  const applicable=list
    .filter(t=>t&&typeof t.effectiveFrom==='string'&&t.effectiveFrom<=day)
    .sort((a,b)=>a.effectiveFrom<b.effectiveFrom?-1:a.effectiveFrom>b.effectiveFrom?1:0);
  return applicable.length?applicable[applicable.length-1]:null;
}

// ---------------------------------------------------------------------------
// DIETARY SCORING v2 — ARCHITECTURE.md §14.1.
//
// The pillar used to read sugar and protein only. It now grades six nutrients
// against the target set that governed that day, resolved through targetsFor().
//
// ############ §11 IS NOT TOUCHED ############
//
// The four PILLAR weights stay at 25% each. Everything below is internal to the
// Dietary pillar — it changes what that one quarter reads, not how the four are
// combined. Do not let the two weightings be confused for one another.
// ---------------------------------------------------------------------------

// 100 inside the target, falling linearly to 0 at the outer bound. One function,
// three shapes, decided by which bounds are present:
//
//   band     lo and hi both set. 0 at lo x 0.5 below, 0 at hi x 1.5 above.
//   floor    hi absent.  100 at or above lo, 0 at lo x 0.5. NO UPPER PENALTY —
//            250 g of protein against a 175 g floor is 100, not a mark against.
//   ceiling  lo absent.  100 at or below hi, 0 at hi x 1.5.
//
// RETURNS null FOR A VALUE THAT IS NOT A NUMBER. Not 0 — a nutrient nobody
// measured has no score, and the caller drops it from the weighted mean rather
// than grading it (§1.7). NOT ROUNDED: rounding happens at display only, so a
// weighted mean is never built out of pre-rounded parts.
export function gradeNutrient(value,{lo,hi}){
  const v=+value;
  if(value===null||value===undefined||value===''||!isFinite(v))return null;
  const hasLo=(lo!==null&&lo!==undefined&&+lo>0);
  const hasHi=(hi!==null&&hi!==undefined&&+hi>0);
  if(!hasLo&&!hasHi)return null;          // no target to grade against
  let s=100;
  if(hasLo&&v<+lo){
    const zero=+lo*0.5;
    s=Math.min(s, v<=zero?0:((v-zero)/(+lo-zero))*100);
  }
  if(hasHi&&v>+hi){
    const zero=+hi*1.5;
    s=Math.min(s, v>=zero?0:((zero-v)/(zero-+hi))*100);
  }
  return Math.max(0,Math.min(100,s));
}

// The eight rows, in the order §14.1's table gives them. WEIGHTS SUM TO EXACTLY
// 100 across the six scored rows: 25+25+15+15+10+10.
//
// ############ carbs AND fat ARE WEIGHT 0 ON PURPOSE ############
//
// CARBS ARE THE ARITHMETIC RESIDUAL of calories, protein and fat — scoring them
// would count the same decision twice, once directly and once through the
// calories band. Total fat is display-only for the same reason, with saturated
// fat carrying the part of it that is actually a health question. Both are
// still CAPTURED and still DISPLAYED. Do not add either to the weighted sum
// without a reason recorded in §14.1, and do not drop their capture.
export const DIET_V2_ROWS=[
  {key:'calories',    label:'Calories',      unit:'',   weight:25, shape:'band'},
  {key:'protein',     label:'Protein',       unit:'g',  weight:25, shape:'floor'},
  {key:'sodium',      label:'Sodium',        unit:'mg', weight:15, shape:'ceiling'},
  {key:'sugar',       label:'Sugar',         unit:'g',  weight:15, shape:'ceiling'},
  {key:'fiber',       label:'Fiber',         unit:'g',  weight:10, shape:'band'},
  {key:'saturatedFat',label:'Saturated fat', unit:'g',  weight:10, shape:'ceiling'},
  {key:'fat',         label:'Total fat',     unit:'g',  weight:0,  shape:'band'},
  {key:'carbs',       label:'Carbs',         unit:'g',  weight:0,  shape:'band'}
];

// The calories band is derived from the set's single stored figure, +/-10%:
// 2250 -> 2025-2475. The target schema (§14) stores one number, not a pair.
const CALORIE_BAND_PCT=0.10;

// ############ saturatedFatMax IS A DATED TARGET NOW (2026-08-15) ############
//
// It used to be this constant alone, and that was the one scored nutrient whose
// ceiling was NOT dated — change the number and every historical day silently
// re-grades against it, which is precisely the bug §14 exists to stop, surviving
// in one row. It is a real field in the target set as of this date.
//
// ############ THE CONSTANT STAYS, AS THE FALLBACK. ABSENCE IS THE BOUNDARY ############
//
// Entries written BEFORE this shipped have no `saturatedFatMax` key and NOTHING
// BACKFILLS THEM — same rule as `asleepMinutes` (§6.10) and the food snapshots'
// `saturatedFat` (§14.1). An entry WITHOUT the key grades against this constant,
// which is exactly what those days were scored against when they were lived; an
// entry WITH it uses its own value. Do not add a migration and do not add an
// epoch date: the presence of the key is the whole test.
//
// health.js imports this for the Targets panel's seed and for the placeholder it
// shows on an entry that predates the field, so the two can never disagree about
// what the fallback is.
export const SATURATED_FAT_MAX_DEFAULT=22;

// {lo, hi} per nutrient for one target set. READ FROM THE SET wherever the set
// carries the field, so a dated target change moves the grading with it.
function dietBounds(t){
  const cal=+((t&&t.calories));
  const band=(r,fallback)=>{
    const mn=+((r&&r.min)), mx=+((r&&r.max));
    return {lo:isFinite(mn)&&mn>0?mn:(fallback?fallback.lo:null),
            hi:isFinite(mx)&&mx>0?mx:(fallback?fallback.hi:null)};
  };
  const ceil=v=>({lo:null, hi:(isFinite(+v)&&+v>0)?+v:null});
  return {
    calories: isFinite(cal)&&cal>0
      ? {lo:Math.round(cal*(1-CALORIE_BAND_PCT)), hi:Math.round(cal*(1+CALORIE_BAND_PCT))}
      : {lo:null,hi:null},
    // FLOOR: the set's max is the display band's upper edge, NOT a penalty
    // bound. hi is deliberately null so gradeNutrient() applies no upper limit.
    protein: {lo:(t&&t.protein&&+t.protein.min>0)?+t.protein.min:null, hi:null},
    sodium:  ceil(t&&t.sodiumMax),
    sugar:   ceil(t&&t.sugarMax),
    fiber:   band(t&&t.fiber),
    // READ FROM THE SET like every other scored nutrient, falling back to the
    // constant ONLY when the entry has no key at all (see the block above).
    saturatedFat: ceil((t&&t.saturatedFatMax!=null)?t.saturatedFatMax:SATURATED_FAT_MAX_DEFAULT),
    fat:     band(t&&t.fat),
    carbs:   band(t&&t.carbs)
  };
}

// Per-row axis maximum for §14.2's track: hi x 1.5 for ceilings and bands (the
// point the score reaches 0), lo x 2 for floors (which have no upper bound, so
// the axis is chosen to put the target at the halfway mark).
function dietAxisMax(row,b){
  if(row.shape==='floor')return (b.lo>0)?b.lo*2:null;
  return (b.hi>0)?b.hi*1.5:null;
}

// ---------------------------------------------------------------------------
// The eight rows for a TARGET SET, with no day attached — the zones and axes
// only. Added 2026-08-15 for §14.2's preview state, where the visual has to draw
// the bands of a set that does not govern today yet.
//
// ############ THIS IS NOT A SCORING PATH ############
//
// It answers "what do these targets look like", never "how did this day do".
// Every row comes back value:null, known:false, score:null, which is what makes
// bandRowHtml() draw a zone and NO MARKER — the same null handling it already
// applies to a nutrient with no reading. A caller must never treat these rows as
// a result: a day nothing was graded against has no score, and inventing a zero
// for it would be the §1.7 mistake in a new place.
//
// It exists so the zone geometry lives in ONE place (§6.9). health.js drawing
// its own bands from dietBounds()'s rules would be a second read path for the
// same fact, which is the exact family of bug §6.9 records.
// ---------------------------------------------------------------------------
export function dietTargetRows(t){
  const b=dietBounds(t);
  return DIET_V2_ROWS.map(r=>{
    const bounds=b[r.key]||{lo:null,hi:null};
    return {...r, lo:bounds.lo, hi:bounds.hi, value:null, known:false, score:null,
            axisMax:dietAxisMax(r,bounds), clamped:false};
  });
}

// ---------------------------------------------------------------------------
// The whole Dietary picture for a day: the score AND the eight rows behind it.
//
// ONE READ PATH (§6.9). calcScore() and the Health page's band visual both come
// through here, so the ring and the pillar can never disagree about the number.
//
// Returns null when the day predates d.targetHistory — the caller then uses the
// pre-v2 formula, because those days were lived against different goals under a
// different rule and must not be retro-graded (§14).
// ---------------------------------------------------------------------------
export function dietaryDetail(ds){
  const day=ds||today();
  const t=targetsFor(day);
  if(!t)return null;                       // historical: caller keeps the old method
  const dm=dayMacros(day);
  const b=dietBounds(t);

  // ############ AN EMPTY DAY SCORES 0, IT DOES NOT SCORE null ############
  //
  // A day with nothing logged is a missed behaviour, not missing information —
  // the same rule training uses (§9.5): empty means it never happened. Without
  // it every ceiling would read 100 and eating nothing would grade as a perfect
  // diet.
  //
  // "Nothing logged" means no counted servings AND no legacy Log Meal entry. A
  // day that has legacy meals but no ADDs is NOT empty: it has real protein and
  // sugar figures, its unknown nutrients drop out below, and it scores on what
  // it actually knows. Zeroing it would be punishing Ryan for using the older
  // form, which is still live on the Dietary page.
  const unlogged=!(dm.servings>0)&&!(dm.mealCount>0);

  const rows=DIET_V2_ROWS.map(r=>{
    const bounds=b[r.key]||{lo:null,hi:null};
    const known=!!(dm.known&&dm.known[r.key]);
    const value=known?+dm[r.key]:null;
    const axisMax=dietAxisMax(r,bounds);
    // A weight-0 row is never graded — it is information, not a target met or
    // missed, and giving it a score would invite it into the sum later.
    const score=(r.weight>0&&known&&!unlogged)?gradeNutrient(value,bounds):null;
    return {...r, lo:bounds.lo, hi:bounds.hi, value, known, score, axisMax,
            clamped:(value!=null&&axisMax!=null&&value>axisMax)};
  });

  if(unlogged){
    return {score:0, rows, unlogged:true,
            usedWeight:0, totalWeight:DIET_V2_ROWS.reduce((a,r)=>a+r.weight,0)};
  }

  // ############ A NULL NUTRIENT IS DROPPED, NOT ZEROED ############
  //
  // It leaves BOTH the numerator and the denominator, so the remaining weights
  // renormalise to 100. A label that does not print sodium is missing
  // information; grading it 0 would invent a failure out of a gap (§1.7).
  //
  // THIS IS THE OPPOSITE OF THE unlogged RULE ABOVE and the difference is the
  // part most likely to be misread later: a missing FIELD is missing
  // information, a missing DAY is a missed behaviour.
  let num=0,den=0;
  rows.forEach(r=>{ if(r.weight>0&&r.score!=null){num+=r.score*r.weight;den+=r.weight;} });
  const total=DIET_V2_ROWS.reduce((a,r)=>a+r.weight,0);
  return {score: den>0?(num/den):null, rows, unlogged:false, usedWeight:den, totalWeight:total};
}

export function calcScore(ds){
  ds=ds||today();const d=db();const tgts=d.targets||{};
  // THE DATED SET FOR THIS DAY, or null when the day predates the first entry
  // (§14). Every target read below goes through histTarget() so the fallback is
  // in one place and cannot drift between pillars.
  const hist=targetsFor(ds);
  // Reads one target: the dated set first, the legacy flat object second, and
  // the hardcoded default last. `pick` pulls the scalar out of a dated entry,
  // which may be a range object rather than a number.
  const histTarget=(pick,legacyKey,fallback)=>{
    const h=hist?pick(hist):null;
    const n=+h;
    if(isFinite(n)&&n>0)return n;
    return +(tgts[legacyKey])||fallback;
  };
  // FASTING DEFAULTS TO COMPLIANT — §1.1 per-pillar defaults, §7.1 binary.
  //
  // An unlogged day scores 100. Only a fastDeviations record marking the day
  // broken drops it to 0. A logged fast that met protocol also scores 100.
  //
  // This used to divide logged hours by the daily goal, which meant an
  // untouched day scored 0 and the Fasting Fail button changed the stored
  // record without changing the number — the exact opposite of "taps are spent
  // on deviations". It also contradicted §7.1: hours-completed grading is
  // explicitly not how this pillar works. A break is a break; silence held.
  //
  // targets.daily is still stored and still editable on the Log page, it just
  // no longer feeds the score. calcFastHrs() is untouched and still drives the
  // timer, the phase bar and the hormone indices.
  const fastScore=fastBroken(ds)?0:100;
  // SLEEP IS NOT IN THE DATED SET. d.targetHistory carries the thirteen
  // nutrition fields and no sleep goal (§14), so this correctly still reads the
  // legacy object — there is nothing dated to prefer, and inventing a sleep
  // field here would be building a schema Ryan did not ask for.
  const sl=getSleepForDate(ds);const sleepGoal=+(tgts.sleep)||8;const sleepScore=Math.min(100,Math.round((Math.min(100,(+(sl.hours)/sleepGoal)*100))*.7+((+(sl.quality)/5)*100)*.3));
  // Training moved out to calcTrainingScore() (§9.5) — checkboxes, pause and
  // API activity. The old category table lives on inside it as the fallback
  // for rest days and for days that were never touched.
  const trainingScore=calcTrainingScore(ds);
  // ONE READ PATH FOR A DAY'S MACROS (§6.9's checklist). This used to sum
  // d.meals inline here while the Dietary page summed it separately — two
  // readers of the same fact, which is precisely how §6.9's bug happened.
  // dayMacros() is now the single source for the score, the Dietary page's
  // four cards and the 30-day chart, so they cannot disagree.
  // ############ TWO DIETARY METHODS, SPLIT BY WHETHER THE DAY WAS GOVERNED ############
  //
  // A day with a dated target set is graded by v2 (§14.1): six weighted
  // nutrients against that day's own bands. A day that PREDATES the first
  // target-history entry keeps the ORIGINAL sugar-and-protein formula, reading
  // the legacy flat d.targets.
  //
  // DO NOT RETRO-APPLY v2. Those days were lived against different goals and a
  // different rule, and re-grading them is the exact failure §14 exists to stop.
  // `targetsFor(ds) === null` is the signal, and dietaryDetail() returns null on
  // precisely the same condition.
  const detail=dietaryDetail(ds);
  let dietScore;
  if(detail){
    // A governed day with nothing measurable at all scores 0 rather than null —
    // dietaryDetail() has already applied the unlogged rule, and a null here
    // could only mean "logged, but not one scored nutrient was known", which is
    // still a day with no evidence of what was eaten.
    dietScore=Math.round(detail.score==null?0:detail.score);
  }else{
    const dm=dayMacros(ds);const ts=dm.sugar;const tp=dm.protein;
    const protGoal=histTarget(h=>h.protein&&h.protein.min,'protein',180);dietScore=100;if(ts>0&&ts<=10)dietScore=Math.max(70,100-(ts/10)*30);else if(ts>10&&ts<=25)dietScore=Math.max(40,70-((ts-10)/15)*30);else if(ts>25)dietScore=10;if(tp>=protGoal)dietScore=Math.min(100,dietScore+10);dietScore=Math.round(dietScore);
  }
  return{total:Math.round(fastScore*.25+sleepScore*.25+trainingScore*.25+dietScore*.25),fast:fastScore,sleep:sleepScore,training:trainingScore,diet:dietScore};
}

// ---------------------------------------------------------------------------
// THE HORMONE INDICES WERE DELETED HERE (2026-08-14). DO NOT REINTRODUCE THEM.
//
// calcHGH(), calcTest() and calcCortisol() used to live at this spot. They took
// sleep, fasting, workout type and sugar, ran them through a hand-tuned ladder
// of magic numbers, and printed the result as "HGH 72/100" beside a bar.
//
// They were removed because THERE IS NO CRITERION VARIABLE. Not one blood test
// has ever been taken against which any of the three outputs could be checked,
// so nothing about them was ever validated, falsifiable, or even wrong in a way
// that could be noticed. The weights were invented. Presenting that as a
// hormone level — a thing with real units and a real clinical meaning — is the
// single biggest overclaim this app has ever made, and no banner underneath it
// fixed that.
//
// They also carried a live lie: the `else if(cort>30)` branch in health.js set
// the label '−5 cortisol drag' and then never subtracted anything. The label
// described a calculation that did not exist. See §10.
//
// DO NOT REBUILD THESE WITHOUT REAL LAB DATA to fit against. A behavioural
// proxy is a legitimate thing to build once there is a measurement to regress
// it on; until then it is a number with a hormone's name on it.
// ---------------------------------------------------------------------------

export function getPhase(hrs){if(hrs<12)return{name:'Glycogen Depletion',idx:0};if(hrs<16)return{name:'Ketosis Initiating',idx:1};if(hrs<24)return{name:'Autophagy Elevated',idx:2};return{name:'Peak Autophagy',idx:3};}

// Score -> colour token. Used for inline styles on generated markup.
export function sc(n){return n>=80?'var(--accent5)':n>=50?'var(--warn)':'var(--danger)';}

// ---------------------------------------------------------------------------
// Body composition — ARCHITECTURE.md §10.
//
// BODYWEIGHT DISPLAYS AS THE 7-DAY ROLLING AVERAGE, NEVER THE DAILY VALUE.
// Daily weight is mostly water and produces noise that misleads. If a future
// session "helpfully" surfaces the latest reading as the headline number, that
// is drift, not a fix.
// ---------------------------------------------------------------------------
export const BODYWEIGHT_WINDOW_DAYS = 7;

// {avg, count, latest} — avg is null when nothing was logged inside the window,
// in which case the UI must say so rather than fall back to an older reading.
export function rollingBodyweight(){
  const d=db();
  const list=((d.body&&d.body.weights)||[]).filter(w=>w&&w.date&&+w.lbs>0);
  if(!list.length)return{avg:null,count:0,latest:null};
  const sorted=list.slice().sort((a,b)=>a.date<b.date?1:-1);
  const cutoff=dateStr(addDays(new Date(),-(BODYWEIGHT_WINDOW_DAYS-1)));
  const win=sorted.filter(w=>w.date>=cutoff);
  const avg=win.length?Math.round((win.reduce((a,w)=>a+(+w.lbs),0)/win.length)*10)/10:null;
  return{avg,count:win.length,latest:sorted[0]};
}

// ---------------------------------------------------------------------------
// SUGGESTED MACRO TARGETS — ARCHITECTURE.md §8.2.
//
// SUGGESTIONS, NOT AUTOFILL. These render next to the target inputs; nothing
// here writes to d.targets. Ryan's entered value always wins.
//
//   protein  = bodyweight * 1.0 g
//   calories = bodyweight * 15          (maintenance baseline)
//   fat      = 25% of calories / 9
//   carbs    = remainder after protein and fat
//   sugar    = 10% of calories / 4      (a ceiling, not a goal)
//
// BODYWEIGHT IS THE 7-DAY ROLLING AVERAGE (§10), never the latest daily
// reading — daily weight is mostly water, and a suggestion that swung with
// yesterday's salt would be noise.
//
// NO BODYWEIGHT MEANS NO SUGGESTION. Every field returns null and the UI shows
// "—". Do not substitute a default weight: a macro target invented from a
// number Ryan never entered is worse than a blank.
//
// ############ DO NOT WIRE RESTING HR OR WAIST INTO THESE ############
// Both are available (dailyRestingHeartRate via §6, latestWaist() above) and
// both are tempting. They are PROGRESS INDICATORS, NOT NUTRITION INPUTS.
// Feeding them in would make the suggested protein move because Ryan slept
// badly or measured his waist after a large meal — the number would drift for
// reasons that have nothing to do with what he should eat, and he would stop
// trusting it. Training load enters through bodyweight and the 15x multiplier
// only. If a future session wants activity-adjusted calories, that is a
// conversation with Ryan, not a quiet edit here.
// ---------------------------------------------------------------------------
export const MACRO_FORMULA={
  proteinPerLb:1.0,
  caloriesPerLb:15,
  fatPctOfCalories:0.25,
  sugarPctOfCalories:0.10,
  kcalPerGramProtein:4,
  kcalPerGramCarb:4,
  kcalPerGramFat:9
};

// {bodyweight, calories, protein, fat, carbs, sugar} — every value null when no
// bodyweight has been logged inside the rolling window.
export function macroSuggestions(){
  const bw=rollingBodyweight().avg;
  if(bw==null||!(bw>0))return{bodyweight:null,calories:null,protein:null,fat:null,carbs:null,sugar:null};
  const F=MACRO_FORMULA;
  const calories=bw*F.caloriesPerLb;
  const protein=bw*F.proteinPerLb;
  const fat=(calories*F.fatPctOfCalories)/F.kcalPerGramFat;
  // Carbs are whatever is left once protein and fat are paid for.
  const carbs=(calories-(protein*F.kcalPerGramProtein)-(fat*F.kcalPerGramFat))/F.kcalPerGramCarb;
  const sugar=(calories*F.sugarPctOfCalories)/F.kcalPerGramCarb;
  return{
    bodyweight:Math.round(bw*10)/10,
    calories:Math.round(calories),
    protein:Math.round(protein),
    fat:Math.round(fat),
    carbs:Math.max(0,Math.round(carbs)),
    sugar:Math.round(sugar)
  };
}

// Most recent waist measurement, or null.
export function latestWaist(){
  const d=db();
  const list=((d.body&&d.body.waists)||[]).filter(w=>w&&w.date&&+w.inches>0);
  if(!list.length)return null;
  return list.slice().sort((a,b)=>a.date<b.date?1:-1)[0];
}

// Relative strength = each Training Max ÷ bodyweight (§10). Bodyweight is the
// rolling average, matching what the page displays. ratio is null when either
// the TM or the bodyweight is missing — never a fabricated number.
export function relativeStrength(){
  const bw=rollingBodyweight().avg;
  // Uses the same derived TM as the prescription card, so the two can never
  // disagree about how strong Ryan currently is.
  return MAIN_LIFTS.map(l=>{
    const tm=trainingMax(l.tmKey);
    return{name:l.name,tm,bodyweight:bw,ratio:(tm>0&&bw>0)?Math.round((tm/bw)*100)/100:null};
  });
}

// How many days of history the app has, counted from the first record of any
// kind through today, inclusive. 0 if nothing has ever been logged.
export function historyDays(){
  const d=db();const dates=[];
  ['fasts','workouts','sleeps','meals','hrs'].forEach(k=>{(d[k]||[]).forEach(r=>{if(r&&r.date)dates.push(r.date);});});
  Object.keys(d.deviations||{}).forEach(k=>dates.push(k));
  Object.keys(d.fastDeviations||{}).forEach(k=>dates.push(k));
  const body=d.body||{};
  (body.weights||[]).forEach(r=>{if(r&&r.date)dates.push(r.date);});
  (body.waists||[]).forEach(r=>{if(r&&r.date)dates.push(r.date);});
  if(!dates.length)return 0;
  // ISO dates sort correctly as plain strings.
  const first=dates.slice().sort()[0];const t=today();
  if(first>t)return 1;
  return Math.floor((new Date(t+'T12:00:00')-new Date(first+'T12:00:00'))/86400000)+1;
}

// The six rows of the consistency score box (§4), each as {week, month, ready}.
// `ready` is false while history is too short, in which case both numbers are 0
// and the UI must render them as a suppressed "0/0", not as a real average.
//
// One pass over the last MONTH_WINDOW_DAYS days feeds every row, so this costs
// 28 calcScore() calls per render rather than 28 per row.
export function consistencyRows(){
  const hist=historyDays();const now=new Date();const scores=[];
  for(let i=0;i<MONTH_WINDOW_DAYS;i++)scores.push(calcScore(dateStr(addDays(now,-i))));
  const mean=(key,n)=>Math.round(scores.slice(0,n).reduce((a,s)=>a+(s[key]||0),0)/n);
  const pair=key=>({
    week: hist>=WEEK_WINDOW_DAYS?mean(key,WEEK_WINDOW_DAYS):0,
    month: hist>=MONTH_WINDOW_DAYS?mean(key,MONTH_WINDOW_DAYS):0,
    weekReady: hist>=WEEK_WINDOW_DAYS,
    monthReady: hist>=MONTH_WINDOW_DAYS
  });
  return{
    historyDays:hist,
    total:pair('total'),training:pair('training'),diet:pair('diet'),
    sleep:pair('sleep'),fast:pair('fast')
  };
}
