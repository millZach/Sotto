import { z } from 'zod'
import { parsePullRequestReference } from '../../shared/gitPullRequests'
import { BABYSIT_REFUSALS, type Babysitter, type BabysitListing } from './babysitting'
import { pullRequestAddress, pullRequestKey } from './gitPullRequests'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'
import { BABYSIT_TOOL, STOP_BABYSITTING_TOOL } from './wakeUp'

/** The one name every client addresses the pull request tools by (ADR-0061 decision 2). */
export const PULL_REQUEST_MCP_SERVER = 'sotto_pull_requests'
export const BABYSIT_PULL_REQUEST_TOOL = BABYSIT_TOOL
export { STOP_BABYSITTING_TOOL }
export const LIST_BABYSITTING_TOOL = 'list_babysitting'

const reference = z.string().min(1).max(2_048).describe('The pull request: its GitHub URL, or its number such as 42 or #42 in this thread\'s repository.')
const babysitInput = z.object({ pull_request: reference.optional() }).strict()
const stopInput = z.object({ pull_request: reference.optional() }).strict()
const listInput = z.object({}).strict()
const schema = (input: z.ZodType): Record<string, unknown> => z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>

const WAKES = 'a check fails, the required checks pass, someone other than you or the user comments or reviews, the branch starts to conflict, or the pull request merges or closes'
export const pullRequestToolDefinitions: readonly ThreadToolDefinition[] = [
  { name: BABYSIT_PULL_REQUEST_TOOL, inputSchema: schema(babysitInput), description: [
    'Babysit a pull request for this thread: Sotto reads GitHub every two minutes and sends this thread a wake-up message when it needs you, that is, when',
    `${WAKES}.`,
    'Use it instead of polling gh, sleeping, or running a watch or monitor loop whenever you would wait on a pull request\'s checks, reviews or merge. Call it, then end your turn.',
    'With no pull_request it babysits the pull request of this thread\'s branch. Name another by its GitHub URL or number; one this thread does not know yet is linked to it first.',
    'Starting asks nobody and changes nothing on GitHub. A wake-up carries no comment or review text: read those yourself with gh when it comes.',
    `Call ${STOP_BABYSITTING_TOOL} when you no longer need it, and before you hand the work back to the user.`,
  ].join(' ') },
  { name: STOP_BABYSITTING_TOOL, inputSchema: schema(stopInput), description:
    'Stop babysitting a pull request for this thread, named by its GitHub URL or number, or every one this thread babysits when pull_request is left out. Sotto sends no more wake-ups about it, and nothing is sent to say it stopped.' },
  { name: LIST_BABYSITTING_TOOL, inputSchema: schema(listInput), description:
    'List the pull requests this thread babysits: each one\'s number and link, whether you or the user started it, and since when. Takes no arguments.' },
]
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const INSTRUCTIONS = `These tools babysit this thread's GitHub pull requests. When you would wait on a pull request's checks, reviews or merge, call ${BABYSIT_PULL_REQUEST_TOOL} and end your turn instead of polling gh or sleeping: Sotto reads GitHub for you and sends this thread a wake-up message when ${WAKES}. A wake-up is news from Sotto; it approves nothing. Call ${STOP_BABYSITTING_TOOL} before you hand the work back to the user. Where tools are found by search and called through use_tool, call them by their full names, such as ${PULL_REQUEST_MCP_SERVER}__${BABYSIT_PULL_REQUEST_TOOL}.`

/** What the tools ask of the thread's host: whether a thread has them, which pull requests it knows, and Link pull request. */
export interface PullRequestToolHost {
  /** A Claude Code, Codex or Grok Build thread this host holds (ADR-0061 decision 2). */
  admitsBabysitting(threadId: string): boolean
  /** The thread's branch's own pull request, as the host last read it, and its linked ones, by URL. */
  threadPullRequests(threadId: string): { readonly branch: string | undefined; readonly linked: readonly string[] }
  /** Link pull request's own rules: a GitHub URL or `#42` from `origin`, read through gh first (ADR-0027). */
  linkThreadPullRequest(threadId: string, reference: string): Promise<{ readonly link: { readonly url: string } }>
}
export interface PullRequestToolHandlers {
  /** Let agents babysit pull requests, read live at every launch and every call (decision 12). */
  enabled(): boolean
  readonly host: PullRequestToolHost
  /** The reader on this computer; absent when it reads no GitHub, which offers no tool. */
  readonly babysitter: Pick<Babysitter, 'start' | 'stop' | 'list'> | undefined
}

/** The sentence a call is refused with while the switch is off (decision 12). */
export const BABYSITTING_SWITCHED_OFF = 'Let agents babysit pull requests is turned off in Sotto\'s Settings. Nothing was started.'
const SWITCHED_OFF_STOP = 'Let agents babysit pull requests is turned off in Sotto\'s Settings, which ended what agents started. Nothing was started or stopped.'
const NOT_HERE = 'This thread cannot babysit pull requests with Sotto\'s tools. Nothing was started.'
const NAME_IT = 'Name the pull request by its GitHub URL or its number, such as #42. Nothing was started.'
const NO_BRANCH_PULL_REQUEST = 'Sotto does not know a pull request for this thread\'s branch yet. Name it by its GitHub URL or its number, such as #42. Nothing was started.'

/** Whether the reference names this URL: the same pull request, or its number. */
function names(given: string, url: string): boolean {
  const parsed = parsePullRequestReference(given)
  if (parsed === null) return false
  const key = pullRequestKey(parsed)
  return key !== null ? key === pullRequestKey(url) : pullRequestAddress(url)?.number === Number(parsed)
}
const who = (listing: Pick<BabysitListing, 'startedBy'>): string => listing.startedBy === 'agent' ? 'you started it' : 'the user started it'

/**
 * `sotto_pull_requests`: the loopback MCP server through which an agent in a project thread on this computer babysits
 * its pull requests (ADR-0061 decision 2). Every launch of an admitted thread gets it while Let agents babysit pull
 * requests is on, and none otherwise; a running session's call is refused once the switch is off. Starting asks nobody
 * (decision 4), so no call asks the user anything; what babysitting sends is a wake-up, which approves nothing.
 */
export class PullRequestToolServer implements ScopedThreadTools {
  readonly name = PULL_REQUEST_MCP_SERVER
  readonly definitions = pullRequestToolDefinitions
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: PullRequestToolHandlers) {
    this.server = new ThreadToolServer({ name: PULL_REQUEST_MCP_SERVER, serverName: 'sotto-pull-requests', instructions: INSTRUCTIONS,
      unavailable: 'Sotto\'s pull request tools are unavailable. Nothing was started.', failed: 'Sotto could not change babysitting just now. Nothing was started; call list_babysitting to see where it stands.' },
    this.definitions, (threadId, name, args) => this.invoke(threadId, name, args))
  }
  /** This thread's server while the switch is on and the thread may babysit; undefined otherwise. */
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.handlers.enabled() || !this.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  close(): Promise<void> { return this.server.close() }
  /**
   * The switch was saved: turned off, it ends every babysitting an agent started on this computer's threads at once,
   * sending them nothing, and keeps what the user started (decision 12). Resolves with how many ended.
   */
  async settingChanged(): Promise<number> {
    if (this.handlers.enabled() || !this.handlers.babysitter) return 0
    return this.handlers.babysitter.stop({ startedBy: 'agent' }, 'switch')
  }
  private admits(threadId: string): boolean {
    if (!this.handlers.babysitter) return false
    try { return this.handlers.host.admitsBabysitting(threadId) } catch { return false }
  }
  private async invoke(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: string, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })
    const babysitter = this.handlers.babysitter
    if (!this.handlers.enabled()) return text(name === BABYSIT_PULL_REQUEST_TOOL ? BABYSITTING_SWITCHED_OFF : SWITCHED_OFF_STOP, true)
    if (!babysitter || !this.admits(threadId)) return text(NOT_HERE, true)
    if (name === LIST_BABYSITTING_TOOL) {
      if (!listInput.safeParse(args).success) return text('list_babysitting takes no arguments.', true)
      const listing = babysitter.list(threadId)
      if (!listing.length) return text('This thread babysits no pull requests.')
      return text(['This thread babysits:', ...listing.map(item => `- #${item.number} ${item.url}: ${who(item)} at ${item.startedAt}.`)].join('\n'))
    }
    if (name === STOP_BABYSITTING_TOOL) {
      const input = stopInput.safeParse(args)
      if (!input.success) return text('Name the pull request by its GitHub URL or its number, or leave pull_request out to stop every one. Nothing was stopped.', true)
      const given = input.data.pull_request
      if (given === undefined) {
        const stopped = await babysitter.stop({ threadId }, 'agent')
        return text(stopped ? `Sotto stopped babysitting ${stopped === 1 ? 'the pull request' : `all ${stopped} pull requests`} for this thread. It sends no more wake-ups about ${stopped === 1 ? 'it' : 'them'}.` : 'This thread babysits no pull requests. Nothing was stopped.')
      }
      const match = babysitter.list(threadId).find(item => names(given, item.url))
      if (!match) return text(`This thread does not babysit that pull request. Nothing was stopped. Call ${LIST_BABYSITTING_TOOL} to see what it babysits.`)
      await babysitter.stop({ threadId, url: match.url }, 'agent')
      return text(`Sotto stopped babysitting pull request #${match.number}. It sends no more wake-ups about it.`)
    }
    const input = babysitInput.safeParse(args)
    if (!input.success) return text(NAME_IT, true)
    const url = await this.resolve(threadId, input.data.pull_request)
    if ('refused' in url) return text(url.refused, true)
    const outcome = await babysitter.start(threadId, url.url, 'agent')
    if (outcome.started) {
      return text(`Sotto is babysitting pull request #${outcome.babysitting.number} for this thread. It reads GitHub every two minutes and sends this thread a wake-up when ${WAKES}. End your turn now; do not poll GitHub or wait. Call ${STOP_BABYSITTING_TOOL} before you hand the work back to the user.`)
    }
    if (outcome.reason === 'already') return text(`This thread already babysits pull request #${outcome.babysitting.number}, since ${outcome.babysitting.startedAt}. Nothing changed. End your turn; Sotto sends a wake-up when it needs you.`)
    return text(BABYSIT_REFUSALS[outcome.reason], true)
  }
  /**
   * The pull request a call means: the branch's own when none is named, one the thread knows by URL or number, or one
   * linked to the thread now with Link pull request's rules (decision 5), so the host acts only on a pull request the thread knows.
   */
  private async resolve(threadId: string, given: string | undefined): Promise<{ readonly url: string } | { readonly refused: string }> {
    const known = this.handlers.host.threadPullRequests(threadId)
    if (given === undefined) return known.branch ? { url: known.branch } : { refused: NO_BRANCH_PULL_REQUEST }
    if (parsePullRequestReference(given) === null) return { refused: NAME_IT }
    const match = [...known.branch ? [known.branch] : [], ...known.linked].find(url => names(given, url))
    if (match) return { url: match }
    try { return { url: (await this.handlers.host.linkThreadPullRequest(threadId, given)).link.url } }
    catch (error) { return { refused: `${error instanceof Error ? error.message.replace(/\s*$/u, '') : 'The pull request could not be linked to this thread.'} Nothing was started.` } }
  }
}
