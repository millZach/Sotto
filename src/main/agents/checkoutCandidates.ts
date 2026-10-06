import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { checkoutIdentity } from './threadWorktrees'

/** One operation's reads: cheap candidate filtering precedes Git discovery and each folder is discovered once. */
export async function threadsInCheckout(snapshot: AgentHostSnapshot, targetId: string, folderOf: (thread: AgentThread) => string, knownIdentity?: string): Promise<AgentThread[]> {
  const target = snapshot.threads.find(thread => thread.id === targetId)
  if (!target) return []
  const folders = new Map<string, Promise<string>>()
  const identities = new Map<string, Promise<string>>()
  const canonical = (folder: string): Promise<string> => {
    let value = folders.get(folder)
    if (!value) {
      value = realpath(folder).catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        return resolve(folder)
      }).then(path => process.platform === 'win32' ? path.toLowerCase() : path)
      folders.set(folder, value)
    }
    return value
  }
  const identity = (folder: string): Promise<string> => {
    let value = identities.get(folder)
    if (!value) { value = checkoutIdentity(folder); identities.set(folder, value) }
    return value
  }
  const folder = folderOf(target)
  const root = knownIdentity ?? await identity(folder)
  identities.set(folder, Promise.resolve(root))
  const candidates = await Promise.all(snapshot.threads.filter(thread => !thread.archivedAt).map(async thread => {
    if (thread.worktree?.mode === 'independent' && (!thread.worktree.path && !thread.worktree.existingWorktreePath || thread.worktree.reclaimedAt)) return null
    try {
      const candidateFolder = folderOf(thread)
      const child = relative(root, await canonical(candidateFolder))
      const underRoot = child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith(`..\\`) && !child.startsWith('../')
      // Shared project folders are candidates even before their copy is discovered. Established independent
      // roots outside this checkout are separate, even when they belong to the same project.
      if (!underRoot && (thread.projectId !== target.projectId || thread.worktree?.mode === 'independent')) return null
      return await identity(candidateFolder) === root ? thread : null
    } catch { return null }
  }))
  return candidates.filter((thread): thread is AgentThread => thread !== null)
}
