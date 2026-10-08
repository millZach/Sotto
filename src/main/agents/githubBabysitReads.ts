import { z } from 'zod'
import { RATE_LIMIT_SELECTION, rateLimitSchema } from './github'
import { checkOf, checksRefused } from './gitPullRequests'
import type { GitPullRequestCheck } from '../../shared/gitPullRequests'

/**
 * What babysitting asks GitHub (ADR-0061 decision 13), as GraphQL documents and their readings. Two questions: the
 * fingerprint, one batched query per repository that says what moved, and the detail of one pull request, its checks or
 * its remarks or both, asked only for what the fingerprint says moved. Electron-free.
 */

/** Pull requests asked about in one fingerprint: T3 measured 25 at one point with `rateLimit(dryRun: true)` (T3 #16270). */
export const FINGERPRINT_PER_QUERY = 25

/**
 * T3's fingerprint selection (`PULL_REQUEST_WATCH_FINGERPRINT_SELECTION`, checked against live pull requests in T3
 * #16270), with the number, title, link and base it costs nothing more to name. Counts and the newest edit cover new
 * comments, reviews (a reply in a review thread is a review) and threads, and a bot rewriting its summary; check counts
 * by state move whenever a check starts or finishes. Comments come most recently updated first, so an edit to an old
 * comment is still in the page.
 */
const FINGERPRINT_SELECTION = 'number title url state mergeable headRefOid baseRefName '
  + 'comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { lastEditedAt } } '
  + 'reviews(last: 100) { totalCount nodes { lastEditedAt } } '
  + 'reviewThreads { totalCount } '
  + 'commits(last: 1) { nodes { commit { statusCheckRollup { contexts { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }'

/**
 * The fingerprint of up to 25 pull requests of one repository: one aliased `pullRequest` each, its number passed as a
 * variable rather than written into the document, with GitHub's reading of the rate limit and the sign-in beside them.
 */
export function fingerprintQuery(count: number): string {
  const declarations = ['$owner: String!', '$name: String!', ...Array.from({ length: count }, (_, index) => `$p${index}: Int!`)]
  const selections = Array.from({ length: count }, (_, index) => `    p${index}: pullRequest(number: $p${index}) { ${FINGERPRINT_SELECTION} }`)
  return `query BabysitFingerprint(${declarations.join(', ')}) {\n  ${RATE_LIMIT_SELECTION}\n  viewer { login }\n  repository(owner: $owner, name: $name) {\n${selections.join('\n')}\n  }\n}`
}

const loose = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()
const editedSchema = z.object({ totalCount: z.number().int().nonnegative(), nodes: loose(z.array(loose(z.object({ lastEditedAt: loose(z.string()) })))) })
const stateCountsSchema = loose(z.array(loose(z.object({ state: z.string(), count: z.number().int() }))))
const fingerprintNodeSchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string(), state: z.string(), mergeable: loose(z.string()),
  headRefOid: loose(z.string()), baseRefName: loose(z.string()), comments: editedSchema, reviews: editedSchema,
  reviewThreads: z.object({ totalCount: z.number().int().nonnegative() }),
  commits: loose(z.object({ nodes: loose(z.array(loose(z.object({ commit: loose(z.object({
    statusCheckRollup: loose(z.object({ contexts: loose(z.object({ checkRunCountsByState: stateCountsSchema, statusContextCountsByState: stateCountsSchema })) })),
  })) })))) })),
})
const fingerprintAnswerSchema = z.object({ data: z.object({
  rateLimit: rateLimitSchema, viewer: loose(z.object({ login: loose(z.string()) })),
  repository: z.record(z.string(), z.unknown()).nullable(),
}) })

/** One pull request as the fingerprint read it. */
export interface PullRequestFingerprint {
  readonly number: number; readonly title: string; readonly url: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown'
  readonly head: string | null; readonly base: string
  /** State, mergeability, head and check counts: when this moves, the checks are read. */
  readonly status: string
  /** Comment, review and review-thread counts and the newest edits: when this moves, the remarks are read. */
  readonly remarks: string
  /** A check is queued or still running, so the checks are read every pass until none is. */
  readonly checksRunning: boolean
  readonly reviewThreads: number
}
export interface FingerprintAnswer {
  readonly rateLimit: z.infer<typeof rateLimitSchema>
  readonly viewer: string | null
  /** By the number asked about; a pull request GitHub answered nothing for (gone, or not visible to the sign-in) is absent. */
  readonly pullRequests: ReadonlyMap<number, PullRequestFingerprint>
}

/**
 * Check states a check is still on its way in: queued, running, or a status reported pending. Waiting is a check needing
 * action. A status expected and never reported is not running: a path-filtered required workflow can leave one expected
 * for good, and its reporting moves the counts, so the fingerprint finds it without a read every pass (decision 13).
 */
const RUNNING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED'])
// An edit only ever moves `lastEditedAt` forward, so the newest one stands for them all.
const newestEdit = (connection: z.infer<typeof editedSchema>): string =>
  (connection.nodes ?? []).reduce((newest, node) => node?.lastEditedAt && node.lastEditedAt > newest ? node.lastEditedAt : newest, '')
const stateCounts = (counts: z.infer<typeof stateCountsSchema>): string =>
  (counts ?? []).flatMap(entry => entry && entry.count > 0 ? [`${entry.state}:${entry.count}`] : []).sort().join(',')

/** Reads a fingerprint answer, given the numbers in the order they were asked. Throws when it is not GitHub's answer. */
export function readFingerprint(text: string, numbers: readonly number[]): FingerprintAnswer {
  const answer = fingerprintAnswerSchema.parse(JSON.parse(text))
  const pullRequests = new Map<number, PullRequestFingerprint>()
  numbers.forEach((number, index) => {
    const parsed = fingerprintNodeSchema.safeParse(answer.data.repository?.[`p${index}`])
    if (!parsed.success || parsed.data.number !== number) return
    const node = parsed.data
    const upper = node.state.toUpperCase()
    const mergeable = node.mergeable?.toUpperCase()
    const contexts = node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts
    const checkRuns = contexts?.checkRunCountsByState ?? [], statuses = contexts?.statusContextCountsByState ?? []
    const checks = `${stateCounts(checkRuns)} ${stateCounts(statuses)}`
    pullRequests.set(number, {
      number, title: node.title, url: node.url,
      state: upper === 'MERGED' ? 'merged' : upper === 'CLOSED' ? 'closed' : 'open',
      mergeable: mergeable === 'MERGEABLE' ? 'mergeable' : mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
      head: node.headRefOid ?? null, base: node.baseRefName ?? '',
      status: [upper, mergeable ?? '', node.headRefOid ?? '', checks].join(' '),
      remarks: [node.comments.totalCount, newestEdit(node.comments), node.reviews.totalCount, newestEdit(node.reviews), node.reviewThreads.totalCount].join(' '),
      checksRunning: [...checkRuns, ...statuses].some(entry => entry != null && entry.count > 0 && RUNNING.has(entry.state.toUpperCase())),
      reviewThreads: node.reviewThreads.totalCount,
    })
  })
  return { rateLimit: answer.data.rateLimit, viewer: answer.data.viewer?.login ?? null, pullRequests }
}

/** Review threads read with the remarks, newest last, and the comments read from each. Edits further back wait (T3's limit too). */
const REVIEW_THREADS_READ = 50
const THREAD_COMMENTS_READ = 20
/**
 * The detail of one pull request: its head's checks, each with whether the base branch requires it, and its remarks,
 * each switched on only when the fingerprint says it moved. `isRequired` is asked on github.com, which is the only host
 * Sotto links pull requests from (ADR-0027). No remark's text is asked for: a wake-up never carries it (ADR-0061 decision 7).
 */
export const DETAIL_QUERY = `query BabysitDetail($owner: String!, $name: String!, $number: Int!, $checks: Boolean!, $remarks: Boolean!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) @include(if: $checks) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
      comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $remarks) { nodes { id url createdAt lastEditedAt author { login } } }
      reviews(last: 100) @include(if: $remarks) { nodes { id url state createdAt submittedAt lastEditedAt author { login } comments { totalCount } } }
      reviewThreads(last: ${REVIEW_THREADS_READ}) @include(if: $remarks) { nodes { path comments(last: ${THREAD_COMMENTS_READ}) { nodes { id url createdAt publishedAt lastEditedAt author { login } } } } }
    }
  }
}`

const authorSchema = loose(z.object({ login: loose(z.string()) }))
const remarkFields = { id: z.string(), url: loose(z.string()), createdAt: z.string(), publishedAt: loose(z.string()), lastEditedAt: loose(z.string()), author: authorSchema }
const detailAnswerSchema = z.object({ data: z.object({
  rateLimit: rateLimitSchema,
  repository: z.object({ pullRequest: loose(z.object({
    headRefOid: loose(z.string()),
    commits: loose(z.object({ nodes: loose(z.array(loose(z.object({ commit: loose(z.object({ oid: loose(z.string()), statusCheckRollup: loose(z.object({ contexts: loose(z.object({ nodes: loose(z.array(loose(z.object({
      __typename: loose(z.string()), name: loose(z.string()), context: loose(z.string()), status: loose(z.string()), conclusion: loose(z.string()), state: loose(z.string()),
      detailsUrl: loose(z.string()), targetUrl: loose(z.string()), isRequired: loose(z.boolean()),
      checkSuite: loose(z.object({ workflowRun: loose(z.object({ workflow: loose(z.object({ name: loose(z.string()) })) })) })),
    })))) })) })) })) })))) })),
    comments: loose(z.object({ nodes: loose(z.array(loose(z.object(remarkFields)))) })),
    reviews: loose(z.object({ nodes: loose(z.array(loose(z.object({ ...remarkFields, state: loose(z.string()), submittedAt: loose(z.string()), comments: loose(z.object({ totalCount: z.number().int() })) })))) })),
    reviewThreads: loose(z.object({ nodes: loose(z.array(loose(z.object({ path: loose(z.string()), comments: loose(z.object({ nodes: loose(z.array(loose(z.object(remarkFields)))) })) })))) })),
  })) }).nullable(),
  }),
  /** Where GitHub refused a part of the read: each error's path names the field it left empty. */
  errors: loose(z.array(loose(z.object({ path: loose(z.array(z.union([z.string(), z.number()]))) })))),
})

/** One check on the head commit, as babysitting needs it. */
export interface BabysitCheck { readonly name: string; readonly status: GitPullRequestCheck['status']; readonly url: string | null; readonly required: boolean }
/** One comment or review on the pull request, without what it says. */
export interface BabysitRemark {
  readonly id: string
  readonly kind: 'comment' | 'review' | 'review-comment'
  /** The login of whoever wrote it; null for an account GitHub no longer names. */
  readonly author: string | null
  /** A review's side; null for a comment. */
  readonly review: 'approved' | 'changes-requested' | 'commented' | 'dismissed' | null
  /** The file a review comment is on. */
  readonly path: string | null
  readonly url: string | null
  /** When others could first see it: a review's submission, and a comment drafted in a review its review's. */
  readonly createdAt: string
  /** When it was last edited after that; an edit to a draft is part of what went out. */
  readonly editedAt: string | null
}
export interface DetailAnswer {
  readonly rateLimit: z.infer<typeof rateLimitSchema>
  /** The head the pull request is on now, as this read saw it. */
  readonly head: string | null
  /**
   * The head's checks, or null when they were not asked for, were read from another commit than the head, or GitHub
   * refused them. Null is never no checks: the reader asks again next pass.
   */
  readonly checks: readonly BabysitCheck[] | null
  /** Every remark read, or null when they were not asked for. */
  readonly remarks: readonly BabysitRemark[] | null
}

/** A link GitHub gave, kept only when it is an https link of a sensible length. */
const linkOf = (url: string | null | undefined): string | null => url && /^https:\/\//iu.test(url) && url.length <= 2_048 ? url : null
const REVIEW_STATES: Readonly<Record<string, BabysitRemark['review']>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed' }
/**
 * A remark's times as others saw them. A comment drafted in a pending review keeps the time it was drafted as its
 * `createdAt` and goes out when the review is submitted, so it is timed by when it went out (`publishedAt`, or the
 * review's `submittedAt`), or it could fall before what the thread was already told and never be told. An edit counts
 * only when it came after that: editing a draft is part of the writing.
 */
function remarkTimes(written: string, out: string | null | undefined, edited: string | null | undefined): Pick<BabysitRemark, 'createdAt' | 'editedAt'> {
  const later = (left: string | null | undefined, right: string): boolean => !!left && Date.parse(left) > Date.parse(right)
  const createdAt = later(out, written) ? out! : written
  return { createdAt, editedAt: later(edited, createdAt) ? edited! : null }
}

/** Reads a detail answer for the parts asked. Throws when it is not GitHub's answer, or names no pull request. */
export function readDetail(text: string, asked: { readonly checks: boolean; readonly remarks: boolean }): DetailAnswer {
  const answer = detailAnswerSchema.parse(JSON.parse(text))
  const pullRequest = answer.data.repository?.pullRequest
  if (!pullRequest) throw new Error('GitHub answered no pull request.')
  const head = pullRequest.headRefOid ?? null
  let checks: BabysitCheck[] | null = null
  if (asked.checks) {
    const commits = pullRequest.commits?.nodes
    const commit = commits?.at(-1)?.commit
    const rollup = commit?.statusCheckRollup
    const nodes = rollup?.contexts?.nodes
    // No rollup is a head with no checks. A refusal leaves the same gap with an error naming it, or nulls the check list
    // or one check (GraphQL nulls the nearest field that may be empty), so each is taken as unread rather than as no
    // checks, which would be recorded as read and never asked again with a failure behind it.
    const refused = !commits || (commits.length > 0 && !commit) || checksRefused(answer.errors ?? [])
      || (rollup != null && nodes == null) || (nodes ?? []).some(node => node == null)
    if (!refused && (!commit || commit.oid === head)) {
      checks = (nodes ?? []).flatMap(node => {
        if (!node) return []
        const check = checkOf({ __typename: node.__typename, name: node.name, context: node.context, status: node.status, conclusion: node.conclusion, state: node.state,
          detailsUrl: node.detailsUrl, targetUrl: node.targetUrl, description: null, workflowName: node.checkSuite?.workflowRun?.workflow?.name })
        return [{ name: check.name, status: check.status, url: check.url, required: node.isRequired === true }]
      })
    }
  }
  let remarks: BabysitRemark[] | null = null
  if (asked.remarks) {
    remarks = []
    for (const node of pullRequest.comments?.nodes ?? []) {
      if (node) remarks.push({ id: node.id, kind: 'comment', author: node.author?.login ?? null, review: null, path: null, url: linkOf(node.url), ...remarkTimes(node.createdAt, node.publishedAt, node.lastEditedAt) })
    }
    for (const node of pullRequest.reviews?.nodes ?? []) {
      const review = node?.state ? REVIEW_STATES[node.state.toUpperCase()] : undefined
      // A pending review is the viewer's own draft. A review that only commented, with comments on the code, is told
      // through those comments, each on its file: a reply in a review thread is such a review.
      if (!node || !review || (review === 'commented' && (node.comments?.totalCount ?? 0) > 0)) continue
      remarks.push({ id: node.id, kind: 'review', author: node.author?.login ?? null, review, path: null, url: linkOf(node.url), ...remarkTimes(node.createdAt, node.submittedAt, node.lastEditedAt) })
    }
    for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
      for (const node of thread?.comments?.nodes ?? []) {
        if (node) remarks.push({ id: node.id, kind: 'review-comment', author: node.author?.login ?? null, review: null, path: thread?.path ?? null, url: linkOf(node.url), ...remarkTimes(node.createdAt, node.publishedAt, node.lastEditedAt) })
      }
    }
  }
  return { rateLimit: answer.data.rateLimit, head, checks, remarks }
}
