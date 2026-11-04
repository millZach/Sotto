import { z } from 'zod'

/** A team link joins two owners' desktops over a closed list (ADR-0186); what its messages may do is ADR-0187's. */

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
export const TEAM_LINK_LIFETIME_MS = 30 * DAY
/** How long one owner's Link again waits for the other's. */
export const TEAM_RENEW_WINDOW_MS = 7 * DAY
/** Longer than pairing's five minutes: a code goes between two people, not across one desk. */
export const TEAM_CODE_LIFETIME_MS = 30 * MINUTE
export const TEAM_CODE_TRIES = 5
export const TEAM_ANSWERS_PER_DAY = 20
export const TEAM_ANSWERS_PER_BURST = 5
export const TEAM_BURST_MS = 10 * MINUTE
export const TEAM_ASK_CHARACTERS_MAX = 800
export const TEAM_ANSWER_CHARACTERS_MAX = 4_000
export const TEAM_NAME_MAX = 60
export const TEAM_BODY_BYTES_MAX = 16 * 1024
export const TEAM_MESSAGES_KEPT = 100
/** Tailnet HTTPS ports for the listener, in the order they are tried. Serve carries them; Funnel never does. */
export const TEAM_SERVE_PORTS = [8445, 8446, 8447] as const
export const TEAM_ROUTE = '/teams/v1'
/** How often a computer with a link and no listener asks its own Tailscale whether it can listen yet. */
export const TEAM_RELISTEN_MS = 30_000
/** A team desk's budget (ADR-0189, decision 5): one press reads at most this much, and more than this many presses in a burst are turned down. */
export const TEAM_DESK_THREADS_MAX = 40
export const TEAM_DESK_PULL_REQUESTS_MAX = 5
export const TEAM_DESK_TEXT_MAX = 160
export const TEAM_DESK_BYTES_MAX = 32 * 1024
export const TEAM_DESK_READS_PER_BURST = 10
export const TEAM_DESK_READS_KEPT = 100

export const TEAM_ASKS = ['merge-priority', 'working-on'] as const
export const teamAskSchema = z.enum(TEAM_ASKS)
export type TeamAsk = z.infer<typeof teamAskSchema>

/** Only a `.ts.net` name over HTTPS, so a pasted code cannot point Sotto at any other host. */
const TEAM_HOST = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.ts\.net$/u
export function isTeamAddress(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && TEAM_HOST.test(url.hostname)
}
export const teamAddressSchema = z.string().max(300).refine(isTeamAddress)

/** The name a teammate sees: one short line, no control or format characters. */
export function teamName(value: string): string {
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, TEAM_NAME_MAX).replace(/[\uD800-\uDBFF]$/u, '')
}
const nameSchema = z.string().min(1).max(TEAM_NAME_MAX * 2).transform(teamName).refine(name => name.length > 0)

const CODE_PREFIX = 'sotto-team:'
export interface TeamCode { readonly address: string; readonly code: string }
export function formatTeamCode(address: string, code: string): string {
  const url = new URL(address)
  return `${CODE_PREFIX}${url.hostname}:${url.port || '443'}:${code}`
}
/** A pasted code, or undefined for anything that is not one or names any other host. */
export function parseTeamCode(text: string): TeamCode | undefined {
  const match = /^sotto-team:([a-z0-9.-]{1,253}):(\d{1,5}):([A-Z0-9]{4,16})$/u.exec(text.trim())
  if (!match) return undefined
  const address = `https://${match[1]}:${match[2]}/`
  return isTeamAddress(address) ? { address, code: match[3]! } : undefined
}

/**
 * The closed list (ADR-0186, decision 5; ADR-0189). A strict union of four commands: anything else on the wire fails here, with
 * the sender's token or without it, before anything reads it further.
 */
export const teamWireSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('redeem-code'), code: z.string().min(4).max(16), name: nameSchema, address: teamAddressSchema, token: z.string().min(20).max(512) }).strict(),
  z.object({ command: z.literal('ask'), ask: teamAskSchema, words: z.string().max(TEAM_ASK_CHARACTERS_MAX) }).strict(),
  z.object({ command: z.literal('link-again') }).strict(),
  z.object({ command: z.literal('read-desk') }).strict(),
])
export type TeamWire = z.infer<typeof teamWireSchema>
export const TEAM_WIRE_COMMANDS: readonly TeamWire['command'][] = ['redeem-code', 'ask', 'link-again', 'read-desk']

export const teamRefusalSchema = z.enum(['not-on-the-list', 'not-linked', 'expired', 'code-rejected', 'daily-cap', 'too-many', 'busy'])
export type TeamRefusal = z.infer<typeof teamRefusalSchema>
const refused = z.object({ status: z.literal('refused'), reason: teamRefusalSchema }).strict()
export const teamRedeemAnswerSchema = z.union([z.object({ status: z.literal('linked'), name: nameSchema, token: z.string().min(20).max(512), expiresAt: z.iso.datetime() }).strict(), refused])
export const teamAskAnswerSchema = z.union([z.object({ status: z.literal('answered'), words: z.string().min(1).max(TEAM_ANSWER_CHARACTERS_MAX), plain: z.literal(true).optional() }).strict(), refused])
export const teamAgainAnswerSchema = z.union([z.object({ status: z.literal('waiting') }).strict(), z.object({ status: z.literal('renewed'), expiresAt: z.iso.datetime() }).strict(), refused])
export type TeamAnswer = z.infer<typeof teamAskAnswerSchema>

export const TEAM_THREAD_STANDS = ['working', 'waiting-on-its-owner', 'failed', 'idle'] as const
const teamChecksSchema = z.enum(['passed', 'pending', 'failed', 'unknown'])
export type TeamChecks = z.infer<typeof teamChecksSchema>
const deskText = z.string().max(TEAM_DESK_TEXT_MAX)
/**
 * A team desk (ADR-0189): what one press reads, with no model. Strict, so nothing else a computer sends gets in, and it has
 * nowhere to hold a thread's messages, a file name, a project key or a machine name.
 */
export const teamDeskSchema = z.object({
  threads: z.array(z.object({ project: deskText, title: deskText, stands: z.enum(TEAM_THREAD_STANDS),
    pullRequests: z.array(z.object({ number: z.number().int().positive(), title: deskText, draft: z.boolean(), checks: teamChecksSchema, checksPassedAt: z.iso.datetime().optional() }).strict()).max(TEAM_DESK_PULL_REQUESTS_MAX),
  }).strict()).max(TEAM_DESK_THREADS_MAX),
  /** Threads that did not fit, counted and not sent. */
  more: z.number().int().nonnegative(),
}).strict()
export type TeamDesk = z.infer<typeof teamDeskSchema>
export type TeamDeskPullRequest = TeamDesk['threads'][number]['pullRequests'][number]
export const teamDeskAnswerSchema = z.union([z.object({ status: z.literal('desk'), desk: teamDeskSchema }).strict(), refused])

export interface TeamMergeOrderRow { readonly number: number; readonly title: string; readonly project: string; readonly draft: boolean; readonly checks: TeamChecks; readonly whose: 'yours' | 'theirs' | 'both' }
const CHECKS_RANK: Readonly<Record<TeamChecks, number>> = { passed: 0, pending: 1, unknown: 2, failed: 3 }
const DRAFT_RANK = 4
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const earlier = (a: string | undefined, b: string | undefined): string | undefined => a === undefined ? b : b === undefined ? a : Date.parse(a) <= Date.parse(b) ? a : b
/** Two computers' readings of one pull request, the same whichever comes first: a reading beats none, and the less hopeful of two wins. */
const sameChecks = (a: TeamChecks, b: TeamChecks): TeamChecks => a === 'unknown' ? b : b === 'unknown' ? a : CHECKS_RANK[a] >= CHECKS_RANK[b] ? a : b
type TeamMergeOrderItem = Omit<TeamMergeOrderRow, 'whose'> & { readonly whose: readonly ('yours' | 'theirs')[]; readonly checksPassedAt: string | undefined }
/**
 * The merge order (ADR-0189, decision 8): advice, and it merges nothing. Checks passed first, the oldest pass first as in the
 * merge queue; then checks running, not read and failed, each by number; drafts last. Nothing in the sort or in joining two
 * readings asks whose a pull request is, so two owners with the same two desks get the same order, each from their own side.
 */
export function teamMergeOrder(yours: TeamDesk, theirs: TeamDesk): readonly TeamMergeOrderRow[] {
  const rows = new Map<string, TeamMergeOrderItem>()
  const add = (desk: TeamDesk, side: 'yours' | 'theirs'): void => {
    for (const thread of desk.threads) for (const item of thread.pullRequests) {
      // Its number and title say it is one pull request, and both already cross: no address or hash of one does, because a teammate could test guesses against it (ADR-0189, decision 8).
      const key = item.title ? `${item.number} ${item.title}` : `${side} ${thread.project} ${item.number}`, held = rows.get(key)
      rows.set(key, held ? { ...held, project: compareText(held.project, thread.project) <= 0 ? held.project : thread.project,
        draft: held.draft || item.draft, checks: sameChecks(held.checks, item.checks), checksPassedAt: earlier(held.checksPassedAt, item.checksPassedAt), whose: held.whose.includes(side) ? held.whose : [...held.whose, side] }
        : { number: item.number, title: item.title, project: thread.project, draft: item.draft, checks: item.checks, checksPassedAt: item.checksPassedAt, whose: [side] })
    }
  }
  add(yours, 'yours'); add(theirs, 'theirs')
  const rank = (item: TeamMergeOrderItem): number => item.draft ? DRAFT_RANK : CHECKS_RANK[item.checks]
  const passedAt = (item: TeamMergeOrderItem): number => item.checksPassedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(item.checksPassedAt)
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 && passedAt(a) !== passedAt(b) ? passedAt(a) - passedAt(b) : 0) || a.number - b.number || compareText(a.title, b.title) || compareText(a.project, b.project))
    .map(({ number, title, project, draft, checks, whose }) => ({ number, title, project, draft, checks, whose: whose.length > 1 ? 'both' as const : whose[0]! }))
}

/** One thread as a team summary gives it. Never its messages, tool output, file names or paths (ADR-0187, decision 2). */
export interface TeamThreadFact {
  readonly project: string
  readonly projectKey: string
  readonly title: string
  readonly stands: (typeof TEAM_THREAD_STANDS)[number]
  /** `checks` and `checksPassedAt` go only on a team desk (ADR-0189), never to the writer of an answer. */
  readonly pullRequests: readonly { readonly number: number; readonly title: string; readonly state: string; readonly draft: boolean; readonly checks: TeamChecks; readonly checksPassedAt?: string }[]
}
/** The summary's facts, the most active first. `beyondCap` counts the threads past the summary's own cap, so a desk can say so. */
export interface TeamFacts { readonly threads: readonly TeamThreadFact[]; readonly beyondCap: number }
/** `machine` is another machine's name, or null for this computer. */
export interface TeamProjectFact { readonly key: string; readonly title: string; readonly machine: string | null }

/** A teammate's message, as a row in Watcher's conversation and on the Teams tab. */
export const teammateMessageSchema = z.object({
  id: z.string().min(1).max(64), linkId: z.string().min(1).max(64), teammate: z.string().max(TEAM_NAME_MAX * 2),
  /** `we-asked`: this computer asked and this is what came back. `they-asked`: the teammate asked and this computer answered. */
  direction: z.enum(['we-asked', 'they-asked']), ask: teamAskSchema, askWords: z.string().max(TEAM_ASK_CHARACTERS_MAX),
  state: z.enum(['asking', 'answered', 'refused', 'failed']),
  answer: z.string().max(TEAM_ANSWER_CHARACTERS_MAX).optional(), plain: z.literal(true).optional(), refusal: teamRefusalSchema.optional(),
  at: z.iso.datetime(), answeredAt: z.iso.datetime().optional(), afterMessageId: z.string().max(512).nullable(),
  /** Watcher has read it through `read_teammate_messages`. Never changes what the user sees. */
  read: z.literal(true).optional(),
}).strict()
export type TeammateMessage = z.infer<typeof teammateMessageSchema>

export interface TeamLinkView {
  readonly id: string
  readonly name: string
  readonly machine: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly expired: boolean
  readonly lastUsedAt: string | null
  readonly answersToday: number
  readonly refusedToday: number
  readonly wantedAgain: boolean
  readonly theyWantAgain: boolean
}
export type TeamsProblem = 'tailscale-off' | 'serve-off' | 'serve-denied' | 'serve-failed' | 'ports-taken' | 'credentials-locked'
export interface TeamsState {
  readonly ownName: string
  readonly listening: boolean
  readonly code: { readonly text: string; readonly expiresAt: string } | null
  readonly links: readonly TeamLinkView[]
  readonly messages: readonly TeammateMessage[]
  readonly projects: readonly (TeamProjectFact & { readonly leftOut: boolean })[]
  readonly problem: TeamsProblem | null
  /** The address Tailscale gave to turn Serve on, opened only on a press. */
  readonly serveEnableUrl: string | null
  /** The team desk last read for each link, by link, while Sotto runs: never on disk (ADR-0189, decision 6). */
  readonly desks: Readonly<Record<string, { readonly desk: TeamDesk; readonly at: string }>>
  /** Each read of this computer's desk that it answered, oldest first (ADR-0189, decision 5). */
  readonly deskReads: readonly TeamDeskRead[]
}
/** A teammate read this computer's desk. It holds no words. */
export const teamDeskReadSchema = z.object({ id: z.string().min(1).max(64), linkId: z.string().min(1).max(64), teammate: z.string().max(TEAM_NAME_MAX * 2), at: z.iso.datetime() }).strict()
export type TeamDeskRead = z.infer<typeof teamDeskReadSchema>

export const teamsCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('make-code'), name: nameSchema }).strict(),
  z.object({ type: z.literal('cancel-code') }).strict(),
  z.object({ type: z.literal('link'), code: z.string().max(400), name: nameSchema }).strict(),
  z.object({ type: z.literal('link-again'), linkId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('remove-link'), linkId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('leave-out'), project: z.string().min(1).max(200), leftOut: z.boolean() }).strict(),
  z.object({ type: z.literal('open-serve-setting') }).strict(),
  z.object({ type: z.literal('read-desk'), linkId: z.string().min(1).max(64) }).strict(),
])
export type TeamsCommand = z.infer<typeof teamsCommandSchema>
export type TeamsCommandResult = { readonly status: 'ok' } | { readonly status: 'refused'; readonly message: string }

export const TEAMS_GET = 'sotto:teams:get'
export const TEAMS_COMMAND = 'sotto:teams:command'
export const TEAMS_CHANGED = 'sotto:teams:changed'
export const TEAMS_OWN_DESK = 'sotto:teams:own-desk'
export interface TeamsBridge {
  get(): Promise<TeamsState>
  command(command: TeamsCommand): Promise<TeamsCommandResult>
  /** This computer's own desk, as a teammate would read it. Sends nothing. */
  ownDesk(): Promise<TeamDesk>
  subscribe(listener: (state: TeamsState) => void): () => void
}

/** Watcher's tools for this (ADR-0187). They live outside `watcherToolSchemas`, as propose_moves does, so stable offers none. */
export const TEAM_ASK_TOOL = 'ask_teammate'
export const TEAM_READ_TOOL = 'read_teammate_messages'
export const teamAskToolInputSchema = z.object({ ask: teamAskSchema, words: z.string().max(TEAM_ASK_CHARACTERS_MAX).default(''), teammate: z.string().max(TEAM_NAME_MAX * 2).optional() }).strict()
export const teamReadToolInputSchema = z.object({}).strict()
const toolRefusal = z.object({ status: z.literal('refused'), code: z.string(), message: z.string(), retryable: z.boolean().optional() }).strict()
export const teamAskToolOutputSchema = z.union([z.object({ status: z.literal('ok'), askId: z.string(), teammate: z.string(), message: z.string() }).strict(), toolRefusal])
export const teamReadToolOutputSchema = z.union([z.object({ status: z.literal('ok'), notice: z.string(), messages: z.array(z.object({ teammate: z.string(), direction: z.enum(['we-asked', 'they-asked']), ask: teamAskSchema,
  askWords: z.string(), state: z.enum(['answered', 'refused', 'failed']), words: z.string().optional(), at: z.string() }).strict()), waiting: z.number().int().nonnegative() }).strict(), toolRefusal])
