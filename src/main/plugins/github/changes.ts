import { homedir } from 'node:os'
import { GitUnavailableError, type RunGitCommand } from '../../agents/git/gitStatus'

const HOST = 'github.com'
const TIMEOUT_MS = 30_000
const ACCEPT = 'Accept: application/vnd.github+json'
/** An account or organisation's name: letters, digits and hyphens, as GitHub allows. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
/** A repository's name: letters, digits, dots, hyphens and underscores, and never a path of its own. */
export const GITHUB_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u
/** GitHub's own limit on a comment's length, and on an issue's body. */
export const GITHUB_COMMENT_MAX = 65_536
/** GitHub's own limit on an issue's title. */
export const GITHUB_TITLE_MAX = 256

export type GitHubChange =
  | { readonly ok: true; readonly url: string | null }
  | { readonly ok: false; readonly reason: 'not-installed' | 'signed-out' | 'failed'; readonly said?: string }

/** What GitHub says of one issue, as far as a card and a check need it. The title is GitHub's words: shown, never trusted. */
export type GitHubIssue =
  | { readonly ok: true; readonly title: string; readonly state: 'open' | 'closed'; readonly pullRequest: boolean }
  | { readonly ok: false; readonly reason: 'not-installed' | 'signed-out' | 'failed'; readonly said?: string }

interface Place { readonly owner: string; readonly repo: string }
const placed = (input: Place): boolean => GITHUB_OWNER.test(input.owner) && GITHUB_REPO.test(input.repo)
const numbered = (number: number): boolean => Number.isSafeInteger(number) && number >= 1

/** Why gh would not do it, from what it wrote: not installed, signed out, or GitHub's own one line such as "Not Found (HTTP 404)". */
function refusal(error: unknown): { readonly ok: false; readonly reason: 'not-installed' | 'signed-out' | 'failed'; readonly said?: string } {
  if (error instanceof GitUnavailableError) return { ok: false, reason: 'not-installed' }
  const said = error instanceof Error ? error.message : ''
  if (/gh auth login|not logged in|authentication required|HTTP 401/iu.test(said)) return { ok: false, reason: 'signed-out' }
  const line = said.split(/\r?\n/u).map(part => part.trim()).find(part => /HTTP \d{3}/u.test(part))
  return { ok: false, reason: 'failed', ...(line ? { said: line.slice(0, 300) } : {}) }
}

/**
 * One change on github.com as the account gh is signed in to (ADR-0205): `gh api` with POST or PATCH, called only
 * after the user allowed it. What is sent goes as a JSON body on standard input, so its words are never an argument:
 * nothing in them can be read as an option of gh's or as a file for gh to open. The path is built by the caller from
 * parts it has checked.
 */
async function send(run: RunGitCommand, method: 'POST' | 'PATCH', path: string, body: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<GitHubChange> {
  const args = ['api', '--method', method, '--hostname', HOST, '-H', ACCEPT, path, '--input', '-']
  try {
    const answer = await run(homedir(), 'gh', args, { timeoutMs: TIMEOUT_MS, stdin: JSON.stringify(body), ...(signal ? { signal } : {}) })
    let url: string | null = null
    try {
      const said = (JSON.parse(answer) as { html_url?: unknown }).html_url
      // Only an address on github.com is handed back as the thing's own.
      if (typeof said === 'string' && said.length <= 500 && new URL(said).origin === 'https://github.com') url = said
    } catch { /* Done, with nothing readable said of where. */ }
    return { ok: true, url }
  } catch (error) { return refusal(error) }
}

/** Posts a comment on an issue or pull request. The owner, the repository and the number are checked before they go into the path. */
export async function commentOnGitHub(run: RunGitCommand, input: Place & { readonly number: number; readonly body: string }, signal?: AbortSignal): Promise<GitHubChange> {
  if (!placed(input) || !numbered(input.number) || input.body.trim() === '' || input.body.length > GITHUB_COMMENT_MAX) return { ok: false, reason: 'failed' }
  return send(run, 'POST', `repos/${input.owner}/${input.repo}/issues/${input.number}/comments`, { body: input.body }, signal)
}

/** Opens an issue with a title and, where one was given, a body. Nothing else is set: no labels, nobody assigned. */
export async function openGitHubIssue(run: RunGitCommand, input: Place & { readonly title: string; readonly body: string }, signal?: AbortSignal): Promise<GitHubChange> {
  if (!placed(input) || input.title.trim() === '' || input.title.length > GITHUB_TITLE_MAX || input.body.length > GITHUB_COMMENT_MAX) return { ok: false, reason: 'failed' }
  return send(run, 'POST', `repos/${input.owner}/${input.repo}/issues`, { title: input.title, ...(input.body ? { body: input.body } : {}) }, signal)
}

/**
 * Closes an issue, as finished or as not going to be done, or opens it again. GitHub's issues address also answers
 * for pull requests, so the caller reads the number first and never calls this for one.
 */
export async function setGitHubIssueState(run: RunGitCommand, input: Place & { readonly number: number; readonly state: 'open' | 'closed'; readonly reason?: 'completed' | 'not_planned' }, signal?: AbortSignal): Promise<GitHubChange> {
  if (!placed(input) || !numbered(input.number)) return { ok: false, reason: 'failed' }
  const body = input.state === 'closed' ? { state: 'closed', state_reason: input.reason ?? 'completed' } : { state: 'open' }
  return send(run, 'PATCH', `repos/${input.owner}/${input.repo}/issues/${input.number}`, body, signal)
}

/** A line of GitHub's safe to show on a card: one line, no control characters, never long. */
const shown = (value: string): string => [...value].filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 200)

/**
 * Reads one issue before a change to it is asked for: its title, so the card names it in words, whether it is open,
 * and whether the number is a pull request's, which a change to an issue must leave alone. A read, so it asks nobody.
 * gh picks the three facts out itself (`--jq`), so an issue of any length answers in a line.
 */
export async function describeGitHubIssue(run: RunGitCommand, input: Place & { readonly number: number }, signal?: AbortSignal): Promise<GitHubIssue> {
  if (!placed(input) || !numbered(input.number)) return { ok: false, reason: 'failed' }
  const args = ['api', '--method', 'GET', '--hostname', HOST, '-H', ACCEPT, `repos/${input.owner}/${input.repo}/issues/${input.number}`,
    '--jq', '{title: .title, state: .state, pullRequest: has("pull_request")}']
  try {
    const answer = JSON.parse(await run(homedir(), 'gh', args, { timeoutMs: TIMEOUT_MS, ...(signal ? { signal } : {}) })) as { title?: unknown; state?: unknown; pullRequest?: unknown }
    if (typeof answer.title !== 'string' || (answer.state !== 'open' && answer.state !== 'closed') || typeof answer.pullRequest !== 'boolean') return { ok: false, reason: 'failed' }
    return { ok: true, title: shown(answer.title), state: answer.state, pullRequest: answer.pullRequest }
  } catch (error) {
    // An answer that is not what was asked for is a failure, not a refusal of gh's.
    return error instanceof SyntaxError ? { ok: false, reason: 'failed' } : refusal(error)
  }
}
