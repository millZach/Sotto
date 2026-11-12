import { homedir } from 'node:os'
import { z } from 'zod'
import type { GitHubSignIn } from '../../../shared/plugins'
import { GitUnavailableError, type RunGitCommand } from '../../agents/git/gitStatus'

const HOST = 'github.com'
const TIMEOUT_MS = 15_000

/** What `gh auth status --json hosts` prints, as far as this reads it. gh adds no token to it unless asked to. */
const statusSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({ active: z.boolean().optional(), login: z.string().optional(), state: z.string().optional() }))),
})

/**
 * Who the `gh` command is signed in to github.com as on this computer (ADR-0205): GitHub's plugin account is gh's own
 * sign-in, so this asks gh and stores nothing. It reads the account's name and whether gh counts the sign-in good, and
 * never a token. A gh too old for `--json` words its status for a person, and only the "Logged in to" line is read.
 * Run from the home folder, since the answer is the same in every folder.
 */
export async function readGitHubSignIn(run: RunGitCommand, signal?: AbortSignal): Promise<GitHubSignIn> {
  const options = { timeoutMs: TIMEOUT_MS, ...(signal ? { signal } : {}) }
  let listed: string
  try {
    listed = await run(homedir(), 'gh', ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], options)
  } catch (error) {
    if (error instanceof GitUnavailableError) return { state: 'not-installed' }
    return readWords(run, options)
  }
  let parsed: z.infer<typeof statusSchema>
  try { parsed = statusSchema.parse(JSON.parse(listed)) } catch { return { state: 'unknown' } }
  const accounts = parsed.hosts[HOST] ?? []
  const account = accounts.find(entry => entry.active !== false && entry.state === 'success' && entry.login)
    ?? accounts.find(entry => entry.state === 'success' && entry.login)
  return account?.login ? signedIn(account.login) : { state: 'signed-out' }
}

async function readWords(run: RunGitCommand, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<GitHubSignIn> {
  let text: string
  try {
    text = await run(homedir(), 'gh', ['auth', 'status', '--hostname', HOST], options)
  } catch (error) {
    if (error instanceof GitUnavailableError) return { state: 'not-installed' }
    // gh ends with an error when it is signed in nowhere, and says so on either stream.
    text = error instanceof Error ? `${String((error as { stdout?: unknown }).stdout ?? '')}\n${error.message}` : ''
  }
  const login = /Logged in to github\.com (?:account|as) (\S+)/u.exec(text)?.[1]
  if (login) return signedIn(login)
  return /not logged in|gh auth login/iu.test(text) ? { state: 'signed-out' } : { state: 'unknown' }
}

function signedIn(login: string): GitHubSignIn {
  // A name gh printed: GitHub's are letters, digits and hyphens. Anything else is not shown as one.
  return /^[A-Za-z0-9-]{1,100}$/u.test(login) ? { state: 'signed-in', login } : { state: 'unknown' }
}
