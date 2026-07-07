// Notification chime, synthesized with the Web Audio API — no bundled asset, no
// network, no decode. Each note is a soft bell voice (a fundamental plus two
// quiet near-harmonic partials, gentle attack, long decay) sent through a
// lowpass filter for a warm, mellow tone. Two short two-note motifs so the ear
// can tell the events apart without looking:
//   - "done":      a low, resolved ascending pair (a turn finished).
//   - "attention": a soft descending pair (input needed).
//
// Kept deliberately tiny and self-contained; this fits the project's "fast and
// very optimized" principle better than shipping and decoding an audio file.
//
// ── Reliability: a FRESH AudioContext per play ──────────────────────────────
// WKWebView (Tauri's macOS webview) shares the system audio unit. When another
// app or an HTML5 <video> grabs and reconfigures audio — the user "launches a
// video on the side" — a LONG-LIVED AudioContext can become permanently silent:
// its `state` keeps reading "running" while nothing reaches the speakers, and
// resume() does NOT revive it. There is no JS signal for "running but silent",
// so a stale context can't be detected and repaired in place. The robust fix is
// to never keep one around: every chime builds a NEW AudioContext (binding to
// whatever audio configuration is current), plays, then close()s it to release
// the audio unit. This is what makes the chime — and the Settings "Tester"
// button — work every time, even after other audio has played.

function contextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

// Contexts we've opened and not yet closed, each tagged with the wall-clock time
// (performance.now()) its chime is expected to have fully decayed. Each play
// self-closes after its chime decays, but we also cap the set: a burst of plays
// must never exhaust WKWebView's per-document AudioContext limit (~4–6), after
// which construction throws. When at the cap we evict the context CLOSEST TO DONE
// (smallest endsAt) — an already-silent or nearly-decayed one — so a chime that is
// still audibly ringing is never cut off (a fleet burst of ≥5 near-simultaneous
// completions used to truncate the oldest-OPENED one, which may still be sounding).
type LiveContext = { ac: AudioContext; endsAt: number };
const live: LiveContext[] = [];
const MAX_LIVE = 4;

function closeContext(ac: AudioContext): void {
  const i = live.findIndex((l) => l.ac === ac);
  if (i !== -1) live.splice(i, 1);
  try {
    if (ac.state === "closed") return;
    // Spec: close() returns a Promise. Older WebKit returns undefined. Handle
    // both, and swallow any rejection so a failed close never bubbles up.
    const r = ac.close() as Promise<void> | undefined;
    if (r && typeof r.then === "function") r.catch(() => {});
  } catch {
    /* already closing/closed, or a fake context in tests — nothing to free */
  }
}

/** Evict the live context closest to finishing, so a still-ringing chime is never cut. */
function evictClosestToDone(): void {
  let idx = 0;
  for (let i = 1; i < live.length; i++) {
    if (live[i].endsAt < live[idx].endsAt) idx = i;
  }
  closeContext(live[idx].ac);
}

/** Build a fresh AudioContext, evicting the one closest to done if we've hit the cap. */
function newContext(): AudioContext | null {
  const Ctor = contextCtor();
  if (!Ctor) return null;
  while (live.length >= MAX_LIVE) evictClosestToDone();
  let ac: AudioContext;
  try {
    ac = new Ctor();
  } catch {
    return null; // construction can throw if the limit is somehow still hit
  }
  // endsAt is set once scheduleChime knows the decay time; until then treat it as
  // far-off so a not-yet-playing context isn't evicted ahead of a decaying one.
  live.push({ ac, endsAt: Number.POSITIVE_INFINITY });
  return ac;
}

/** A single soft bell-like voice at `freq`, starting at `start`s for `dur`s. */
function bell(
  ac: AudioContext,
  out: AudioNode,
  freq: number,
  start: number,
  dur: number,
  gain: number,
): void {
  // Near-harmonic partials, kept quiet, for a round/woody tone rather than a
  // bright clang. The lowpass on the master (see scheduleChime) tames them further.
  const partials: Array<[mult: number, g: number]> = [
    [1, 1],
    [2, 0.18],
    [3, 0.05],
  ];
  for (const [mult, g] of partials) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(gain * g, start + 0.04); // gentle, non-percussive attack
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur); // long, soft decay
    osc.connect(env);
    env.connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }
}

// Whether the first-gesture warm-up listener has been installed (idempotent).
let primed = false;

/**
 * Warm up audio permission on the first user gesture. WebKit forbids audio until
 * the document has seen a gesture; a chime fired while the app is in the
 * background (an agent finishing unfocused) has no gesture of its own. So on the
 * first click/keypress we build a throwaway context, resume it (which flips the
 * document to "audio allowed" for the rest of its life), then close it — the
 * per-play contexts created later are then free to run without a gesture.
 * Idempotent; safe to call from a React effect that may run twice.
 */
export function primeAudioUnlock(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const warm = () => {
    window.removeEventListener("pointerdown", warm);
    window.removeEventListener("keydown", warm);
    const ac = newContext();
    if (!ac) return;
    // Resume within the gesture to satisfy the autoplay policy, then release the
    // unit — the "audio allowed" grant survives the close().
    Promise.resolve(ac.state === "running" ? undefined : ac.resume())
      .catch(() => {})
      .finally(() => closeContext(ac));
  };
  window.addEventListener("pointerdown", warm);
  window.addEventListener("keydown", warm);
}

export type ChimeKind = "done" | "attention";

/**
 * Play the notification chime for `kind`. No-op when Web Audio is unavailable.
 *
 * A fresh AudioContext is built for every call (see the file header) so a stale,
 * silently-broken context from an earlier audio-session change can never carry
 * over. WKWebView can hand back that fresh context `suspended` (before any
 * gesture) or `interrupted` (iOS/Safari), and `resume()` is ASYNC — scheduling
 * oscillators on a context whose clock isn't advancing silently drops the sound.
 * So we resume FIRST and lay the notes down only once the context is running.
 */
export function playChime(kind: ChimeKind): void {
  const ac = newContext();
  if (!ac) return;
  if (ac.state === "running") {
    // Guard symmetrically with the suspended branch below: if node construction
    // throws on a context that reads "running" but whose audio unit was just
    // reconfigured, free it rather than leak it + throw out of playChime.
    try {
      scheduleChime(ac, kind);
    } catch {
      closeContext(ac);
    }
    return;
  }
  // Suspended or "interrupted": wait for the resume to land, then schedule on the
  // now-advancing clock. If resume rejects (e.g. no user gesture yet) we still
  // attempt to schedule — worst case a no-op, never a throw.
  ac.resume()
    .then(() => scheduleChime(ac, kind))
    .catch((e) => {
      // resume() rejected (e.g. no user gesture yet) OR scheduling threw because the
      // context became unusable. Retry best-effort, then swallow: a dropped chime
      // must NEVER surface as an unhandled promise rejection (this runs in a
      // microtask, past the caller's guard). Close the dead context either way.
      console.error("audio chime failed:", e);
      try {
        scheduleChime(ac, kind);
      } catch {
        closeContext(ac); // context unusable — free it and give up silently
      }
    });
}

/** Lay down the two-note chime for `kind`, then close the context once it decays. */
function scheduleChime(ac: AudioContext, kind: ChimeKind): void {
  // Soft master level + a lowpass filter that rolls off the highs, so the chime
  // is warm and gentle rather than sharp. A short fade-in on the cutoff keeps
  // even the attack from sounding edgy.
  const master = ac.createGain();
  master.gain.value = 0.26;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1500;
  lp.Q.value = 0.5;
  master.connect(lp);
  lp.connect(ac.destination);

  const t = ac.currentTime + 0.02;
  let end: number;
  if (kind === "done") {
    // C5 → G5: a low, warm, resolved ascending fifth — slow and unhurried.
    bell(ac, master, 523.25, t, 1.0, 0.26);
    bell(ac, master, 783.99, t + 0.18, 1.2, 0.24);
    end = t + 0.18 + 1.2;
  } else {
    // A5 → E5: a soft descending two-note, still noticeable but mellow.
    bell(ac, master, 880.0, t, 0.85, 0.26);
    bell(ac, master, 659.25, t + 0.18, 1.15, 0.24);
    end = t + 0.18 + 1.15;
  }

  // Once the sound has fully decayed, close the whole context — this is the
  // single-use lifecycle that keeps every play on a fresh audio unit. Closing
  // tears down the master + filter + oscillators in one shot, so no dangling
  // node accumulates and the audio unit is handed back to the OS.
  const ms = Math.max(0, (end + 0.15 - ac.currentTime) * 1000);
  // Record when this context goes silent so eviction can prefer the one closest
  // to done (see evictClosestToDone) rather than cutting off a still-ringing chime.
  const entry = live.find((l) => l.ac === ac);
  if (entry) entry.endsAt = performance.now() + ms;
  setTimeout(() => closeContext(ac), ms);
}
