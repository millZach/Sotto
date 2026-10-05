import type { FilesBridge } from '../../../shared/files'
import type { GitChangesBridge } from '../../../shared/gitChanges'

/** How often Changes asks a paired host for its thread's change list while Changes shows that thread. */
export const HOST_CHANGES_POLL_MS = 4000

/**
 * What Files and Changes may ask of a thread on a paired host (ADR-0025, October 5 amendment): its host's reads and
 * Copy path, which main sends to that host. Reveal and the turn checkpoints need the thread on this computer, so they
 * are left out, and the controls they would back are absent rather than disabled.
 */
export function hostThreadFiles(bridge: FilesBridge): FilesBridge {
  return Object.freeze<FilesBridge>({
    list: request => bridge.list(request),
    preview: request => bridge.preview(request),
    copyPath: request => bridge.copyPath(request),
  })
}

type ChangedListener = Parameters<GitChangesBridge['onChanged']>[0]

/**
 * The host pushes no change events, so the watch asks it for the change list on a timer while Changes shows the thread,
 * as main's own watch polls a working copy on this computer. Each answer is passed on with its revision, and the
 * Changes store reads the comparison again only when the revision moved.
 */
export function hostThreadChanges(bridge: GitChangesBridge, pollMs = HOST_CHANGES_POLL_MS): GitChangesBridge {
  const listeners = new Set<ChangedListener>()
  const watched = new Map<string, ReturnType<typeof setInterval>>()
  const poll = async (target: { threadId: string; workspaceId: string }): Promise<void> => {
    const result = await bridge.list(target).catch(() => null)
    if (result?.ok) for (const listener of listeners) listener({ ...target, revision: result.value.revision })
  }
  return Object.freeze<GitChangesBridge>({
    list: request => bridge.list(request),
    review: request => bridge.review(request),
    copyPath: request => bridge.copyPath(request),
    watch: async ({ enabled, ...target }) => {
      const key = `${target.threadId}\n${target.workspaceId}`
      const timer = watched.get(key)
      if (!enabled && timer !== undefined) { clearInterval(timer); watched.delete(key) }
      if (enabled && timer === undefined) watched.set(key, setInterval(() => { void poll(target) }, pollMs))
      return { ok: true, value: undefined }
    },
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
}
