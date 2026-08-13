// ---------------------------------------------------------------------------
// pages/dietary.js — Today's macros, supplements, targets, macro consistency.
//
// ARCHITECTURE.md §8.1: the supplement list is USER-EDITABLE and lives in
// d.supplements. It used to be three hardcoded rows in index.html; those three
// are now SEED_SUPPLEMENTS in store.js, which owns the schema and its defaults.
// This supersedes the "do not change the supplement list" line in §11 — the
// list is Ryan's to edit. Do not hardcode supplements in markup again.
//
// PRE-EXISTING PATTERN — COLOUR LITERALS IN CHART.JS: Chart.js draws to
// <canvas> and cannot resolve CSS var() strings, so its config carries raw hex
// and rgba values. That is the same exception vitals.js already documents
// (§1.6). The literals in renderMacroChart() below are confined to the Chart.js
// config and match the tokens they stand in for; the on-page legend uses real
// var() tokens. Do not spread literals beyond the chart config.
//
// NOT YET BUILT (§8): confidence tiers (exact / high / low), barcode lookup,
// label OCR, plate-photo estimates.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays, esc } from '../util.js';
import { macroSuggestions, dayMacros, dayIntake, rollingIntake } from '../derive.js';
import { renderHome } from './home.js';

let macroChartInstance=null;
let macroChartOpen=false;

export function renderDiet(){
  const d=db(),t=today();
  // ONE READ PATH (§6.9's checklist). dayMacros() sums d.meals AND the Meal
  // Tracker's counted servings (§13) from each day's own snapshot. The same
  // function feeds calcScore() and the 30-day chart, so the number on this card
  // and the number in the score can never disagree — which is exactly the class
  // of bug §6.9 records. d.meals is not replaced; the two are added together.
  const dm=dayMacros(t);
  const tp=dm.protein,tf=dm.fat,tc=dm.carbs,ts=dm.sugar;
  const tgts=d.targets||{},pG=+(tgts.protein)||180,fG=+(tgts.fat)||80,sG=+(tgts.sugar)||10;
  // Carbs has NO hardcoded fallback (§8.2) — 200 was an invented placeholder
  // with no basis, added the same day the carbs card was. Protein (180), fat
  // (80) and sugar (10) are the app's original, long-standing defaults and are
  // deliberately left alone; swapping them for derived values wasn't asked for
  // and would change established behaviour for existing users.
  //
  // If Ryan hasn't set a carb target, fall back to the derived suggestion
  // instead. If even that can't be computed — no bodyweight logged — the bar
  // renders as unset rather than dividing by a number nobody chose.
  const carbsTargetSet=tgts.carbs!=null&&tgts.carbs!==''&&+tgts.carbs>0;
  const cG=carbsTargetSet?+tgts.carbs:macroSuggestions().carbs;

  document.getElementById('today-protein').textContent=Math.round(tp);
  document.getElementById('today-fat').textContent=Math.round(tf);
  document.getElementById('today-carbs').textContent=Math.round(tc);
  document.getElementById('today-sugar').textContent=Math.round(ts);
  document.getElementById('protein-bar').style.width=Math.min(100,(tp/pG)*100)+'%';
  document.getElementById('fat-bar').style.width=Math.min(100,(tf/fG)*100)+'%';
  const carbsBar=document.getElementById('carbs-bar');
  if(cG>0){carbsBar.style.width=Math.min(100,(tc/cG)*100)+'%';carbsBar.classList.remove('is-unset');}
  else{carbsBar.style.width='100%';carbsBar.classList.add('is-unset');}
  document.getElementById('sugar-bar').style.width=Math.min(100,(ts/sG)*100)+'%';

  ['protein','fat','carbs','sugar'].forEach(k=>{
    const el=document.getElementById('target-'+k);
    if(el&&tgts[k])el.value=tgts[k];
  });
  renderMacroSuggestions();
  renderSupplements();

  let sdClass,sdIcon,sdMsg;
  if(ts===0){sdClass='sd-clean';sdIcon='✅';sdMsg='No sugar — HGH protected ✓';}
  else if(ts<=10){sdClass='sd-mild';sdIcon='⚠️';sdMsg=`Sugar: ${Math.round(ts)}g — mild GH suppression`;}
  else if(ts<=25){sdClass='sd-sig';sdIcon='🔶';sdMsg=`Sugar: ${Math.round(ts)}g — significant GH + cortisol impact`;}
  else{sdClass='sd-severe';sdIcon='🚨';sdMsg=`Sugar: ${Math.round(ts)}g — severe hormonal suppression`;}
  document.getElementById('sugar-damage-display').innerHTML=`<div class="sugar-damage ${sdClass}"><span class="sd-icon">${sdIcon}</span><span>${sdMsg}</span></div>`;

  if(macroChartOpen)renderMacroChart();
  if(intakeChartOpen)renderIntakeChart();
}

// ---------------------------------------------------------------------------
// Derived macro targets — ARCHITECTURE.md §8.2.
//
// SUGGESTIONS, NOT AUTOFILL. Nothing here writes to d.targets; Ryan's entered
// value always wins. The formulas and the reasoning about what must NOT feed
// them (resting HR, waist) live in macroSuggestions() in derive.js (§1.3).
// ---------------------------------------------------------------------------
function renderMacroSuggestions(){
  const s=macroSuggestions();
  const put=(k,val,unit)=>{
    const el=document.getElementById('suggest-'+k);
    if(!el)return;
    el.textContent=val==null?'Suggested: —':'Suggested: '+val+unit;
    el.classList.toggle('is-unknown',val==null);
  };
  put('protein',s.protein,'g');
  put('fat',s.fat,'g');
  put('carbs',s.carbs,'g');
  put('sugar',s.sugar,'g max');
  const basis=document.getElementById('suggest-basis');
  if(basis)basis.textContent=s.bodyweight==null
    ? 'Suggestions need a bodyweight. Log one on the Health page — nothing is assumed.'
    : `From a ${s.bodyweight} lb 7-day rolling bodyweight and a ${s.calories} kcal maintenance baseline. Suggestions only — your entered target always wins.`;
}

// ---------------------------------------------------------------------------
// Supplements — user-editable, stored additively in d.supplements (§8.1).
// Unscored by design: this is a checklist, not a pillar.
// ---------------------------------------------------------------------------
function supplements(){
  const d=db();
  return Array.isArray(d.supplements)?d.supplements.filter(s=>s&&s.name):[];
}

export function renderSupplements(){
  const el=document.getElementById('supplement-list');
  if(!el)return;
  const list=supplements();
  if(!list.length){
    el.innerHTML='<div class="form-note">No supplements listed. Add one below.</div>';
    return;
  }
  el.innerHTML=list.map((s,i)=>
    `<div class="supp-row">`+
      `<span class="supp-icon">${esc(s.icon||'💊')}</span>`+
      `<div class="supp-body"><div class="supp-name">${esc(s.name)}</div>`+
        (s.detail?`<div class="supp-detail">${esc(s.detail)}</div>`:'')+
      `</div>`+
      `<button class="supp-btn" onclick="moveSupplement(${i},-1)" ${i===0?'disabled':''} aria-label="Move up">↑</button>`+
      `<button class="supp-btn" onclick="moveSupplement(${i},1)" ${i===list.length-1?'disabled':''} aria-label="Move down">↓</button>`+
      `<button class="supp-btn supp-del" onclick="deleteSupplement(${i})" aria-label="Delete">✕</button>`+
    `</div>`).join('');
}

export function addSupplement(){
  const nameEl=document.getElementById('supp-name');
  const detailEl=document.getElementById('supp-detail');
  const name=((nameEl&&nameEl.value)||'').trim();
  if(!name){alert('Enter a supplement name.');return;}
  const d=db();
  if(!Array.isArray(d.supplements))d.supplements=[];
  d.supplements.push({name,detail:((detailEl&&detailEl.value)||'').trim(),icon:'💊'});
  save(d);
  if(nameEl)nameEl.value='';
  if(detailEl)detailEl.value='';
  renderSupplements();
}

export function deleteSupplement(i){
  const d=db();
  if(!Array.isArray(d.supplements)||!d.supplements[i])return;
  d.supplements.splice(i,1);
  save(d);
  renderSupplements();
}

export function moveSupplement(i,dir){
  const d=db();
  if(!Array.isArray(d.supplements))return;
  const j=i+dir;
  if(j<0||j>=d.supplements.length)return;
  const tmp=d.supplements[i];d.supplements[i]=d.supplements[j];d.supplements[j]=tmp;
  save(d);
  renderSupplements();
}

// ---------------------------------------------------------------------------
// Macro consistency graph — replaces the old scrolling meal list.
//
// A list of the last fifteen meals answered "what did I eat"; the question that
// actually matters is "am I hitting the same numbers day after day". Same
// Chart.js pattern as vitals.js, including the colour-literal exception noted
// at the top of this file.
// ---------------------------------------------------------------------------
const MACRO_CHART_DAYS=30;

export function toggleMacroChart(){
  macroChartOpen=!macroChartOpen;
  const card=document.getElementById('macro-chart-card');
  const btn=document.getElementById('macro-chart-btn');
  if(card)card.style.display=macroChartOpen?'block':'none';
  if(btn)btn.textContent=macroChartOpen?'Hide macro consistency graph':'Show macro consistency graph';
  if(macroChartOpen)renderMacroChart();
}

function renderMacroChart(){
  const canvas=document.getElementById('macro-chart');
  if(!canvas||typeof Chart==='undefined')return;
  const now=new Date();
  const labels=[],protein=[],fat=[],carbs=[],sugar=[];
  let anyData=false;
  for(let i=MACRO_CHART_DAYS-1;i>=0;i--){
    const dt=addDays(now,-i),ds=dateStr(dt);
    labels.push((dt.getMonth()+1)+'/'+dt.getDate());
    // Same one read path as the cards and the score. `hasData` is true when the
    // day has a logged meal OR a counted serving; anything else stays a GAP,
    // never a zero — an unlogged day is not a zero-protein day (§8.3).
    const dm=dayMacros(ds);
    if(dm.hasData)anyData=true;
    protein.push(dm.hasData?dm.protein:null);fat.push(dm.hasData?dm.fat:null);
    carbs.push(dm.hasData?dm.carbs:null);sugar.push(dm.hasData?dm.sugar:null);
  }
  const note=document.getElementById('macro-chart-note');
  if(note)note.textContent=anyData
    ? 'Days with nothing logged or counted are gaps, not zeroes — an unlogged day is not a zero-protein day.'
    : 'Nothing logged or counted yet. Log a meal or count a serving and this fills in.';

  // Chart.js colour literals — see the file header. They mirror --accent,
  // --accent3, --accent2 and --danger from tokens.css.
  const line=(label,data,color)=>({label,data,borderColor:color,backgroundColor:'transparent',tension:.3,pointRadius:2,pointBackgroundColor:color,spanGaps:false,borderWidth:2});
  const ctx=canvas.getContext('2d');
  if(macroChartInstance)macroChartInstance.destroy();
  macroChartInstance=new Chart(ctx,{
    type:'line',
    data:{labels,datasets:[
      line('Protein',protein,'#7c6af7'),
      line('Fat',fat,'#f7a46a'),
      line('Carbs',carbs,'#4fd8c4'),
      line('Sugar',sugar,'#f76a6a')
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        y:{beginAtZero:true,ticks:{color:'#6b6b8a',font:{size:9}},grid:{color:'rgba(255,255,255,.04)'},title:{display:true,text:'grams',color:'#6b6b8a',font:{size:9}}},
        x:{ticks:{color:'#6b6b8a',font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:10},grid:{color:'rgba(255,255,255,.02)'}}
      }}
  });
}

// ---------------------------------------------------------------------------
// Caffeine & additives — ARCHITECTURE.md §8.4, §13.8.
//
// CAPTURE, NOT JUDGEMENT. Deliberately thin: two lines and three numbers. There
// is NO threshold, NO warning colour and NO "too much" marker anywhere in here,
// because that decision has not been made — it is a conversation with Ryan once
// he has seen real numbers, not something to invent in a chart config.
//
// MINERALS ARE CAPTURED AND VISIBLE PER ITEM BUT NOT CHARTED HERE. Charting
// them is a later call.
//
// THE AVERAGE IS A RATE OVER LOGGED DAYS (rollingIntake(), derive.js). Dividing
// by seven calendar days would make forgetting to log look like consuming less,
// which is exactly the lie §8.3 refuses for macros.
// ---------------------------------------------------------------------------
const INTAKE_CHART_DAYS=30;
let intakeChartInstance=null;
let intakeChartOpen=false;

export function toggleIntakeChart(){
  intakeChartOpen=!intakeChartOpen;
  const card=document.getElementById('intake-chart-card');
  const btn=document.getElementById('intake-chart-btn');
  if(card)card.style.display=intakeChartOpen?'block':'none';
  if(btn)btn.textContent=intakeChartOpen?'Hide caffeine & additive intake':'Show caffeine & additive intake';
  if(intakeChartOpen)renderIntakeChart();
}

// How many days in the window carry counted servings but NO §13.8 data at all —
// i.e. days recorded before the snapshot carried extras/flags. They are gaps,
// and the card says so rather than letting them read as quiet zeroes.
function legacyDaysInWindow(days){
  const now=new Date();
  let n=0;
  for(let i=days-1;i>=0;i--){
    const ds=dateStr(addDays(now,-i));
    const iv=dayIntake(ds);
    if(dayMacros(ds).hasData&&!iv.caffeineKnown&&!iv.additivesKnown&&!iv.novaKnown)n++;
  }
  return n;
}

function renderIntakeChart(){
  const canvas=document.getElementById('intake-chart');
  if(!canvas||typeof Chart==='undefined')return;
  const now=new Date();
  const labels=[],caffeine=[],additives=[];
  for(let i=INTAKE_CHART_DAYS-1;i>=0;i--){
    const dt=addDays(now,-i),ds=dateStr(dt);
    labels.push((dt.getMonth()+1)+'/'+dt.getDate());
    // null below the minimum — a "7-day average" from one day is noise wearing
    // a trend's clothing, and a gap draws as a break rather than a zero.
    const r=rollingIntake(ds);
    caffeine.push(r.caffeine===null?null:Math.round(r.caffeine*10)/10);
    additives.push(r.additives===null?null:Math.round(r.additives*10)/10);
  }

  const cur=rollingIntake(today());
  const num=(v,unit)=>v===null?'—':(Math.round(v*10)/10)+unit;
  const summary=document.getElementById('intake-summary');
  if(summary){
    summary.textContent=
      'Last 7 days — caffeine '+num(cur.caffeine,' mg/day')+
      ' (from '+cur.caffeineDays+' logged day'+(cur.caffeineDays===1?'':'s')+')'+
      ' · additives '+num(cur.additives,'/day')+
      ' (from '+cur.additiveDays+' day'+(cur.additiveDays===1?'':'s')+')'+
      ' · NOVA-4 items '+num(cur.nova4,'/day')+
      ' (from '+cur.nova4Days+' day'+(cur.nova4Days===1?'':'s')+').';
  }

  const note=document.getElementById('intake-chart-note');
  if(note){
    const legacy=legacyDaysInWindow(INTAKE_CHART_DAYS);
    let text='Averaged over the days that actually have entries, not over seven calendar days — '+
             'forgetting to log is not the same as consuming less. A window with fewer than '+
             cur.minDays+' such days shows nothing rather than a noisy average.';
    if(legacy)text+=' '+legacy+' day'+(legacy===1?'':'s')+' in this window '+
             (legacy===1?'was':'were')+' counted before caffeine and additives were recorded, so '+
             (legacy===1?'it is a gap here — not a zero.':'they are gaps here — not zeroes.');
    if(cur.caffeine===null&&cur.additives===null)
      text='Nothing to average yet. Count a few servings of foods with a barcode, or type caffeine '+
           'in by hand, and this fills in.';
    note.textContent=text;
  }

  // Chart.js colour literals — the documented §1.6 exception, confined to this
  // config. They mirror --accent3 and --accent2; the legend above uses the real
  // tokens. NO red and no threshold band, on purpose.
  const line=(label,data,color,axis)=>({label,data,borderColor:color,backgroundColor:'transparent',
    tension:.3,pointRadius:2,pointBackgroundColor:color,spanGaps:false,borderWidth:2,yAxisID:axis});
  const ctx=canvas.getContext('2d');
  if(intakeChartInstance)intakeChartInstance.destroy();
  intakeChartInstance=new Chart(ctx,{
    type:'line',
    data:{labels,datasets:[
      line('Caffeine',caffeine,'#f7a46a','y'),
      line('Additives',additives,'#4fd8c4','y1')
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        y:{beginAtZero:true,position:'left',ticks:{color:'#6b6b8a',font:{size:9}},
           grid:{color:'rgba(255,255,255,.04)'},
           title:{display:true,text:'caffeine mg/day',color:'#6b6b8a',font:{size:9}}},
        y1:{beginAtZero:true,position:'right',ticks:{color:'#6b6b8a',font:{size:9}},
            grid:{drawOnChartArea:false},
            title:{display:true,text:'additives/day',color:'#6b6b8a',font:{size:9}}},
        x:{ticks:{color:'#6b6b8a',font:{size:8},maxRotation:45,autoSkip:true,maxTicksLimit:10},
           grid:{color:'rgba(255,255,255,.02)'}}
      }}
  });
}

export function logMeal(){const d=db();d.meals.push({name:document.getElementById('meal-name').value,protein:document.getElementById('meal-protein').value||0,fat:document.getElementById('meal-fat').value||0,carbs:document.getElementById('meal-carbs').value||0,sugar:document.getElementById('meal-sugar').value||0,date:document.getElementById('meal-date').value||today()});save(d);alert('Meal logged!');renderHome();renderDiet();}
