export interface TtlCache<T> {
  get(): Promise<T>;
  /** Force the next get() to recompute. A computation already in flight is
      orphaned — its result is neither shared nor cached — but the last value
      is kept as the staleOnError fallback. */
  invalidate(): void;
}

export interface TtlCacheOptions<T> {
  /** When a recompute fails, serve the last value instead of rejecting. */
  staleOnError?: boolean;
  /** Extra freshness check on a cached value, on top of its age. */
  isFresh?: (value: T) => boolean;
}

/** A value recomputed at most once per `ttlMs`. Concurrent callers share one
    in-flight computation rather than each starting their own — several of
    these fork processes, and the dashboard polls them from every tab. */
export function ttlCache<T>(
  ttlMs: number,
  compute: () => Promise<T>,
  opts: TtlCacheOptions<T> = {},
): TtlCache<T> {
  let entry: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  return {
    get() {
      if (entry && Date.now() - entry.at < ttlMs && (opts.isFresh?.(entry.value) ?? true)) {
        return Promise.resolve(entry.value);
      }
      if (inFlight) return inFlight;
      const mine = generation;
      const pending = compute().then(
        value => {
          if (mine === generation) entry = { at: Date.now(), value };
          return value;
        },
        error => {
          if (opts.staleOnError && entry) return entry.value;
          throw error;
        },
      );
      inFlight = pending;
      const clear = () => { if (inFlight === pending) inFlight = null; };
      pending.then(clear, clear);
      return pending;
    },
    invalidate() {
      generation += 1;
      inFlight = null;
      if (entry) entry.at = 0;
    },
  };
}
