// WebAudio chimes — no assets, no permissions. The context can only start
// after a user gesture; before that, chimes silently no-op.
let ctx: AudioContext | null = null;

export function chime(kind: "done" | "question") {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    // done: falling third (settled) · question: rising fourth (hey, you)
    const notes = kind === "done" ? [880, 698.46] : [659.25, 880];
    for (const [i, freq] of notes.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.10, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    }
  } catch { /* audio unavailable */ }
}
