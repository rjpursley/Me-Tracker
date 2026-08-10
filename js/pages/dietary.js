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
import { renderHome } from './home.js';

let macroChartInstance=null;
let macroChartOpen=false;

export function renderDiet(){
  const d=db(),t=today();
  const meals=d.meals.filter(m=>m.date===t);
  const sum=k=>meals.reduce((a,m)=>a+(+m[k]||0),0);
  const tp=sum('protein'),tf=sum('fat'),tc=sum('carbs'),ts=sum('sugar');
  const tgts=d.targets||{},pG=+(tgts.protein)||180,fG=+(tgts.fat)||80,cG=+(tgts.carbs)||200,sG=+(tgts.sugar)||10;

  document.getElementById('today-protein').textContent=Math.round(tp);
  document.getElementById('today-fat').textContent=Math.round(tf);
  document.getElementById('today-carbs').textContent=Math.round(tc);
  document.getElementById('today-sugar').textContent=Math.round(ts);
  document.getElementById('protein-bar').style.width=Math.min(100,(tp/pG)*100)+'%';
  document.getElementById('fat-bar').style.width=Math.min(100,(tf/fG)*100)+'%';
  document.getElementById('carbs-bar').style.width=Math.min(100,(tc/cG)*100)+'%';
  document.getElementById('sugar-bar').style.width=Math.min(100,(ts/sG)*100)+'%';

  ['protein','fat','carbs','sugar'].forEach(k=>{
    const el=document.getElementById('target-'+k);
    if(el&&tgts[k])el.value=tgts[k];
  });
  renderSupplements();

  let sdClass,sdIcon,sdMsg;
  if(ts===0){sdClass='sd-clean';sdIcon='✅';sdMsg='No sugar — HGH protected ✓';}
  else if(ts<=10){sdClass='sd-mild';sdIcon='⚠️';sdMsg=`Sugar: ${Math.round(ts)}g — mild GH suppression`;}
  else if(ts<=25){sdClass='sd-sig';sdIcon='🔶';sdMsg=`Sugar: ${Math.round(ts)}g — significant GH + cortisol impact`;}
  else{sdClass='sd-severe';sdIcon='🚨';sdMsg=`Sugar: ${Math.round(ts)}g — severe hormonal suppression`;}
  document.getElementById('sugar-damage-display').innerHTML=`<div class="sugar-damage ${sdClass}"><span class="sd-icon">${sdIcon}</span><span>${sdMsg}</span></div>`;

  if(macroChartOpen)renderMacroChart();
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
  const d=db(),now=new Date();
  const labels=[],protein=[],fat=[],carbs=[],sugar=[];
  let anyData=false;
  for(let i=MACRO_CHART_DAYS-1;i>=0;i--){
    const dt=addDays(now,-i),ds=dateStr(dt);
    labels.push((dt.getMonth()+1)+'/'+dt.getDate());
    const meals=d.meals.filter(m=>m.date===ds);
    if(meals.length)anyData=true;
    const sum=k=>meals.length?meals.reduce((a,m)=>a+(+m[k]||0),0):null;
    protein.push(sum('protein'));fat.push(sum('fat'));carbs.push(sum('carbs'));sugar.push(sum('sugar'));
  }
  const note=document.getElementById('macro-chart-note');
  if(note)note.textContent=anyData
    ? 'Days with no meals logged are gaps, not zeroes — an unlogged day is not a zero-protein day.'
    : 'No meals logged yet. Log a meal and this fills in.';

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

export function logMeal(){const d=db();d.meals.push({name:document.getElementById('meal-name').value,protein:document.getElementById('meal-protein').value||0,fat:document.getElementById('meal-fat').value||0,carbs:document.getElementById('meal-carbs').value||0,sugar:document.getElementById('meal-sugar').value||0,date:document.getElementById('meal-date').value||today()});save(d);alert('Meal logged!');renderHome();renderDiet();}
