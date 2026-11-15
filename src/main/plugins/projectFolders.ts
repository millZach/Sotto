import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { PluginProject } from '../../shared/plugins'

/** A project as the coordinator holds it, as far as an account's projects need it. */
interface HeldProject { readonly id: string; readonly title: string; readonly path: string; readonly workspaceSettledAt?: string | null | undefined }
interface HeldThread { readonly id: string; readonly projectId: string; readonly kind?: string | undefined }

/** A folder as two paths to it are told to be the same: resolved, and without regard to case where the system has none. */
const folderKey = (path: string): string => { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }

/**
 * What an account is kept to (ADR-0205, decision 9): a project's folder, under a name of Sotto's own that says nothing
 * of where the folder is. A provider gives the same folder a project ID of its own, so the folder is what a project
 * is here: an account kept to a folder is for that folder's threads on every provider, and the folder is offered once.
 */
export function pluginFolderId(path: string): string {
  return `folder:${createHash('sha256').update(folderKey(path)).digest('hex').slice(0, 32)}`
}

/**
 * This computer's projects for the Plugins page, one for each folder, in the order the first of each is held. A
 * folder is settled only while every project in it is. Nothing of the folder's path is handed over.
 */
export function pluginProjects(projects: readonly HeldProject[]): PluginProject[] {
  const folders = new Map<string, PluginProject>()
  for (const project of projects) {
    const id = pluginFolderId(project.path)
    const settled = project.workspaceSettledAt != null
    const held = folders.get(id)
    if (!held) folders.set(id, { id, title: project.title, settled })
    else if (held.settled && !settled) folders.set(id, { ...held, settled: false })
  }
  return [...folders.values()]
}

/**
 * The folder a thread works in, for an account kept to chosen projects. Watcher's threads belong to none of the
 * user's projects, and neither does a thread or a project Sotto does not know, so none of those may use an account
 * kept to some.
 */
export function pluginFolderOfThread(host: { readonly threads: readonly HeldThread[]; readonly projects: readonly HeldProject[] }, threadId: string): string | null {
  const thread = host.threads.find(item => item.id === threadId)
  if (!thread || thread.kind === 'watcher' || thread.kind === 'watcher-history') return null
  const project = host.projects.find(item => item.id === thread.projectId)
  return project ? pluginFolderId(project.path) : null
}
