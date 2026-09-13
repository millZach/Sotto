import type { AgentHostSnapshot } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import type { FilesBinding } from './service'

/** Use the worktree lane's single resolver; missing explicit cwd never falls back on disk. */
export function resolveFilesBinding(host: AgentHostSnapshot, threadId: string): FilesBinding | null {
  const thread = host.threads.find(candidate => candidate.id === threadId)
  if (!thread) return null
  const project = host.projects.find(candidate => candidate.id === thread.projectId)
  return { threadId, projectId: thread.projectId, workingDirectory: resolveThreadWorkingDirectory(thread, project) }
}
