import type { AgentHostSnapshot, AgentThread } from '../../../shared/agents'

/**
 * A Markdown file a message linked, as the side panel holds it (ADR-0120, November 3 amendment). `threadId` is the thread
 * whose machine reads it; `path` is as the link wrote it; `revision` moves with each press, so pressing the same link reads
 * the file again.
 */
export interface LinkedFile { readonly threadId: string; readonly path: string; readonly revision: number }

/** The link a file opened from, so closing it takes focus back there. */
let opener: HTMLElement | null = null
export function rememberLinkOpener(element: HTMLElement): void { opener = element }
/** Focus back on the link, or `fallback` when the link is no longer drawn, as when its pane went behind the file. */
export function focusLinkOpener(fallback?: () => void): void {
  const element = opener
  opener = null
  if (element?.isConnected) element.focus()
  else fallback?.()
}

const isAbsolute = (path: string): boolean => /^(?:\/|[a-z]:[\\/])/iu.test(path)
/** A path to compare: forward slashes with no trailing one, and a Windows path in one case, since Windows ignores it. */
const comparable = (path: string): string => {
  const slashes = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-z]:/iu.test(slashes) ? slashes.toLowerCase() : slashes
}

/**
 * Whose machine a link in Watcher's reply is read on. Watcher runs on this computer and its workers may not, so a full path
 * inside another thread's folder is read from that thread's machine. Watcher's own folder wins, and so does the deepest
 * folder when one holds another. Any other path is Watcher's to read on its own machine.
 */
export function linkedFileThread({ threads, projects }: Pick<AgentHostSnapshot, 'threads' | 'projects'>, readerId: string, path: string): string {
  if (!isAbsolute(path)) return readerId
  const target = comparable(path)
  // A thread sharing its project's checkout names no folder of its own.
  const folderOf = (thread: AgentThread): string => comparable(thread.workingDirectory ?? thread.worktree?.path ?? projects.find(project => project.id === thread.projectId)?.path ?? '')
  const holds = (thread: AgentThread): boolean => { const folder = folderOf(thread); return folder !== '' && target.startsWith(`${folder}/`) }
  if (threads.some(thread => thread.id === readerId && holds(thread))) return readerId
  let deepest: { readonly id: string; readonly length: number } | null = null
  for (const thread of threads) {
    if (!holds(thread)) continue
    const { length } = folderOf(thread)
    if (deepest === null || length > deepest.length) deepest = { id: thread.id, length }
  }
  return deepest?.id ?? readerId
}
