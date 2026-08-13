// ---------------------------------------------------------------------------
// pages/meals.js — the Meal Tracker. ARCHITECTURE.md §8, §13.
//
// Home -> Dietary -> Meal Tracker. A third nav level, which §4 says requires a
// decision; Ryan made it. Reached from a nav row at the bottom of the Dietary
// page, reusing the same .score-box / .score-row component the Personal Records
// row on the Training page already uses.
//
// TWO PARTS, and they have different owners:
//
//   A. THE COUNTER (top, the thing used daily). One row per library item:
//      [ADD] [REMOVE]  2  RXBAR Chocolate Sea Salt
//      Counts are LOCAL data in d.foodCounts, per local civil day via today()
//      (§12), TODAY ONLY. No date picker, no retroactive editing.
//
//   B. THE LIBRARY (below). Add / edit / delete, every field typed by hand.
//      The SERVER owns this (§13.1). The phone keeps a read-only mirror.
//
// ############ THE SNAPSHOT RULE IS LOAD-BEARING ############
//
// The first time an item is added on a day, its per-serving macros are COPIED
// into that day's record. From then on the day is independent of the library:
// its macros come from ITS OWN snapshot, never from a lookup in d.foodLibrary.
//
// That is what makes the server's 120-day purge safe (§13.5), and what stops a
// later correction to a label from silently rewriting a score Ryan has already
// seen. DO NOT "normalise" this into an id reference.
//
// ############ COUNTING WORKS FULLY OFFLINE ############
//
// Every ADD and REMOVE writes localStorage and nothing else. Nothing about the
// counter waits on, or can be blocked by, a server response. The /used ping is
// fire-and-forget and its failure is invisible by design.
//
// A LIBRARY WRITE THAT FAILS SAYS SO AND CHANGES NOTHING (§1.7). Writes are
// never queued locally and the mirror is never allowed to diverge from the
// server — it is a cache, not a second source of truth.
//
// NOT BUILT HERE, DELIBERATELY: barcode scanning and label OCR (§8). They are a
// later, separate build. There are no stub buttons for them.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, esc } from '../util.js';
import { dayMacros, foodCountMacros, FOOD_MACRO_FIELDS } from '../derive.js';
import { fetchFoods, createFood, updateFood, deleteFood, markFoodUsed } from '../api.js';
import { renderHome } from './home.js';

// Label and unit per stored macro field. The first four are scored; the last
// three are displayed only and are labelled as such on the page (§13.2).
const MACRO_META=[
  {key:'protein', label:'Protein',  unit:'g',  scored:true},
  {key:'fat',     label:'Fat',      unit:'g',  scored:true},
  {key:'carbs',   label:'Carbs',    unit:'g',  scored:true},
  {key:'sugar',   label:'Sugar',    unit:'g',  scored:true},
  {key:'calories',label:'Calories', unit:'',   scored:false},
  {key:'fiber',   label:'Fiber',    unit:'g',  scored:false},
  {key:'sodium',  label:'Sodium',   unit:'mg', scored:false}
];

// Module state, not stored: an abandoned edit or a stale error must not
// survive the page. Same reasoning as training.js's pause gate.
let editingId=null;          // null = the form is in "add" mode
let libraryMsg=null;         // {text, kind:'info'|'err'|'success'}
let libraryBusy=false;
let fetchState='idle';       // 'idle' | 'fetching' | 'ok' | 'failed'

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// The MIRROR, always. The page renders off this so it paints instantly and
// works with the server unreachable; the fetch below updates it in the
// background.
function mirror(){
  const d=db();
  return Array.isArray(d.foodLibrary)?d.foodLibrary.filter(i=>i&&i.id):[];
}

function mirrorItem(id){
  return mirror().find(i=>i.id===id)||null;
}

// TODAY ONLY (§13). today() is local civil day (util.js, §12).
function todayCounts(){
  const d=db();
  const day=d.foodCounts&&d.foodCounts[today()];
  return (day&&typeof day==='object'&&!Array.isArray(day))?day:{};
}

function countOf(id){
  const e=todayCounts()[id];
  return e?(+e.count||0):0;
}

// ---------------------------------------------------------------------------
// The counter — ADD / REMOVE. LOCAL WRITES ONLY.
// ---------------------------------------------------------------------------

// Per-serving macros, copied out of a library item. Coerced once, here, so the
// stored snapshot is already numbers-or-null and no reader has to re-parse it.
// A missing or blank field stays NULL — "not on the label" is not zero (§1.7).
function snapshotMacros(src){
  const m=(src&&typeof src==='object')?src:{};
  const out={};
  FOOD_MACRO_FIELDS.forEach(k=>{
    const v=m[k];
    if(v===null||v===undefined||v==='') { out[k]=null; return; }
    const num=+v;
    out[k]=isFinite(num)?num:null;
  });
  return out;
}

// Returns the day's record, creating the containers if they are absent. Never
// migrates or rewrites anything that already exists (§1.4).
function dayRecord(d){
  if(!d.foodCounts||typeof d.foodCounts!=='object'||Array.isArray(d.foodCounts))d.foodCounts={};
  const ds=today();
  const cur=d.foodCounts[ds];
  if(!cur||typeof cur!=='object'||Array.isArray(cur))d.foodCounts[ds]={};
  return d.foodCounts[ds];
}

export function mealAdd(id){
  const d=db();
  const day=dayRecord(d);
  let entry=day[id];
  if(!entry){
    // FIRST ADD OF THE DAY — this is where the snapshot is taken, and the only
    // place it is ever taken. An item already counted today keeps the macros it
    // was counted with, even if the library has since been edited.
    const item=mirrorItem(id);
    if(!item){
      libraryMsg={text:'That food is not in this phone’s library any more, so there is nothing to count. Nothing was changed.',kind:'err'};
      renderMeals();
      return;
    }
    entry={count:0,name:item.name||'',servingText:item.servingText||'',macros:snapshotMacros(item.macros)};
    day[id]=entry;
  }
  entry.count=(+entry.count||0)+1;
  save(d);
  // Fire-and-forget (§13.5). The count above is already saved; this only pushes
  // the item's purge date out. A failure here is invisible on purpose — it must
  // never block or undo a local count.
  markFoodUsed(id);
  renderMeals();
  renderHome();
}

export function mealRemove(id){
  const d=db();
  const day=dayRecord(d);
  const entry=day[id];
  if(!entry)return;
  // FLOOR 0. A negative serving count is not a thing.
  entry.count=Math.max(0,(+entry.count||0)-1);
  // The entry and its snapshot are KEPT at zero, deliberately. Deleting it
  // would mean a later re-add that same day re-snapshots from a library that
  // may have been edited in between.
  save(d);
  renderMeals();
  renderHome();
}

// ---------------------------------------------------------------------------
// The library — server writes. Each one reports honestly and, on failure,
// leaves the mirror exactly as it was.
// ---------------------------------------------------------------------------

function readForm(){
  const val=id=>{const el=document.getElementById(id);return el?el.value:'';};
  const macros={};
  MACRO_META.forEach(m=>{
    const raw=(val('food-in-'+m.key)||'').trim();
    macros[m.key]=raw===''?null:raw;   // blank means NOT ON THE LABEL, not 0
  });
  return {name:(val('food-in-name')||'').trim(),
          servingText:(val('food-in-serving')||'').trim(),
          macros};
}

// Replaces the mirror wholesale from a server response. Only ever called with
// a body the server actually returned — the mirror never diverges.
function adoptLibrary(body){
  if(!body||!Array.isArray(body.items))return false;
  const d=db();
  d.foodLibrary=body.items;
  d.foodLibraryFetchedAt=new Date().toISOString();   // an INSTANT, so UTC (§12)
  save(d);
  return true;
}

export async function mealSaveFood(){
  if(libraryBusy)return;
  const payload=readForm();
  if(!payload.name){
    libraryMsg={text:'Give the food a name.',kind:'err'};
    renderMeals();return;
  }
  libraryBusy=true;
  libraryMsg={text:editingId?'Saving the change…':'Saving…',kind:'info'};
  renderMeals();
  const res=editingId?await updateFood(editingId,payload):await createFood(payload);
  libraryBusy=false;
  if(!res.ok){
    // SAY SO PLAINLY, AND SAY IT WAS NOT SAVED (§1.7). No local queue, no
    // optimistic mirror write — the mirror stays exactly where it was.
    libraryMsg={text:res.error+' The change was NOT saved. Your counts below are local and are unaffected.',kind:'err'};
    renderMeals();return;
  }
  adoptLibrary(res.body);
  const wasEditing=!!editingId;
  editingId=null;
  clearForm();
  libraryMsg={text:wasEditing?'Saved. Days already counted keep the macros they were counted with.':'Added to the library.',kind:'success'};
  renderMeals();
}

export async function mealDeleteFood(id){
  if(libraryBusy)return;
  const item=mirrorItem(id);
  const counted=countOf(id);
  const warn=counted>0
    ? '\n\nYou have counted '+counted+' of these today. That count and its macros stay exactly as they are — a counted day keeps its own snapshot.'
    : '';
  if(!confirm('Delete "'+((item&&item.name)||'this food')+'" from the library?'+warn))return;
  libraryBusy=true;
  libraryMsg={text:'Deleting…',kind:'info'};
  renderMeals();
  const res=await deleteFood(id);
  libraryBusy=false;
  if(!res.ok){
    libraryMsg={text:res.error+' Nothing was deleted.',kind:'err'};
    renderMeals();return;
  }
  adoptLibrary(res.body);
  if(editingId===id){editingId=null;clearForm();}
  libraryMsg={text:'Deleted. Any day that already counted it keeps its own macros.',kind:'success'};
  renderMeals();
}

export function mealEditFood(id){
  editingId=id;
  libraryMsg=null;
  renderMeals();
  fillForm(mirrorItem(id));
}

export function mealCancelEdit(){
  editingId=null;
  libraryMsg=null;
  renderMeals();
}

function clearForm(){
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};
  set('food-in-name','');set('food-in-serving','');
  MACRO_META.forEach(m=>set('food-in-'+m.key,''));
}

function fillForm(item){
  if(!item)return;
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=(v==null?'':v);};
  set('food-in-name',item.name);set('food-in-serving',item.servingText);
  const m=item.macros||{};
  MACRO_META.forEach(f=>set('food-in-'+f.key,m[f.key]));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function macroCell(label,val,unit,scored){
  const shown=(val===null||val===undefined)?'—':(Math.round(val*10)/10);
  return `<div class="mt-total${scored?'':' is-unscored'}"><div class="mt-total-label">${label}</div>`+
         `<div class="mt-total-val">${shown}</div><div class="mt-total-unit">${unit||''}</div></div>`;
}

function counterHtml(){
  const items=mirror();
  const counts=todayCounts();
  // Anything counted today that is no longer in the mirror still gets a row —
  // its macros are still in today's total, so hiding it would leave Ryan with
  // numbers he cannot account for. Rendered from its OWN snapshot (§13.5).
  const extraIds=Object.keys(counts).filter(id=>!items.some(i=>i.id===id));
  const rows=items.map(i=>({id:i.id,name:i.name,servingText:i.servingText,orphan:false}))
    .concat(extraIds.map(id=>({id,name:counts[id].name,servingText:counts[id].servingText,orphan:true})));

  const fc=foodCountMacros(today());
  const dm=dayMacros(today());

  let html='<div class="card">';
  html+=`<div class="card-title">Today · ${today()}</div>`;
  html+=`<div class="mt-totals">`+
        MACRO_META.filter(m=>m.scored).map(m=>macroCell(m.label,fc[m.key],m.unit,true)).join('')+
        `</div>`;
  html+=`<div class="mt-totals mt-totals-sub">`+
        MACRO_META.filter(m=>!m.scored).map(m=>macroCell(m.label,fc[m.key],m.unit,false)).join('')+
        `</div>`;
  html+=`<div class="form-note">From ${fc.servings} serving${fc.servings===1?'':'s'} counted today. `+
        `Calories, fiber and sodium are recorded and shown but are not scored. `+
        `These add to anything logged with Log Meal — the Dietary page shows the combined total `+
        `(protein ${Math.round(dm.protein)}g · fat ${Math.round(dm.fat)}g · carbs ${Math.round(dm.carbs)}g · sugar ${Math.round(dm.sugar)}g).</div>`;
  html+='</div>';

  if(!rows.length){
    return html+`<div class="card"><div class="form-note">No foods in the library yet. Add one below and it appears here to count.</div></div>`;
  }

  html+='<div class="card">';
  html+=rows.map(r=>{
    const n=countOf(r.id);
    return `<div class="fc-row">`+
      `<button class="fc-btn" onclick="mealAdd('${esc(r.id)}')">ADD</button>`+
      `<button class="fc-btn fc-btn-remove" onclick="mealRemove('${esc(r.id)}')"${n===0?' disabled':''}>REMOVE</button>`+
      `<div class="fc-count${n>0?' is-on':''}">${n}</div>`+
      `<div class="fc-body">`+
        `<div class="fc-name">${esc(r.name||'(unnamed)')}</div>`+
        `<div class="fc-serving">${r.servingText?'1 = '+esc(r.servingText):'serving size not recorded'}</div>`+
        (r.orphan?`<div class="fc-serving">No longer in the library — today’s count keeps its own macros.</div>`:'')+
      `</div>`+
    `</div>`;
  }).join('');
  html+=`<div class="form-note">Counts are for today only and are saved on this phone. They work with the server switched off.</div>`;
  html+='</div>';
  return html;
}

function mirrorAgeLabel(){
  const d=db();
  const at=d.foodLibraryFetchedAt;
  if(!at)return 'never refreshed from the server on this phone';
  const t=new Date(at);
  if(isNaN(t.getTime()))return 'unknown';
  const mins=Math.round((Date.now()-t.getTime())/60000);
  const rel=mins<1?'just now':mins<60?(mins+' min ago'):mins<1440?(Math.round(mins/60)+' hr ago'):(Math.round(mins/1440)+' day(s) ago');
  return t.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' · '+rel;
}

function libraryHtml(){
  const items=mirror();
  let html='';

  // The offline story, said plainly rather than left to a blank page (§1.7).
  if(fetchState==='failed'){
    html+=items.length
      ? `<div class="alert info">Showing the copy saved on this phone — the server could not be reached, so it may be out of date. Counting still works; adding or editing a food does not.</div>`
      : `<div class="alert err">There are no foods saved on this phone and the server could not be reached, so there is nothing to count yet. Use the Log Meal form on the Dietary page in the meantime — it still works and still counts toward today.</div>`;
  }

  if(libraryMsg){
    const cls=libraryMsg.kind==='success'?'success':libraryMsg.kind==='err'?'err':'info';
    html+=`<div class="alert ${cls}">${esc(libraryMsg.text)}</div>`;
  }

  html+='<div class="card">';
  html+=`<div class="card-title">${editingId?'Edit food':'Add a food'}</div>`;
  html+=`<div class="form-row"><div class="form-label">Name</div><input type="text" id="food-in-name" placeholder="e.g. RXBAR Chocolate Sea Salt"></div>`;
  html+=`<div class="form-row"><div class="form-label">Serving size, as printed on the label</div><input type="text" id="food-in-serving" placeholder="e.g. 1 bar (52g)"></div>`;
  html+='<div class="mt-macro-grid">';
  MACRO_META.forEach(m=>{
    html+=`<div class="form-row"><div class="form-label">${m.label}${m.unit?' ('+m.unit+')':''}${m.scored?'':' <span class="mt-unscored-tag">not scored</span>'}</div>`+
          `<input type="number" id="food-in-${m.key}" step="0.1" inputmode="decimal" placeholder="blank if not on the label"></div>`;
  });
  html+='</div>';
  html+=`<div class="form-note">Leave a field blank if it is not printed on the label. Blank means "not on the label" — it is not the same as 0, and it is never counted as 0.</div>`;
  html+=`<button class="btn btn-primary" onclick="mealSaveFood()"${libraryBusy?' disabled':''}>${editingId?'Save changes':'Add to library'}</button>`;
  if(editingId)html+=`<button class="btn btn-secondary" onclick="mealCancelEdit()">Cancel</button>`;
  html+='</div>';

  if(!items.length){
    html+=`<div class="card"><div class="form-note">The library is empty on this phone.</div></div>`;
    return html;
  }

  html+='<div class="card">';
  html+=`<div class="card-title">Saved foods (${items.length})</div>`;
  html+=items.map(i=>{
    const m=i.macros||{};
    const line=MACRO_META.map(f=>{
      const v=m[f.key];
      return (v===null||v===undefined)?null:`${f.label} ${v}${f.unit}`;
    }).filter(Boolean).join(' · ');
    return `<div class="fl-row">`+
      `<div class="fl-body">`+
        `<div class="fl-name">${esc(i.name||'(unnamed)')}</div>`+
        `<div class="fl-serving">${i.servingText?esc(i.servingText):'serving size not recorded'}</div>`+
        `<div class="fl-macros">${line||'no macros recorded'}</div>`+
      `</div>`+
      `<button class="fl-btn" onclick="mealEditFood('${esc(i.id)}')">Edit</button>`+
      `<button class="fl-btn fl-del" onclick="mealDeleteFood('${esc(i.id)}')">Delete</button>`+
    `</div>`;
  }).join('');
  html+=`<div class="form-note">The food library lives on the server, so it survives this phone. Last refreshed: ${esc(mirrorAgeLabel())}.</div>`;
  html+='</div>';
  return html;
}

// RENDERS FROM THE MIRROR FIRST, ALWAYS. The page paints before any network
// call is made, so it is instant and it works with the server down. The fetch
// below only ever improves what is already on screen.
export function renderMeals(){
  const counter=document.getElementById('meal-counter');
  const library=document.getElementById('meal-library');
  if(!counter||!library)return;
  counter.innerHTML=counterHtml();
  library.innerHTML=libraryHtml();
  if(editingId)fillForm(mirrorItem(editingId));
}

// Called by showPage() when the page opens. Paints from the mirror, then
// refreshes it in the background.
export function openMeals(){
  libraryMsg=null;
  editingId=null;
  renderMeals();
  refreshLibrary();
}

function refreshLibrary(){
  if(fetchState==='fetching')return;
  fetchState='fetching';
  return fetchFoods().then(function(res){
    if(res.ok&&adoptLibrary(res.body)){
      fetchState='ok';
    }else{
      // The mirror is LEFT ALONE. A failed fetch must not empty it — that
      // would turn a network blip into a phone that thinks Ryan owns no foods.
      fetchState='failed';
    }
    renderMeals();
  });
}
