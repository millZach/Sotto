import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { NEXT_PROMPT_PROJECT_LIMITS, type NextPromptProject } from '../llm/nextPrompt'
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
  const folder = thread.worktree?.path ?? thread.workingDirectory ?? project?.path
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
