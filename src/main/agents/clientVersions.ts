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

/**
 * The client's own version, out of whatever the adapter reports. Grok and Devin add a protocol note
 * ("1.0.5 / ACP 1"); Codex answers with a user agent that names the product first and carries both
 * its version and the OS's ("sotto/0.155.1 (Windows 10.0.26200; x86_64) unknown (sotto; 1.0)").
 * Nothing version-shaped at all reads as no version, and nothing is then claimed about the client.
 */
export function clientVersionOf(reported: string): string {
  const value = reported.trim()
  const agent = /^[^/\s]+\/(\d+(?:\.\d+)+[\w.+-]*)/u.exec(value)
  if (agent?.[1]) return agent[1]
  return /\d+(?:\.\d+)+[\w.+-]*/u.exec(value)?.[0] ?? ''
}
