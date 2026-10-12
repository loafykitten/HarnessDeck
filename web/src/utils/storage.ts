/** localStorage.getItem for a key renamed from its ClaudeCommand-era cc-*
    name: a value still under the old key moves to the new one on first read. */
export function getRenamedItem(key: string, legacyKey: string): string | null {
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
  }
  return localStorage.getItem(key);
}
