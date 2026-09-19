import type { AgentHostSnapshot } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import type { FilesBinding } from './service'

/** An unsent worktree choice previews source files; an allocated folder never falls back on disk. */
export function resolveFilesBinding(host: AgentHostSnapshot, threadId: string): FilesBinding | null {
  const thread = host.threads.find(candidate => candidate.id === threadId)
  if (!thread) return null
  const project = host.projects.find(candidate => candidate.id === thread.projectId)
  // List/preview may read the source. Tools sharing this resolver must refuse the preview binding.
  if (project && thread.nativeSessionStarted === false && !thread.workingDirectory
    && thread.worktree?.mode === 'independent' && thread.worktree.status === 'pending' && !thread.worktree.path) {
    return { threadId, projectId: thread.projectId, workingDirectory: project.path, previewOnly: true }
  }
  return { threadId, projectId: thread.projectId, workingDirectory: resolveThreadWorkingDirectory(thread, project) }
}
