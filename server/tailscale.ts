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

/** This machine's tailnet name and IPs, as URL hostnames, for the Host
    allowlist. Filled in once tailscale reports running. */
export const tailnetHosts = new Set<string>();

/** Best-effort: returns the tailnet URL, or null if tailscale is missing/down. */
export async function ensureTailscaleServe(port: number): Promise<string | null> {
  try {
    const status = await run("status", "--json");
    if (!status.ok) return null;
    const info = JSON.parse(status.out);
    if (info.BackendState !== "Running") return null;
    const self = info.Self ?? {};
    const name = String(self.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    if (name) tailnetHosts.add(name);
    for (const ip of Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []) {
      tailnetHosts.add(String(ip).includes(":") ? `[${ip}]` : String(ip));
    }

    // idempotent: re-registering the same proxy is a no-op
    const serve = await run("serve", "--bg", `--https=${TS_HTTPS_PORT}`, String(port));
    if (!serve.ok) {
      console.error("tailscale serve failed:", serve.err.trim());
      return null;
    }
    if (!name) return null;
    return TS_HTTPS_PORT === 443 ? `https://${name}` : `https://${name}:${TS_HTTPS_PORT}`;
  } catch {
    return null; // tailscale CLI not installed
  }
}
