import type { RunGitCommand } from './gitStatus'

/** What Sotto asks GitHub through `gh` on the user's own sign-in (ADR-0027 decision 7). Electron-free: the headless host uses it too. */

/** A repository on a GitHub host, as a remote URL names it. */
export interface GitHubRepository { readonly host: string; readonly owner: string; readonly name: string }

/**
 * The GitHub repository a remote URL names: HTTPS, `git@host:` or `ssh://`, on github.com or a host whose name says
 * GitHub (an Enterprise server). Null for any other remote, a local path among them, which gh cannot be asked about.
 */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = /^(?:https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/|(?:[^@/\s]+@)?([^/:\s]+):(?!\/)|ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  if (!match) return null
  const host = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase()
  if (!/github/u.test(host)) return null
  return { host, owner: match[4]!, name: match[5]! }
}
export const sameRepository = (a: GitHubRepository, b: GitHubRepository): boolean =>
  a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
export const repositoryKey = (repository: GitHubRepository): string => `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase()

/** Each remote's URL as the user wrote it (before any `insteadOf`), and gh's own mark of the one it reads pull requests from. */
export async function readRemotes(run: RunGitCommand, cwd: string): Promise<Map<string, { url: string | null; ghResolved: string | null }>> {
  const remotes = new Map<string, { url: string | null; ghResolved: string | null }>()
  // Git answers 1 when no key matches, which is a repository with no remotes.
  const listing = await run(cwd, 'git', ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']).catch(() => '')
  for (const line of listing.split('\n')) {
    const match = /^remote\.(.+)\.(url|gh-resolved) (.*)$/u.exec(line.trim())
    if (!match) continue
    const entry = remotes.get(match[1]!) ?? { url: null, ghResolved: null }
    if (match[2] === 'url' && entry.url === null) entry.url = match[3]!
    else if (match[2] === 'gh-resolved') entry.ghResolved = match[3]!
    remotes.set(match[1]!, entry)
  }
  return remotes
}
/** The repository `gh pr list` would read in this folder: the remote `gh repo set-default` marked, else `origin`. */
export function baseRepository(remotes: ReadonlyMap<string, { url: string | null; ghResolved: string | null }>): GitHubRepository | null {
  const marked = [...remotes].find(([, remote]) => remote.ghResolved === 'base')?.[1]
  const url = marked?.url ?? remotes.get('origin')?.url
  return url ? parseGitHubRemote(url) : null
}

/** Asked by the timer, which may wait, or by the user (a refresh, a Git action, the Pull request surface), who should not. */
export type GitHubAsk = 'background' | 'user'
