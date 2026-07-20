import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "./harnesses";

/** Per-harness self-updaters. Each harness gets its own updater instance —
    same caching, generation, and job semantics, different binary and
    latest-version sources. */

// Deliberately under the dashboard's 30m poll: an equal TTL means the poll
// lands a few ms short of expiry, hits the cache, and the real check slips to
// the following hour.
const TTL = 25 * 60_000;

const home = homedir();

// The native installer's release manifest — what `claude update` actually
// installs. npm is the fallback for npm-global installs (and for when GCS is
// unreachable); the two agree in practice.
const CLAUDE_DIST_LATEST =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";
const CLAUDE_NPM_LATEST = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
// npm tracks the standalone releases that `codex update` installs; the GitHub
// release tag (rust-vX.Y.Z) is the fallback.
const CODEX_NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";
const CODEX_GH_LATEST = "https://api.github.com/repos/openai/codex/releases/latest";

export interface UpdateJob {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  from: string | null;   // version we started from
  output: string;        // tail of the CLI's own output — the error case needs it
}

export interface UpdateStatus {
  installed: string | null;   // null when the binary isn't where we expect it
  latest: string | null;      // null when all lookups failed
  updateAvailable: boolean;
  checkedAt: number;
  error: string | null;       // a hint for the UI; never fails the request
  job: UpdateJob | null;      // last/current self-update run
}

/** "2.1.215 (Claude Code)" / "codex-cli 0.144.5" / "rust-v0.144.5" → version */
function parseVersion(text: string): string | null {
  return text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

/** Numeric-segment compare; a prerelease sorts below its own release. */
export function isNewer(latest: string, installed: string): boolean {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre: pre ?? null };
  };
  const a = split(latest), b = split(installed);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const x = a.nums[i] ?? 0, y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;   // 2.1.215 beats 2.1.215-beta.1
  if (!b.pre) return false;
  return a.pre > b.pre;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

interface UpdaterConfig {
  bin: () => string;
  updateArgs: string[];
  latest: () => Promise<string | null>;
  notFoundHint: string;
}

interface Updater {
  getStatus: (force?: boolean) => Promise<UpdateStatus>;
  start: () => UpdateJob | { error: string };
}

function makeUpdater(cfg: UpdaterConfig): Updater {
  let cache: { at: number; data: Omit<UpdateStatus, "job"> } | null = null;
  let inFlight: { generation: number; p: Promise<Omit<UpdateStatus, "job">> } | null = null;
  let generation = 0; // bumped whenever an update changes the installed version
  let job: UpdateJob | null = null;

  async function installedVersion(): Promise<string | null> {
    try {
      const p = Bun.spawn([cfg.bin(), "--version"], { stdout: "pipe", stderr: "ignore" });
      const timeout = setTimeout(() => p.kill(), 10_000);
      const out = await new Response(p.stdout).text();
      await p.exited;
      clearTimeout(timeout);
      return parseVersion(out.trim());
    } catch {
      return null; // not installed, or not on the path we expect
    }
  }

  async function check(): Promise<Omit<UpdateStatus, "job">> {
    const [installed, latest] = await Promise.all([
      installedVersion(),
      cfg.latest().catch((e: unknown) => e instanceof Error ? e : new Error(String(e))),
    ]);
    const failed = latest instanceof Error;
    // A network blip must not retract a known update: keep the last good
    // `latest` and report the failure alongside it, rather than caching a null
    // that would hide the badge until the next check.
    const latestVer = failed ? cache?.data.latest ?? null : latest;
    return {
      installed,
      latest: latestVer,
      updateAvailable: !!(installed && latestVer && isNewer(latestVer, installed)),
      checkedAt: Date.now(),
      error: failed ? `version check failed: ${latest.message}`
        : installed ? null : cfg.notFoundHint,
    };
  }

  /** Cached for TTL. `force` is the dashboard's manual refresh — concurrent
      callers share one in-flight check rather than each spawning the CLI.

      `generation` exists because an update changes the installed version out
      from under a check that is already running: a check started before the
      update finished reports the old version, and without this it would both
      be handed to the forced post-update call and cached for the full TTL,
      leaving the chip insisting an update is still available. Results from a
      superseded generation are dropped, and a forced call never adopts one. */
  async function getStatus(force = false): Promise<UpdateStatus> {
    if (!force && cache && Date.now() - cache.at < TTL) return { ...cache.data, job };
    if (!inFlight || (force && inFlight.generation !== generation)) {
      const mine = generation;
      const p = check()
        .then(data => {
          if (mine === generation) cache = { at: Date.now(), data };
          return data;
        })
        .catch((e: unknown) => {
          if (cache) return cache.data; // serve stale over failing
          throw e;
        })
        .finally(() => { if (inFlight?.p === p) inFlight = null; });
      inFlight = { generation: mine, p };
    }
    return { ...(await inFlight.p), job };
  }

  /** Fire-and-forget self-update; progress is read back via getStatus.
      Only one run at a time — a second click while it works is a no-op. */
  function start(): UpdateJob | { error: string } {
    if (job?.status === "running") return { error: "an update is already running" };
    const started: UpdateJob = {
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      from: cache?.data.installed ?? null,
      output: "",
    };
    job = started;

    (async () => {
      try {
        const p = Bun.spawn([cfg.bin(), ...cfg.updateArgs], {
          stdout: "pipe", stderr: "pipe",
          env: { ...process.env },
        });
        const timeout = setTimeout(() => p.kill(), 5 * 60_000);
        const [out, errOut] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        const code = await p.exited;
        clearTimeout(timeout);
        started.output = `${out}${errOut}`.trim().slice(-2000);
        started.status = code === 0 ? "done" : "error";
        if (code !== 0 && !started.output) started.output = `update exited ${code}`;
      } catch (e) {
        started.status = "error";
        started.output = e instanceof Error ? e.message : String(e);
      } finally {
        started.finishedAt = Date.now();
        // The installed version just moved. Bump the generation so no in-flight
        // check can write a pre-update reading, but leave the cache in place —
        // it holds the last known `latest`, which a failed re-check (same outage
        // that may have broken the update) still needs to keep the badge alive.
        generation++;
        getStatus(true).catch(() => {});
      }
    })();

    return started;
  }

  return { getStatus, start };
}

export const updaters: Record<HarnessId, Updater> = {
  claude: makeUpdater({
    // PATH first — npm-global and Homebrew installs live elsewhere — then the
    // native installer's location, which is what launchd's PATH usually finds.
    bin: () => Bun.which("claude") ?? join(home, ".local", "bin", "claude"),
    updateArgs: ["update"],
    latest: async () => {
      try {
        const v = parseVersion((await fetchText(CLAUDE_DIST_LATEST)).trim());
        if (v) return v;
      } catch { /* fall through to npm */ }
      return parseVersion(String(JSON.parse(await fetchText(CLAUDE_NPM_LATEST)).version ?? ""));
    },
    notFoundHint: "claude not found on PATH or at ~/.local/bin/claude",
  }),
  codex: makeUpdater({
    bin: () => Bun.which("codex") ?? join(home, ".local", "bin", "codex"),
    updateArgs: ["update"],
    latest: async () => {
      try {
        const v = parseVersion(String(JSON.parse(await fetchText(CODEX_NPM_LATEST)).version ?? ""));
        if (v) return v;
      } catch { /* fall through to GitHub */ }
      return parseVersion(String(JSON.parse(await fetchText(CODEX_GH_LATEST)).tag_name ?? ""));
    },
    notFoundHint: "codex not found on PATH or at ~/.local/bin/codex",
  }),
};
