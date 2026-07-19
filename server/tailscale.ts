// Expose the app on the tailnet via `tailscale serve` (TLS + wss for free,
// tailnet-only). The server itself stays bound to loopback — tailscaled
// proxies to it.
const TS_HTTPS_PORT = 443;

async function run(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { ok: (await p.exited) === 0, out, err };
}

/** Best-effort: returns the tailnet URL, or null if tailscale is missing/down. */
export async function ensureTailscaleServe(port: number): Promise<string | null> {
  try {
    const status = await run("status", "--json");
    if (!status.ok) return null;
    const info = JSON.parse(status.out);
    if (info.BackendState !== "Running") return null;

    // idempotent: re-registering the same proxy is a no-op
    const serve = await run("serve", "--bg", `--https=${TS_HTTPS_PORT}`, String(port));
    if (!serve.ok) {
      console.error("tailscale serve failed:", serve.err.trim());
      return null;
    }
    const dns = String(info.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!dns) return null;
    return TS_HTTPS_PORT === 443 ? `https://${dns}` : `https://${dns}:${TS_HTTPS_PORT}`;
  } catch {
    return null; // tailscale CLI not installed
  }
}
