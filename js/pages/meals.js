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
// ############ THE BARCODE PATH — REVIEW BEFORE SAVE (§13.6, §13.7) ############
//
// Typed digits only. NO CAMERA, NO LIVE SCANNING, NO IMAGE DECODING, AND NO
// VISION MODEL — a misread digit returns a different product's macros with full
// confidence and nothing downstream can tell. Label OCR is still a later,
// separate build and there is deliberately no stub button for it.
//
// A lookup NEVER writes anything. It produces a review card; Ryan checks it
// against the package in his hand, edits whatever is wrong, and only an
// explicit Save tap creates the item — through the EXISTING POST /api/foods,
// not a second create path.
//
// When Open Food Facts only knows the product per 100 g (about one lookup in
// four, measured — §13.6), the card says so and offers two routes to a serving
// size. Both produce the same single output: GRAMS PER SERVING. Only that is
// stored; the net weight and servings-per-container that may have produced it
// are inputs to a calculation, not facts, and must not be persisted.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, esc } from '../util.js';
import { dayMacros, foodCountMacros, FOOD_MACRO_FIELDS, FOOD_EXTRA_FIELDS } from '../derive.js';
import { fetchFoods, createFood, updateFood, deleteFood, markFoodUsed, lookupBarcode } from '../api.js';
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

// §13.8's six extras. All milligrams, all optional, NONE scored. Auto-filled by
// a lookup where Open Food Facts has them and typed by hand otherwise — caffeine
// especially, which OFF carries for only about a third of energy drinks and
// almost nothing else.
const EXTRA_META=[
  {key:'caffeine', label:'Caffeine'},
  {key:'potassium',label:'Potassium'},
  {key:'calcium',  label:'Calcium'},
  {key:'iron',     label:'Iron'},
  {key:'magnesium',label:'Magnesium'},
  {key:'zinc',     label:'Zinc'}
];

// Module state, not stored: an abandoned edit or a stale error must not
// survive the page. Same reasoning as training.js's pause gate.
let editingId=null;          // null = the form is in "add" mode
let libraryMsg=null;         // {text, kind:'info'|'err'|'success'}
let libraryBusy=false;
let fetchState='idle';       // 'idle' | 'fetching' | 'ok' | 'failed'

// The barcode path. All three are module state, never stored: an abandoned
// review or a stale error must not survive the page.
let barcodeInput='';         // what is typed in the lookup box, kept across re-renders
let scan=null;               // the open review card, or null. NOTHING IS SAVED FROM IT
                             // until mealScanSave() runs.
let pendingBarcode=null;     // a NOT-FOUND code, kept so the manual form keeps it

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

// The six §13.8 extras, copied out of a library item the same way and for the
// same reason as the macros. Returns null when the item carries none at all, so
// the snapshot simply has no `extras` key — absence stays the boundary.
function snapshotExtras(src){
  const m=(src&&typeof src==='object')?src:null;
  if(!m)return null;
  const out={};let any=false;
  FOOD_EXTRA_FIELDS.forEach(k=>{
    const v=m[k];
    if(v===null||v===undefined||v===''){out[k]=null;return;}
    const num=+v;
    if(isFinite(num)){out[k]=num;any=true;}else{out[k]=null;}
  });
  return any?out:null;
}

// The flags, deep-copied so the snapshot cannot share structure with the mirror
// — a later library refresh replacing d.foodLibrary must not be able to reach
// into a stored day through a shared array reference.
//
// NOT SCALED, EVER (§13.8). This is a copy, not a calculation.
function snapshotFlags(src){
  const f=(src&&typeof src==='object')?src:null;
  if(!f)return null;
  const a=f.additives;
  let additives=null;
  if(a&&typeof a==='object'&&Array.isArray(a.tags)){
    // The count:0 / empty-tags case is PRESERVED, not dropped: it means OFF
    // positively reported no additives, which is a different fact from not
    // knowing (§13.8).
    additives={count:+a.count||0,
               tags:a.tags.map(t=>String(t)),
               names:Array.isArray(a.names)?a.names.map(n=>n==null?null:String(n)):[]};
  }
  const nova=+f.novaGroup;
  const novaGroup=(isFinite(nova)&&nova>=1&&nova<=4)?nova:null;
  if(!additives&&novaGroup===null)return null;
  return {additives,novaGroup};
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
    // §13.8's two groups are snapshotted at the SAME moment and by the same
    // rule. Added as two keys beside `macros` — the existing shape is not
    // restructured. An item carrying neither leaves the entry exactly as days
    // recorded before this shipped look, which is what makes absence readable.
    const ex=snapshotExtras(item.extras);
    if(ex)entry.extras=ex;
    const fl=snapshotFlags(item.flags);
    if(fl)entry.flags=fl;
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
  // §13.8's extras are typeable here. FLAGS ARE NOT AND MUST NOT BE — a
  // hand-entered item has unknown additives, not zero.
  const extras={};
  EXTRA_META.forEach(m=>{
    const raw=(val('food-in-x-'+m.key)||'').trim();
    extras[m.key]=raw===''?null:raw;
  });
  return {name:(val('food-in-name')||'').trim(),
          servingText:(val('food-in-serving')||'').trim(),
          macros,extras};
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
  // A barcode Open Food Facts did not have is kept with the item Ryan types, so
  // he enters the panel once and a later lookup finds his own entry. Confidence
  // is deliberately NOT sent: a hand-typed panel stays `high` (§8), barcode or
  // not — only a lookup earns `exact`.
  if(pendingBarcode&&!editingId)payload.barcode=pendingBarcode;
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
  pendingBarcode=null;
  barcodeInput='';
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
  EXTRA_META.forEach(m=>set('food-in-x-'+m.key,''));
}

function fillForm(item){
  if(!item)return;
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=(v==null?'':v);};
  set('food-in-name',item.name);set('food-in-serving',item.servingText);
  const m=item.macros||{};
  MACRO_META.forEach(f=>set('food-in-'+f.key,m[f.key]));
  const x=item.extras||{};
  EXTRA_META.forEach(f=>set('food-in-x-'+f.key,x[f.key]));
}

// ---------------------------------------------------------------------------
// The barcode path — §13.6, §13.7. Lookup, review, and only then save.
// ---------------------------------------------------------------------------

// A number strictly greater than zero, or null. BLANK, ZERO, TEXT, A NEGATIVE
// AND Infinity ALL COME BACK null — this is the one gate every serving-size
// figure passes through, so a division can never emit NaN or Infinity into the
// card. Number('') is 0 and Number('Infinity') is Infinity, which is exactly
// why this is not a bare Number() call.
function positiveNum(v){
  const s=String(v==null?'':v).trim();
  if(s==='')return null;
  const n=Number(s);
  return (isFinite(n)&&n>0)?n:null;
}

function round2(n){return Math.round(n*100)/100;}

// The comparison key for two barcodes. The server canonicalises what it returns
// (§13.6), but an item saved before that — or typed in the other form — must
// still be recognised as the same product, or the duplicate guard has a hole
// exactly where it is needed. Leading zeros are the only thing that differs
// between a UPC-A and its EAN-13, so they are what gets stripped.
function barcodeKey(code){
  const digits=String(code==null?'':code).replace(/[\s-]/g,'');
  if(!digits||!/^\d+$/.test(digits))return null;
  return digits.replace(/^0+/,'')||'0';
}

function findByBarcode(code){
  const key=barcodeKey(code);
  if(!key)return null;
  return mirror().find(i=>barcodeKey(i.barcode)===key)||null;
}

export function mealBarcodeTyped(v){barcodeInput=v;}

// Grams in one serving, as the card currently stands, or null if not known yet.
// For a converted candidate that is Open Food Facts' own figure; for a per-100g
// one it is whichever route Ryan is using.
function scanGrams(){
  if(!scan)return null;
  if(scan.basis!=='per_100g')return positiveNum(scan.servingGrams);
  if(scan.route==='A')return positiveNum(scan.grams);
  const net=positiveNum(scan.net), per=positiveNum(scan.per);
  if(net===null||per===null)return null;      // blank or zero -> NOTHING, per §13.7
  const g=net/per;
  return (isFinite(g)&&g>0)?g:null;
}

function scanSource(){
  if(!scan)return null;
  if(scan.basis!=='per_100g')return 'off';
  return scan.route==='A'?'label':'divided';
}

// Reads whatever is currently in the card's inputs back into module state, so a
// re-render (a background library refresh, an ADD tap) cannot lose an edit.
function captureScan(){
  if(!scan)return;
  const val=id=>{const el=document.getElementById(id);return el?el.value:null;};
  const name=val('sc-name');           if(name!==null)scan.name=name;
  const st=val('sc-serving');          if(st!==null)scan.servingText=st;
  const g=val('sc-grams');             if(g!==null)scan.grams=g;
  const net=val('sc-net');             if(net!==null)scan.net=net;
  const per=val('sc-per');             if(per!==null)scan.per=per;
  FOOD_MACRO_FIELDS.forEach(k=>{
    const v=val('sc-m-'+k);
    if(v!==null)scan.macros[k]=v;
  });
  FOOD_EXTRA_FIELDS.forEach(k=>{
    const v=val('sc-x-'+k);
    if(v!==null)scan.extras[k]=v;
  });
}

export async function mealBarcodeLookup(){
  if(libraryBusy)return;
  captureScan();
  const typed=(barcodeInput||'').trim();
  if(!typed){
    libraryMsg={text:'Type the barcode digits first.',kind:'err'};
    renderMeals();return;
  }
  libraryBusy=true;scan=null;pendingBarcode=null;
  libraryMsg={text:'Looking up '+typed+'…',kind:'info'};
  renderMeals();
  const res=await lookupBarcode(typed);
  libraryBusy=false;

  if(!res.ok){
    // 400 (not a barcode), 502 (Open Food Facts down or slow), or 0 (this
    // server unreachable). SAY SO PLAINLY AND SHOW NOTHING — no half product,
    // no invented macros (§1.7). Manual entry is still right there below.
    libraryMsg={text:res.error+' Nothing was looked up and nothing was saved. '+
                     'You can still type the label in by hand below.',kind:'err'};
    renderMeals();return;
  }

  const body=res.body||{};
  if(body.found===false){
    // A PRODUCT OPEN FOOD FACTS DOES NOT HAVE IS A NORMAL OUTCOME. Keep the
    // code and drop straight into the manual form so Ryan types the panel once.
    const code=body.barcode||typed;
    const already=findByBarcode(code);
    if(already){
      // He has already saved this one himself. Don't hand him a blank form
      // that would create a second copy of it.
      //
      // Opened inline rather than via mealEditFood(), which clears libraryMsg —
      // that would drop him into a prefilled form with nothing saying why.
      editingId=already.id;
      libraryMsg={text:'Open Food Facts still does not have '+code+', but you already saved it as “'+
                       (already.name||'(unnamed)')+'”. That item is open for editing below — '+
                       'a second copy was not created.',kind:'info'};
      renderMeals();return;
    }
    pendingBarcode=code;
    editingId=null;
    libraryMsg={text:'Open Food Facts has no product with barcode '+code+'. Type the label in below — '+
                     'the barcode is saved with it, so looking it up again finds your own entry.',kind:'info'};
    renderMeals();return;
  }

  const per=(body.macros&&typeof body.macros==='object')?body.macros:{};
  const dup=findByBarcode(body.barcode);
  scan={
    barcode:body.barcode||typed,
    matchedAs:body.matchedAs||'',
    basis:body.basis||'per_100g',
    brand:body.brand||'',
    sodiumSource:body.sodiumSource||null,
    packageGrams:body.packageGrams,
    servingGrams:body.servingGrams,
    // The upstream numbers, KEPT UNTOUCHED as the thing every recalculation
    // works from. scan.macros is what the inputs show and what gets saved.
    source:per,
    macros:{},
    // §13.8. `sourceExtras` scales with the serving exactly like `source`;
    // `flags` is copied through untouched and NEVER scaled or edited.
    sourceExtras:(body.extras&&typeof body.extras==='object')?body.extras:{},
    extras:{},
    flags:(body.flags&&typeof body.flags==='object')?body.flags:null,
    name:body.name||'',
    servingText:body.servingText||'',
    servingTouched:false,
    route:'A',
    grams:'',
    // Prefilled so Ryan does not re-type a net weight the lookup already knew.
    // He can overwrite it.
    net:(body.packageGrams===null||body.packageGrams===undefined)?'':String(body.packageGrams),
    per:'',
    dupId:dup?dup.id:null
  };
  if(scan.basis!=='per_100g'){
    // Already per serving — show exactly what came back.
    FOOD_MACRO_FIELDS.forEach(k=>{
      const v=per[k];
      scan.macros[k]=(v===null||v===undefined)?'':String(v);
    });
    FOOD_EXTRA_FIELDS.forEach(k=>{
      const v=scan.sourceExtras[k];
      scan.extras[k]=(v===null||v===undefined)?'':String(v);
    });
  }else{
    // PER 100 g. The editable fields stay EMPTY until a serving size exists, so
    // a per-100g figure can never be mistaken for a per-serving one. The raw
    // per-100g numbers are shown separately, read-only, as reference. The
    // extras follow the macros exactly — same rule, same moment.
    FOOD_MACRO_FIELDS.forEach(k=>{scan.macros[k]='';});
    FOOD_EXTRA_FIELDS.forEach(k=>{scan.extras[k]='';});
  }
  libraryMsg=null;
  renderMeals();
}

// Recomputes from the per-100g figures. Bound ONLY to the serving-size inputs —
// never to the macro inputs themselves, or typing a corrected macro would be
// overwritten by the computed value on the very next keystroke.
export function mealScanRecalc(){
  if(!scan)return;
  captureScan();
  const g=scanGrams();
  if(scan.basis==='per_100g'){
    FOOD_MACRO_FIELDS.forEach(k=>{
      const v=scan.source[k];
      // NO SERVING SIZE MEANS NO PER-SERVING NUMBER. Clearing the serving size
      // clears these too, rather than leaving the figures from the last valid
      // one on screen — a per-serving column that no longer matches any serving
      // is exactly the kind of quietly wrong number this feature exists to
      // avoid. Save is already blocked; this stops it LOOKING right as well.
      const shown=(g===null||v===null||v===undefined)?'':String(round2(v*g/100));
      scan.macros[k]=shown;
      const el=document.getElementById('sc-m-'+k);
      if(el)el.value=shown;
    });
    // The extras convert by the SAME factor. No special case (§13.8).
    FOOD_EXTRA_FIELDS.forEach(k=>{
      const v=scan.sourceExtras[k];
      const shown=(g===null||v===null||v===undefined)?'':String(round2(v*g/100));
      scan.extras[k]=shown;
      const el=document.getElementById('sc-x-'+k);
      if(el)el.value=shown;
    });
    if(!scan.servingTouched){
      scan.servingText=(g===null)?'':'1 serving ('+round2(g)+'g)';
      const el=document.getElementById('sc-serving');
      if(el)el.value=scan.servingText;
    }
  }
  const line=document.getElementById('sc-derived');
  if(line)line.innerHTML=derivedLineHtml(g);
  syncSaveState();
}

// Any other edit on the card: capture it, and re-check whether Save is allowed.
export function mealScanEdited(){
  if(!scan)return;
  captureScan();
  syncSaveState();
}

export function mealScanServingTouched(){
  if(!scan)return;
  scan.servingTouched=true;
  captureScan();
}

export function mealScanRoute(route){
  if(!scan)return;
  captureScan();
  scan.route=(route==='B')?'B':'A';
  renderMeals();
  mealScanRecalc();
}

function scanCanSave(){
  if(!scan)return false;
  if(!String(scan.name||'').trim())return false;
  // THE HARD RULE (§13.7): a per-100g candidate cannot be saved until one of
  // the two routes has produced a grams-per-serving number.
  if(scan.basis==='per_100g')return scanGrams()!==null;
  return true;
}

// Flips the Save button without re-rendering the card, so the keyboard stays up
// and the caret stays put while Ryan types.
function syncSaveState(){
  const btn=document.getElementById('sc-save');
  if(btn)btn.disabled=!scanCanSave()||libraryBusy;
}

export function mealScanCancel(){
  // NOTHING WAS EVER WRITTEN, so there is nothing to undo — that is the whole
  // point of reviewing before saving.
  scan=null;
  libraryMsg={text:'Discarded. Nothing was saved.',kind:'info'};
  renderMeals();
}

export async function mealScanSave(){
  if(!scan||libraryBusy)return;
  captureScan();
  if(!scanCanSave()){
    libraryMsg={text:scan.basis==='per_100g'
      ? 'These numbers are per 100 grams. Give a serving size first — either type the grams, or divide a net weight by the servings in the container.'
      : 'Give the food a name.',kind:'err'};
    renderMeals();return;
  }

  const grams=scanGrams();
  const payload={
    name:String(scan.name).trim(),
    servingText:String(scan.servingText||'').trim(),
    macros:{},
    // §8's tiers: a lookup is deterministic, so it is `exact` — including a
    // per-100g candidate Ryan converted himself. Hand-typed stays `high`.
    confidence:'exact',
    barcode:scan.barcode,
    basis:scan.basis,
    servingSource:scanSource()
  };
  FOOD_MACRO_FIELDS.forEach(k=>{
    const raw=String(scan.macros[k]==null?'':scan.macros[k]).trim();
    payload.macros[k]=raw===''?null:raw;   // blank means NOT ON THE LABEL, not 0
  });
  // §13.8. extras are editable and go up as typed; flags go up EXACTLY as the
  // lookup returned them — they are never edited here and there is no UI to.
  payload.extras={};
  FOOD_EXTRA_FIELDS.forEach(k=>{
    const raw=String(scan.extras[k]==null?'':scan.extras[k]).trim();
    payload.extras[k]=raw===''?null:raw;
  });
  if(scan.flags)payload.flags=scan.flags;
  // ONLY GRAMS PER SERVING IS STORED. The net weight and servings-per-container
  // that may have produced it are inputs to a calculation, not facts — and a
  // future session must not be able to recompute from them (§13.7).
  if(grams!==null)payload.servingGrams=round2(grams);

  // DUPLICATE GUARD, re-checked at the last moment in case the mirror moved
  // since the lookup. A scanned duplicate is the most likely way this library
  // gets junked up, so this never creates a second copy — it updates.
  const dup=findByBarcode(scan.barcode);
  const targetId=scan.dupId||(dup?dup.id:null);

  libraryBusy=true;
  libraryMsg={text:targetId?'Updating…':'Saving…',kind:'info'};
  renderMeals();
  const res=targetId?await updateFood(targetId,payload):await createFood(payload);
  libraryBusy=false;

  if(!res.ok){
    libraryMsg={text:res.error+' NOTHING was saved. Your counts are local and are unaffected.',kind:'err'};
    renderMeals();return;
  }
  adoptLibrary(res.body);
  const name=payload.name;
  scan=null;pendingBarcode=null;barcodeInput='';
  libraryMsg={text:targetId
    ? 'Updated “'+name+'”. Days already counted keep the macros they were counted with.'
    : 'Saved “'+name+'” to the library. It is in the counter above, ready to ADD.',kind:'success'};
  renderMeals();
}

export function mealClearPendingBarcode(){
  pendingBarcode=null;
  libraryMsg=null;
  renderMeals();
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

// The lookup box. inputmode="numeric" so the phone shows a number pad; the
// button clears the 44pt minimum (§1.5).
function barcodeEntryHtml(){
  return '<div class="card">'+
    '<div class="card-title">Look up a barcode</div>'+
    '<div class="bc-entry">'+
      '<input type="text" id="bc-in" inputmode="numeric" pattern="[0-9]*" autocomplete="off" '+
        'placeholder="8, 12 or 13 digits" value="'+esc(barcodeInput)+'" oninput="mealBarcodeTyped(this.value)">'+
      '<button class="bc-btn" onclick="mealBarcodeLookup()"'+(libraryBusy?' disabled':'')+'>Look Up</button>'+
    '</div>'+
    '<div class="form-note">Type the digits printed under the barcode. Nothing is saved by a lookup — '+
      'you get a card to check against the package first. There is no camera here on purpose: '+
      'a misread digit would return a different product’s macros.</div>'+
  '</div>';
}

// The grams-per-serving result, or an honest blank. NEVER NaN, NEVER Infinity —
// a garbage number on this line would be read as a real serving size.
function derivedLineHtml(g){
  if(g===null){
    return '<span class="sc-derived-none">Grams per serving: not set yet — Save stays off until it is.</span>';
  }
  return '<span class="sc-derived-val">1 serving = '+round2(g)+' g</span>';
}

function basisLine(b){
  if(b==='converted')return 'Converted for you: Open Food Facts knew the serving size in grams, so its per-100g figures were scaled to one serving.';
  if(b==='per_serving')return 'Taken per serving, exactly as Open Food Facts reports it. No conversion was done.';
  return 'THESE NUMBERS ARE PER 100 GRAMS, not per serving. Give a serving size below and they will be converted.';
}

// Flags, READ-ONLY. There is deliberately no input here and no way to type one
// anywhere in this app: a hand-entered item has UNKNOWN additives, not zero
// (§13.8). Unknown renders as a plain sentence, never as 0 and never as "none".
function flagsHtml(flags){
  const f=(flags&&typeof flags==='object')?flags:null;
  const a=f?f.additives:null;
  let body='';
  if(!a){
    body+='<div class="sc-flag-row"><span class="sc-flag-key">Additives</span>'+
          '<span class="sc-flag-unknown">not known — Open Food Facts has no additives data for this product</span></div>';
  }else if(!a.count){
    body+='<div class="sc-flag-row"><span class="sc-flag-key">Additives</span>'+
          '<span class="sc-flag-val">none — Open Food Facts reports no additives</span></div>';
  }else{
    const listed=(a.tags||[]).map((t,i)=>{
      const n=(a.names||[])[i];
      return esc(n||String(t).toUpperCase());
    }).join(' · ');
    body+='<div class="sc-flag-row"><span class="sc-flag-key">Additives</span>'+
          '<span class="sc-flag-val">'+a.count+'</span></div>'+
          '<div class="sc-flag-list">'+listed+'</div>';
  }
  const nova=f?f.novaGroup:null;
  body+='<div class="sc-flag-row"><span class="sc-flag-key">NOVA group</span>'+
        (nova?('<span class="sc-flag-val">'+nova+' of 4</span>')
             :'<span class="sc-flag-unknown">not known</span>')+'</div>';
  return '<div class="sc-flags"><div class="sc-flags-head">From Open Food Facts — not editable, not scored</div>'+
         body+'</div>';
}

function reviewCardHtml(){
  const s=scan;
  const g=scanGrams();
  const dup=s.dupId?mirrorItem(s.dupId):null;
  let html='<div class="card sc-card">';
  html+='<div class="card-title">'+(dup?'Already in your library':'Check this before saving')+'</div>';

  if(dup){
    html+='<div class="alert warn">Barcode '+esc(s.barcode)+' is already saved as “'+esc(dup.name||'(unnamed)')+
          '”. A second copy will not be created — saving will UPDATE that item instead. '+
          'Days you have already counted keep the macros they were counted with.</div>';
  }

  html+='<div class="bc-meta">'+esc(s.barcode)+' · matched as '+esc(s.matchedAs||'—')+
        (s.brand?' · '+esc(s.brand):'')+'</div>';
  html+='<div class="sc-basis'+(s.basis==='per_100g'?' is-warn':'')+'">'+esc(basisLine(s.basis))+'</div>';

  html+='<div class="form-row"><div class="form-label">Name</div>'+
        '<input type="text" id="sc-name" value="'+esc(s.name)+'" placeholder="name this food" oninput="mealScanEdited()"></div>';
  html+='<div class="form-row"><div class="form-label">Serving</div>'+
        '<input type="text" id="sc-serving" value="'+esc(s.servingText)+'" placeholder="e.g. 1 bar (52g)" oninput="mealScanServingTouched()"></div>';

  if(s.basis==='per_100g'){
    const per100=FOOD_MACRO_FIELDS.map(k=>{
      const v=s.source[k];
      if(v===null||v===undefined)return null;
      const m=MACRO_META.find(x=>x.key===k);
      return m.label+' '+v+(m.unit||'');
    }).filter(Boolean).join(' · ');
    html+='<div class="sc-per100"><div class="sc-per100-head">Open Food Facts, per 100 g</div>'+
          '<div class="sc-per100-body">'+(per100||'no figures at all')+'</div></div>';

    html+='<div class="sc-routes">'+
      '<button class="sc-route'+(s.route==='A'?' is-on':'')+'" onclick="mealScanRoute(\'A\')">Serving size (g)</button>'+
      '<button class="sc-route'+(s.route==='B'?' is-on':'')+'" onclick="mealScanRoute(\'B\')">Net weight ÷ servings</button>'+
    '</div>';

    if(s.route==='A'){
      html+='<div class="form-row"><div class="form-label">Serving size, in grams, off the panel</div>'+
            '<input type="number" id="sc-grams" step="0.1" inputmode="decimal" value="'+esc(s.grams)+
            '" placeholder="e.g. 52" oninput="mealScanRecalc()"></div>';
    }else{
      html+='<div class="mt-macro-grid">'+
        '<div class="form-row"><div class="form-label">Net weight (g)</div>'+
          '<input type="number" id="sc-net" step="0.1" inputmode="decimal" value="'+esc(s.net)+
          '" placeholder="e.g. 340" oninput="mealScanRecalc()"></div>'+
        '<div class="form-row"><div class="form-label">Servings per container</div>'+
          '<input type="number" id="sc-per" step="0.1" inputmode="decimal" value="'+esc(s.per)+
          '" placeholder="e.g. 4" oninput="mealScanRecalc()"></div>'+
      '</div>';
      html+='<div class="form-note">Manufacturers round servings per container, so this route carries real '+
            'rounding slop. Ryan asked for it anyway — it is a deliberate choice, not an oversight.</div>';
    }
    html+='<div class="sc-derived" id="sc-derived">'+derivedLineHtml(g)+'</div>';
  }

  html+='<div class="form-label sc-macro-head">'+
        (s.basis==='per_100g'?'Per serving, converted — check against the panel':'Per serving — check against the panel')+
        '</div>';
  html+='<div class="mt-macro-grid">';
  MACRO_META.forEach(m=>{
    html+='<div class="form-row"><div class="form-label">'+m.label+(m.unit?' ('+m.unit+')':'')+
          (m.scored?'':' <span class="mt-unscored-tag">not scored</span>')+'</div>'+
          '<input type="number" id="sc-m-'+m.key+'" step="0.01" inputmode="decimal" value="'+
          esc(s.macros[m.key])+'" placeholder="blank if not on the label" oninput="mealScanEdited()"></div>';
  });
  html+='</div>';

  // §13.8's extras — editable, all milligrams, none scored.
  html+='<div class="form-label sc-macro-head">Caffeine and minerals (mg) — optional, never scored</div>';
  html+='<div class="mt-macro-grid">';
  EXTRA_META.forEach(m=>{
    html+='<div class="form-row"><div class="form-label">'+m.label+' (mg)</div>'+
          '<input type="number" id="sc-x-'+m.key+'" step="0.01" inputmode="decimal" value="'+
          esc(s.extras[m.key])+'" placeholder="blank if unknown" oninput="mealScanEdited()"></div>';
  });
  html+='</div>';
  html+='<div class="form-note">Open Food Facts carries caffeine for only about a third of energy '+
        'drinks and almost nothing else, so this is usually blank — type it off the can if you want it '+
        'recorded. Blank means unknown, not zero.</div>';

  html+=flagsHtml(s.flags);

  html+='<div class="form-note">Every number here is editable and what you leave is what gets saved. '+
        'Blank means “not on the label” — it is never counted as 0.'+
        (s.sodiumSource==='salt'?' Sodium was worked out from the salt figure, not read directly.':'')+
        (s.sodiumSource==='sodium'?' Sodium came straight from Open Food Facts.':'')+
        (s.basis==='per_100g'?' Changing the serving size re-fills these from the per-100g figures above.':'')+
        '</div>';

  html+='<button class="btn btn-primary" id="sc-save" onclick="mealScanSave()"'+
        ((!scanCanSave()||libraryBusy)?' disabled':'')+'>'+
        (dup?'Update “'+esc(dup.name||'(unnamed)')+'”':'Save to library')+'</button>';
  html+='<button class="btn btn-secondary" onclick="mealScanCancel()">Cancel — save nothing</button>';
  html+='<div class="form-note">Nothing has been written yet. Cancel leaves the library exactly as it is.</div>';
  html+='</div>';
  return html;
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

  html+=barcodeEntryHtml();

  // THE REVIEW CARD REPLACES THE ADD FORM while it is open. Two Save buttons on
  // one phone screen, meaning two different things, is a mis-tap waiting to
  // happen — and the card is the thing Ryan is being asked to check.
  if(scan)return html+reviewCardHtml();

  html+='<div class="card">';
  html+=`<div class="card-title">${editingId?'Edit food':'Add a food'}</div>`;
  if(pendingBarcode&&!editingId){
    html+=`<div class="alert info">Barcode <strong>${esc(pendingBarcode)}</strong> will be saved with this food, `+
          `so looking it up again finds your entry. Typed macros stay marked as hand-typed, not exact.`+
          ` <button class="bc-chip-clear" onclick="mealClearPendingBarcode()">save without it</button></div>`;
  }
  html+=`<div class="form-row"><div class="form-label">Name</div><input type="text" id="food-in-name" placeholder="e.g. RXBAR Chocolate Sea Salt"></div>`;
  html+=`<div class="form-row"><div class="form-label">Serving size, as printed on the label</div><input type="text" id="food-in-serving" placeholder="e.g. 1 bar (52g)"></div>`;
  html+='<div class="mt-macro-grid">';
  MACRO_META.forEach(m=>{
    html+=`<div class="form-row"><div class="form-label">${m.label}${m.unit?' ('+m.unit+')':''}${m.scored?'':' <span class="mt-unscored-tag">not scored</span>'}</div>`+
          `<input type="number" id="food-in-${m.key}" step="0.1" inputmode="decimal" placeholder="blank if not on the label"></div>`;
  });
  html+='</div>';
  html+=`<div class="form-note">Leave a field blank if it is not printed on the label. Blank means "not on the label" — it is not the same as 0, and it is never counted as 0.</div>`;
  // §13.8's extras, optional and blank by default. No flags here, deliberately:
  // additives can only come from a lookup.
  html+='<div class="form-label sc-macro-head">Caffeine and minerals (mg) — optional, never scored</div>';
  html+='<div class="mt-macro-grid">';
  EXTRA_META.forEach(m=>{
    html+=`<div class="form-row"><div class="form-label">${m.label} (mg)</div>`+
          `<input type="number" id="food-in-x-${m.key}" step="0.01" inputmode="decimal" placeholder="blank if unknown"></div>`;
  });
  html+='</div>';
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
    // The barcode line appears only on items that have one. An item saved
    // before the barcode path simply has no such field and shows nothing —
    // absence is the boundary (§13.2), never an em dash or a fabricated blank.
    const prov=i.barcode
      ? `<div class="fl-serving">barcode ${esc(i.barcode)}${i.servingGrams?' · '+esc(i.servingGrams)+'g per serving':''}</div>`
      : '';
    return `<div class="fl-row">`+
      `<div class="fl-body">`+
        `<div class="fl-name">${esc(i.name||'(unnamed)')}</div>`+
        `<div class="fl-serving">${i.servingText?esc(i.servingText):'serving size not recorded'}</div>`+
        prov+
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
  // Read the open review card's inputs back into state FIRST. This function is
  // also called by ADD/REMOVE and by the background library refresh, and either
  // would otherwise throw away an edit Ryan had typed but not yet saved.
  captureScan();
  counter.innerHTML=counterHtml();
  library.innerHTML=libraryHtml();
  if(editingId)fillForm(mirrorItem(editingId));
}

// Called by showPage() when the page opens. Paints from the mirror, then
// refreshes it in the background.
export function openMeals(){
  libraryMsg=null;
  editingId=null;
  // An abandoned review, a half-typed barcode and a not-found code all die with
  // the page. None of them was ever written anywhere.
  scan=null;
  pendingBarcode=null;
  barcodeInput='';
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
