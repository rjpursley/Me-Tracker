// ---------------------------------------------------------------------------
// schedule.js — SCHEDULE, PROGRESSION, PROGRAM_START constants.
//
// Brian Alsruhe 12-Week Strength & Conditioning Program.
// Pure data plus the day->session lookup. No rendering, no storage.
// Moved verbatim from index.html. No values changed.
// ---------------------------------------------------------------------------

// PROGRAM_START is a code constant, not stored data. It is NO LONGER read as
// "the" program start date — that is now d.programStart, set by tapping Start
// on the Training page (ARCHITECTURE.md §9.0). This constant's only remaining
// job is a last-resort fallback inside derive.js's programWeek() if a stored
// programStart value is present but malformed, so that function still cannot
// throw. Do not delete it, and do not read it as a semantic start date again.
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

// NO fastLabel FIELD HERE. A per-weekday `fastLabel` string used to describe
// the fasting protocol (18:6 daily, 36hr Fri–Sun) and was removed once that
// protocol changed: the current one (§7) has a 48hr deload that depends on the
// program week, which a static per-weekday string cannot express. It moved to
// fastPlan() in derive.js. Removed rather than left as dead data with a
// deprecation marker, so there is nothing here for a future session to
// mistake for the current protocol. See ARCHITECTURE.md §7 for what runs now.
export const SCHEDULE={
  1:{session:'Max Effort Lower (Squat)',category:'Resistance',tmKey:'tm_squat',mainLift:'Barbell Back Squat',exercises:[
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
  2:{session:'Max Effort Upper (OHP)',category:'Resistance',tmKey:'tm_ohp',mainLift:'Overhead Barbell Press',exercises:[
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
  3:{session:'Active Recovery / Zone 2',category:'Zone 2',exercises:[
    {name:'Steady-State Zone 2',equip:'Ruck / row / bike / incline walk',detail:'30–45 min · conversational pace, no gasping',block:'Aerobic Base'},
    {name:"World's Greatest Stretch",equip:'Bodyweight',detail:'x 5 reps per side',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Couch Stretch',equip:'Wall / bench',detail:'x 60 seconds per side',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Deep Squat Pry',equip:'Bodyweight',detail:'x 2 minutes',block:'Mobility & Thoracic Flow — 15 Min'},
    {name:'Dead Hang',equip:'Pull-up bar',detail:'x max time',block:'Core & Grip — 3 Sets'},
    {name:'Suitcase Hold',equip:'Heavy dumbbell / kettlebell',detail:'x 45 seconds per side',block:'Core & Grip — 3 Sets'}
  ]},
  4:{session:'Dynamic Speed Lower (Deadlift)',category:'Resistance',tmKey:'tm_dl',mainLift:'Deadlift',speed:true,speedSetsReps:'5 sets x 3 reps',exercises:[
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
  5:{session:'Dynamic Speed Upper (Bench)',category:'Resistance',tmKey:'tm_bench',mainLift:'Barbell Bench Press',speed:true,speedSetsReps:'5 sets x 3–5 reps',exercises:[
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
  6:{session:'Strongman / GPP Carries',category:'Bodyweight',exercises:[
    {name:'Heavy Farmers Walk',equip:'Dumbbells / handles',detail:'x 100 feet',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Bear-Hug Carry',equip:'Sandbag / keg / med-ball',detail:'x 100 feet',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:"Overhead Waiter's Walk",equip:'Kettlebell / dumbbell',detail:'x 50 feet right / 50 feet left',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Sled Push',equip:'Sled or heavy tire',detail:'x 100 feet · rest 2 min after each round',block:'Loaded Carry Circuit — 4 Rounds'},
    {name:'Side Plank',equip:'Bodyweight',detail:'x 45 seconds per side',block:'Trunk & GPP Finisher — 3 Sets'},
    {name:'Sledgehammer Tire Strikes',equip:'Sledgehammer or steel mace',detail:'x 20 reps per side',block:'Trunk & GPP Finisher — 3 Sets'},
    {name:'Light Sled Drag / Walk',equip:'Sled or bodyweight',detail:'x 5 minutes continuous',block:'Trunk & GPP Finisher — 3 Sets'}
  ]},
  0:{session:'Full Rest',category:'Active Rest',exercises:null,rest:true}
};

// Category -> colour lookups used for inline styles on generated markup.
// PRE-EXISTING hex literals, moved verbatim. See report re: ARCHITECTURE.md §1.6.
export const WCOLORS={Resistance:'#7c6af7','Zone 2':'#4fd8c4',Bodyweight:'#f7a46a','Wtd Walk':'#f76a8a',HIIT:'#f76a6a',Mobility:'#6af77c',Other:'#f7c46a','Active Rest':'#6b6b8a'};
export const CATEGORY_COLORS={'Resistance':'rgba(124,106,247,.15)','Zone 2':'rgba(79,216,196,.15)','Bodyweight':'rgba(247,164,106,.15)','Active Rest':'rgba(107,107,138,.1)'};
export const CATEGORY_BORDER={'Resistance':'rgba(124,106,247,.4)','Zone 2':'rgba(79,216,196,.4)','Bodyweight':'rgba(247,164,106,.4)','Active Rest':'rgba(107,107,138,.3)'};
export const CATEGORY_COLOR_TEXT={'Resistance':'var(--accent)','Zone 2':'var(--accent2)','Bodyweight':'var(--accent3)','Active Rest':'var(--muted)'};

export function getScheduleForDate(ds){return SCHEDULE[new Date(ds+'T12:00:00').getDay()]||SCHEDULE[0];}

// ---------------------------------------------------------------------------
// HOME_SCHEDULE — the interim home routine, ARCHITECTURE.md §9.0.
//
// Ryan trains at home until the gym (and Alsruhe) opens. Active ONLY while
// the Alsruhe program has not been started — see isProgramStarted() and
// getActiveScheduleForDate() in derive.js, which is where the Alsruhe-vs-home
// routing decision actually lives. This file stays "pure data plus the
// day->session lookup" for both schedules; it does not know which one is
// currently in effect.
//
// FIXED LOADS, NOT PERCENTAGES. No tmKey, no mainLift, no exercise carries
// `main:true`. These exercises must never be routed through trainingMax() /
// mainLiftRx() — the whole point of a fixed sandbag/kettlebell/gada routine is
// that the load does not move with a Training Max that does not exist for it.
//
// Same {name, equip, detail, block} shape as SCHEDULE, so it goes through the
// exact same prescription card, checkbox storage (d.exerciseLogs, by name)
// and scoring (calcTrainingScore) with no special-casing.
//
// Source: "Simple Workout Routine.rtf" in the repo root. Equipment on hand:
// 65lb heavy sandbag, ~42-45lb medium sandbag, 50lb kettlebell, 10-25lb gada
// club, pull-up bar.
//
// When Alsruhe starts, the app switches to it (getActiveScheduleForDate()).
// This stays in the code for later reuse — do not delete it once Alsruhe is
// running.
// ---------------------------------------------------------------------------
export const HOME_SCHEDULE={
  1:{session:'Upper Pull & Horizontal Push',category:'Bodyweight',exercises:[
    {name:'Strict Pull-Ups',equip:'Bodyweight',detail:'4 sets x 6–10 reps · Pause at the top',block:'Upper Pull & Horizontal Push'},
    {name:'Heavy Sandbag Floor Press',equip:'65 lb Sandbag',detail:'4 sets x 8–12 reps · Lie on floor, press bag from chest — great chest/triceps burner',block:'Upper Pull & Horizontal Push'},
    {name:'Kettlebell Single-Arm Row',equip:'50 lb Kettlebell',detail:'3 sets x 8–10 reps per side · Brace on a bench/chair, draw elbow to hip',block:'Upper Pull & Horizontal Push'},
    {name:'Feet-Elevated Push-Ups',equip:'Bodyweight',detail:'3 sets x 12–15 reps · Feet on a chair/couch for upper chest emphasis',block:'Upper Pull & Horizontal Push'},
    {name:'Gada 360s or Casts',equip:'10–25 lb Gada Club',detail:'3 sets x 10–12 reps per direction · Smooth rotational shoulder control and grip endurance',block:'Upper Pull & Horizontal Push'}
  ]},
  2:{session:'Lower & Posterior Chain',category:'Bodyweight',exercises:[
    {name:'Sandbag Bear-Hug Squats',equip:'65 lb Sandbag',detail:'4 sets x 8–12 reps · Hug bag high and tight; squat below parallel',block:'Lower & Posterior Chain'},
    {name:'Kettlebell Single-Leg RDL',equip:'50 lb Kettlebell',detail:'4 sets x 8–10 reps per leg · Hinge at hips; maintain flat back and stable stance',block:'Lower & Posterior Chain'},
    {name:'Sandbag Zercher Reverse Lunges',equip:'42 lb Sandbag',detail:'3 sets x 8 reps per leg · Hold bag in crook of elbows; step backward',block:'Lower & Posterior Chain'},
    {name:'Kettlebell Swings',equip:'50 lb Kettlebell',detail:'3 sets x 15–20 reps · Explosive hip snap; lock out glutes at top',block:'Lower & Posterior Chain'},
    {name:'Hanging Leg/Knee Raises',equip:'Pull-up Bar',detail:'3 sets x 10–12 reps · Squeeze abs at top without swinging',block:'Lower & Posterior Chain'}
  ]},
  3:{session:'Active Recovery',category:'Active Rest',exercises:[
    {name:'Light Walking',equip:'Bodyweight',detail:'15–20 min · easy, conversational pace',block:'Active Recovery'},
    {name:'Light Gada Swings',equip:'10–25 lb Gada Club',detail:'Easy pace · shoulder mobility',block:'Active Recovery'},
    {name:'Thoracic Spine Stretches',equip:'Bodyweight',detail:'As needed',block:'Active Recovery'}
  ]},
  4:{session:'Upper Overhead & Vertical',category:'Bodyweight',exercises:[
    {name:'Sandbag Strict Overhead Press',equip:'42 lb Sandbag',detail:'4 sets x 6–8 reps · Brace core and press overhead without arching low back',block:'Upper Overhead & Vertical'},
    {name:'Chin-Ups',equip:'Pull-up Bar',detail:'4 sets x 6–10 reps · Underhand grip; focus on biceps and lower lats',block:'Upper Overhead & Vertical'},
    {name:'Pike Push-Ups',equip:'Bodyweight',detail:'3 sets x 8–12 reps · Feet elevated or flat on floor to target shoulders',block:'Upper Overhead & Vertical'},
    {name:'Kettlebell Bottoms-Up Clean & Press',equip:'50 lb Kettlebell',detail:'3 sets x 5–6 reps per arm · Builds wrist/shoulder stability and pressing power',block:'Upper Overhead & Vertical'},
    {name:'Hollow Body Hold',equip:'Bodyweight',detail:'3 sets x 45 sec · Press lower back flat into the floor; arms extended',block:'Upper Overhead & Vertical'}
  ]},
  5:{session:'Lower & Conditioning',category:'Bodyweight',exercises:[
    {name:'Sandbag Ground-to-Over-Shoulder',equip:'65 lb Sandbag',detail:'4 sets x 5 reps per shoulder · Explosive hip drive from floor to shoulder',block:'Lower & Conditioning'},
    {name:'Bulgarian Split Squats',equip:'Bodyweight or 50 lb Kettlebell',detail:'3 sets x 10–12 reps per leg · Bodyweight, or hold kettlebell in goblet position',block:'Lower & Conditioning'},
    {name:'Sandbag Bear-Hug Carry',equip:'65 lb Sandbag',detail:'4 sets x 45–60 sec walk · Walk briskly, core braced, posture upright',block:'Lower & Conditioning'},
    {name:'Gada 10-to-2s',equip:'10–25 lb Gada Club',detail:'3 sets x 10 reps per side · Explosive rotational core and upper-back work',block:'Lower & Conditioning'},
    {name:'Plank-to-Push-Up',equip:'Bodyweight',detail:'3 sets x 10–12 reps · Transition from elbows to hands without rocking hips',block:'Lower & Conditioning'}
  ]},
  6:{session:'Rest / Mobility',category:'Active Rest',exercises:null,rest:true},
  0:{session:'Rest / Mobility',category:'Active Rest',exercises:null,rest:true}
};

export function getHomeScheduleForDate(ds){return HOME_SCHEDULE[new Date(ds+'T12:00:00').getDay()]||HOME_SCHEDULE[0];}
