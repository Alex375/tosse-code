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

// One shared AudioContext, created lazily on first use. WKWebView (Tauri's macOS
// webview) may start it suspended until a user gesture; we resume() on every play
// so the "Tester" button (a gesture) always works, and background plays resume a
// context that an earlier gesture already unlocked.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch((e) => console.error("audio resume failed:", e));
  }
  return ctx;
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
  // bright clang. The lowpass on the master (see playChime) tames them further.
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

// Whether the first-gesture unlock listener has been installed (idempotent).
let primed = false;

/**
 * Unlock the AudioContext on the first user gesture. Desktop webviews can start
 * it "suspended"; a chime triggered while the app is in the background (an agent
 * finishing unfocused) has no gesture of its own to resume it, so we create and
 * resume the context eagerly on the first click/keypress. Idempotent; safe to
 * call from a React effect that may run twice.
 */
export function primeAudioUnlock(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const unlock = () => {
    audio(); // creates + resume()s the context within the gesture
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

export type ChimeKind = "done" | "attention";

/**
 * Play the notification chime for `kind`. No-op when Web Audio is unavailable.
 *
 * Reliability: WKWebView (Tauri's macOS webview) can leave the AudioContext
 * `suspended` — before the first user gesture, and again after the app has been
 * backgrounded — and `resume()` is ASYNC. Scheduling oscillators on a context
 * that isn't running yet silently drops the sound (its clock isn't advancing),
 * which was the root cause of the "chime often doesn't fire" bug. So we resume
 * FIRST and only lay down the notes once the context is actually running, on a
 * fresh `currentTime`. If the context is already running we schedule inline.
 */
export function playChime(kind: ChimeKind): void {
  const ac = audio();
  if (!ac) return;
  if (ac.state === "running") {
    scheduleChime(ac, kind);
    return;
  }
  // Suspended (or "interrupted" on iOS/Safari): wait for the resume to land, then
  // schedule on the now-advancing clock. If resume rejects (e.g. no user gesture
  // yet) we still attempt to schedule — worst case a no-op, never a throw.
  ac.resume()
    .then(() => scheduleChime(ac, kind))
    .catch((e) => {
      // resume() rejected (e.g. no user gesture yet) OR scheduling threw because the
      // context became unusable (`closed` → createGain throws InvalidStateError).
      // Retry best-effort, then swallow: a dropped chime must NEVER surface as an
      // unhandled promise rejection (this runs in a microtask, past the caller's guard).
      console.error("audio chime failed:", e);
      try {
        scheduleChime(ac, kind);
      } catch {
        /* context unusable — give up silently */
      }
    });
}

/** Lay down the two-note chime for `kind` on an (assumed running) context. */
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

  // Tear the per-play master + filter down once the sound has fully decayed —
  // otherwise each chime leaves a dangling node connected to `destination`,
  // accumulating over a long session. The oscillators self-stop; disconnecting
  // the chain's head lets the whole subgraph be GC'd.
  const ms = Math.max(0, (end + 0.15 - ac.currentTime) * 1000);
  setTimeout(() => {
    master.disconnect();
    lp.disconnect();
  }, ms);
}
