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
export function getSleepForDate(ds){
  const d=db();const logged=d.sleeps.find(s=>s.date===ds);
  if(logged)return logged;
  const v=getCachedVitals(ds||today());
  const sleepMin=(v&&v.sleep)?(v.sleep.asleepMinutes??v.sleep.totalMinutes):null;
  if(sleepMin!=null&&sleepMin>0){
    const stages=v.sleep.stageMinutes||{};
    const deepMin=stages.deep??stages.DEEP??stages.Deep??0;
    return{hours:sleepMin/60,deep:deepMin/60,quality:3,_fromApi:true};
  }
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

// {touched, checked[]} for a date, normalised so callers never see undefined.
export function exerciseLog(ds){
  const d=db();const log=(d.exerciseLogs||{})[ds];
  return{touched:!!(log&&log.touched),checked:Array.isArray(log&&log.checked)?log.checked:[]};
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

export function calcScore(ds){
  ds=ds||today();const d=db();const tgts=d.targets||{};
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
  const sl=getSleepForDate(ds);const sleepGoal=+(tgts.sleep)||8;const sleepScore=Math.min(100,Math.round((Math.min(100,(+(sl.hours)/sleepGoal)*100))*.7+((+(sl.quality)/5)*100)*.3));
  // Training moved out to calcTrainingScore() (§9.5) — checkboxes, pause and
  // API activity. The old category table lives on inside it as the fallback
  // for rest days and for days that were never touched.
  const trainingScore=calcTrainingScore(ds);
  const meals=d.meals.filter(m=>m.date===ds);const ts=meals.reduce((a,m)=>a+(+m.sugar||0),0);const tp=meals.reduce((a,m)=>a+(+m.protein||0),0);const protGoal=+(tgts.protein)||180;let dietScore=100;if(ts>0&&ts<=10)dietScore=Math.max(70,100-(ts/10)*30);else if(ts>10&&ts<=25)dietScore=Math.max(40,70-((ts-10)/15)*30);else if(ts>25)dietScore=10;if(tp>=protGoal)dietScore=Math.min(100,dietScore+10);dietScore=Math.round(dietScore);
  return{total:Math.round(fastScore*.25+sleepScore*.25+trainingScore*.25+dietScore*.25),fast:fastScore,sleep:sleepScore,training:trainingScore,diet:dietScore};
}

// ARCHITECTURE.md §10: these are behavioural correlations, NOT medical claims.
// They must always be labelled as such in the UI.
export function calcHGH(sl,fastHrs,w,s){let h=0;const deep=+(sl&&sl.deep)||0,tot=+(sl&&sl.hours)||0;if(deep>=1.5)h+=30;else if(deep>=1)h+=20;else if(deep>0)h+=10;if(tot>=8)h+=20;else if(tot>=7)h+=15;else if(tot>=6)h+=8;if(fastHrs>=24)h+=25;else if(fastHrs>=16)h+=20;else if(fastHrs>=12)h+=10;if(w){const t=w.type;if(t==='Resistance'||t==='HIIT')h+=15;else if(t==='Zone 2'||t==='Bodyweight')h+=10;else if(t==='Active Rest')h+=5;}if(s===0)h+=10;else if(s<=10)h+=5;if(s>=25)h-=30;else if(s>=10)h-=15;if(tot<6)h-=20;if(fastHrs===0)h-=10;return Math.max(0,Math.min(100,Math.round(h)));}

export function calcTest(sl,fastHrs,w,s,l7){let t=0;const tot=+(sl&&sl.hours)||0;if(w){const wt=w.type;if(wt==='Resistance')t+=30;else if(wt==='HIIT')t+=20;else if(wt==='Zone 2'||wt==='Bodyweight')t+=10;else if(wt==='Wtd Walk')t+=8;}if(tot>=7.5)t+=25;else if(tot>=6)t+=15;else if(tot>0)t+=5;if(fastHrs>=16)t+=15;else if(fastHrs>=12)t+=8;if(l7.filter(x=>x.type==='Resistance'||x.type==='HIIT').length>=3)t+=10;if(s>=25)t-=25;else if(s>=10)t-=15;if(tot<6)t-=15;const l4=l7.slice(-4);if(l4.length>=4&&l4.every(x=>x.type==='Resistance'||x.type==='HIIT'))t-=10;return Math.max(0,Math.min(100,Math.round(t)));}

export function calcCortisol(sl,s,w,l7,fastHrs){let c=20;const tot=+(sl&&sl.hours)||0;if(s>=25)c+=30;else if(s>=10)c+=15;if(tot<6)c+=25;else if(tot<7)c+=10;if(!sl||sl._default)c+=5;const l4=l7.slice(-4);if(l4.length>=4&&l4.every(x=>x.type==='Resistance'||x.type==='HIIT'))c+=15;if(fastHrs>=36&&(!w||w.type==='Active Rest'))c+=10;if(tot>=8)c-=10;if(w&&w.type==='Active Rest')c-=5;if(s===0)c-=5;if(fastHrs>=16&&fastHrs<24)c-=5;return Math.max(0,Math.min(100,Math.round(c)));}

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
