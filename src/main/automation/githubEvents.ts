import type { RunGitCommand } from '../agents/git/gitStatus'

/**
 * New GitHub issues and pull requests for a scheduled task's GitHub trigger (ADR-0218), read through `gh`, the GitHub
 * sign-in Sotto already uses on this computer: no new host and no token of Sotto's. GitHub can't reach this computer, so
 * the task asks it every couple of minutes while scheduled tasks are on. What an issue says is outside words, carried to
 * the run as data; it starts only the run the user set up, and nothing of it is logged.
 */

export interface GitHubEvent {
  readonly kind: 'issue' | 'pull-request'
  readonly repository: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly author: string
  readonly labels: readonly string[]
  readonly createdAt: string
}

/** How often a task's GitHub trigger asks GitHub. */
export const GITHUB_POLL_MS = 2 * 60_000
const BODY_KEPT = 8000
const PAGE = 50

export class GitHubReadError extends Error {}

interface ApiIssue {
  readonly number?: unknown; readonly title?: unknown; readonly body?: unknown; readonly html_url?: unknown; readonly created_at?: unknown
  readonly user?: { readonly login?: unknown }; readonly labels?: readonly { readonly name?: unknown }[]; readonly pull_request?: unknown
}

/** The repository a project's folder pushes to, as `owner/name`, from gh. */
export async function projectRepository(run: RunGitCommand, cwd: string): Promise<string> {
  try {
    const name = (await run(cwd, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { timeoutMs: 20_000 })).trim()
    if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u.test(name)) return name
  } catch { /* Said below. */ }
  throw new GitHubReadError('gh could not tell which GitHub repository this project is. Name it in the task as owner/name.')
}

/**
 * Issues and pull requests opened at or after `since`, oldest first (the run keys drop one seen before), of the kinds the trigger names and, when it names one,
 * carrying its label.
 */
export async function readGitHubEvents(run: RunGitCommand, cwd: string, trigger: {
  readonly repository: string; readonly since: string; readonly issues: boolean; readonly pullRequests: boolean; readonly label?: string | undefined
}): Promise<GitHubEvent[]> {
  let output: string
  try {
    output = await run(cwd, 'gh', ['api', '--paginate', '--slurp', '-X', 'GET', `repos/${trigger.repository}/issues`, '-f', 'state=all', '-f', 'sort=created', '-f', 'direction=desc',
      '-f', `per_page=${PAGE}`, '-f', `since=${trigger.since}`, ...trigger.label ? ['-f', `labels=${trigger.label}`] : []], { timeoutMs: 30_000 })
  } catch {
    throw new GitHubReadError(`GitHub could not be read for ${trigger.repository}. Check that gh is signed in on this computer and can see that repository.`)
  }
  let pages: unknown
  try { pages = JSON.parse(output) } catch { throw new GitHubReadError('GitHub answered with something Sotto could not read.') }
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new GitHubReadError('GitHub answered with something Sotto could not read.')
  const since = Date.parse(trigger.since)
  const events: GitHubEvent[] = []
  for (const item of pages.flat() as ApiIssue[]) {
    if (!item || typeof item.number !== 'number' || typeof item.created_at !== 'string' || !(Date.parse(item.created_at) >= since)) continue
    const kind = item.pull_request ? 'pull-request' : 'issue'
    if (kind === 'issue' ? !trigger.issues : !trigger.pullRequests) continue
    events.push({
      kind, repository: trigger.repository, number: item.number,
      title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
      body: typeof item.body === 'string' ? item.body.slice(0, BODY_KEPT) : '',
      url: typeof item.html_url === 'string' ? item.html_url : '',
      author: typeof item.user?.login === 'string' ? item.user.login : '',
      labels: (item.labels ?? []).flatMap(label => typeof label.name === 'string' ? [label.name] : []),
      createdAt: item.created_at,
    })
  }
  return events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}
