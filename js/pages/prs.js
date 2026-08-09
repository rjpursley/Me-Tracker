// ---------------------------------------------------------------------------
// pages/prs.js — Personal Records: tested 1RMs for the four main lifts.
//
// ARCHITECTURE.md §10.1.
//
// SCOPE IS THE FOUR MAIN LIFTS ONLY — back squat, overhead press, deadlift,
// bench press. Not assistance work, not accessories. Those are prescribed by
// schedule.js and are not things Ryan tests for a max.
//
// EVERY VALUE HERE IS A TESTED 1RM THAT RYAN LOGGED HIMSELF.
//
// DO NOT ADD REP-MAX ESTIMATION. No Epley, no Brzycki, no "5 reps at 275 means
// your max is ~310". That was decided explicitly: the big four get tested and
// logged. An estimated max is a guess that would then silently drive every
// prescribed weight in the program through TM, and §1.7 does not allow an
// estimate to wear the same clothes as a measurement.
//
// Entries APPEND. Logging a new 1RM never overwrites an old one — the history
// is the point, because progress over twelve weeks is the thing worth seeing.
//
// The Training Max shown here is derived, never stored: TM = 1RM * 0.85. See
// the block comment in derive.js before touching any of that arithmetic.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today } from '../util.js';
import { mainLiftStatus, MAIN_LIFTS, TM_PERCENT_OF_1RM } from '../derive.js';

// Round a derived TM for display only. The unrounded value is what the
// percentage math uses — see derive.js.
function showTM(tm){return Math.round(tm*10)/10;}

export function renderPRs(){
  const el=document.getElementById('pr-container');
  if(!el)return;
  const lifts=mainLiftStatus();
  let html='';

  html+=`<div class="pr-intro">Log a tested 1RM. Training Max is derived as 1RM × ${TM_PERCENT_OF_1RM} — the program's percentages all run off TM, never the 1RM.</div>`;

  lifts.forEach(l=>{
    const hist=l.history.slice().reverse(); // newest first for reading
    html+=`<div class="pr-card">`+
      `<div class="pr-head"><span class="pr-name">${l.name}</span>`+
        (l.source==='1rm'
          ? `<span class="pr-date">set ${l.date}</span>`
          : `<span class="pr-date pr-none">${l.source==='legacy'?'legacy TM — no 1RM yet':'not set'}</span>`)+
      `</div>`+
      `<div class="pr-stats">`+
        `<div class="pr-stat"><div class="pr-stat-label">1RM</div><div class="pr-stat-val">${l.oneRM!=null?l.oneRM:'—'}</div><div class="pr-stat-unit">lbs</div></div>`+
        `<div class="pr-stat"><div class="pr-stat-label">Training Max</div><div class="pr-stat-val pr-tm">${l.tm>0?showTM(l.tm):'—'}</div><div class="pr-stat-unit">${l.source==='legacy'?'lbs · typed':'lbs · derived'}</div></div>`+
      `</div>`;

    if(l.source==='legacy'){
      html+=`<div class="pr-note">Still running on the old typed Training Max of ${showTM(l.tm)} lb. Log a tested 1RM and it takes over.</div>`;
    }

    html+=`<div class="pr-entry">`+
      `<input type="number" id="pr-in-${l.key}" placeholder="Tested 1RM (lbs)" step="5" inputmode="numeric">`+
      `<input type="text" id="pr-date-${l.key}" value="${today()}" aria-label="Date tested">`+
      `<button class="btn btn-primary pr-save" onclick="logOneRM('${l.key}')">Log</button>`+
    `</div>`;

    if(hist.length){
      html+=`<div class="pr-hist-head">History</div>`;
      html+=hist.map((r,i)=>`<div class="pr-hist-row"><span class="pr-hist-date">${r.date}</span><span class="pr-hist-lbs">${+r.lbs} lb</span><span class="pr-hist-tm">TM ${showTM(+r.lbs*TM_PERCENT_OF_1RM)}</span>${i===0?'<span class="pr-hist-cur">current</span>':''}</div>`).join('');
    }else{
      html+=`<div class="pr-note">No tested 1RM logged yet.</div>`;
    }
    html+=`</div>`;
  });

  el.innerHTML=html;
}

// Append a tested 1RM. Never overwrites — §10.1 keeps the whole history.
//
// The date defaults to today() from util.js, which is LOCAL (§12). Do not
// swap it for toISOString(): after 20:00 Eastern that stamps tomorrow.
export function logOneRM(liftKey){
  const lift=MAIN_LIFTS.find(l=>l.key===liftKey);
  if(!lift)return;
  const inp=document.getElementById('pr-in-'+liftKey);
  const dateInp=document.getElementById('pr-date-'+liftKey);
  const lbs=+(inp&&inp.value);
  if(!(lbs>0)){alert('Enter the weight you tested, in pounds.');return;}
  const date=((dateInp&&dateInp.value)||'').trim()||today();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){alert('Date must look like YYYY-MM-DD.');return;}

  const d=db();
  if(!d.oneRepMaxes||typeof d.oneRepMaxes!=='object'||Array.isArray(d.oneRepMaxes))d.oneRepMaxes={};
  if(!Array.isArray(d.oneRepMaxes[liftKey]))d.oneRepMaxes[liftKey]=[];
  d.oneRepMaxes[liftKey].push({lbs:String(lbs),date});
  save(d);
  if(inp)inp.value='';
  renderPRs();
}
