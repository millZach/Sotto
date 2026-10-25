import type { AgentProject } from '../../shared/agents'
import { PROJECT_ORIGINS_MAX, type ProjectOrigins } from '../../shared/workerMachine'
import { parseGitHubRemote, type GitHubRepository } from './github'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'

/** How many folders are asked at once: one `git config` read each, a few milliseconds apiece. */
const READS_AT_ONCE = 8

/**
 * The GitHub repository a folder's `origin` remote names (#1032), judged from the URL alone as `parseGitHubRemote` judges
 * it, so the same repository reads the same over HTTPS and SSH. Null for a folder that is not a Git repository, has no
 * `origin`, or whose `origin` is not on GitHub. Asks Git nothing over the network.
 */
export async function readGitHubOrigin(path: string, run: RunGitCommand = runGitStatusCommand): Promise<GitHubRepository | null> {
  // A project without a folder would otherwise be read in whatever folder Sotto runs from.
  if (!path.trim()) return null
  const url = await run(path, 'git', ['config', '--get', 'remote.origin.url']).catch(() => '')
  return url.trim() ? parseGitHubRemote(url.trim()) : null
}

/**
 * Each project's GitHub origin, as the `project-origins` feature answers it and as this computer reads its own: Electron-
 * free, so a headless host answers with it too. Read when a start is placed, never on a timer; a folder two projects
 * share is read once.
 */
export async function readProjectOrigins(projects: readonly Pick<AgentProject, 'id' | 'path'>[], run: RunGitCommand = runGitStatusCommand): Promise<ProjectOrigins> {
  const listed = projects.slice(0, PROJECT_ORIGINS_MAX)
  const paths = [...new Set(listed.map(project => project.path))]
  const read = new Map<string, GitHubRepository | null>()
  for (let at = 0; at < paths.length; at += READS_AT_ONCE) {
    const batch = paths.slice(at, at + READS_AT_ONCE)
    const origins = await Promise.all(batch.map(path => readGitHubOrigin(path, run)))
    batch.forEach((path, index) => read.set(path, origins[index]!))
  }
  return { projects: listed.map(project => {
    const repository = read.get(project.path) ?? null
    return { projectId: project.id, repository: repository ? { host: repository.host, owner: repository.owner, name: repository.name } : null }
  }) }
}
