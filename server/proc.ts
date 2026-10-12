export interface RunResult {
  ok: boolean;
  /** Exit code; null when the command never started. */
  code: number | null;
  out: string;
  err: string;
}

export interface RunOptions {
  cwd?: string;
  /** Extra variables, layered over the server's own environment. */
  env?: Record<string, string>;
  /** Kill the command after this long; whatever it printed so far is kept. */
  timeoutMs?: number;
  /** Trim both streams — for commands whose output is a single value. */
  trim?: boolean;
}

/** Run a command to completion and collect its output. Never throws: a
    missing binary or bad cwd comes back as { ok: false } with the spawn
    error in `err`, so callers only have one failure shape to handle. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (opts.timeoutMs) timer = setTimeout(() => p.kill(), opts.timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return opts.trim
      ? { ok: code === 0, code, out: out.trim(), err: err.trim() }
      : { ok: code === 0, code, out, err };
  } catch (error) {
    return { ok: false, code: null, out: "", err: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
