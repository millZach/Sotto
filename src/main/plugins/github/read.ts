import { homedir } from 'node:os'
import type { PluginReadKind } from '../../../shared/plugins'
import { GitUnavailableError, type RunGitCommand } from '../../agents/git/gitStatus'

const HOST = 'github.com'
const TIMEOUT_MS = 30_000
/** The most of an answer handed to an agent. A longer one is cut and says so, so the agent asks for less. */
export const GITHUB_READ_MAX_CHARS = 200_000
export const GITHUB_PATH_MAX = 1_000
export const GITHUB_QUERY_MAX = 20

/**
 * A REST path as GitHub documents them, without the leading slash: `repos/OWNER/NAME/issues`. It starts with a letter
 * or digit, so it can never be read as an option of gh's; it holds no `{}` and no `:` for gh to fill from a folder (an
 * older gh reads `:owner` as it reads `{owner}`), no `?` (the
 * query has its own argument), no `..` and no scheme, so it cannot leave github.com's API.
 */
const PATH = /^[A-Za-z0-9][A-Za-z0-9._~%+@,=-]*(?:\/[A-Za-z0-9._~%+@,=-]+)*$/u
const QUERY_KEY = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/u

/**
 * Reads Sotto refuses because what they return is other credentials (ADR-0205, decision 6). Secret scanning alerts
 * hold the literal tokens GitHub found in a repository's history, in every form of the endpoint: a repository's, an
 * organisation's and an enterprise's, the list, one alert and its locations.
 */
const SECRET_SEGMENTS: ReadonlySet<string> = new Set(['secret-scanning'])

export type GitHubReadRefusal = 'path' | 'query' | 'graphql' | 'secrets'
export type GitHubRead =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: GitHubReadRefusal | 'not-installed' | 'signed-out' | 'failed'; readonly said?: string }

/** Why a read is refused before gh is asked, or null when it may go. */
export function gitHubReadRefusal(path: string, query: Readonly<Record<string, string>>): GitHubReadRefusal | null {
  if (path.length > GITHUB_PATH_MAX || !PATH.test(path)) return 'path'
  // Each part is read as GitHub will read it, so a part spelled with percent signs is checked as what it spells.
  const parts: string[] = []
  for (const raw of path.split('/')) {
    let part: string
    try { part = decodeURIComponent(raw) } catch { return 'path' }
    if (part === '.' || part === '..' || /[/\\]/u.test(part) || [...part].some(character => character.charCodeAt(0) < 0x20)) return 'path'
    parts.push(part.toLowerCase())
  }
  // GraphQL takes a POST, and one POST there can change things: reads go through REST.
  if (parts[0] === 'graphql') return 'graphql'
  if (parts.some(part => SECRET_SEGMENTS.has(part))) return 'secrets'
  const entries = Object.entries(query)
  if (entries.length > GITHUB_QUERY_MAX || entries.some(([key, value]) => !QUERY_KEY.test(key) || value.length > 1_000 || [...value].some(character => character.charCodeAt(0) < 0x20))) return 'query'
  return null
}

/**
 * Reads from GitHub's REST API as the account gh is signed in to on this computer (ADR-0205): `gh api` with GET and
 * nothing else. The method is fixed, the host is pinned to github.com, and each query value goes as a raw field (`-f`),
 * never a typed one (`-F`), which would let a value name a file for gh to read. Run from the home folder, so gh fills
 * nothing in from a repository. The answer goes to the calling agent and nowhere else: it is not logged or recorded.
 */
export async function readGitHub(run: RunGitCommand, path: string, query: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<GitHubRead> {
  const refusal = gitHubReadRefusal(path, query)
  if (refusal) return { ok: false, reason: refusal }
  const args = ['api', '--method', 'GET', '--hostname', HOST, '-H', 'Accept: application/vnd.github+json', path,
    ...Object.entries(query).flatMap(([key, value]) => ['-f', `${key}=${value}`])]
  try {
    const text = await run(homedir(), 'gh', args, { timeoutMs: TIMEOUT_MS, ...(signal ? { signal } : {}) })
    return text.length > GITHUB_READ_MAX_CHARS
      ? { ok: true, text: text.slice(0, GITHUB_READ_MAX_CHARS), truncated: true }
      : { ok: true, text, truncated: false }
  } catch (error) {
    if (error instanceof GitUnavailableError) return { ok: false, reason: 'not-installed' }
    const said = error instanceof Error ? error.message : ''
    if (/gh auth login|not logged in|authentication required|HTTP 401/iu.test(said)) return { ok: false, reason: 'signed-out' }
    // GitHub's own words for a refusal, such as "Not Found (HTTP 404)": one line, for the agent that asked.
    const line = said.split(/\r?\n/u).map(part => part.trim()).find(part => /HTTP \d{3}/u.test(part))
    return { ok: false, reason: 'failed', ...(line ? { said: line.slice(0, 300) } : {}) }
  }
}

/** The kind of thing a path reads, for the use record: never which repository or which issue. */
export function gitHubReadKind(path: string): PluginReadKind {
  const parts = path.toLowerCase().split('/')
  if (parts[0] === 'search') return 'search'
  if (parts[0] === 'user' || parts[0] === 'users' || parts[0] === 'orgs' || parts[0] === 'notifications') return 'account'
  if (parts[0] !== 'repos') return 'other'
  const thing = parts[3]
  if (thing === undefined) return 'repository'
  if (thing === 'issues') return 'issues'
  if (thing === 'pulls') return 'pull-requests'
  if (thing === 'commits' || thing === 'compare' || thing === 'branches' || thing === 'git') return 'commits'
  if (thing === 'actions' || thing === 'check-runs' || thing === 'check-suites' || thing === 'statuses') return 'checks'
  if (thing === 'releases' || thing === 'tags') return 'releases'
  return 'repository'
}
