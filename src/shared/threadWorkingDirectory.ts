import type { AgentProject, AgentThread } from './agents'

/** Working files follow the thread; memory and authority continue to follow its project. */
export function resolveThreadWorkingDirectory(
  thread: Pick<AgentThread, 'workingDirectory' | 'worktree'>,
  project: Pick<AgentProject, 'path'> | undefined,
): string {
  if (thread.worktree && thread.worktree.status !== 'ready') throw new Error(thread.worktree.error ?? 'This thread’s working folder is not ready. Retry working-copy setup.')
  const checkout = thread.worktree?.path
  const directory = thread.workingDirectory ?? (checkout && thread.worktree?.projectRelativePath
    ? `${checkout}/${thread.worktree.projectRelativePath}` : checkout) ?? project?.path
  if (!directory) throw new Error('This thread’s working folder is unavailable.')
  return directory
}
