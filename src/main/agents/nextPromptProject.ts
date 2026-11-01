import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import { NEXT_PROMPT_PROJECT_LIMITS, NEXT_PROMPT_WATCHER_THREADS, type NextPromptProject, type NextPromptWatcherFacts } from '../llm/nextPrompt'
import type { RunGitCommand } from './gitStatus'

/** A read that takes longer is left out rather than holding the suggestion. */
const GIT_TIMEOUT_MS = 5_000

/**
 * What a new thread's own provider is told about its project to guess its first prompt (ADR-0173): the branch, the latest
 * commit subjects and the uncommitted files of the folder the thread works in, and the titles of the user's latest named
 * threads in the same project on any provider. Read when a client first shows the new thread, never per update. Null
 * when the thread has no folder to read.
 */
export async function nextPromptProject(thread: AgentThread, host: Pick<AgentHostSnapshot, 'threads' | 'projects'>, run: RunGitCommand): Promise<NextPromptProject | null> {
  const project = host.projects.find(item => item.id === thread.projectId && (item.providerId === undefined || thread.providerId === undefined || item.providerId === thread.providerId))
  // The thread's own folder; a new worktree is made on the first send, so until it is ready the project's folder is read.
  let folder: string | undefined
  try { folder = resolveThreadWorkingDirectory(thread, project) } catch { folder = project?.path }
  if (!folder) return null
  const git = (args: readonly string[], separator = '\n'): Promise<string[]> => run(folder, 'git', args, { timeoutMs: GIT_TIMEOUT_MS })
    .then(output => output.split(separator).map(line => line.trimEnd()).filter(Boolean), () => [])
  const limits = NEXT_PROMPT_PROJECT_LIMITS
  const [branch, commits, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', `-${limits.commits}`, '--format=%s']),
    // NUL-separated, so a name with spaces or other scripts comes back as it is rather than quoted and escaped.
    git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], '\0'),
  ])
  const changed: string[] = []
  for (let index = 0; index < status.length && changed.length < limits.changed; index++) {
    const record = status[index]!
    changed.push(record.slice(3))
    // A rename or copy is followed by the name it came from, which is not a change of its own.
    if (record[0] === 'R' || record[0] === 'C') index++
  }
  // The same project on another provider is another record with the same folder.
  const path = project?.path
  const sameProject = new Set(host.projects.filter(item => path !== undefined && item.path === path).map(item => item.id))
  const threads = host.threads
    .filter(item => item.id !== thread.id && sameProject.has(item.projectId) && (item.kind ?? 'project') === 'project' && item.titleSource !== undefined && item.titleSource !== 'default')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, limits.threads)
    .map(item => item.title)
  return {
    name: project?.title ?? folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder,
    branch: branch[0] && branch[0] !== 'HEAD' ? branch[0] : thread.worktree?.branch ?? null,
    commits,
    changed,
    threads,
  }
}

/**
 * What Watcher's provider is told to guess the user's first message to Watcher (ADR-0173): the user's latest named threads
 * on every host the window joins, each with its project and whether it works, waits on the user or is at rest. Watcher
 * reads all of them once it starts. Read when the first-start box is shown, never per update.
 */
export function nextPromptWatcherFacts(host: Pick<AgentHostSnapshot, 'threads' | 'projects'>): NextPromptWatcherFacts {
  const threads = host.threads
    .filter(item => (item.kind ?? 'project') === 'project' && !item.archivedAt && item.titleSource !== undefined && item.titleSource !== 'default')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, NEXT_PROMPT_WATCHER_THREADS)
    .map(item => ({ title: item.title, project: host.projects.find(project => project.id === item.projectId)?.title ?? '',
      state: item.requests.length > 0 ? 'waiting on you' as const : item.status === 'running' ? 'working' as const : 'at rest' as const }))
  return { threads }
}
