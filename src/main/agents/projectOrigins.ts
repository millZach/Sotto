import type { AgentProject } from '../../shared/agents'
import { PROJECT_ORIGINS_MAX, type ProjectOrigins } from '../../shared/workerMachine'
import { parseGitHubRemote, type GitHubRepository } from './git/github'
import { runGitStatusCommand, type RunGitCommand } from './git/gitStatus'

/** How many folders are asked at once: one `git config` read each, a few milliseconds apiece. */
const READS_AT_ONCE = 8

/** Extracts a normalized `owner/repo` slug from a Git remote URL (GitHub, GitLab, SSH or HTTPS), or null. */
export function parseRepoSlug(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, '')
  if (!trimmed) return null
  const github = parseGitHubRemote(trimmed)
  if (github) return `${github.owner}/${github.name}`
  const ssh = /^[^@\s]+@[^:\s/]+:([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu.exec(trimmed)
  if (ssh?.[1]) return ssh[1]
  try {
    const parsed = new URL(trimmed)
    const parts = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '').split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null
  } catch { return null }
}

/**
 * Reads each project's `origin` `owner/repo` slug locally with bounded concurrency, deduplicating shared folders and
 * returning null for folders without a readable `origin` remote.
 */
export async function readProjectRepoSlugs(projects: readonly Pick<AgentProject, 'id' | 'path'>[], run: RunGitCommand = runGitStatusCommand): Promise<Map<string, string | null>> {
  const listed = projects.slice(0, PROJECT_ORIGINS_MAX), paths = [...new Set(listed.map(project => project.path))]
  const read = new Map<string, string | null>()
  for (let at = 0; at < paths.length; at += READS_AT_ONCE) {
    const batch = paths.slice(at, at + READS_AT_ONCE)
    const slugs = await Promise.all(batch.map(async path => {
      if (!path.trim()) return null
      const url = await run(path, 'git', ['config', '--get', 'remote.origin.url']).catch(() => '')
      return url.trim() ? parseRepoSlug(url) : null
    }))
    batch.forEach((path, index) => read.set(path, slugs[index]!))
  }
  return new Map(listed.map(project => [project.id, read.get(project.path) ?? null]))
}

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
