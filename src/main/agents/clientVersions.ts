/**
 * Compare two client version strings. Only the numeric parts decide; a prerelease suffix is ignored
 * rather than guessed at, because a client that calls itself 1.0.40-rc.1 is still 1.0.40's shape.
 * Returns a negative number when `a` is older. 1.0.5 is older than 1.0.40, which a string compare
 * gets backwards and which is exactly the case that kept an installed Grok client pinned.
 */
export function compareClientVersions(a: string, b: string): number {
  const parts = (value: string): number[] => (value.trim().replace(/^v/u, '').split(/[-+]/u)[0] ?? '').split('.')
    .map(part => Number.parseInt(part, 10)).filter(part => Number.isSafeInteger(part))
  const left = parts(a); const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** True when a version is readable as numbers at all. An unreadable version is never called behind. */
export function isComparableVersion(value: string): boolean {
  return /^v?\d+(\.\d+)*/u.test(value.trim())
}

/** The client's own version, without the protocol note an adapter adds to it ("1.0.5 / ACP 1"). */
export function clientVersionOf(reported: string): string {
  return reported.trim().split(/[\s/]/u)[0] ?? ''
}
