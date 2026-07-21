export const clampPct = (p: number | null | undefined) =>
  p == null ? null : Math.max(0, Math.min(100, p));

export function remaining(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `~${h}h ${m}m remaining` : `~${m}m remaining`;
}
