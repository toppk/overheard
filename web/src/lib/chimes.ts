import { diag } from './diag';

/**
 * Synthesized notification tones — WebAudio oscillators, no assets.
 * The context can only start after a user gesture; until then chimes are
 * silently dropped (resume is retried on every call).
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function blip(c: AudioContext, freq: number, at: number, dur: number, peak: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

export type ChimeKind = 'arrival' | 'construct' | 'patch';

const PATTERNS: Record<ChimeKind, { freqs: number[]; step: number; dur: number }> = {
  // someone jacks into the grid: soft two-note hail
  arrival: { freqs: [587, 880], step: 0.09, dur: 0.18 },
  // a construct is spun up: rising three-note arpeggio
  construct: { freqs: [440, 587, 784], step: 0.08, dur: 0.16 },
  // someone patches into a construct: single ping
  patch: { freqs: [740], step: 0, dur: 0.2 },
};

export function chime(kind: ChimeKind): void {
  try {
    const c = ensureCtx();
    if (c.state !== 'running') return; // no gesture yet; stay silent
    const p = PATTERNS[kind];
    const now = c.currentTime + 0.01;
    p.freqs.forEach((f, i) => blip(c, f, now + i * p.step, p.dur, 0.06));
  } catch (err) {
    diag(`chime failed: ${err}`);
  }
}

/** Warm up / resume the context from a real user gesture. */
export function primeChimes(): void {
  ensureCtx();
}
