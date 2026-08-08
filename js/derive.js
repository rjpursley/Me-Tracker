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

export function programWeek(ds){
  const start=new Date(PROGRAM_START+'T12:00:00');const cur=new Date((ds||today())+'T12:00:00');
  if(isNaN(start)||isNaN(cur))return 1;
  return Math.max(1,Math.min(12,Math.floor(Math.floor((cur-start)/86400000)/7)+1));
}

export function round5(v){return Math.round(v/5)*5;}

export function mainLiftRx(sched,ds){
  if(!sched||!sched.tmKey)return null;
  const wk=programWeek(ds),p=PROGRESSION[wk-1];const tm=+((db().targets||{})[sched.tmKey])||0;
  if(sched.speed)return{week:wk,phase:p.phase,setsReps:sched.speedSetsReps,pctLabel:SPEED_PCT[0]+'–'+SPEED_PCT[1]+'%',
    weight:tm?round5(tm*SPEED_PCT[0]/100)+'–'+round5(tm*SPEED_PCT[1]/100)+' lbs':'set TM',rest:'90 sec',objective:'Speed & acceleration — flat % all 12 weeks'};
  return{week:wk,phase:p.phase,setsReps:p.setsReps,pctLabel:p.pct+'%',weight:tm?round5(tm*p.pct/100)+' lbs':'set TM',rest:p.rest,objective:p.objective};
}

export function calcFastHrs(fast){if(!fast||!fast.start)return 0;const s=new Date((fast.date||today())+'T'+fast.start);if(isNaN(s))return 0;return Math.max(0,((fast.end?new Date((fast.date||today())+'T'+fast.end):new Date())-s)/3600000);}

// ARCHITECTURE.md §1.1 — silence = compliance. An unlogged day falls back to a
// reasonable default rather than scoring as a failure.
export function getSleepForDate(ds){const d=db();const logged=d.sleeps.find(s=>s.date===ds);if(logged)return logged;return{hours:7,deep:1.2,quality:3,_default:true};}

export function getWorkoutForDate(ds){const d=db();const dev=d.deviations&&d.deviations[ds];if(dev&&dev.type==='swapped'&&dev.swap)return{type:dev.swap,date:ds,_swapped:true};if(dev&&dev.type==='missed')return null;const logged=d.workouts.find(w=>w.date===ds);if(logged)return logged;const sched=getScheduleForDate(ds);if(sched.rest)return{type:'Active Rest',date:ds,_assumed:true};return{type:sched.category,date:ds,_assumed:true};}

// §7.1 — did the fast break on this date? Stored additively under
// d.fastDeviations{date} as {broke:true, note:''}. Absence means it held.
export function fastBroken(ds){
  const d=db();
  return !!(d.fastDeviations&&d.fastDeviations[ds]&&d.fastDeviations[ds].broke);
}

export function calcScore(ds){
  ds=ds||today();const d=db();const dow=new Date(ds+'T12:00:00').getDay();const isRestDay=(dow===0);const tgts=d.targets||{};const fastGoal=+(tgts.daily)||18;
  const todayFasts=d.fasts.filter(f=>f.date===ds);const fastHrs=d.activeFast&&ds===today()?calcFastHrs({start:d.activeFast.start,date:d.activeFast.date}):(todayFasts.length?Math.max(...todayFasts.map(calcFastHrs)):0);
  // §7.1 — a broken fast is binary. No partial credit, no hours-completed
  // grading: the day scores 0 for fasting regardless of hours logged. An
  // untouched day is unaffected, because silence is compliance (§1.1).
  const fastScore=fastBroken(ds)?0:Math.min(100,Math.round((fastHrs/fastGoal)*100));
  const sl=getSleepForDate(ds);const sleepGoal=+(tgts.sleep)||8;const sleepScore=Math.min(100,Math.round((Math.min(100,(+(sl.hours)/sleepGoal)*100))*.7+((+(sl.quality)/5)*100)*.3));
  const w=getWorkoutForDate(ds);let trainingScore=0;if(w){const t=w.type;if(t==='Resistance'||t==='HIIT')trainingScore=100;else if(t==='Zone 2'||t==='Bodyweight')trainingScore=85;else if(t==='Wtd Walk')trainingScore=70;else if(t==='Mobility')trainingScore=60;else if(t==='Active Rest')trainingScore=isRestDay?80:60;else trainingScore=60;}else{trainingScore=isRestDay?80:0;}
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
  const d=db();const tg=d.targets||{};const bw=rollingBodyweight().avg;
  return[
    {key:'tm_squat',name:'Back Squat'},
    {key:'tm_ohp',  name:'Overhead Press'},
    {key:'tm_dl',   name:'Deadlift'},
    {key:'tm_bench',name:'Bench Press'}
  ].map(l=>{
    const tm=+tg[l.key]||0;
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
