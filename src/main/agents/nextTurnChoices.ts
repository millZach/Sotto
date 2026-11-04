import type { AgentModel, AgentThread, AgentThreadOptions } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import type { ClientIdentity } from './hostService'
import { speedAfterChange, speedRuns } from './threadOptions'

/** What a thread's chips change: its model, effort, speed and permission mode. */
export type NextTurnOptions = Pick<AgentThreadOptions, 'modelId' | 'reasoningEffort' | 'runtimeMode' | 'providerMode' | 'speed' | 'fastMode'>
/**
 * The choice kept for one thread's next turn (CONTEXT.md **Next-turn choice**, ADR-0192), and the client whose press set its
 * permission, which is asked again when the choice is sent (ADR-0004). Kept in memory only: Sotto quitting drops it.
 */
export interface NextTurnChoice {
  readonly options: NextTurnOptions
  readonly client: ClientIdentity
  /**
   * Sent, with no result from the provider: main keeps the change as it keeps any such change (#1192) and asks for it
   * before the thread's next turn, so the choice stays shown and is not sent again until main lets the change go.
   */
  readonly unconfirmed?: true
}

const threadSpeed = (thread: Pick<AgentThread, 'speed' | 'fastMode'>) => thread.speed !== undefined ? thread.speed : thread.fastMode === true ? 'fast' : null

/**
 * A press merged into the choice that waits. A press names one setting, so the rest of what waits stays chosen; a new model
 * takes its own default effort unless the press names one, and keeps a speed only where that model offers it.
 */
export function pressedOnto(base: NextTurnOptions, press: NextTurnOptions, thread: Pick<AgentThread, 'modelId'>, models: AgentModel[]): NextTurnOptions {
  const merged: { -readonly [K in keyof NextTurnOptions]: NextTurnOptions[K] } = { ...base }
  if (press.modelId !== undefined) {
    if (press.modelId !== (base.modelId ?? thread.modelId)) {
      delete merged.reasoningEffort
      const speed = speedAfterChange(merged)
      if (speed && !speedRuns({ models }, press.modelId, speed)) { delete merged.speed; delete merged.fastMode }
    }
    merged.modelId = press.modelId
  }
  if (press.reasoningEffort !== undefined) merged.reasoningEffort = press.reasoningEffort
  if (press.runtimeMode !== undefined) merged.runtimeMode = press.runtimeMode
  if (press.providerMode !== undefined) merged.providerMode = press.providerMode
  if (press.speed !== undefined) { merged.speed = press.speed; delete merged.fastMode }
  else if (press.fastMode !== undefined) { merged.fastMode = press.fastMode; delete merged.speed }
  return merged
}

/**
 * The part of a choice the thread does not already run on, or null when it runs on all of it. An effort that rides with a
 * new model stays with it; one the model the thread is on already runs at goes.
 */
export function stillToChange(options: NextTurnOptions, thread: AgentThread, models: AgentModel[]): NextTurnOptions | null {
  const left: { -readonly [K in keyof NextTurnOptions]: NextTurnOptions[K] } = { ...options }
  const model = resolveModel(models, thread.modelId)
  if (left.modelId === thread.modelId) delete left.modelId
  if (left.modelId === undefined && left.reasoningEffort !== undefined && left.reasoningEffort === (thread.reasoningEffort ?? model?.defaultReasoningEffort)) delete left.reasoningEffort
  if (left.runtimeMode !== undefined && left.runtimeMode === thread.runtimeMode) delete left.runtimeMode
  if (left.providerMode !== undefined && left.providerMode === (thread.providerMode ?? model?.providerModes?.[0]?.id)) delete left.providerMode
  if ((left.speed !== undefined || left.fastMode !== undefined) && speedAfterChange(left) === threadSpeed(thread)) { delete left.speed; delete left.fastMode }
  return Object.keys(left).length > 0 ? left : null
}

/**
 * Each thread's kept choice and the one on its way to the provider. Changed only by a press, an apply and its end, so a
 * provider update reads `size` and nothing else (AGENTS.md: main's update path reads without copying).
 */
export class NextTurnChoices {
  private readonly kept = new Map<string, NextTurnChoice>()
  private readonly sending = new Map<string, NextTurnOptions>()
  /** The list the shell publishes, made again only when a choice changes. */
  private published: readonly Readonly<{ threadId: string } & NextTurnOptions>[] = []

  get size(): number { return this.kept.size }
  waiting(threadId: string): NextTurnChoice | undefined { return this.kept.get(threadId) }
  /** The choice on its way to the provider for this thread, while it is. */
  sent(threadId: string): NextTurnOptions | undefined { return this.sending.get(threadId) }
  /** Read in place on every pump while a choice waits; a choice put away meanwhile is simply not visited again. */
  threadIds(): IterableIterator<string> { return this.kept.keys() }

  keep(threadId: string, choice: NextTurnChoice): void { this.kept.set(threadId, choice); this.publish() }
  /** Puts the choice away; with `only`, only while it is still that choice, so a newer press stays. */
  drop(threadId: string, only?: NextTurnChoice): void {
    if (only !== undefined && this.kept.get(threadId) !== only) return
    if (this.kept.delete(threadId)) this.publish()
  }
  startSending(threadId: string, options: NextTurnOptions): void { this.sending.set(threadId, options) }
  endSending(threadId: string): void { this.sending.delete(threadId) }

  /** Frozen, so every shell may share it: a choice is replaced, never changed in place. */
  list(): readonly Readonly<{ threadId: string } & NextTurnOptions>[] { return this.published }
  private publish(): void { this.published = Object.freeze([...this.kept].map(([threadId, choice]) => Object.freeze({ ...choice.options, threadId }))) }
}
