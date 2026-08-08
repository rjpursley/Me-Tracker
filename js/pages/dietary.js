// ---------------------------------------------------------------------------
// pages/dietary.js — Today's macros, supplements, targets, meal history.
//
// ARCHITECTURE.md §11: the supplement list (Himalayan salt, CoQ-10, Magnesium
// Threonate) is not to be changed without explicit instruction. It lives in the
// index.html markup and is deliberately unscored.
//
// Moved verbatim from index.html. No logic changed.
//
// NOT YET BUILT (§8): confidence tiers (exact / high / low), barcode lookup,
// label OCR, plate-photo estimates.
// ---------------------------------------------------------------------------

import { db, save } from '../store.js';
import { today } from '../util.js';
import { renderHome } from './home.js';

export function renderDiet(){
  const d=db(),t=today();const meals=d.meals.filter(m=>m.date===t);const tp=meals.reduce((a,m)=>a+(+m.protein||0),0),tf=meals.reduce((a,m)=>a+(+m.fat||0),0),ts=meals.reduce((a,m)=>a+(+m.sugar||0),0);const tgts=d.targets||{},pG=+(tgts.protein)||180,fG=+(tgts.fat)||80,sG=+(tgts.sugar)||10;
  document.getElementById('today-protein').textContent=Math.round(tp);document.getElementById('today-fat').textContent=Math.round(tf);document.getElementById('today-sugar').textContent=Math.round(ts);document.getElementById('protein-bar').style.width=Math.min(100,(tp/pG)*100)+'%';document.getElementById('fat-bar').style.width=Math.min(100,(tf/fG)*100)+'%';document.getElementById('sugar-bar').style.width=Math.min(100,(ts/sG)*100)+'%';
  if(tgts.protein)document.getElementById('target-protein').value=tgts.protein;if(tgts.fat)document.getElementById('target-fat').value=tgts.fat;if(tgts.sugar)document.getElementById('target-sugar').value=tgts.sugar;
  let sdClass,sdIcon,sdMsg;if(ts===0){sdClass='sd-clean';sdIcon='✅';sdMsg='No sugar — HGH protected ✓';}else if(ts<=10){sdClass='sd-mild';sdIcon='⚠️';sdMsg=`Sugar: ${Math.round(ts)}g — mild GH suppression`;}else if(ts<=25){sdClass='sd-sig';sdIcon='🔶';sdMsg=`Sugar: ${Math.round(ts)}g — significant GH + cortisol impact`;}else{sdClass='sd-severe';sdIcon='🚨';sdMsg=`Sugar: ${Math.round(ts)}g — severe hormonal suppression`;}
  document.getElementById('sugar-damage-display').innerHTML=`<div class="sugar-damage ${sdClass}"><span class="sd-icon">${sdIcon}</span><span>${sdMsg}</span></div>`;
  const allMeals=[...d.meals].reverse().slice(0,15);document.getElementById('meal-history').innerHTML=allMeals.length?allMeals.map(m=>`<div class="history-item"><span class="history-date">${m.date}</span><div style="flex:1"><div style="font-size:13px;font-weight:600">${m.name||'Meal'}</div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono)">P:${m.protein||0}g F:${m.fat||0}g S:${m.sugar||0}g</div></div>${+m.sugar>0?`<span class="tag red">${m.sugar}g</span>`:''}</div>`).join(''):'<div style="text-align:center;color:var(--muted);font-size:13px;padding:10px 0;font-family:var(--font-mono)">No meals logged</div>';
}

export function logMeal(){const d=db();d.meals.push({name:document.getElementById('meal-name').value,protein:document.getElementById('meal-protein').value||0,fat:document.getElementById('meal-fat').value||0,carbs:document.getElementById('meal-carbs').value||0,sugar:document.getElementById('meal-sugar').value||0,date:document.getElementById('meal-date').value||today()});save(d);alert('Meal logged!');renderHome();renderDiet();}
