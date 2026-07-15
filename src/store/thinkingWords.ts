// The playful "Thinking…" replacement. When the agent sits in its most generic working
// state — the last-resort "Thinking…" of describeActivity, i.e. no tool in flight, no active
// to-do, not streaming a reply — we show a fancier gerund in place of the plain word, the way
// the CLI cycles playful verbs. ONLY this one label is affected; every other activity string
// (tools, to-dos, "Writing a reply…") is untouched.
//
// The word climbs difficulty TIERS driven by the CUMULATIVE thinking time of the whole
// discussion (sum of every thinking block's duration, plus the one in flight): the longer &
// deeper the conversation has reasoned, the fancier the vocabulary — the ridiculous words are
// the signature of a long, deep session. Within the current tier a word is drawn (deterministic
// per rotation slot) and rotates every ROTATE_MS of cumulative thinking AND on every new turn.
// The first ANCHOR_MS of cumulative thinking always shows the literal "Thinking" anchor.
//
// All pure & deterministic (no Math.random / Date.now) so the label is stable within a slot and
// unit-testable; the React hook `useActivityLabel` feeds it live cumulative time via `useNow`.

/** The literal word shown for the first {@link ANCHOR_MS} of cumulative thinking. */
export const THINKING_ANCHOR = "Thinking";

/**
 * Difficulty tiers, easy → ridiculous. Every word is a real (or knowingly silly) gerund ending
 * in "-ing"; the themes are laziness, board sports (wing/kite foiling, windsurf), guessing games
 * (GeoGuessr, Cemantix, Pédantix) and dev in-jokes. A couple of late ones (`Jetpunking`,
 * `Kerjojoing`) are pure nonsense on purpose.
 */
export const THINKING_TIERS: readonly (readonly string[])[] = [
  // Tier 1 — easy + light laziness + simple sports
  ["Thinking", "Pondering", "Musing", "Wondering", "Mulling", "Brooding",
   "Reckoning", "Percolating", "Marinating", "Dawdling", "Lounging", "Idling",
   "Napping", "Dozing", "Snoozing", "Slacking", "Guessing", "Floating",
   "Winging", "Foiling", "Riding", "Swimming", "Serving"],
  // Tier 2 — medium + nods to our hobbies + assumed laziness
  ["Ruminating", "Cogitating", "Meditating", "Speculating", "Deliberating",
   "Contemplating", "Geoguessing", "Debugging", "Caffeinating", "Dogfooding",
   "Globetrotting", "Compiling", "Procrastinating", "Daydreaming", "Twiddling",
   "Meandering", "Puttering", "Faffing", "Cemantixing", "Improvising",
   "Moonwalking", "Volleying", "Windsurfing", "Kitesurfing", "Smashing"],
  // Tier 3 — hard + dev humour + distinguished laziness
  ["Extrapolating", "Hypothesizing", "Theorizing", "Philosophizing",
   "Conceptualizing", "Prognosticating", "Pontificating", "Triangulating",
   "Refactoring", "Bikeshedding", "Yak-shaving", "Overthinking",
   "Overengineering", "Lollygagging", "Gallivanting", "Woolgathering",
   "Pedantixing", "Wing-foiling", "Kite-foiling"],
  // Tier 4 — ridiculous scholarly words + aristocratic laziness
  ["Excogitating", "Cerebrating", "Ratiocinating", "Confabulating",
   "Perambulating", "Peregrinating", "Circumnavigating", "Anthropomorphizing",
   "Prestidigitating", "Discombobulating", "Transmogrifying", "Malingering",
   "Vegetating", "Jetpunking", "Kerjojoing"],
];

/** Cumulative thinking below this always shows the literal "Thinking" anchor. */
export const ANCHOR_MS = 40_000; // 40 s
/**
 * Upper edges (cumulative thinking, ms) of tiers 1/2/3 — tier 4 is everything above the last.
 * 40 s–2 min → tier 1 · 2–6 min → tier 2 · 6–15 min → tier 3 · 15 min+ → tier 4. Tune here.
 */
export const TIER_BOUNDS_MS = [120_000, 360_000, 900_000];
/** The word re-draws every this-much cumulative thinking (on top of every new turn). */
export const ROTATE_MS = 40_000; // 40 s
/**
 * Max thinking time credited per accrual sample. The spinner clock is sampled by a 500 ms ticker
 * that FREEZES during system sleep while `Date.now()` keeps advancing; without a cap the first
 * sample after wake would credit the whole sleep gap (hours) and pin the word to the top tier.
 * Capping each sample bounds that to a couple of ticks while a genuine long think — sampled every
 * 500 ms — still accrues in full. NOT turbo-scaled (it's a wall-clock sampling guard, not a tier).
 */
export const THINKING_ACCRUAL_CAP_MS = 2_000;

/**
 * Rotation pools = the tiers, but tier 1 drops its leading "Thinking" (that word is reserved for
 * the anchor, so past the anchor the label always visibly differs from the plain word).
 */
const ROTATION_TIERS: readonly (readonly string[])[] = THINKING_TIERS.map((pool, i) =>
  i === 0 ? pool.slice(1) : pool,
);

/** 1-based difficulty tier for a cumulative thinking time (assumes ms ≥ {@link ANCHOR_MS}). */
export function tierForThinkingMs(ms: number): number {
  let tier = 1;
  for (const bound of TIER_BOUNDS_MS) if (ms >= bound) tier++;
  return tier; // 1..4 (capped by the number of bounds)
}

/** FNV-1a hash of a string → uint32. Deterministic word choice without Math.random. */
function hashInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The playful word for the given cumulative thinking time. `turnCount` and the ROTATE_MS bucket
 * form the rotation slot (word changes on either), `seed` (the conversation id) gives per-conv
 * variety. Below {@link ANCHOR_MS} → the literal anchor. Tier is folded into the slot so a tier
 * boundary flips the word immediately, not only at the next 40 s bucket.
 */
export function thinkingWord(cumulativeMs: number, turnCount: number, seed: string): string {
  if (cumulativeMs < ANCHOR_MS) return THINKING_ANCHOR;
  const tier = tierForThinkingMs(cumulativeMs);
  const pool = ROTATION_TIERS[tier - 1];
  const bucket = Math.floor(cumulativeMs / ROTATE_MS);
  const idx = hashInt(`${seed}|${turnCount}|${tier}|${bucket}`) % pool.length;
  return pool[idx];
}
