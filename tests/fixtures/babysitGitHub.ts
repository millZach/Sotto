import type { RunGitCommand } from '../../src/main/agents/gitStatus'

/**
 * A scripted GitHub for babysitting (ADR-0061): pull requests as plain records a test changes between passes, and a
 * scripted `gh api graphql` that answers the fingerprint and the detail from them the way GitHub shapes its answers.
 * Every question is recorded, so a test counts reads exactly.
 */
export type CheckState = 'QUEUED' | 'IN_PROGRESS' | 'WAITING' | 'SUCCESS' | 'FAILURE' | 'CANCELLED' | 'SKIPPED' | 'NEUTRAL'
export interface ScriptedCheck { name: string; state: CheckState; required?: boolean; url?: string }
export interface ScriptedRemark { id: string; author: string | null; at: string; editedAt?: string; url?: string }
export interface ScriptedReview extends ScriptedRemark { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING'; inline?: number }
export interface ScriptedPull {
  number: number; owner?: string; name?: string; title?: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'; mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; head?: string; base?: string
  checks?: ScriptedCheck[]; comments?: ScriptedRemark[]; reviews?: ScriptedReview[]; threads?: Array<{ path: string; comments: ScriptedRemark[] }>
}
export interface GhQuestion { readonly kind: 'fingerprint' | 'detail'; readonly variables: Readonly<Record<string, string>>; readonly query: string }

const RUNNING: ReadonlySet<CheckState> = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING'])

/** The `-f`/`-F` variables of a `gh api graphql` call, by name. */
export function graphqlVariables(args: readonly string[]): Record<string, string> {
  const variables: Record<string, string> = {}
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== '-f' && args[index] !== '-F') continue
    const pair = args[index + 1]!
    const split = pair.indexOf('=')
    variables[pair.slice(0, split)] = pair.slice(split + 1)
  }
  return variables
}

export function scriptedGitHub(pulls: ScriptedPull[], options: { viewer?: string; now?: () => number } = {}) {
  const questions: GhQuestion[] = []
  /** Set to make gh fail the next questions with this error; cleared by setting null. */
  let failure: Error | null = null
  const find = (owner: string, name: string, number: number): ScriptedPull | undefined =>
    pulls.find(pull => (pull.owner ?? 'o') === owner && (pull.name ?? 'r') === name && pull.number === number)
  const rateLimit = () => ({ limit: 5000, remaining: 4000, resetAt: new Date((options.now?.() ?? Date.now()) + 3_600_000).toISOString() })
  const countsBy = (checks: readonly ScriptedCheck[]) => {
    const counts = new Map<string, number>()
    for (const check of checks) counts.set(check.state, (counts.get(check.state) ?? 0) + 1)
    return [...counts].map(([state, count]) => ({ state, count }))
  }
  const remarkNode = (remark: ScriptedRemark) => ({ id: remark.id, url: remark.url ?? `https://github.com/o/r/pull/1#${remark.id}`, createdAt: remark.at, lastEditedAt: remark.editedAt ?? null, author: remark.author === null ? null : { login: remark.author } })
  const fingerprintOf = (pull: ScriptedPull) => {
    const comments = pull.comments ?? [], reviews = pull.reviews ?? [], threads = pull.threads ?? []
    return {
      number: pull.number, title: pull.title ?? `Pull ${pull.number}`, url: `https://github.com/${pull.owner ?? 'o'}/${pull.name ?? 'r'}/pull/${pull.number}`,
      state: pull.state ?? 'OPEN', mergeable: pull.mergeable ?? 'MERGEABLE', headRefOid: pull.head ?? 'head-1', baseRefName: pull.base ?? 'main',
      comments: { totalCount: comments.length, nodes: comments.map(comment => ({ lastEditedAt: comment.editedAt ?? null })) },
      // A reply in a review thread is a review, so each thread comment counts as one here, as GitHub counts it.
      reviews: { totalCount: reviews.length + threads.reduce((sum, thread) => sum + thread.comments.length, 0), nodes: reviews.map(review => ({ lastEditedAt: review.editedAt ?? null })) },
      reviewThreads: { totalCount: threads.length },
      commits: { nodes: [{ commit: { statusCheckRollup: (pull.checks ?? []).length ? { contexts: { checkRunCountsByState: countsBy(pull.checks ?? []), statusContextCountsByState: [] } } : null } }] },
    }
  }
  const detailOf = (pull: ScriptedPull, checks: boolean, remarks: boolean) => ({
    headRefOid: pull.head ?? 'head-1',
    ...checks ? { commits: { nodes: [{ commit: { oid: pull.head ?? 'head-1', statusCheckRollup: (pull.checks ?? []).length ? { contexts: { nodes: (pull.checks ?? []).map(check => ({
      __typename: 'CheckRun', name: check.name, status: RUNNING.has(check.state) ? check.state : 'COMPLETED', conclusion: RUNNING.has(check.state) ? null : check.state,
      detailsUrl: check.url ?? `https://github.com/o/r/actions/runs/${check.name}`, isRequired: check.required === true, checkSuite: null,
    })) } } : null } }] } } : {},
    ...remarks ? {
      comments: { nodes: (pull.comments ?? []).map(remarkNode) },
      reviews: { nodes: (pull.reviews ?? []).map(review => ({ ...remarkNode(review), state: review.state, submittedAt: review.at, comments: { totalCount: review.inline ?? 0 } })) },
      reviewThreads: { nodes: (pull.threads ?? []).map(thread => ({ path: thread.path, comments: { nodes: thread.comments.map(remarkNode) } })) },
    } : {},
  })
  const run: RunGitCommand = async (_cwd, command, args) => {
    if (command !== 'gh' || args[0] !== 'api' || args[1] !== 'graphql') throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    const variables = graphqlVariables(args)
    const query = variables['query'] ?? ''
    const kind = query.includes('BabysitFingerprint') ? 'fingerprint' : 'detail'
    questions.push({ kind, variables, query })
    if (failure) throw failure
    const owner = variables['owner']!, name = variables['name']!
    if (kind === 'fingerprint') {
      const repository: Record<string, unknown> = {}
      const errors: unknown[] = []
      for (const [key, value] of Object.entries(variables)) {
        if (!/^p\d+$/u.test(key)) continue
        const pull = find(owner, name, Number(value))
        repository[key] = pull ? fingerprintOf(pull) : null
        if (!pull) errors.push({ type: 'NOT_FOUND', path: ['repository', key], message: `Could not resolve to a PullRequest with the number of ${value}.` })
      }
      const body = JSON.stringify({ data: { rateLimit: rateLimit(), viewer: { login: options.viewer ?? 'me' }, repository }, ...errors.length ? { errors } : {} })
      // gh prints GitHub's answer and fails when the answer carries errors, as it does for a pull request it cannot find.
      if (errors.length) throw Object.assign(new Error('gh: Could not resolve to a PullRequest with the number of 99.'), { stdout: body })
      return body
    }
    const pull = find(owner, name, Number(variables['number']))
    return JSON.stringify({ data: { rateLimit: rateLimit(), repository: { pullRequest: pull ? detailOf(pull, variables['checks'] === 'true', variables['remarks'] === 'true') : null } } })
  }
  return {
    run, questions,
    fail(error: Error | null) { failure = error },
    count(kind: GhQuestion['kind']) { return questions.filter(question => question.kind === kind).length },
    reset() { questions.length = 0 },
  }
}
