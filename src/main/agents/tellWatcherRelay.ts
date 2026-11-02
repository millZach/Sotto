import { randomUUID } from 'node:crypto'
import { TELL_WATCHER_ANSWER_MS, tellWatcherAnswerSchema, tellWatcherAskSchema, type TellWatcherAnswer, type TellWatcherAsk } from '../../shared/tellWatcher'
import type { WatcherThreadTarget } from '../../shared/watcher'

/** A desktop connected to this host whose hello accepted `watcher-tell`: the socket's way to push it an ask. */
export interface TellWatcherDesktop {
  readonly clientId: string
  /** Pushes the ask; false when the socket would not take it. */
  push(askId: string, ask: TellWatcherAsk): boolean
}

/**
 * A headless host's side of `watcher-tell` (ADR-0073, amendment of November 2, 2026): Watcher runs on a desktop, so a thread
 * on this host reaches it over that desktop's connection here. Asked of the desktops newest first, until one has Watcher.
 * One that does not answer may have taken it, so no other is asked: two desktops would each open a request for one message.
 * Nothing is kept: a thread that hears nothing got through is told so, and its model tells the user.
 */
export class HostTellWatcherRelay {
  private readonly desktops: TellWatcherDesktop[] = []
  private readonly pending = new Map<string, { readonly desktop: TellWatcherDesktop; readonly resolve: (answer: TellWatcherAnswer) => void; readonly timer: NodeJS.Timeout }>()
  constructor(private readonly answerMs: number = TELL_WATCHER_ANSWER_MS) {}
  desktopConnected(desktop: TellWatcherDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    this.desktops.push(desktop)
  }
  /** Its socket closed: an ask still waiting on it has no answer, and may have been taken. */
  desktopGone(desktop: TellWatcherDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    for (const [askId, ask] of [...this.pending]) if (ask.desktop === desktop) { clearTimeout(ask.timer); this.pending.delete(askId); ask.resolve({ status: 'refused', reason: 'no-answer' }) }
  }
  /** The desktop's answer: true when it was one this host is waiting for from that desktop. */
  answered(desktop: Pick<TellWatcherDesktop, 'clientId'>, askId: string, answer: unknown): boolean {
    const ask = this.pending.get(askId)
    if (!ask || ask.desktop.clientId !== desktop.clientId) return false
    this.pending.delete(askId); clearTimeout(ask.timer)
    const parsed = tellWatcherAnswerSchema.safeParse(answer)
    ask.resolve(parsed.success ? parsed.data : { status: 'refused', reason: 'no-answer' })
    return true
  }
  async tell(ask: TellWatcherAsk): Promise<TellWatcherAnswer> {
    let last: TellWatcherAnswer = { status: 'refused', reason: 'not-connected' }
    for (const desktop of [...this.desktops].reverse()) {
      const answer = await this.askOne(desktop, ask)
      if (answer.status === 'told' || answer.reason === 'no-answer') return answer
      last = answer
    }
    return last
  }
  close(): void {
    for (const [askId, ask] of [...this.pending]) { clearTimeout(ask.timer); this.pending.delete(askId); ask.resolve({ status: 'refused', reason: 'no-answer' }) }
    this.desktops.length = 0
  }
  private askOne(desktop: TellWatcherDesktop, ask: TellWatcherAsk): Promise<TellWatcherAnswer> {
    return new Promise(resolve => {
      const askId = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(askId); resolve({ status: 'refused', reason: 'no-answer' }) }, this.answerMs)
      timer.unref?.()
      this.pending.set(askId, { desktop, resolve, timer })
      if (!desktop.push(askId, ask)) { clearTimeout(timer); this.pending.delete(askId); resolve({ status: 'refused', reason: 'not-connected' }) }
    })
  }
}

/** A connection this desktop keeps to a host, as the relay reads it. */
export interface TellWatcherConnection {
  readonly kind: string
  readonly hostId: string | undefined
  readonly service: {
    subscribeWatcherTell?(listener: (askId: string, ask: TellWatcherAsk) => void): () => void
    answerWatcherTell?(askId: string, answer: TellWatcherAnswer): Promise<void>
  }
}
export interface TellWatcherHostSource {
  subscribeConnected(listener: (connection: TellWatcherConnection) => void): () => void
  remoteConnections(): Iterable<TellWatcherConnection>
}

/**
 * The desktop's side of `watcher-tell`: each connected host's threads reach this computer's Watcher. The thread is named by
 * the host's own connection, so a host can speak only for its own threads.
 */
export class DesktopTellWatcherRelay {
  private readonly followed = new WeakSet<object>()
  private unfollow: (() => void) | undefined
  constructor(private readonly tell: (target: WatcherThreadTarget, ask: TellWatcherAsk) => Promise<TellWatcherAnswer>) {}
  useHosts(source: TellWatcherHostSource): void {
    this.unfollow?.()
    this.unfollow = source.subscribeConnected(connection => this.follow(connection))
    for (const connection of source.remoteConnections()) this.follow(connection)
  }
  close(): void { this.unfollow?.(); this.unfollow = undefined }
  private follow(connection: TellWatcherConnection): void {
    const { service, hostId } = connection
    if (connection.kind !== 'remote' || !hostId || this.followed.has(service) || !service.subscribeWatcherTell) return
    this.followed.add(service)
    service.subscribeWatcherTell((askId, raw) => {
      void (async () => {
        let answer: TellWatcherAnswer
        try {
          const ask = tellWatcherAskSchema.parse(raw)
          answer = await this.tell({ hostId, threadId: ask.threadId }, ask)
        } catch { answer = { status: 'refused', reason: 'no-watcher' } }
        // A lost answer reads on the host as no answer, and the thread's model tells the user.
        await service.answerWatcherTell?.(askId, answer).catch(() => undefined)
      })()
    })
  }
}
