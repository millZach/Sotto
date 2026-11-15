import type { AgentModel, AgentThread, RouterPick } from '../../shared/agents'
import { catalogEntry } from '../../shared/modelCatalog'
import { isRoutedThread, parseRouterAnswer, routedSettings, routerEffortFor, routerMaterial, routerModel, routerTierOf, ROUTER_CLASSIFIER, ROUTER_TIMEOUT_MS, type ModelRouterSettings } from '../../shared/modelRouter'
import type { ShortTextPrompt, ShortTextTarget } from './host'
import { ROUTER_INSTRUCTION } from './modelRouterInstruction'

/** The names model routing logs: what happened, never a model, a level, a reason or a word of the prompt. */
export type RouterEvent = 'model-router-chose' | 'model-router-kept' | 'model-router-failed unavailable' | 'model-router-failed timeout' | 'model-router-failed unreadable' | 'model-router-unconfirmed'
/** What routing a send needs of the coordinator. Nothing here reaches a log but `logEvent`'s fixed names. */
export interface RoutedSendDependencies {
  readonly thread: (threadId: string) => AgentThread
  readonly models: () => readonly AgentModel[]
  readonly settings: () => ModelRouterSettings
  /** The side call (ADR-0026) on the classifier's model and effort, or null where Claude Code cannot be asked. */
  readonly classify: (target: ShortTextTarget, prompt: ShortTextPrompt, signal: AbortSignal) => Promise<string | null>
  /** The same `configure-thread` a chip press makes, resolved only when it came back accepted. */
  readonly configure: (threadId: string, modelId: string, reasoningEffort: string) => Promise<void>
  /** A model or effort the user pressed for this thread's next turn waits or is on its way (ADR-0192): theirs wins. */
  readonly userChoiceWaits: (threadId: string) => boolean
  readonly publish: () => void
  readonly logEvent?: ((name: RouterEvent) => void) | undefined
}

const NO_PICKS: readonly RouterPick[] = Object.freeze([])
/**
 * The most threads whose last routing is kept, newest first to stay: a tenth of what the published state's schema takes,
 * so ten hosts' picks still fit one shell. A thread past it loses only its chip's card until its next routed message.
 */
export const ROUTER_PICKS_MAX = 100
const lastText = (thread: AgentThread, role: 'user' | 'assistant'): string => thread.messages.findLast(message => message.role === role)?.text ?? ''

/**
 * Model routing for a send (CONTEXT.md **Routed thread**, ADR-0207): before a routed thread's message goes, the classifier
 * is asked which model and effort it should run on, and the thread is put on them with an ordinary `configure-thread`.
 * Whatever happens the message is still sent. Each thread's last routing is kept here, in memory only.
 */
export class RoutedSends {
  private readonly picks = new Map<string, RouterPick>()
  /** Frozen and made again only when a pick changes, so a published state shares it without a copy. */
  private published: readonly RouterPick[] = NO_PICKS
  /** Threads whose user chose a model or an effort themselves since their last message: that next message is theirs, not routed (ADR-0192). */
  private readonly userChose = new Set<string>()
  constructor(private readonly dependencies: RoutedSendDependencies) {}

  get size(): number { return this.picks.size }
  list(): readonly RouterPick[] { return this.published }
  /** A thread's record goes with its mark, and with the thread: turned off or deleted, nothing of its last routing is kept. */
  forget(...threadIds: readonly string[]): void {
    let gone = false
    for (const threadId of threadIds) { this.userChose.delete(threadId); gone = this.picks.delete(threadId) || gone }
    if (gone) this.republish()
  }
  /** Whether a message on this thread would be classified now: it is routed, and no choice of the user's own waits for its next turn. */
  routes(threadId: string): boolean { return isRoutedThread(this.dependencies.thread(threadId), true) && !this.dependencies.userChoiceWaits(threadId) }

  /**
   * The user, or Watcher for them, set this thread's model or effort by hand: its next message goes on that choice, whether
   * the choice was applied at once or kept for the thread's next turn and applied when it rested.
   */
  choseByHand(threadId: string): void { if (isRoutedThread(this.dependencies.thread(threadId), true)) this.userChose.add(threadId) }
  /** Whether this thread's next message is the user's own choice to run, asked once: the message after it is routed again. */
  takeChoiceByHand(threadId: string): boolean { return this.userChose.delete(threadId) }
  private record(pick: RouterPick): void {
    // Set again so the newest is last, and the oldest goes once there are more than are kept.
    this.picks.delete(pick.threadId); this.picks.set(pick.threadId, pick)
    if (this.picks.size > ROUTER_PICKS_MAX) this.picks.delete(this.picks.keys().next().value!)
    this.republish()
  }
  private republish(): void { this.published = Object.freeze([...this.picks.values()]); this.dependencies.publish() }

  /** Route one user's message. It never throws: a routing that fails leaves the thread on what it has. */
  async beforeSend(threadId: string, text: string): Promise<void> {
    const { dependencies } = this
    if (!this.routes(threadId)) return
    const thread = dependencies.thread(threadId)
    const models = dependencies.models()
    const classifier = routerModel(models, ROUTER_CLASSIFIER.tier)
    if (!classifier) { dependencies.logEvent?.('model-router-failed unavailable'); this.record({ threadId, state: 'failed' }); return }
    this.record({ threadId, state: 'choosing' })
    // A first message is one sent before the thread has a provider session, whatever history Sotto holds of it: a session
    // whose messages were cleared (Keep local history off) is still a session, and staying keeps its model.
    const first = thread.nativeSessionStarted === false
    const held = catalogEntry(models, thread.modelId)
    const effortNow = thread.reasoningEffort ?? held?.defaultReasoningEffort
    const material = routerMaterial(text, first ? undefined
      : { model: routerTierOf(held) ?? 'unknown', effort: effortNow ?? 'medium', previousUser: lastText(thread, 'user'), lastReply: lastText(thread, 'assistant') })
    const deadline = AbortSignal.timeout(ROUTER_TIMEOUT_MS)
    const reply = await dependencies.classify({ modelId: classifier.id, effort: routerEffortFor(classifier, ROUTER_CLASSIFIER.effort) },
      { instruction: ROUTER_INSTRUCTION, material, purpose: 'model-route' }, deadline).catch(() => null)
    const answer = parseRouterAnswer(reply)
    const settings = answer ? routedSettings(models, answer, thread, dependencies.settings().stayOnFirstModel && !first) : undefined
    if (!answer || !settings) {
      dependencies.logEvent?.(deadline.aborted ? 'model-router-failed timeout' : reply === null ? 'model-router-failed unavailable' : 'model-router-failed unreadable')
      this.record({ threadId, state: 'failed' }); return
    }
    const reason = answer.reason ? { reason: answer.reason } : {}
    if (settings.modelId === thread.modelId && settings.reasoningEffort === effortNow) {
      dependencies.logEvent?.('model-router-kept'); this.record({ threadId, state: 'kept', ...settings, ...reason }); return
    }
    try {
      await dependencies.configure(threadId, settings.modelId, settings.reasoningEffort)
      dependencies.logEvent?.('model-router-chose'); this.record({ threadId, state: 'chose', ...settings, ...reason })
    } catch {
      // Refused, unacknowledged, taken in part or lost in a restart: the exception does not say which, and the adapter may
      // already hold the pick for its next launch. So no settings are named; the chips read the thread's own record.
      dependencies.logEvent?.('model-router-unconfirmed'); this.record({ threadId, state: 'unconfirmed', ...reason })
    }
  }
}
