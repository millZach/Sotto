import { threadProviderOf, type AgentHostSnapshot, type AgentRequest, type AgentThread, type ProviderId } from '../../shared/agents'
import { modelSummary } from './requestInput'

/** The providers with no side call to ask (ADR-0026), so their cards say from the start that no summary came. */
const NO_SIDE_CALL: ReadonlySet<ProviderId> = new Set<ProviderId>(['devin', 'deepseek', 'muse'])
/** A client starts cold for each side call, so a burst of requests waits its turn rather than filling the machine. */
const AT_ONCE = 2

export type CommandSummaryWrite = (threadId: string, command: string, signal: AbortSignal) => Promise<string | null | undefined>
interface Ask {
  readonly command: string
  readonly stop: AbortController
  /** What the card shows: `off` is the switch being off, which reads as a command that came with no summary. */
  outcome: 'waiting' | 'failed' | 'off' | { readonly summary: string }
  shown?: { readonly from: AgentRequest; readonly outcome: Ask['outcome']; readonly request: AgentRequest }
}

/**
 * The summaries Sotto asks for when a command's model sent none (ADR-0185, November 2 amendment). The coordinator hands
 * it each shown list as it does `RequestWaits`, and it puts each ask's state on the request: the card never waits for one, a
 * request answered or gone stops its call, and all of it lives in memory, so nothing about a command is kept.
 */
export class CommandSummaries {
  private readonly asks = new Map<string, Map<string, Ask>>()
  /** The threads shown with an ask on them, by what they were made from, so an unchanged thread keeps its identity. */
  private readonly shown = new Map<string, { readonly from: AgentThread; readonly revision: number; readonly thread: AgentThread }>()
  private readonly waiting: { readonly threadId: string; readonly ask: Ask }[] = []
  private running = 0
  private revision = 0
  private closed = false

  constructor(private readonly write: CommandSummaryWrite) {}

  /** Told of each thread whose shown requests changed, so a caller listing by change relists it. */
  onMoved: ((threadId: string) => void) | undefined
  /** Told when an ask's outcome changed after the list was shown, so the caller shows it again. */
  onChanged: (() => void) | undefined

  /** The snapshot with each ask on its request. Without `gone` it is the whole list; with it, only the threads it names. */
  decorate(snapshot: AgentHostSnapshot, gone?: ReadonlySet<string>): AgentHostSnapshot {
    for (const id of gone ?? []) this.forget(id)
    let changed = false
    const threads = snapshot.threads.map(thread => {
      const shown = this.show(thread)
      if (shown !== thread) changed = true
      return shown
    })
    if (!gone && this.asks.size > 0) {
      const present = new Set(snapshot.threads.map(thread => thread.id))
      for (const id of [...this.asks.keys()]) if (!present.has(id)) this.forget(id)
    }
    return changed ? { ...snapshot, threads } : snapshot
  }

  /** Stops every call under way and asks for nothing more. */
  close(): void {
    this.closed = true
    this.waiting.length = 0
    for (const id of [...this.asks.keys()]) this.forget(id)
  }

  private show(thread: AgentThread): AgentThread {
    const mine = this.asks.get(thread.id)
    if (thread.requests.length === 0) {
      if (mine) this.forget(thread.id)
      return thread
    }
    if (!mine && !thread.requests.some(asksForSummary)) return thread
    const last = this.shown.get(thread.id)
    if (last?.from === thread && last.revision === this.revision) return last.thread
    let changed = false
    const requests = thread.requests.map(request => {
      const shown = this.showRequest(thread, request)
      if (shown !== request) changed = true
      return shown
    })
    const standing = this.asks.get(thread.id)
    if (standing) for (const [id, ask] of standing) if (!thread.requests.some(request => request.id === id)) { this.stop(ask); standing.delete(id) }
    const made = changed ? { ...thread, requests } : thread
    this.shown.set(thread.id, { from: thread, revision: this.revision, thread: made })
    return made
  }

  private showRequest(thread: AgentThread, request: AgentRequest): AgentRequest {
    let mine = this.asks.get(thread.id)
    let ask = mine?.get(request.id)
    if (!ask && !asksForSummary(request)) return request
    // Told an ask stands, a request taken back from what was shown is this coordinator's own: its state is replaced below.
    const { summary: _summary, summaryAsk: _summaryAsk, ...context } = request.context ?? {}
    void _summary; void _summaryAsk
    const command = context.command
    if (!command) return request
    if (ask && ask.command !== command) { this.stop(ask); ask = undefined }
    if (!ask) {
      const provider = threadProviderOf(thread)
      if (this.closed || (provider && NO_SIDE_CALL.has(provider))) return request
      ask = { command, stop: new AbortController(), outcome: 'waiting' }
      mine ??= new Map()
      mine.set(request.id, ask)
      this.asks.set(thread.id, mine)
      this.start(thread.id, ask)
    }
    // An answer whose arrival is unknown keeps its request standing. The user has answered all the same.
    if (request.delivery === 'uncertain' && ask.outcome === 'waiting') { this.stop(ask); ask.outcome = 'off' }
    if (ask.outcome === 'off') return request.context?.summaryAsk ? { ...request, context } : request
    if (ask.shown?.outcome === ask.outcome && (ask.shown.from === request || ask.shown.request === request)) return ask.shown.request
    const shown: AgentRequest = { ...request, context: { ...context, ...(ask.outcome === 'waiting' ? { summaryAsk: 'waiting' as const }
      : ask.outcome === 'failed' ? { summaryAsk: 'failed' as const } : { summary: ask.outcome.summary, summaryAsk: 'answered' as const }) } }
    ask.shown = { from: request, outcome: ask.outcome, request: shown }
    return shown
  }

  private start(threadId: string, ask: Ask): void {
    if (this.running < AT_ONCE) this.run(threadId, ask)
    else this.waiting.push({ threadId, ask })
  }

  private run(threadId: string, ask: Ask): void {
    this.running += 1
    void this.write(threadId, ask.command, ask.stop.signal).catch(() => null).then(said => {
      this.running -= 1
      const next = this.waiting.shift()
      if (next) this.run(next.threadId, next.ask)
      if (ask.stop.signal.aborted) return
      const summary = said === undefined ? undefined : modelSummary(said, ask.command)
      ask.outcome = said === undefined ? 'off' : summary ? { summary } : 'failed'
      this.revision += 1
      this.onMoved?.(threadId)
      this.onChanged?.()
    })
  }

  /** Stops an ask's call, or takes it out of the line for one, so no record of it is left behind. */
  private stop(ask: Ask): void {
    ask.stop.abort()
    const place = this.waiting.findIndex(entry => entry.ask === ask)
    if (place >= 0) this.waiting.splice(place, 1)
  }

  private forget(threadId: string): void {
    for (const ask of this.asks.get(threadId)?.values() ?? []) this.stop(ask)
    this.asks.delete(threadId)
    this.shown.delete(threadId)
  }
}

/** A permission to run a command whose model sent no summary, and which no other coordinator has asked about. */
function asksForSummary(request: AgentRequest): boolean {
  const context = request.context
  return request.kind === 'permission' && Boolean(context?.command) && !context!.summary && !context!.summaryAsk && request.delivery !== 'uncertain'
}
