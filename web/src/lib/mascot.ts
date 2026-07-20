// Bridge: hotkeys.ts (plain module) → the mounted Mascot component.
let cb: (() => void) | null = null;

/** Mascot registers on mount; returns an unregister fn for cleanup. */
export function onSlopmaxx(fn: () => void): () => void {
  cb = fn;
  return () => { if (cb === fn) cb = null; };
}

/** Returns true if a mascot was mounted and handled it. */
export function triggerSlopmaxx(): boolean {
  if (!cb) return false;
  cb();
  return true;
}
