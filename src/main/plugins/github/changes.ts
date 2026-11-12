import { homedir } from 'node:os'
import { GitUnavailableError, type RunGitCommand } from '../../agents/git/gitStatus'

const HOST = 'github.com'
const TIMEOUT_MS = 30_000
/** An account or organisation's name: letters, digits and hyphens, as GitHub allows. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
/** A repository's name: letters, digits, dots, hyphens and underscores, and never a path of its own. */
export const GITHUB_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u
/** GitHub's own limit on a comment's length. */
export const GITHUB_COMMENT_MAX = 65_536

export type GitHubChange =
  | { readonly ok: true; readonly url: string | null }
  | { readonly ok: false; readonly reason: 'not-installed' | 'signed-out' | 'failed'; readonly said?: string }

/**
 * Posts a comment on an issue or pull request as the account gh is signed in to (ADR-0205): `gh api` with POST on
 * github.com, called only after the user allowed it. The comment goes as a JSON body on standard input, so its words
 * are never an argument: nothing in them can be read as an option of gh's or as a file for gh to open. The owner, the
 * repository and the number are checked before they go into the path.
 */
export async function commentOnGitHub(run: RunGitCommand, input: { readonly owner: string; readonly repo: string; readonly number: number; readonly body: string }, signal?: AbortSignal): Promise<GitHubChange> {
  if (!GITHUB_OWNER.test(input.owner) || !GITHUB_REPO.test(input.repo) || !Number.isSafeInteger(input.number) || input.number < 1
    || input.body.trim() === '' || input.body.length > GITHUB_COMMENT_MAX) return { ok: false, reason: 'failed' }
  const args = ['api', '--method', 'POST', '--hostname', HOST, '-H', 'Accept: application/vnd.github+json',
    `repos/${input.owner}/${input.repo}/issues/${input.number}/comments`, '--input', '-']
  try {
    const answer = await run(homedir(), 'gh', args, { timeoutMs: TIMEOUT_MS, stdin: JSON.stringify({ body: input.body }), ...(signal ? { signal } : {}) })
    let url: string | null = null
    try {
      const said = (JSON.parse(answer) as { html_url?: unknown }).html_url
      // Only an address on github.com is handed back as the comment's own.
      if (typeof said === 'string' && said.length <= 500 && new URL(said).origin === 'https://github.com') url = said
    } catch { /* Posted, with nothing readable said of where. */ }
    return { ok: true, url }
  } catch (error) {
    if (error instanceof GitUnavailableError) return { ok: false, reason: 'not-installed' }
    const said = error instanceof Error ? error.message : ''
    if (/gh auth login|not logged in|authentication required|HTTP 401/iu.test(said)) return { ok: false, reason: 'signed-out' }
    const line = said.split(/\r?\n/u).map(part => part.trim()).find(part => /HTTP \d{3}/u.test(part))
    return { ok: false, reason: 'failed', ...(line ? { said: line.slice(0, 300) } : {}) }
  }
}
