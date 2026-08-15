// ---------------------------------------------------------------------------
// pages/health.js — Health Status: body measurements, driving factors, phase.
//
// ############ THE HORMONE INDICES WERE DELETED (2026-08-14) ############
//
// This page used to headline three cards — HGH, Test, Cortisol — computed by
// derive.js's calcHGH/calcTest/calcCortisol. They are gone, along with the
// "Estimates from behavioral data only" banner that tried to make them safe.
// See the block comment where they used to live in derive.js, and §10: there
// was never a criterion variable, so nothing about them could be checked. DO
// NOT REINTRODUCE THEM WITHOUT REAL LAB DATA.
//
// The Driving Factors card SURVIVED the deletion and now stands on its own. It
// was always the honest half: five plainly-labelled behavioural facts with a
// good/bad dot each, no arithmetic pretending to be a measurement. Its
// container id is still `hgh-factors` — legacy, deliberately NOT renamed
// (§1.4 applies to DOM ids other code references just as it does to schema
// keys; index.html and this file are the only two places it appears).
//
// BUILT (§10): manual height / age / bodyweight / waist entry, the 7-day
// rolling bodyweight trend, and dated blood-pressure / SpO2 / pulse records
// (§10.2). Age lives here (d.body.age) because it has no other home in the
// schema and Karvonen zones (§5, derive.js) need it.
//
// HRV comes from the Google Health API via api.js's cache (getCachedVitals()),
// read for today's date, and renders as a cell in the Body summary. An absent
// reading is an em-dash, never a zero (§1.7) — a Versa 2 frequently produces
// no HRV figure for a night, and that is "no reading", not a measured 0.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today, dateStr, addDays, esc } from '../util.js';
// targetsFor() is deliberately NOT imported: this page EDITS the history, it
// does not resolve it. Only calcScore() and dietaryDetail() resolve a day.
import { getSleepForDate, calcFastHrs, getWorkoutForDate, getPhase,
         rollingBodyweight, latestWaist, BODYWEIGHT_WINDOW_DAYS,
         dayMacros, foodCountExtras, dietaryDetail, dietTargetRows,
         SATURATED_FAT_MAX_DEFAULT } from '../derive.js';
import { getCachedVitals, triggerSync, fetchSyncStatus, primeRecentVitals } from '../api.js';
import { renderVitalsHeader } from '../components/vitals-header.js';
import { renderHome } from './home.js';

// ---------------------------------------------------------------------------
// Body composition — ARCHITECTURE.md §10.
//
// Measurements live under the additive d.body key:
//   d.body = { height: '71', weights: [{date, lbs}], waists: [{date, inches}] }
// No existing key is read or written by any of this.
// ---------------------------------------------------------------------------

// ############ FOUR CELLS, 2x2 — NOT FOUR ACROSS ############
//
// The grid is 1fr 1fr, deliberately. At 393pt a four-column row leaves each
// cell about 85px wide, which crushes a two-digit value and its unit onto
// separate lines and truncates the sub-label. Two columns of two is the layout
// that actually fits the phone this app is built for (§1.5).
//
// HRV joined this card when the "Awaiting Sync" panel was deleted (2026-08-14).
// Body fat and VO2 max went with that panel: NO CONNECTED DEVICE WRITES THEM.
// Ryan wears a Versa 2 and owns no smart scale, so both were permanently null
// and the panel could only ever render two em-dashes under a heading promising
// they were on their way. That is not honest reporting, it is furniture. If a
// smart scale is ever added, body fat comes back as a real field.
function renderBodySummary(){
  const body=db().body||{};
  const rb=rollingBodyweight();
  const waist=latestWaist();
  const v=getCachedVitals(today());
  const weightSub = rb.avg!=null
    ? rb.count+' weigh-in'+(rb.count===1?'':'s')+' · '+BODYWEIGHT_WINDOW_DAYS+'-day avg'
    : (rb.latest ? 'none in last '+BODYWEIGHT_WINDOW_DAYS+' days · last '+rb.latest.date : 'not logged yet');
  const cells=[
    {label:'Bodyweight', val: rb.avg!=null?rb.avg.toFixed(1):'—', unit:'lbs', sub:weightSub},
    {label:'Height',     val: body.height?String(+body.height):'—', unit:'in', sub: body.height?'manual entry':'not set'},
    {label:'Waist',      val: waist?String(+waist.inches):'—',      unit:'in', sub: waist?waist.date:'not logged yet'},
    // '—' WHEN NULL, NEVER 0 (§1.7). A Versa 2 frequently produces no HRV
    // reading for a night — that is "no reading", not a measurement of zero
    // milliseconds, and the sub-label says which of the two this is.
    {label:'HRV',        val: v&&v.hrv!=null?String(v.hrv):'—',     unit:'ms', sub: v&&v.hrv!=null?'synced '+v.date:'no reading'}
  ];
  document.getElementById('body-summary').innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
    cells.map(c=>`<div class="card" style="text-align:center;padding:12px"><div class="card-title" style="margin-bottom:4px">${c.label}</div><div class="stat-big" style="font-size:26px">${c.val}</div><div class="stat-sub">${c.unit}</div><div class="stat-sub" style="font-size:10px;margin-top:4px">${c.sub}</div></div>`).join('') +
    '</div>';
}

// ---------------------------------------------------------------------------
// TARGETS — ARCHITECTURE.md §14. Dated, next-day-effective, append-only.
//
// The resolver lives in derive.js (targetsFor); this is the editor for it. See
// that block comment for WHY the old single undated d.targets was a bug.
//
// ############ d.targets IS NOT TOUCHED BY ANY OF THIS ############
//
// The legacy flat object is not migrated, not deleted, and never written to
// here. It still serves the Log page's own fields and it is still the fallback
// for days that predate the first history entry. This panel reads and writes
// d.targetHistory and nothing else.
//
// MODE IS FIXED TO 'cut'. There is deliberately no maintain/cut toggle — Ryan
// asked for one mode and building the switch would be inventing a feature.
// ---------------------------------------------------------------------------

// The fourteen fields, in the schema's own order. `kind` decides whether the row
// gets one input or a min/max pair; `src` says where today's actual comes from.
//
// saturatedFatMax JOINED 2026-08-15 (§14.1). It sits directly under Fat rather
// than at the end of the list: the two are one decision read two ways, and six
// micronutrients between them would bury it. Position is display order only —
// nothing resolves a target by index.
//
// `fallback` marks the one field that has a constant behind it. An entry written
// before the field existed has no key, grades against that constant (derive.js),
// and the row shows it as a PLACEHOLDER — a value Ryan can see but has not set.
//
// The per-row `useKnown` opt-in was removed 2026-08-15: every macro row consults
// `known` now (§14.4), so there is nothing left to opt into.
const TARGET_FIELDS=[
  {key:'calories',   label:'Calories',  unit:'',   kind:'scalar', src:'macro', macro:'calories'},
  {key:'protein',    label:'Protein',   unit:'g',  kind:'range',  src:'macro', macro:'protein'},
  {key:'fat',        label:'Fat',       unit:'g',  kind:'range',  src:'macro', macro:'fat'},
  {key:'saturatedFatMax', label:'Saturated fat max', unit:'g', kind:'scalar', src:'macro',
   macro:'saturatedFat', fallback:SATURATED_FAT_MAX_DEFAULT},
  {key:'carbs',      label:'Carbs',     unit:'g',  kind:'range',  src:'macro', macro:'carbs'},
  {key:'sugarMax',   label:'Sugar max', unit:'g',  kind:'scalar', src:'macro', macro:'sugar'},
  {key:'fiber',      label:'Fiber',     unit:'g',  kind:'range',  src:'macro', macro:'fiber'},
  {key:'sodiumMax',  label:'Sodium max',unit:'mg', kind:'scalar', src:'macro', macro:'sodium'},
  {key:'potassium',  label:'Potassium', unit:'mg', kind:'scalar', src:'extra', extra:'potassium'},
  {key:'calcium',    label:'Calcium',   unit:'mg', kind:'scalar', src:'extra', extra:'calcium'},
  {key:'iron',       label:'Iron',      unit:'mg', kind:'scalar', src:'extra', extra:'iron'},
  {key:'magnesium',  label:'Magnesium', unit:'mg', kind:'scalar', src:'extra', extra:'magnesium'},
  {key:'zinc',       label:'Zinc',      unit:'mg', kind:'scalar', src:'extra', extra:'zinc'},
  {key:'caffeineMax',label:'Caffeine max',unit:'mg',kind:'scalar',src:'extra', extra:'caffeine'}
];

// The seed, exactly as specified in the brief. SHOWN, NEVER WRITTEN, until Ryan
// presses Save — an empty d.targetHistory stays empty, so a phone that has
// never had targets set still resolves to null and still falls back to the
// legacy object (§14). Prefilling the form is not the same as having targets.
const TARGET_SEED={
  mode:'cut', calories:2250,
  protein:{min:175,max:190}, fat:{min:70,max:85},
  // Seeded at the constant that governed this nutrient before it was a field, so
  // a first save changes nothing about how saturated fat is graded (§14.1).
  saturatedFatMax:SATURATED_FAT_MAX_DEFAULT,
  carbs:{min:180,max:220},
  sugarMax:35, fiber:{min:30,max:35}, sodiumMax:2300,
  potassium:3400, calcium:1000, iron:8, magnesium:420, zinc:11, caffeineMax:400
};

// Module state, never stored — an abandoned confirm must not survive the page,
// exactly like training.js's pause gate and the Meal Tracker's delete gate.
let tgGate=null;      // null when closed, else {code, entry, msg, diffs, next, entryObj}
let tgMsg=null;       // {text, kind:'info'|'err'|'success'}

function tomorrowStr(){return dateStr(addDays(new Date(today()+'T12:00:00'),1));}

// The most recently SAVED set, INCLUDING ONE THAT HAS NOT TAKEN EFFECT YET.
//
// ############ WHY NOT targetsFor(today()) HERE ############
//
// targetsFor() answers "what governed this day", which is the right question
// for scoring and the wrong one for this form. Because a save is always
// effective TOMORROW, the entry Ryan just wrote is not in force yet — so a form
// built from targetsFor(today()) would snap straight back to the old numbers
// the moment he saved, looking exactly like the save had been discarded. Worse,
// the duplicate guard would then compare his next save against the OLD set and
// happily append a second entry for the same effectiveFrom.
//
// So the editor shows, and diffs against, the latest entry on file. Scoring is
// entirely unaffected: calcScore() still goes through targetsFor(), which still
// ignores anything dated later than the day being scored.
function latestTargetSet(){
  const list=db().targetHistory;
  if(!Array.isArray(list)||!list.length)return null;
  const sorted=list
    .filter(t=>t&&typeof t.effectiveFrom==='string')
    .sort((a,b)=>a.effectiveFrom<b.effectiveFrom?-1:a.effectiveFrom>b.effectiveFrom?1:0);
  // Array.sort is stable, so entries sharing an effectiveFrom keep insertion
  // order and the LAST-APPENDED one wins — the same rule targetsFor() applies.
  return sorted.length?sorted[sorted.length-1]:null;
}

// {set, seeded, pending} — `seeded` means nothing has ever been saved and these
// are display-only starting values; `pending` means the set on screen is saved
// but does not take effect until its own effectiveFrom.
function currentTargetSet(){
  const t=latestTargetSet();
  if(!t)return {set:TARGET_SEED,seeded:true,pending:false};
  return {set:t,seeded:false,pending:t.effectiveFrom>today()};
}

// Reads the thirteen fields out of the form. A blank or unusable field falls
// back to the value currently on screen for it, so a half-filled form cannot
// write a zero into a target (§1.7).
function readTargetForm(base){
  const num=id=>{
    const el=document.getElementById(id);
    const raw=((el&&el.value)||'').trim();
    if(raw==='')return null;
    const n=Number(raw);
    return (isFinite(n)&&n>0)?n:null;
  };
  const out={mode:'cut'};
  TARGET_FIELDS.forEach(f=>{
    const cur=base?base[f.key]:null;
    if(f.kind==='range'){
      const mn=num('tg-'+f.key+'-min'), mx=num('tg-'+f.key+'-max');
      out[f.key]={min: mn!=null?mn:(cur&&cur.min), max: mx!=null?mx:(cur&&cur.max)};
    }else{
      const v=num('tg-'+f.key);
      out[f.key]= v!=null?v:cur;
    }
  });
  return out;
}

function fmtTarget(f,val){
  if(val===null||val===undefined)return '—';
  if(f.kind==='range'){
    const mn=(val&&val.min),mx=(val&&val.max);
    if(mn==null&&mx==null)return '—';
    return (mn==null?'?':mn)+'–'+(mx==null?'?':mx)+(f.unit?' '+f.unit:'');
  }
  return String(val)+(f.unit?' '+f.unit:'');
}

// Every field where the proposed set differs from the one in force, as
// "Protein 175–190 g → 180–195 g". An empty array means nothing changed.
function targetDiffs(from,to){
  const out=[];
  TARGET_FIELDS.forEach(f=>{
    const a=fmtTarget(f,from?from[f.key]:null), b=fmtTarget(f,to?to[f.key]:null);
    if(a!==b)out.push({label:f.label,from:a,to:b});
  });
  return out;
}

// Today's actual for one row. Returns {text, note} — note carries the coverage
// sentence for a micronutrient, or '' where there is nothing to qualify.
function todayActual(f,dm,ex){
  if(f.src==='macro'){
    const v=dm[f.macro];
    // ############ ABSENT IS NOT ZERO — ALL EIGHT ROWS, §14.4 ############
    //
    // dayMacros() returns 0 for a macro nothing counted today stated, so a bare
    // read prints "0 g" — an assertion that Ryan ate none of it, which is a
    // different and much worse claim than "nothing you counted said". This panel
    // used to make both claims side by side: saturated fat read '—' while fiber
    // read '0 g' off the same empty day.
    //
    // `known` is what tells the two apart (§14.1), and it is what the band
    // visual directly above this editor has always used — so the two now agree.
    //
    // A GENUINE MEASURED 0 STILL READS 0. Black coffee really does have 0 g of
    // protein, and `known` is true for a field an item actually stated as zero.
    // The distinction preserved here is "stated as zero" versus "never stated".
    if(!(dm.known&&dm.known[f.macro]))return {text:'—',note:''};
    if(v===null||v===undefined||!isFinite(+v))return {text:'—',note:''};
    return {text:Math.round(+v)+(f.unit?' '+f.unit:''),note:''};
  }
  // A MICRONUTRIENT WITH NO DATA IS '—', NEVER 0 AND NEVER A 0% BAR (§1.7).
  // Coverage of these six is poor: most Open Food Facts items carry none of
  // them, so a total is usually a partial sum and the row says so rather than
  // letting Ryan read a gap as a shortfall.
  const cov=(ex.coverage&&ex.coverage[f.extra])||{withData:0,items:0};
  if(!ex.known[f.extra])return {text:'—',note: cov.items?'no data on any of '+cov.items+' item'+(cov.items===1?'':'s'):'nothing counted today'};
  const total=Math.round(ex[f.extra]);
  const partial=cov.withData<cov.items;
  return {text:total+(f.unit?' '+f.unit:''),
          note: partial?cov.withData+' of '+cov.items+' items':'all '+cov.items+' item'+(cov.items===1?'':'s')};
}

// ---------------------------------------------------------------------------
// THE TARGET BAND VISUAL — ARCHITECTURE.md §14.2.
//
// A donut of the day's Dietary score, then one track per nutrient showing where
// today's actual falls against that day's target zone. It reads the SAME
// dietaryDetail() the score itself is built from (§6.9's one-read-path rule),
// so the ring and the Home score box can never disagree.
//
// STATIC. No tooltips, no tap-to-expand, no animation — this is a thing Ryan
// glances at, and every interaction would be one more thing to mis-tap in a gym.
// ---------------------------------------------------------------------------

// Score -> token. ALL FOUR ARE EXISTING TOKENS (§1.6); nothing new is defined.
// Distinct from derive.js's sc(), which uses 80 as its green threshold — these
// are §14.2's bands and the two are deliberately not shared.
function bandColor(score){
  if(score===null||score===undefined)return 'var(--muted)';
  if(score>=90)return 'var(--accent5)';
  if(score>=50)return 'var(--warn)';
  return 'var(--danger)';
}

// "Sodium", "Sodium and saturated fat", "Sodium, sugar and saturated fat".
// Only the first keeps its capital — the rest read as mid-sentence words.
function joinNames(labels){
  const l=labels.map((s,i)=>i===0?s:s.charAt(0).toLowerCase()+s.slice(1));
  if(l.length<=1)return l[0]||'';
  return l.slice(0,-1).join(', ')+' and '+l[l.length-1];
}

// The one-line summary under the ring. DERIVED, never hardcoded: it names the
// rows that actually cost the most weighted points and the rows that actually
// held the score up, for this day's numbers.
function bandSummary(det){
  if(det.unlogged)return 'Nothing was logged today, so the day scores zero — that is a missed day, not missing data.';
  const scored=det.rows.filter(r=>r.weight>0&&r.score!=null);
  if(!scored.length)return 'No nutrient had a figure today, so there is nothing to score against your targets.';
  // Cost is WEIGHTED: 15 points lost on sodium hurts more than 25 lost on a
  // row worth 10, and the sentence should name what actually moved the score.
  const byLoss=scored.slice().sort((a,b)=>((100-b.score)*b.weight)-((100-a.score)*a.weight));
  const zeros=scored.filter(r=>r.score<1);
  const carried=scored.filter(r=>r.score>=90).sort((a,b)=>b.weight-a.weight).slice(0,2);
  const parts=[];
  if(zeros.length){
    parts.push(joinNames(zeros.map(r=>r.label))+(zeros.length===1?' scored zero.':' scored zero.'));
  }else if(byLoss.length&&byLoss[0].score<90){
    parts.push(joinNames([byLoss[0].label])+' cost the most.');
  }
  if(carried.length)parts.push(joinNames(carried.map(r=>r.label))+(carried.length===1?' carried the day.':' carried the day.'));
  if(!parts.length)parts.push('Every scored nutrient landed in its target range.');
  // Say when the score is standing on partial information — a 100 built from
  // three of six nutrients is not the same claim as a 100 built from all six.
  if(det.usedWeight<det.totalWeight){
    parts.push('Scored on '+det.usedWeight+' of '+det.totalWeight+
               ' points of weight — the rest had no figure today.');
  }
  return parts.join(' ');
}

// The donut. Plain inline SVG: one neutral track circle and one arc whose
// dash offset is the score. Rotated -90deg so it fills from the top.
// `showAs` overrides the centre number. It exists for the preview state (below),
// where the ring must be an EMPTY TRACK with an em-dash: today is not being
// graded against these bands, and a 0 in the middle would be a score — the worst
// possible one — rather than the absence of one (§1.7).
function ringHtml(score,showAs){
  const s=(score==null)?0:Math.max(0,Math.min(100,score));
  const shown=(showAs!==undefined)?showAs:Math.round(s);
  const r=44, C=2*Math.PI*r;
  const off=C*(1-s/100);
  const col=bandColor(score);
  return '<div class="db-ring">'+
    '<svg viewBox="0 0 104 104" width="104" height="104" aria-hidden="true">'+
      `<circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--surface3)" stroke-width="10"></circle>`+
      `<circle cx="52" cy="52" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"`+
        ` stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"`+
        ' transform="rotate(-90 52 52)"></circle>'+
    '</svg>'+
    `<div class="db-ring-mid"><div class="db-ring-score" style="color:${col}">${shown}</div>`+
    '<div class="db-ring-label">DIETARY</div></div>'+
  '</div>';
}

// One nutrient track. The zone is where the target is; the marker is where today
// actually landed.
function bandRowHtml(r){
  const axis=r.axisMax;
  const pct=v=>(axis>0)?Math.max(0,Math.min(100,(v/axis)*100)):0;
  // THE TARGET ZONE RENDERS EVEN WITH NO READING (§14.2) — the row still has to
  // answer "what was I aiming for", and a bare track would answer nothing.
  let zone='';
  if(axis>0){
    let a=0,b=100;
    if(r.shape==='ceiling')       {a=0;         b=pct(r.hi);}
    else if(r.shape==='floor')    {a=pct(r.lo); b=100;}
    else                          {a=pct(r.lo); b=pct(r.hi);}
    if(b>a)zone=`<div class="db-zone" style="left:${a.toFixed(2)}%;width:${(b-a).toFixed(2)}%"></div>`;
  }
  // NO MARKER AT ALL WHEN THERE IS NO READING. Drawing one at zero would assert
  // a measurement of zero, which is the §1.7 mistake this whole build keeps
  // legislating against.
  let mark='';
  if(r.value!=null&&axis>0){
    // Centred on the value, clamped so the full 4px bar stays inside the track
    // even when the reading is pinned at either end of the axis.
    const p=pct(r.value).toFixed(2);
    mark='<div class="db-mark" style="left:clamp(0px, calc('+p+'% - 2px), calc(100% - 4px));'+
         'background:'+bandColor(r.score)+'"></div>';
  }
  const unscored=(r.weight===0);
  // An unscored row is grey and carries NO weight suffix — it reads as
  // information, not as a target that was missed.
  const valColor=unscored?'var(--muted)':bandColor(r.score);
  const shownVal=(r.value==null)?'—'
    :(Math.round(r.value*10)/10)+(r.unit?' '+r.unit:'')+(r.clamped?' ▸':'');
  return '<div class="db-row">'+
    '<div class="db-head">'+
      `<span class="db-name">${esc(r.label)}`+
        (unscored?'':`<span class="db-w">${r.weight}%</span>`)+
      '</span>'+
      `<span class="db-val" style="color:${valColor}">${esc(shownVal)}</span>`+
    '</div>'+
    `<div class="db-track">${zone}${mark}</div>`+
  '</div>';
}

// The pending entry that takes effect FIRST. That is the set whose bands are
// about to govern, so it is the one worth previewing and its date is the date
// the preview quotes. Entries sharing an effectiveFrom resolve LAST-APPENDED
// WINS — the same rule targetsFor() and the editor both apply, stated once more
// here rather than assumed.
//
// Returns null when nothing is pending, which includes an empty history.
function firstPendingSet(){
  const list=db().targetHistory;
  if(!Array.isArray(list)||!list.length)return null;
  const t=today();
  const pending=list
    .filter(e=>e&&typeof e.effectiveFrom==='string'&&e.effectiveFrom>t)
    .sort((a,b)=>a.effectiveFrom<b.effectiveFrom?-1:a.effectiveFrom>b.effectiveFrom?1:0);
  if(!pending.length)return null;
  const first=pending[0].effectiveFrom;
  const sameDay=pending.filter(e=>e.effectiveFrom===first);
  return sameDay[sameDay.length-1];
}

// ############ THE PREVIEW STATE — WHY IT DRAWS ZONES BUT NO MARKERS ############
//
// A first save is ALWAYS effective tomorrow (§14), so on the day Ryan first sets
// targets — and on the day this shipped — targetsFor(today()) is null and the
// visual had nothing to draw. The band visual was therefore invisible on the one
// day he was most likely to go looking for it.
//
// So the bands are drawn from the pending set: this is what you are aiming at,
// starting tomorrow. THE MARKERS AND THE SCORE ARE NOT DRAWN, and that is the
// load-bearing half. Today is NOT graded against these numbers — it is still on
// the previous targets — and a marker sitting in or out of a green band would
// say it was. The ring is an empty track with an em-dash for the same reason.
//
// A day with NO pending entry at all keeps the plain text block. There are no
// bands to preview and nothing to draw them from.
function dietBandsHtml(){
  const det=dietaryDetail(today());
  if(!det){
    const pending=firstPendingSet();
    if(!pending){
      // A day predating the first target set has no v2 bands to draw, and drawing
      // them against targets that did not govern it would be the retro-grading
      // §14 forbids. Say so plainly instead.
      return '<div class="card"><div class="form-note">No dated target set governs today yet. '+
             'Save your targets below and this day starts scoring against them tomorrow.</div></div>';
    }
    // THE DATE COMES FROM THE ENTRY, never from tomorrowStr() and never a
    // literal — a set saved days ago is still pending until its own date, and
    // quoting "tomorrow" then would be wrong.
    return '<div class="card db-card">'+
      ringHtml(null,'—')+
      `<div class="db-summary">Not in force until ${esc(pending.effectiveFrom)}. `+
      'Today is scored on your previous targets.</div>'+
      dietTargetRows(pending).map(bandRowHtml).join('')+
      '<div class="form-note">Green band is the target range. No bar is drawn on any row '+
      'and the ring has no score, because today is not measured against these targets — '+
      'they start on '+esc(pending.effectiveFrom)+'. Total fat and carbs are shown but never scored.</div>'+
    '</div>';
  }
  return '<div class="card db-card">'+
    ringHtml(det.score)+
    `<div class="db-summary">${esc(bandSummary(det))}</div>`+
    det.rows.map(bandRowHtml).join('')+
    '<div class="form-note">Green band is the target range, the bar is today. '+
    'Total fat and carbs are shown but not scored — carbs are what is left after '+
    'calories, protein and fat, so scoring them would count the same choice twice. '+
    'A dash means nothing counted today stated that figure.</div>'+
  '</div>';
}

function newTargetChallenge(){return String(Math.floor(Math.random()*10));}

// The change preview. Listed BEFORE the keypad, in the order Ryan reads it:
// what is changing, when it starts, and what it does not touch today.
function targetGateHtml(){
  const g=tgGate;
  const slot=`<span class="keypad-slot${g.entry?' is-filled':''}">${esc(g.entry)}</span>`;
  const key=k=>`<button class="keypad-key" onclick="targetGateKey('${k}')">${k}</button>`;
  const keys=['1','2','3','4','5','6','7','8','9'].map(key).join('');
  return '<div class="pause-card">'+
    '<div class="pause-state">Confirm target change</div>'+
    '<div class="tg-diff">'+
      g.diffs.map(d=>'<div class="tg-diff-row">'+esc(d.label)+' <span class="tg-diff-from">'+esc(d.from)+
                     '</span> → <span class="tg-diff-to">'+esc(d.to)+'</span></div>').join('')+
    '</div>'+
    '<div class="pause-hint">Takes effect '+esc(g.next)+'. Today is scored against your current targets.</div>'+
    '<div class="pause-sub">Type this number to save.</div>'+
    '<div class="keypad-code">'+g.code+'</div>'+
    '<div class="keypad-entry">'+slot+'</div>'+
    (g.msg?'<div class="keypad-msg">'+esc(g.msg)+'</div>':'')+
    '<div class="keypad">'+keys+
      '<span class="keypad-spacer"></span>'+
      key('0')+
      '<button class="keypad-key keypad-alt" onclick="targetGateBack()">⌫</button>'+
    '</div>'+
    '<button class="pause-btn keypad-cancel" onclick="targetGateCancel()">Cancel — save nothing</button>'+
  '</div>';
}

export function renderTargets(){
  const el=document.getElementById('targets-panel');
  if(!el)return;
  if(tgGate){el.innerHTML=targetGateHtml();return;}

  const {set,seeded,pending}=currentTargetSet();
  const dm=dayMacros(today());
  const ex=foodCountExtras(today());

  // §14.2's visual leads the section — it is what Ryan is here to look at. The
  // editor below it stays: it is the only way targets get set at all, and it
  // covers the six micronutrients the eight-row visual does not.
  let html=dietBandsHtml();
  if(tgMsg){
    const cls=tgMsg.kind==='success'?'success':tgMsg.kind==='err'?'err':'info';
    html+=`<div class="alert ${cls}">${esc(tgMsg.text)}</div>`;
  }
  html+='<div class="card">';
  html+='<div class="card-title">Edit targets</div>';
  html+='<div class="tg-head"><span class="tg-head-label"></span><span class="tg-head-col">Target</span><span class="tg-head-col">Today</span></div>';
  html+=TARGET_FIELDS.map(f=>{
    const val=set[f.key];
    const act=todayActual(f,dm,ex);
    let inputs;
    if(f.kind==='range'){
      inputs=`<input type="number" id="tg-${f.key}-min" inputmode="numeric" step="1" value="${val&&val.min!=null?esc(String(val.min)):''}" aria-label="${f.label} minimum">`+
             `<span class="tg-dash">–</span>`+
             `<input type="number" id="tg-${f.key}-max" inputmode="numeric" step="1" value="${val&&val.max!=null?esc(String(val.max)):''}" aria-label="${f.label} maximum">`;
    }else{
      // THE PLACEHOLDER IS NOT A VALUE. A field with a constant behind it shows
      // that constant greyed out when the set does not carry the key, so an
      // empty box reads as "falls back to 22", not as "no ceiling at all". It is
      // never submitted, so an untouched form still diffs as unchanged.
      const ph=(f.fallback!=null&&val==null)?` placeholder="${esc(String(f.fallback))}"`:'';
      inputs=`<input type="number" id="tg-${f.key}" inputmode="numeric" step="1" value="${val!=null?esc(String(val)):''}"${ph} aria-label="${f.label}">`;
    }
    return `<div class="tg-row">`+
      `<div class="tg-label">${f.label}${f.unit?' <span class="tg-unit">('+f.unit+')</span>':''}</div>`+
      `<div class="tg-fields">${inputs}</div>`+
      `<div class="tg-today"><span class="tg-today-val">${esc(act.text)}</span>`+
        (act.note?`<span class="tg-today-note">${esc(act.note)}</span>`:'')+
      `</div>`+
    `</div>`;
  }).join('');
  html+=`<button class="btn btn-primary" onclick="saveTargetHistory()">Save targets</button>`;
  html+=`<div class="form-note">Mode: cut. A change takes effect ${esc(tomorrowStr())} — the day you change it is still scored against the targets you lived it under.</div>`;
  if(seeded){
    // "the targets on the Log page" used to be the wording here. The flat
    // nutrition inputs were retired 2026-08-15, so there is no page to point at
    // any more — the fallback is the stored legacy object, which is now read
    // only and never written.
    html+=`<div class="form-note">These are starting values only. NOTHING IS SAVED until you press Save, and until then every day is scored the older way, against the flat targets stored before this panel existed.</div>`;
  }else if(pending){
    // SAY THAT IT IS NOT LIVE YET. Showing a saved-but-pending set without
    // saying so would let Ryan believe today is being graded against numbers
    // that will not apply until tomorrow (§1.7).
    html+=`<div class="form-note">Saved, and takes effect ${esc(set.effectiveFrom)} — not in force yet. Today is still scored against the previous targets.</div>`;
  }else{
    html+=`<div class="form-note">In force since ${esc(set.effectiveFrom||'—')}. Earlier days keep the targets they were scored under.</div>`;
  }
  // A set saved before saturatedFatMax existed carries no key for it. Say what
  // it is actually graded against rather than leaving a blank box to guess at
  // (§1.7). NOTHING IS BACKFILLED — the blank is the truth about that entry.
  if(!seeded&&set.saturatedFatMax==null){
    html+=`<div class="form-note">Saturated fat max is blank because this target set was saved before that field existed. It is graded against ${SATURATED_FAT_MAX_DEFAULT} g — the ceiling in use before it was editable. Type a number to set your own; earlier days keep the ${SATURATED_FAT_MAX_DEFAULT} g they were scored under.</div>`;
  }
  html+='</div>';
  el.innerHTML=html;
}

// Opens the confirm gate. WRITES NOTHING — the entry is built here, held in
// module state, and only committed when a matching digit is typed.
export function saveTargetHistory(){
  const {set}=currentTargetSet();
  const proposed=readTargetForm(set);
  // Compared against the LATEST SAVED SET — including one that is still pending
  // — not against the seed and not against whatever happens to be in force
  // today. That is what makes "nothing changed" mean what Ryan expects
  // immediately after a save, and what stops a second Save appending a
  // near-identical entry for the same effectiveFrom. With no history at all
  // this is null and every field reads as a change, which is right: saving the
  // seed unedited is still the first real target set.
  const diffs=targetDiffs(latestTargetSet(),proposed);
  if(!diffs.length){
    // NO DUPLICATE ENTRY. An append-only list that gains an identical row every
    // time Save is pressed would make "when did this change" unanswerable.
    tgMsg={text:'Nothing changed, so nothing was saved. Your targets are already exactly these.',kind:'info'};
    renderTargets();return;
  }
  tgMsg=null;
  tgGate={code:newTargetChallenge(),entry:'',msg:'',diffs,next:tomorrowStr(),proposed};
  renderTargets();
}

export function targetGateCancel(){
  tgGate=null;
  tgMsg={text:'Cancelled. Nothing was saved and your targets are unchanged.',kind:'info'};
  renderTargets();
}

export function targetGateBack(){
  if(!tgGate)return;
  tgGate.entry='';tgGate.msg='';
  renderTargets();
}

export function targetGateKey(k){
  if(!tgGate)return;
  if(k!==tgGate.code){
    // WRONG DIGIT: nothing is written and the gate stays open on the same
    // challenge — a number that moved mid-attempt punishes a fumbled thumb
    // twice, the same reasoning training.js records.
    tgGate.entry='';
    tgGate.msg='That is not the number shown. Nothing was saved.';
    renderTargets();return;
  }
  const {proposed,next}=tgGate;
  tgGate=null;
  const d=db();
  if(!Array.isArray(d.targetHistory))d.targetHistory=[];
  // APPEND ONLY, effectiveFrom ALWAYS TOMORROW (§14). An entry is never edited
  // and never removed: rewriting one would re-grade the days it governed, which
  // is the bug this whole feature exists to fix.
  d.targetHistory.push({...proposed,effectiveFrom:next,savedAt:new Date().toISOString()});
  d.targetHistory.sort((a,b)=>a.effectiveFrom<b.effectiveFrom?-1:a.effectiveFrom>b.effectiveFrom?1:0);
  save(d);
  tgMsg={text:'Saved. These targets take effect '+next+'. Today’s score is unchanged — it is still measured against the targets you lived today under.',kind:'success'};
  renderTargets();
  // Today's score genuinely did not move, but the day strip and score box are
  // re-rendered anyway so nothing on screen is left showing a stale read.
  renderHome();
}

// ---------------------------------------------------------------------------
// Sync now — ARCHITECTURE.md §6.3.
//
// WHY THIS PAGE: `triggerSync()` and `fetchVitalsDay()` had been exported from
// api.js since §6 was built and were called by nothing — the server could sync
// but the app could not ask it to. This control sits directly under the
// "Awaiting Sync" panel because that panel is the thing that goes stale, and
// this is what fixes it. (The drawer was the alternative and was rejected: the
// drawer is navigation plus backup/restore, and a sync button there would be
// invisible from the page whose numbers it refreshes.)
//
// THREE RULES, all of them §1.7 in spirit — never imply data is fresher than
// it is:
//   1. A failure says so, plainly, and says the numbers did not change.
//   2. "Server data last written" reports the SERVER's own last write
//      (GET /api/sync/status's lastWriteUtc), not when this browser last
//      fetched. It answers "how old is this data" honestly even when the sync
//      button has never been pressed.
//   3. A sync in flight disables the button, so a double-tap cannot fire two
//      overlapping pulls. `busy` is checked as well, because a disabled
//      attribute is a UI state and this is the guarantee (same defence-in-depth
//      pattern as toggleExercise()'s lock, §9.4).
// ---------------------------------------------------------------------------

// Module state, deliberately not stored: an in-flight sync must not survive a
// reload, and a result message is about one button press.
let syncBusy = false;
let syncMsg = null;        // {text, kind:'info'|'err'|'success'}
let syncStatus = null;     // last {lastWriteUtc, daysStored} seen, or null

function lastWrittenLabel(){
  if(!syncStatus || !syncStatus.lastWriteUtc) return 'unknown — the server has not answered';
  const t = new Date(syncStatus.lastWriteUtc);
  if(isNaN(t.getTime())) return 'unknown';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  let rel;
  if(mins < 1) rel = 'just now';
  else if(mins < 60) rel = mins + ' min ago';
  else if(mins < 1440) rel = Math.round(mins / 60) + ' hr ago';
  else rel = Math.round(mins / 1440) + ' day' + (Math.round(mins / 1440) === 1 ? '' : 's') + ' ago';
  // Local time, per §12 — the server hands back a UTC instant and the phone
  // renders it where Ryan is standing.
  return t.toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) + ' · ' + rel;
}

export function renderSyncPanel(){
  const el = document.getElementById('sync-panel');
  if(!el) return;
  const cls = syncMsg ? ('alert ' + (syncMsg.kind === 'success' ? 'success' : syncMsg.kind === 'err' ? 'err' : 'info')) : '';
  const stored = syncStatus && syncStatus.daysStored != null
    ? syncStatus.daysStored + ' day' + (syncStatus.daysStored === 1 ? '' : 's') + ' stored on the server'
    : '';
  el.innerHTML =
    '<div class="card">' +
      `<button class="btn btn-primary" onclick="runSync()"${syncBusy ? ' disabled' : ''}>` +
        (syncBusy ? 'Syncing…' : 'Sync now') +
      '</button>' +
      (syncMsg ? `<div class="${cls}" style="margin-top:10px">${esc(syncMsg.text)}</div>` : '') +
      `<div class="form-note">Server data last written: ${esc(lastWrittenLabel())}</div>` +
      (stored ? `<div class="form-note">${esc(stored)}</div>` : '') +
    '</div>';
}

// Fire-and-forget: the panel renders immediately with whatever is known and
// updates when the server answers. Never throws (api.js's contract).
function refreshSyncStatus(){
  return fetchSyncStatus().then(function(s){
    syncStatus = s;
    renderSyncPanel();
    return s;
  });
}

export async function runSync(){
  if(syncBusy) return;                       // the guarantee, not just the disabled attribute
  syncBusy = true;
  syncMsg = {text:'Syncing with Google Health…', kind:'info'};
  renderSyncPanel();

  const res = await triggerSync();            // no dates: this primes explicitly below
  if(!res){
    // Server down, Tailscale off, or a non-200. Say so and say the numbers on
    // screen did not change — never leave a stale reading looking fresh.
    syncBusy = false;
    syncMsg = {text:'Sync failed — the server did not answer. Nothing on this screen has changed.', kind:'err'};
    renderSyncPanel();
    return;
  }

  const primed = await primeRecentVitals();
  await refreshSyncStatus();
  syncBusy = false;

  const days = (res.daysWritten || []).length;
  if(res.errors && res.errors.length){
    syncMsg = {text:'Sync finished with ' + res.errors.length + ' problem' +
                    (res.errors.length === 1 ? '' : 's') + ': ' + res.errors[0], kind:'err'};
  }else if(!primed){
    syncMsg = {text:'The server synced, but this app could not re-read the data. Reload to be sure.', kind:'err'};
  }else{
    syncMsg = {text:'Synced ' + days + ' day' + (days === 1 ? '' : 's') +
                    (res.start && res.end ? ' (' + res.start + ' to ' + res.end + ')' : '') + '.', kind:'success'};
  }

  // Re-render off the refreshed cache so the new numbers are on screen without
  // a reload. renderHome() re-does the score box, the day strip and the home
  // vitals header; the Training header is the only other mounted consumer.
  renderHome();
  renderVitalsHeader('vitals-header-training');
  renderHealth();
}

// renderRelativeStrength() MOVED TO pages/prs.js, 2026-08-14 — it reads derived
// Training Maxes, which is that page's subject, not this one's (§10.1).
// rollingBodyweight() is still imported here: renderBodySummary() uses it.

export function saveBodyHeight(){
  const d=db();d.body=d.body||{};
  const h=document.getElementById('health-height').value;
  if(h!=='')d.body.height=h;
  save(d);renderHealth();
}

// Age has no other home in the schema (§6, §5 in ARCHITECTURE.md) — stored
// additively as d.body.age, alongside height. Needed for the Karvonen zone's
// Tanaka maxHR term (derive.js's tanakaMaxHR()/getAge()); with no age on file
// the live vitals header's Zone value stays a placeholder rather than guess.
export function saveBodyAge(){
  const d=db();d.body=d.body||{};
  const a=document.getElementById('health-age').value;
  if(a!=='')d.body.age=a;
  save(d);renderHealth();
}

// ---------------------------------------------------------------------------
// Blood pressure, SpO2 and pulse — ARCHITECTURE.md §10.2.
//
// Stored additively under d.body.vitals, a new key beside weights/waists:
//   d.body.vitals = [{date, systolic, diastolic, spo2, pulse}]
//
// ############ THE APP DOES NOT INTERPRET THESE ############
//
// No hypertension staging, no normal/elevated/high label, no colour by
// threshold, and NOTHING HERE FEEDS A SCORE (§11 — the four pillar weights are
// untouched by this whole feature). Blood pressure staging is a clinical
// judgement that depends on context this app does not have — posture, cuff
// size, time of day, medication, what the reading was last month. Printing
// "Stage 1 Hypertension" under a number would be exactly the overclaim the
// hormone indices were deleted for. Store the numbers; show the numbers.
//
// ############ EVERY FIELD IS INDEPENDENTLY NULLABLE ############
//
// Ryan may take BP without the oximeter or the other way round. An absent field
// is OMITTED FROM THE RECORD — not written as null, not written as 0 (§1.4,
// §1.7). A record with no non-null field is not saved at all.
//
// ONE RECORD PER DATE. Re-saving the same date REPLACES that record rather than
// appending a second — unlike weights/waists, which append by design. These are
// point-in-time readings Ryan takes once in the evening, and two rows for one
// date would leave "the latest reading" ambiguous.
// ---------------------------------------------------------------------------

// A value is a typo, not a measurement, when it lands outside these. Rejected
// loudly rather than stored — a mistyped 1280/82 that got saved would sit in
// the history forever looking like something that happened.
const VITAL_RANGES={
  systolic: {min:60,  max:260, label:'Systolic',  unit:'mmHg'},
  diastolic:{min:30,  max:160, label:'Diastolic', unit:'mmHg'},
  spo2:     {min:50,  max:100, label:'SpO₂',      unit:'%'},
  pulse:    {min:25,  max:220, label:'Pulse',     unit:'bpm'}
};
const VITAL_KEYS=Object.keys(VITAL_RANGES);

// Every record, newest first. Sorted here rather than assuming the array is
// ordered — records are keyed by a date Ryan types, so they can be entered out
// of order.
function bodyVitalsByDate(){
  const list=((db().body||{}).vitals)||[];
  return list.filter(r=>r&&r.date).slice()
             .sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
}

// The most recent record by date, or null.
function latestBodyVitals(){
  const all=bodyVitalsByDate();
  return all.length?all[0]:null;
}

// The most recent record that actually CARRIES this field, with its date. Not
// the most recent record — a reading Ryan did take three days ago is a better
// answer than an em-dash just because yesterday's record was oximeter-only.
function latestFieldReading(key){
  const all=bodyVitalsByDate();
  for(const r of all){
    const v=r[key];
    if(v!==null&&v!==undefined&&v!=='')return {value:v,date:r.date};
  }
  return null;
}

// "today" / "yesterday" / "3 days ago". Whole days between two local calendar
// dates (§12) — never a timezone-shifted instant.
function daysAgoText(ds){
  const a=new Date(ds+'T12:00:00'), b=new Date(today()+'T12:00:00');
  const n=Math.round((b-a)/86400000);
  if(!isFinite(n))return ds;
  if(n<=0)return 'today';
  if(n===1)return 'yesterday';
  return n+' days ago';
}

// ############ SHOWING THE LAST KNOWN VALUE IS HONEST. STORING IT IS NOT ############
//
// Changed 2026-08-15, superseding §10.2's original "never borrows a value from
// an older record". Each cell now falls back to the most recent record that
// carries that field AND SAYS HOW OLD IT IS — "97 %, 3 days ago". An em-dash
// where a real reading exists three days back throws away something true.
//
// THE DISTINCTION THAT MAKES THIS SAFE: this is a display fallback with the age
// attached, never a write. Nothing is copied into today's record, so a reading
// Ryan never took can never end up stored as though he had (§1.7). A field with
// no reading anywhere still shows '—' and 'not taken'.
function renderBodyVitals(){
  const el=document.getElementById('body-vitals-latest');
  if(!el)return;
  if(!latestBodyVitals()){
    el.innerHTML='<div class="card"><div class="form-note">No blood pressure, SpO₂ or pulse logged yet. '+
                 'Add one below — every field is optional.</div></div>';
    return;
  }
  let anyStale=false;
  const cells=VITAL_KEYS.map(k=>{
    const m=VITAL_RANGES[k];
    const hit=latestFieldReading(k);
    if(hit&&hit.date!==today())anyStale=true;
    return `<div class="card" style="text-align:center;padding:12px">`+
      `<div class="card-title" style="margin-bottom:4px">${m.label}</div>`+
      `<div class="stat-big" style="font-size:26px">${hit?esc(String(hit.value)):'—'}</div>`+
      `<div class="stat-sub">${m.unit}</div>`+
      `<div class="stat-sub" style="font-size:10px;margin-top:4px">${hit?esc(daysAgoText(hit.date)):'not taken'}</div>`+
    `</div>`;
  }).join('');
  el.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+cells+'</div>'+
    `<div class="form-note">`+
    (anyStale?'Each number is the last one you recorded, with when you recorded it — they are not all from the same day, and none of them is being treated as today’s reading. ':'')+
    `These are recorded and shown only — the app does not interpret them and they do not affect any score.</div>`;
}

// ---------------------------------------------------------------------------
// INDEPENDENT FIELD SAVES — 2026-08-15.
//
// One card, one Save button, and every field independently optional. Ryan takes
// blood pressure one evening, SpO2 another, and weighs himself on a third; he
// must never have to re-enter an unrelated field to record one reading. Two
// fields filled and the rest blank is a COMPLETE, VALID SAVE.
//
// ############ A BLANK FIELD IS ABSENT. IT IS NEVER CARRIED FORWARD ############
//
// Carrying yesterday's value into today's blank box was ASKED FOR and was
// REJECTED, deliberately, and this note exists so it is not reintroduced later
// as a convenience. A carried-forward SpO2 is a reading Ryan never took, stored
// indistinguishably from one he did — the same defect class as the awake-minutes
// bug (§6.10) and the em-dash rules throughout §1.7. Once written it is
// unfalsifiable: nothing in the record says which numbers were measured.
//
// SHOWING the last known value beside its age is a different thing entirely and
// IS done — see renderBodyVitals() above. Display carries the date with it;
// storage would not.
//
// Height and age are the one exception, and only because they are PROFILE STATE
// rather than dated measurements: their inputs are prefilled from what is stored
// (renderHealth) so they need no re-entry, and they are still only written when
// actually present.
// ---------------------------------------------------------------------------

// A one-line receipt naming what was and was not recorded, held in module state
// and rendered into the card. Never stored.
let measureMsg=null;      // {text, kind:'info'|'err'|'success'}

function renderMeasureMsg(){
  const el=document.getElementById('measure-receipt');
  if(!el)return;
  if(!measureMsg){el.innerHTML='';return;}
  const cls=measureMsg.kind==='success'?'success':measureMsg.kind==='err'?'err':'info';
  el.innerHTML=`<div class="alert ${cls}">${esc(measureMsg.text)}</div>`;
}

// Receipt names read MID-SENTENCE, so they are lower case except where the
// capital is part of the term itself. VITAL_RANGES' labels head their own cards
// and are capitalised for that; reusing them here produced "and Pulse".
const RECEIPT_NAMES={systolic:'systolic',diastolic:'diastolic',spo2:'SpO₂',pulse:'pulse'};

// "SpO₂ 97%", "pulse 62 bpm".
function vitalPhrase(k,v){
  const m=VITAL_RANGES[k];
  return RECEIPT_NAMES[k]+' '+v+(m.unit==='%'?'%':' '+m.unit);
}

export function logBodyMeasurement(){
  const val=id=>{const el=document.getElementById(id);return ((el&&el.value)||'').trim();};
  const w=val('health-weight');
  const wa=val('health-waist');

  // Read and validate the four vitals BEFORE writing anything, so a typo in the
  // pulse box cannot leave a bodyweight half-saved. Same all-or-nothing shape
  // the library writes on the Meal Tracker use (§1.7).
  const vitals={};
  for(const k of VITAL_KEYS){
    const raw=val('health-'+k);
    if(raw==='')continue;                       // absent, not zero — omitted below
    const num=Number(raw);
    const m=VITAL_RANGES[k];
    if(!isFinite(num)){
      measureMsg={text:m.label+' must be a number. Nothing was saved.',kind:'err'};
      renderHealth();return;
    }
    if(num<m.min||num>m.max){
      // SAY WHAT WAS EXPECTED AND SAY NOTHING WAS SAVED. A value this far out is
      // a typo; storing it would corrupt the history silently.
      measureMsg={text:m.label+' of '+raw+' '+m.unit+' is outside the plausible range ('+
            m.min+'–'+m.max+' '+m.unit+'). Nothing was saved — check the number.',kind:'err'};
      renderHealth();return;
    }
    vitals[k]=num;
  }
  const anyVital=VITAL_KEYS.some(k=>k in vitals);

  const d=db();
  d.body=d.body||{};d.body.weights=d.body.weights||[];d.body.waists=d.body.waists||[];
  const date=val('health-measure-date')||today();

  // ############ HALF A BLOOD PRESSURE IS NOT A BLOOD PRESSURE ############
  //
  // A lone systolic means nothing clinically and nothing to Ryan reading it back
  // in six months. The test is on the RECORD THAT WOULD RESULT, not on the form
  // alone, so correcting one half of a reading already stored for that date
  // still works — the merge below supplies the other half.
  if(!Array.isArray(d.body.vitals))d.body.vitals=[];
  const existingIdx=d.body.vitals.findIndex(r=>r&&r.date===date);
  const existing=(existingIdx>=0)?d.body.vitals[existingIdx]:{};
  const wouldHave=k=>{
    const v=(k in vitals)?vitals[k]:existing[k];
    return v!==null&&v!==undefined&&v!=='';
  };
  if(anyVital&&(wouldHave('systolic')!==wouldHave('diastolic'))){
    const missing=wouldHave('systolic')?'diastolic':'systolic';
    measureMsg={text:'A blood pressure needs both numbers to mean anything — the '+missing+
                     ' is missing. Nothing was saved; enter both, or leave both blank and save the '+
                     'other readings on their own.',kind:'err'};
    renderHealth();return;
  }

  // Height and age: profile state, written only when present. Their own onchange
  // handlers already save them; this makes the Save button agree rather than
  // silently ignoring a box Ryan just typed in.
  const h=val('health-height'), ag=val('health-age');
  const heightChanged=(h!==''&&String(d.body.height==null?'':d.body.height)!==h);
  const ageChanged=(ag!==''&&String(d.body.age==null?'':d.body.age)!==ag);

  if(!w&&!wa&&!anyVital&&!heightChanged&&!ageChanged){
    // NOTHING FILLED WRITES NOTHING, AND SAYS SO. Silence here would look
    // identical to a successful save.
    measureMsg={text:'Nothing was filled in, so nothing was saved. Enter any one field — '+
                     'a bodyweight, a waist, a blood pressure, an SpO₂ or a pulse — and save that on its own.',kind:'info'};
    renderHealth();return;
  }

  if(heightChanged)d.body.height=h;
  if(ageChanged)d.body.age=ag;
  // UNCHANGED. Weights and waists still APPEND, per §10.2 — two weigh-ins in one
  // day are two real readings, unlike the point-in-time vitals below.
  if(w)d.body.weights.push({date,lbs:w});
  if(wa)d.body.waists.push({date,inches:wa});

  if(anyVital){
    // ONE RECORD PER DATE, AND SAVES INTO IT **MERGE** (changed 2026-08-15).
    // It used to REPLACE, which quietly destroyed the whole point of independent
    // saves: logging SpO2 in the afternoon and pulse in the evening left a record
    // holding only the pulse. Only the fields actually entered are written; every
    // other key on the record is left exactly as it was, and a field never
    // entered is simply not a key (§1.4).
    const rec={...existing,date,...vitals};
    if(existingIdx>=0)d.body.vitals[existingIdx]=rec;else d.body.vitals.push(rec);
  }

  save(d);

  // ############ THE RECEIPT NAMES THE GAP AT THE MOMENT IT IS CREATED ############
  //
  // Both lists are DERIVED from what was actually written. A known gap said out
  // loud today is worth far more than a mystery hole in a chart in three weeks.
  const saved=[],skipped=[];
  (w?saved:skipped).push(w?'bodyweight '+w+' lbs':'bodyweight');
  (wa?saved:skipped).push(wa?'waist '+wa+' in':'waist');
  if('systolic' in vitals||'diastolic' in vitals){
    const s=('systolic' in vitals)?vitals.systolic:existing.systolic;
    const dia=('diastolic' in vitals)?vitals.diastolic:existing.diastolic;
    saved.push('blood pressure '+s+'/'+dia);
  }else skipped.push('blood pressure');
  ['spo2','pulse'].forEach(k=>{
    if(k in vitals)saved.push(vitalPhrase(k,vitals[k]));
    else skipped.push(RECEIPT_NAMES[k]);
  });
  let text='Saved'+(date===today()?'':' for '+date)+': '+(saved.length?saved.join(', '):'nothing')+'.';
  if(skipped.length)text+=' Not recorded: '+skipped.join(', ')+'.';
  if(heightChanged)text+=' Height updated to '+h+' in.';
  if(ageChanged)text+=' Age updated to '+ag+'.';
  if(skipped.length)text+=' Blank fields stay blank — nothing was carried over from an earlier reading.';
  measureMsg={text,kind:'success'};

  document.getElementById('health-weight').value='';
  document.getElementById('health-waist').value='';
  VITAL_KEYS.forEach(k=>{const el=document.getElementById('health-'+k);if(el)el.value='';});
  renderHealth();
}

export function renderHealth(){
  renderBodySummary();renderBodyVitals();renderMeasureMsg();renderTargets();
  // Paint the panel from what is already known, then ask the server for a
  // fresher answer — same placeholder-then-update pattern the vitals header
  // uses (§9.3), never a number before there is a source for it.
  renderSyncPanel();
  refreshSyncStatus();
  const bodyNow=db().body||{};
  const hEl=document.getElementById('health-height');if(hEl&&bodyNow.height)hEl.value=bodyNow.height;
  const ageEl=document.getElementById('health-age');if(ageEl&&bodyNow.age)ageEl.value=bodyNow.age;
  const dEl=document.getElementById('health-measure-date');if(dEl&&!dEl.value)dEl.value=today();
  const d=db(),t=today();const sl=getSleepForDate(t);const todayFasts=d.fasts.filter(f=>f.date===t);const fastHrs=d.activeFast?calcFastHrs({start:d.activeFast.start,date:d.activeFast.date}):(todayFasts.length?Math.max(...todayFasts.map(calcFastHrs)):0);const w=getWorkoutForDate(t);const meals=d.meals.filter(m=>m.date===t);const sugar=meals.reduce((a,m)=>a+(+m.sugar||0),0);
  // FIVE ROWS, NOT SIX. The Cortisol row went with the indices — it was the one
  // entry here whose value came from a computation rather than from a logged
  // fact, and it read 'Moderate'/'High' off thresholds on an unvalidated score.
  // THE OTHER FIVE THRESHOLDS ARE UNCHANGED, deliberately: they are the same
  // behavioural facts, judged the same way, and this deletion is not the place
  // to re-tune them.
  // Deep sleep is null on an unstaged night (§1.7). It renders as an em-dash
  // and its dot is NOT "good" — but that is "no reading", not "you slept badly",
  // and showing 0.0h here would have asserted the second.
  const deepH=(sl&&sl.deep!=null&&isFinite(+sl.deep))?+sl.deep:null;
  const factors=[{name:'Deep sleep',val:deepH!=null?deepH.toFixed(1)+'h':'— not tracked',good:deepH!=null&&deepH>=1.5},{name:'Total sleep',val:(+(sl&&sl.hours)||0).toFixed(1)+'h'+(sl._default?' (assumed)':''),good:(+(sl&&sl.hours)||0)>=7.5},{name:'Fasting',val:fastHrs>0?fastHrs.toFixed(1)+'h':'None today',good:fastHrs>=16},{name:'Workout',val:w?w.type:'None logged',good:!!w&&w.type!=='Active Rest'},{name:'Sugar today',val:sugar+'g',good:sugar<10}];
  document.getElementById('hgh-factors').innerHTML=factors.map(f=>`<div class="factor-row"><div class="factor-icon ${f.good?'good':'bad'}"></div><div class="factor-name" style="flex:1;color:var(--muted);font-size:13px">${f.name}</div><div style="font-size:13px">${f.val}</div></div>`).join('');
  const phase=getPhase(fastHrs);document.getElementById('autophagy-phase').textContent=phase.name;document.getElementById('autophagy-hrs').textContent=fastHrs>0?fastHrs.toFixed(1)+' hours fasted':'Start a fast to track phase';for(let i=1;i<=4;i++)document.getElementById('ps'+i).className='phase-seg'+(i<=phase.idx+1?' active':'');
}
