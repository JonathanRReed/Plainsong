/** Names only. Never forward an address or a multi-line field. */
export function cleanLocalNames(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    const key = name.toLowerCase();
    if (!name || [...name].length > 64 || /[@\r\n]/.test(name) || seen.has(key)) continue;
    names.push(name);
    seen.add(key);
    if (names.length === 2_000) break;
  }
  return names;
}
