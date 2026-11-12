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
 * The states gh gives a sign-in it asked GitHub about and found gone: `error` is one GitHub refused, `refresh_expired`
 * one gh has already removed because it could not be renewed. Both want `gh auth login`. Any other state that is not
 * `success`, `timeout` above all, is a sign-in gh could not check, which is not the same as signed out.
 */
const GONE_STATES: ReadonlySet<string> = new Set(['error', 'refresh_expired'])

/**
 * Who the `gh` command is signed in to github.com as on this computer (ADR-0205): GitHub's plugin account is gh's own
 * sign-in, so this asks gh and stores nothing. It reads the account's name and whether gh counts the sign-in good, and
 * never a token. gh acts as its active account, so that is the one read: a good older sign-in listed beside a failing
 * active one is not who gh is. A gh too old for `--json` words its status for a person, on either stream, and is asked
 * again that way; a gh that failed for any other reason, a timeout among them, is not asked twice. Run from the home
 * folder, since the answer is the same in every folder.
 */
export async function readGitHubSignIn(run: RunGitCommand, signal?: AbortSignal): Promise<GitHubSignIn> {
  const options = { timeoutMs: TIMEOUT_MS, ...(signal ? { signal } : {}) }
  let listed: string
  try {
    listed = await run(homedir(), 'gh', ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], options)
  } catch (error) {
    if (error instanceof GitUnavailableError) return { state: 'not-installed' }
    const said = saidBy(error)
    if (/unknown flag|unknown shorthand|--json/iu.test(said)) return readWords(run, options)
    return /not logged in/iu.test(said) ? { state: 'signed-out' } : { state: 'unknown' }
  }
  let parsed: z.infer<typeof statusSchema>
  try { parsed = statusSchema.parse(JSON.parse(listed)) } catch { return { state: 'unknown' } }
  const accounts = parsed.hosts[HOST] ?? []
  if (accounts.length === 0) return { state: 'signed-out' }
  const account = accounts.find(entry => entry.active === true) ?? (accounts.length === 1 ? accounts[0] : undefined)
  if (!account) return { state: 'unknown' }
  if (account.state === 'success') return account.login ? signedIn(account.login) : { state: 'unknown' }
  return account.state !== undefined && GONE_STATES.has(account.state) ? { state: 'signed-out' } : { state: 'unknown' }
}

/** Starts with one account's line in gh's worded status: signed in, refused, or not checked in time. */
const ACCOUNT_LINE = /(Logged in to|Failed to log in to|Timeout trying to log in to) github\.com (?:account|as) (\S+)/u

async function readWords(run: RunGitCommand, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<GitHubSignIn> {
  // An older gh prints a good status on its error stream and ends well, so both streams are read as they are printed.
  const lines: string[] = []
  try {
    lines.push(await run(homedir(), 'gh', ['auth', 'status', '--hostname', HOST], { ...options, onLine: line => { lines.push(line) } }))
  } catch (error) {
    if (error instanceof GitUnavailableError) return { state: 'not-installed' }
    // gh ends with an error when it is signed in nowhere, or when a sign-in fails, and says so on either stream.
    lines.push(saidBy(error))
  }
  const text = lines.join('\n')
  // One block per account: its line, then what gh says of it until the next account's line.
  const blocks: { readonly kind: string; readonly login: string; readonly active: boolean | undefined; readonly text: string }[] = []
  for (const line of text.split(/\r?\n/u)) {
    const account = ACCOUNT_LINE.exec(line)
    if (account) blocks.push({ kind: account[1]!, login: account[2]!, active: undefined, text: line })
    else if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]!
      const active = /Active account: (true|false)/u.exec(line)?.[1]
      blocks[blocks.length - 1] = { ...last, active: active === undefined ? last.active : active === 'true', text: `${last.text}\n${line}` }
    }
  }
  if (blocks.length === 0) return /not logged in/iu.test(text) ? { state: 'signed-out' } : { state: 'unknown' }
  // A gh that keeps several accounts marks the one it acts as. One older than that keeps a single account.
  const marked = blocks.some(block => block.active !== undefined)
  const acting = marked ? blocks.find(block => block.active === true) : blocks[0]
  if (!acting) return { state: 'unknown' }
  if (acting.kind === 'Logged in to') return signedIn(acting.login)
  return acting.kind === 'Failed to log in to' ? { state: 'signed-out' } : { state: 'unknown' }
}

/** What a failed gh said, on either stream, for reading alone: it is never shown or logged. */
function saidBy(error: unknown): string {
  return error instanceof Error ? `${String((error as { stdout?: unknown }).stdout ?? '')}\n${error.message}` : ''
}

function signedIn(login: string): GitHubSignIn {
  // A name gh printed: GitHub's are letters, digits and hyphens. Anything else is not shown as one.
  return /^[A-Za-z0-9-]{1,100}$/u.test(login) ? { state: 'signed-in', login } : { state: 'unknown' }
}

/**
 * One read of gh's sign-in at a time: a page opened again, or Check again pressed, while gh is still being asked joins
 * that read rather than starting another gh beside it.
 */
export function sharedGitHubSignIn(read: () => Promise<GitHubSignIn>): () => Promise<GitHubSignIn> {
  let running: Promise<GitHubSignIn> | undefined
  return () => {
    running ??= read().finally(() => { running = undefined })
    return running
  }
}
