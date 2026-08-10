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
import { PROGRESSION, SPEED_PCT, getScheduleForDate, PROGRAM_START } from './schedule.js';

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

// Elapsed days minus paused days, divided by seven. Unpausing therefore resumes
// at the same program week instead of jumping ahead to wall-clock time.
export function programWeek(ds){
  const start=new Date(PROGRAM_START+'T12:00:00');const cur=new Date((ds||today())+'T12:00:00');
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
// This is the SCHEDULE only. The timer and the phase engine (calcFastHrs,
// getPhase) are untouched and stay untouched (§11) — this block answers
// "what fast is planned on this date", nothing more.
//
//   Daily      18:6, eating window 12:30–18:30 local.
//   Weekly     24hr, Saturday 18:30 -> Sunday 18:30.
//   Deload     48hr, Friday 18:30 -> Sunday 18:30, PROGRAM WEEKS 4 AND 8 ONLY.
//
// NO EXTENDED FAST IN WEEK 12. Week 12 is the test week — you never test a 1RM
// off a fast. Week 12 keeps the weekly 24hr and gets no 48hr. The check below
// is written explicitly even though 12 is not in DELOAD_WEEKS, so the rule is
// visible in code rather than an accident of the array's contents.
//
// The quarterly 60–72hr fast was REMOVED. Do not reintroduce it.
//
// PAUSED: while the program is dormant there IS NO PROGRAM WEEK (§9.1), so
// "is this week 4?" has no answer. In that state the weekly 24hr runs and the
// 48hr never does. Handled explicitly below — it must not throw and must not
// silently pick a week.
// ---------------------------------------------------------------------------
export const FASTING_PROTOCOL={
  eatOpen:'12:30',
  eatClose:'18:30',
  weeklyHours:24,   // Sat 18:30 -> Sun 18:30
  deloadHours:48,   // Fri 18:30 -> Sun 18:30
  DELOAD_WEEKS:[4,8],
  TEST_WEEK:12
};

// Is a 48hr deload fast scheduled for the week containing this date?
//
// PROGRAM_START is a Monday, so a week runs Mon..Sun — which means the Friday,
// Saturday and Sunday of one 48hr window all share the same program week. No
// window straddles a week boundary.
export function isDeloadFastWeek(ds){
  if(isPaused(ds))return false;                       // no program week while dormant
  const wk=programWeek(ds);
  if(wk===FASTING_PROTOCOL.TEST_WEEK)return false;    // never test a 1RM off a fast
  return FASTING_PROTOCOL.DELOAD_WEEKS.includes(wk);
}

// What fast is planned on this calendar date?
//
// Returns {kind, protocol, headline, detail, week, paused} where kind is
// 'daily' | 'weekly24' | 'deload48'. Purely derived (§1.3); writes nothing.
export function fastPlan(ds){
  ds=ds||today();
  const dow=new Date(ds+'T12:00:00').getDay();        // 0 Sun .. 6 Sat
  const paused=isPaused(ds);
  const week=paused?null:programWeek(ds);
  const deload=isDeloadFastWeek(ds);
  const daily={
    kind:'daily',
    protocol:'18:6 · eat '+FASTING_PROTOCOL.eatOpen+'–'+FASTING_PROTOCOL.eatClose,
    headline:'18:6 Window',
    detail:'Eat '+FASTING_PROTOCOL.eatOpen+'–'+FASTING_PROTOCOL.eatClose+' · fast the rest',
    week,paused
  };

  if(deload&&(dow===5||dow===6||dow===0)){
    const label='48hr deload · Fri '+FASTING_PROTOCOL.eatClose+' → Sun '+FASTING_PROTOCOL.eatClose;
    return{kind:'deload48',protocol:label,headline:'48hr Deload Fast',week,paused,
      detail:dow===5?'Begins '+FASTING_PROTOCOL.eatClose+' tonight — week '+week+' deload'
            :dow===6?'Fast active · day 1 of 2'
            :'Breaks '+FASTING_PROTOCOL.eatClose+' today'};
  }

  if(dow===6||dow===0){
    const label='24hr weekly · Sat '+FASTING_PROTOCOL.eatClose+' → Sun '+FASTING_PROTOCOL.eatClose;
    return{kind:'weekly24',protocol:label,headline:'24hr Fast Window',week,paused,
      detail:dow===6?'Begins '+FASTING_PROTOCOL.eatClose+' tonight'
                    :'Breaks '+FASTING_PROTOCOL.eatClose+' today'};
  }

  return daily;
}

export function calcFastHrs(fast){if(!fast||!fast.start)return 0;const s=new Date((fast.date||today())+'T'+fast.start);if(isNaN(s))return 0;return Math.max(0,((fast.end?new Date((fast.date||today())+'T'+fast.end):new Date())-s)/3600000);}

// ARCHITECTURE.md §1.1 — silence = compliance. An unlogged day falls back to a
// reasonable default rather than scoring as a failure.
export function getSleepForDate(ds){const d=db();const logged=d.sleeps.find(s=>s.date===ds);if(logged)return logged;return{hours:7,deep:1.2,quality:3,_default:true};}

export function getWorkoutForDate(ds){const d=db();const dev=d.deviations&&d.deviations[ds];if(dev&&dev.type==='swapped'&&dev.swap)return{type:dev.swap,date:ds,_swapped:true};if(dev&&dev.type==='missed')return null;const logged=d.workouts.find(w=>w.date===ds);if(logged)return logged;const sched=getScheduleForDate(ds);if(sched.rest)return{type:'Active Rest',date:ds,_assumed:true};return{type:sched.category,date:ds,_assumed:true};}

// ---------------------------------------------------------------------------
// Per-exercise checkboxes — ARCHITECTURE.md §9.4.
//
// Stored additively under d.exerciseLogs{date} as {touched, checked[]}, with
// exercises identified BY NAME. Reads only; pages/training.js does the writing.
//
// Retroactive ticking is allowed with no time limit — any date the app can
// render a prescription card for can be edited. Nothing here looks at today().
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
  const names=(getScheduleForDate(ds).exercises||[]).map(e=>e.name);
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
// TODO(server): implement against Google Health (§6) when the Alienware server
// task lands — the same task that builds server/google_health.py. It should ask
// for sessions/activities with an explicit start, NOT for heart-rate samples.
//
// Returns false unconditionally for now. This is a deliberate stub, not an
// oversight: there is no data source (§3 has no server yet), and inventing
// sample activity would put a fake number into a health console. Because it is
// always false today, paused days score 0 for training. That is expected and
// accepted — do not "fix" it with a neutral or excluded state.
export function hasStartedActivity(ds){
  return false;
}

// ---------------------------------------------------------------------------
// TRAINING SCORE — ARCHITECTURE.md §9.5.
//
// REST DAYS ARE UNAFFECTED by checkboxes, pause and API activity. They keep the
// original schedule-fallback behaviour entirely.
//
// PROGRAM PAUSED (non-rest days):
//   checkboxes ignored entirely. Started activity = 100, otherwise 0.
//
// PROGRAM ACTIVE (non-rest days):
//   never touched -> assume the session happened; schedule fallback, unchanged.
//   touched       -> (checked / total) * 100, plus 50 for a started activity,
//                    capped at 100.
//
// The untouched vs touched-but-empty pair is the subtle one. Both render as a
// card with no ticks, but the first scores by the fallback and the second
// scores 0. That is the whole point of storing `touched` separately.
// ---------------------------------------------------------------------------

// The original category-table scoring, unchanged. Still the rule for rest days
// and for untouched active days.
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

// The deviation type recorded for a date, or null. 'missed', 'swapped',
// 'completed', 'skipped', 'makeup' — set from the tray on the Home page.
export function deviationType(ds){
  const d=db();const dev=d.deviations&&d.deviations[ds];
  return(dev&&dev.type)||null;
}

export function calcTrainingScore(ds){
  ds=ds||today();
  const isRestDay=new Date(ds+'T12:00:00').getDay()===0;
  if(getScheduleForDate(ds).rest)return scheduleFallbackScore(ds,isRestDay);
  if(isPaused(ds))return hasStartedActivity(ds)?100:0;
  // AN EXPLICIT "MISSED" OUTRANKS THE CHECKBOXES — §9.5.
  //
  // Saying "I missed this session" is a direct statement about the day; ticks
  // are just the residue of tapping through a card. Without this, marking a day
  // Missed and ticking every box scored 100, which is nonsense.
  //
  // This is deliberately ONLY 'missed'. The other deviation types keep flowing
  // through the fallback exactly as before — 'swapped' still scores by the
  // category swapped to, and 'completed'/'skipped'/'makeup' are unchanged.
  // An untouched missed day already scored 0 via the fallback, so this changes
  // nothing there; it fixes the touched case.
  if(deviationType(ds)==='missed')return 0;
  const p=exerciseProgress(ds);
  if(!p.touched)return scheduleFallbackScore(ds,isRestDay);
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
