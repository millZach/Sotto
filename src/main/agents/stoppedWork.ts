/**
 * The background work and watches that ended with a CLI Sotto stopped on its own account (ADR-0023), in the words every
 * such stop uses: what ended, by name when there is one, and how to get it back, since it does not come back by itself.
 */
export function stoppedWork(work: readonly { label: string }[]): { what: string; again: string } {
  const what = work.length === 1 ? `"${work[0]!.label}"` : `${work.length} background tasks`
  const them = work.length === 1 ? 'it' : 'them'
  return { what, again: `Ask Claude to start ${them} again if you still need ${them}.` }
}
