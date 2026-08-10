// ---------------------------------------------------------------------------
// schedule.js — SCHEDULE, PROGRESSION, PROGRAM_START constants.
//
// Brian Alsruhe 12-Week Strength & Conditioning Program.
// Pure data plus the day->session lookup. No rendering, no storage.
// Moved verbatim from index.html. No values changed.
// ---------------------------------------------------------------------------

// PROGRAM_START is a code constant, not stored data. Edit this one line to
// re-baseline the 12-week cycle. Must be the Monday the program begins.
export const PROGRAM_START='2026-08-03';

export const PROGRESSION=[
  {week:1, phase:'Wave 1: Hypertrophy',  setsReps:'4 sets x 8 reps',              pct:65, rest:'90 sec',  objective:'Work capacity & volume'},
  {week:2, phase:'Wave 1: Hypertrophy',  setsReps:'4 sets x 8 reps',              pct:70, rest:'90 sec',  objective:'Work capacity & volume'},
  {week:3, phase:'Wave 1: Hypertrophy',  setsReps:'4 sets x 6 reps',              pct:75, rest:'90 sec',  objective:'Peak volume load'},
  {week:4, phase:'Deload',               setsReps:'3 sets x 6 reps',              pct:50, rest:'120 sec', objective:'Deload / Technique focus'},
  {week:5, phase:'Wave 2: Strength',     setsReps:'4 sets x 5 reps',              pct:75, rest:'120 sec', objective:'Strength base building'},
  {week:6, phase:'Wave 2: Strength',     setsReps:'4 sets x 5 reps',              pct:80, rest:'120 sec', objective:'Strength intensification'},
  {week:7, phase:'Wave 2: Strength',     setsReps:'4 sets x 3 reps',              pct:85, rest:'120 sec', objective:'Heavy strength density'},
  {week:8, phase:'Deload',               setsReps:'3 sets x 5 reps',              pct:55, rest:'120 sec', objective:'Deload / Joint recovery'},
  {week:9, phase:'Wave 3: Realization',  setsReps:'3x3 @ 80%, 1x3+ (AMRAP)',      pct:85, rest:'150 sec', objective:'High intensity effort'},
  {week:10,phase:'Wave 3: Realization',  setsReps:'3x2 @ 85%, 1x2+ (AMRAP)',      pct:90, rest:'150 sec', objective:'High intensity effort'},
  {week:11,phase:'Wave 3: Realization',  setsReps:'2x1 @ 90%, 1x1+ (AMRAP)',      pct:95, rest:'180 sec', objective:'Peak strength output'},
  {week:12,phase:'Test / Reset',         setsReps:'Work to safe 1RM or 3x3',      pct:60, rest:'Flexible',objective:'Re-test baselines or deload'}
];

// Days 4 & 5 are dynamic/speed days: flat 60-70% TM across all 12 weeks.
export const SPEED_PCT=[60,70];

// NOTE: the per-day `fastLabel` strings below describe the OLD fasting protocol
// (18:6 daily, 36hr Fri–Sun) and are NO LONGER READ. The protocol moved to
// fastPlan() in derive.js (§7) because the 48hr deload depends on the program
// week, which a static per-weekday string cannot express. Left in place rather
// than deleted so this data file keeps one shape; do not wire them back up.
export const SCHEDULE={
  1:{session:'Max Effort Lower (Squat)',category:'Resistance',fastLabel:'18:6 window',tmKey:'tm_squat',mainLift:'Barbell Back Squat',exercises:[
    {name:'Goblet Squat',equip:'Kettlebell / dumbbell',detail:'x 10 reps · 3-second pause at bottom',block:'Warm-Up — 2 Rounds'},
    {name:'Hanging Leg Raise',equip:'Pull-up bar',detail:'x 10 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Kettlebell / Steel Mace Swing',equip:'Kettlebell or mace',detail:'x 15 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Broad Jump',equip:'Bodyweight — explosive',detail:'x 3 reps (or Box Jump x 3)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Barbell Back Squat',equip:'Barbell — main lift',detail:'Refer to progression matrix',block:'Main Strength Giant Set — 4 Sets',main:true},
    {name:'Ab Wheel Rollout',equip:'Ab wheel — core',detail:'x 8–10 reps (or Hanging Toes-to-Bar)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Jump Rope',equip:'Active rest',detail:'x 45 seconds (or light kettlebell swings)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Barbell Romanian Deadlift',equip:'Barbell',detail:'x 8–10 reps (or Zercher Good Mornings)',block:'Assistance Block — 3 Rounds'},
    {name:'Bulgarian Split Squat',equip:'Dumbbells + bench',detail:'x 10 reps per leg (or Walking Lunges)',block:'Assistance Block — 3 Rounds'},
    {name:'Heavy Plank Hold',equip:'Weight plate optional',detail:'x 45 seconds · rest 90 sec between rounds',block:'Assistance Block — 3 Rounds'},
    {name:'Clean & Press',equip:'Kettlebell / dumbbell',detail:'5 reps every minute',block:'Conditioning Finisher — 10-Min EMOM'},
    {name:'Burpees',equip:'Bodyweight',detail:'8–10 reps every minute · rest remainder of minute',block:'Conditioning Finisher — 10-Min EMOM'}
  ]},
  2:{session:'Max Effort Upper (OHP)',category:'Resistance',fastLabel:'18:6 window',tmKey:'tm_ohp',mainLift:'Overhead Barbell Press',exercises:[
    {name:'Band Pull-Apart',equip:'Resistance band',detail:'x 20 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Scapular Pull-up',equip:'Pull-up bar',detail:'x 10 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Bear Crawl',equip:'Bodyweight',detail:'x 50 feet',block:'Warm-Up — 2 Rounds'},
    {name:'Weighted Pull-Up',equip:'Antagonist',detail:'x 5–8 reps (or heavy lat pulldown)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Overhead Barbell Press',equip:'Barbell — main lift',detail:'Refer to progression matrix',block:'Main Strength Giant Set — 4 Sets',main:true},
    {name:'Dragon Flag',equip:'Bench — core',detail:'x 8–10 reps (or heavy hanging knee raises)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Battle Ropes',equip:'Active rest',detail:'x 45 seconds (or shadow boxing)',block:'Main Strength Giant Set — 4 Sets'},
    {name:'Incline Dumbbell Bench Press',equip:'Dumbbells + incline bench',detail:'x 10–12 reps',block:'Assistance Giant Set — 3 Rounds'},
    {name:'Bent-Over Barbell Row',equip:'Barbell',detail:'x 10–12 reps (or T-Bar Row)',block:'Assistance Giant Set — 3 Rounds'},
    {name:'Half-Kneeling Bottoms-Up Press',equip:'Kettlebell',detail:'x 8 reps per side',block:'Assistance Giant Set — 3 Rounds'},
    {name:'Face Pull',equip:'Cable / band',detail:'x 15–20 reps · rest 90 sec between rounds',block:'Assistance Giant Set — 3 Rounds'},
    {name:'Dumbbell Thruster',equip:'Dumbbells',detail:'x 10 reps',block:'Conditioning Finisher — 8-Min AMRAP'},
    {name:'Push-up',equip:'Bodyweight',detail:'x 10 reps',block:'Conditioning Finisher — 8-Min AMRAP'},
    {name:'Ring Row',equip:'Rings / bar',detail:'x 10 reps (or inverted rows)',block:'Conditioning Finisher — 8-Min AMRAP'}
  ]},
  3:{session:'Active Recovery / Zone 2',category:'Zone 2',fastLabel:'18:6 window',exercises:[
    {name:'Steady-State Zone 2',equip:'Ruck / row / bike / incline walk',detail:'30–45 min · conversational pace, no gasping',block:'Aerobic Base'},
    {name:"World's Greatest Stretch",equip:'Bodyweight',detail:'x 5 reps per side',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Couch Stretch',equip:'Wall / bench',detail:'x 60 seconds per side',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Deep Squat Pry',equip:'Bodyweight',detail:'x 2 minutes',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Dead Hang',equip:'Pull-up bar',detail:'x max time',block:'Core & Grip — 3 Sets'},
    {name:'Suitcase Hold',equip:'Heavy dumbbell / kettlebell',detail:'x 45 seconds per side',block:'Core & Grip — 3 Sets'}
  ]},
  4:{session:'Dynamic Speed Lower (Deadlift)',category:'Resistance',fastLabel:'18:6 window',tmKey:'tm_dl',mainLift:'Deadlift',speed:true,speedSetsReps:'5 sets x 3 reps',exercises:[
    {name:'Single-Leg Glute Bridge',equip:'Bodyweight',detail:'x 10 reps per side',block:'Warm-Up — 2 Rounds'},
    {name:'Band Good Morning',equip:'Resistance band',detail:'x 15 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Birddog',equip:'Bodyweight',detail:'x 8 reps per side',block:'Warm-Up — 2 Rounds'},
    {name:'Kettlebell Snatch',equip:'Kettlebell — explosive',detail:'x 5 reps (or kettlebell swings)',block:'Speed Giant Set — 5 Sets'},
    {name:'Deadlift',equip:'Barbell — main lift',detail:'Focus on maximal bar speed',block:'Speed Giant Set — 5 Sets',main:true},
    {name:'Landmine Twist',equip:'Barbell anchored — core',detail:'x 8 reps per side (or heavy Pallof press)',block:'Speed Giant Set — 5 Sets'},
    {name:'Jumping Jacks',equip:'Active rest',detail:'x 45 seconds (or A-skips) · rest 90 sec after',block:'Speed Giant Set — 5 Sets'},
    {name:'Safety Squat Bar Squat',equip:'SSB or goblet front squat',detail:'x 10–12 reps',block:'Volume Triplet — 3 Rounds'},
    {name:'Hamstring Curl',equip:'Band or machine',detail:'x 15 reps',block:'Volume Triplet — 3 Rounds'},
    {name:'Heavy Farmers Carry',equip:'Dumbbells / handles',detail:'x 100 feet · rest 90 sec between rounds',block:'Volume Triplet — 3 Rounds'},
    {name:'Death by Kettlebell Swings',equip:'Kettlebell',detail:'Min 1: 10 swings, +2 reps every minute until failure',block:'Conditioning Finisher'}
  ]},
  5:{session:'Dynamic Speed Upper (Bench)',category:'Resistance',fastLabel:'18:6 / fast begins after dinner',tmKey:'tm_bench',mainLift:'Barbell Bench Press',speed:true,speedSetsReps:'5 sets x 3–5 reps',exercises:[
    {name:'Push-up to Downward Dog',equip:'Bodyweight',detail:'x 8 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Cuban Rotation',equip:'Light dumbbells',detail:'x 12 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Band Dislocate',equip:'Resistance band',detail:'x 15 reps',block:'Warm-Up — 2 Rounds'},
    {name:'Chest-Supported Dumbbell Row',equip:'Antagonist',detail:'x 8 reps',block:'Speed Giant Set — 5 Sets'},
    {name:'Barbell Bench Press',equip:'Barbell — main lift',detail:'Focus on maximal bar speed',block:'Speed Giant Set — 5 Sets',main:true},
    {name:'Ab Mat Sit-up w/ Plate',equip:'Weight plate overhead — core',detail:'x 12 reps',block:'Speed Giant Set — 5 Sets'},
    {name:'Row / SkiErg',equip:'Active rest',detail:'x 10 reps (or medicine ball slams) · rest 90 sec after',block:'Speed Giant Set — 5 Sets'},
    {name:'Standing Dumbbell Overhead Press',equip:'Dumbbells',detail:'x 10–12 reps',block:'Volume Triplet — 3 Rounds'},
    {name:'Chin-up',equip:'Pull-up bar',detail:'x max reps (or band-assisted to 10)',block:'Volume Triplet — 3 Rounds'},
    {name:'Dips',equip:'Parallel bars',detail:'x 10–12 reps · rest 90 sec between rounds',block:'Volume Triplet — 3 Rounds'},
    {name:'Alternating Dumbbell Snatch',equip:'Dumbbell',detail:'50 reps',block:'Conditioning Finisher — 10-Min Chipper'},
    {name:'Hand-Release Push-up',equip:'Bodyweight',detail:'40 reps',block:'Conditioning Finisher — 10-Min Chipper'},
    {name:'Dumbbell Goblet Squat',equip:'Dumbbell',detail:'30 reps',block:'Conditioning Finisher — 10-Min Chipper'},
    {name:'Burpee Over Dumbbell',equip:'Bodyweight + dumbbell',detail:'20 reps · for time',block:'Conditioning Finisher — 10-Min Chipper'}
  ]},
  6:{session:'Strongman / GPP Carries',category:'Bodyweight',fastLabel:'Fast active (hrs 12–18)',exercises:[
    {name:'Heavy Farmers Walk',equip:'Dumbbells / handles',detail:'x 100 feet',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Bear-Hug Carry',equip:'Sandbag / keg / med-ball',detail:'x 100 feet',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:"Overhead Waiter's Walk",equip:'Kettlebell / dumbbell',detail:'x 50 feet right / 50 feet left',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Sled Push',equip:'Sled or heavy tire',detail:'x 100 feet · rest 2 min after each round',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Side Plank',equip:'Bodyweight',detail:'x 45 seconds per side',block:'Trunk & GPP Finisher — 3 Sets'},
    {name:'Sledgehammer Tire Strikes',equip:'Sledgehammer or steel mace',detail:'x 20 reps per side',block:'Trunk & GPP Finisher — 3 Sets'},
    {name:'Light Sled Drag / Walk',equip:'Sled or bodyweight',detail:'x 5 minutes continuous',block:'Trunk & GPP Finisher — 3 Sets'}
  ]},
  0:{session:'Full Rest',category:'Active Rest',fastLabel:'Fast breaks this morning',exercises:null,rest:true}
};

// Category -> colour lookups used for inline styles on generated markup.
// PRE-EXISTING hex literals, moved verbatim. See report re: ARCHITECTURE.md §1.6.
export const WCOLORS={Resistance:'#7c6af7','Zone 2':'#4fd8c4',Bodyweight:'#f7a46a','Wtd Walk':'#f76a8a',HIIT:'#f76a6a',Mobility:'#6af77c',Other:'#f7c46a','Active Rest':'#6b6b8a'};
export const CATEGORY_COLORS={'Resistance':'rgba(124,106,247,.15)','Zone 2':'rgba(79,216,196,.15)','Bodyweight':'rgba(247,164,106,.15)','Active Rest':'rgba(107,107,138,.1)'};
export const CATEGORY_BORDER={'Resistance':'rgba(124,106,247,.4)','Zone 2':'rgba(79,216,196,.4)','Bodyweight':'rgba(247,164,106,.4)','Active Rest':'rgba(107,107,138,.3)'};
export const CATEGORY_COLOR_TEXT={'Resistance':'var(--accent)','Zone 2':'var(--accent2)','Bodyweight':'var(--accent3)','Active Rest':'var(--muted)'};

export function getScheduleForDate(ds){return SCHEDULE[new Date(ds+'T12:00:00').getDay()]||SCHEDULE[0];}
