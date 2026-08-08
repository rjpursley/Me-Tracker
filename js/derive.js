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

import { today } from './util.js';
import { db } from './store.js';
import { PROGRESSION, SPEED_PCT, getScheduleForDate, PROGRAM_START } from './schedule.js';

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

export function calcScore(ds){
  ds=ds||today();const d=db();const dow=new Date(ds+'T12:00:00').getDay();const isRestDay=(dow===0);const tgts=d.targets||{};const fastGoal=+(tgts.daily)||18;
  const todayFasts=d.fasts.filter(f=>f.date===ds);const fastHrs=d.activeFast&&ds===today()?calcFastHrs({start:d.activeFast.start,date:d.activeFast.date}):(todayFasts.length?Math.max(...todayFasts.map(calcFastHrs)):0);const fastScore=Math.min(100,Math.round((fastHrs/fastGoal)*100));
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
