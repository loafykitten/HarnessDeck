/** The item `dir` steps from `current`, wrapping at both ends. */
export function cycle<T>(items: readonly T[], current: T, dir: 1 | -1): T {
  return items[(items.indexOf(current) + dir + items.length) % items.length];
}
