export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function fmtUSD(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : d.toLocaleDateString("en-US", { weekday: "short" }) + " " + time;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 21) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400 / 7)}w ago`;
  return `${Math.floor(s / 86400 / 30)}mo ago`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Stable per-project avatar gradient. */
export function projectGradient(name: string): string {
  const palette = [
    ["#ff5ec7", "#5aa8ff"], ["#a06bff", "#5aa8ff"], ["#ff8a5e", "#ff5ec7"],
    ["#5ae3c7", "#5aa8ff"], ["#8f86b8", "#5aa8ff"], ["#c8309a", "#8f86b8"],
    ["#ffd75e", "#ff5ec7"], ["#5affa3", "#a06bff"],
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg,${a},${b})`;
}

export function initials(name: string): string {
  const parts = name.split(/[-_ ]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}
