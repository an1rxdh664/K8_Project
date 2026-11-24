'use client';

import { useCallback, useRef } from 'react';

// Web Audio API — no external libraries, no network requests.
// All sounds are synthesised inline from oscillators.

type SoundType = 'click' | 'section' | 'success' | 'error' | 'tick';

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    return new Ctx();
  } catch {
    return null;
  }
}

function playClick(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.06);
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.1);
}

function playSection(ctx: AudioContext) {
  // Soft two-note chime on section change
  [0, 0.08].forEach((delay, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(i === 0 ? 440 : 550, ctx.currentTime + delay);
    gain.gain.setValueAtTime(0.06, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.18);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + 0.2);
  });
}

function playSuccess(ctx: AudioContext) {
  [0, 0.1, 0.2].forEach((delay, i) => {
    const freq = [440, 550, 660][i];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(0.07, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.22);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + 0.25);
  });
}

function playError(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.25);
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.3);
}

function playTick(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  gain.gain.setValueAtTime(0.04, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.05);
}

export function useSound() {
  const ctxRef = useRef<AudioContext | null>(null);

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = getAudioContext();
    }
    // Resume if suspended (browser autoplay policy)
    if (ctxRef.current && ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const play = useCallback((type: SoundType) => {
    const ctx = ensureCtx();
    if (!ctx) return;
    try {
      switch (type) {
        case 'click':   playClick(ctx);   break;
        case 'section': playSection(ctx); break;
        case 'success': playSuccess(ctx); break;
        case 'error':   playError(ctx);   break;
        case 'tick':    playTick(ctx);    break;
      }
    } catch {
      // Silently fail — sound is non-critical
    }
  }, [ensureCtx]);

  return { play };
}
