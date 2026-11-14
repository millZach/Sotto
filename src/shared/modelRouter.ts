import { z } from 'zod'
import type { AgentModel, AgentThread } from './agents'
import { catalogEntry } from './modelCatalog'
import { modelLine } from './modelLineup'

/**
 * Model routing (CONTEXT.md, **Routed thread**; ADR-0207): a Claude Code thread whose model and effort Sotto chooses for
 * each message the user sends, by asking a classifier on the user's own Claude Code first. An Owl feature, `model-router`.
 * Everything here is a pure function, so main, the window and the tests read the same answers.
 */

/** The models the router chooses between, smallest first, by the word their catalog entry's line reads as. */
export const ROUTER_TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type RouterTier = typeof ROUTER_TIERS[number]
/** The efforts it chooses between, least thorough first. `max` and Ultracode are never chosen. */
export const ROUTER_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type RouterEffort = typeof ROUTER_EFFORTS[number]

/** What classifies a message: the model and effort the benchmark chose (docs/plans/model-router.md). */
export const ROUTER_CLASSIFIER: { readonly tier: RouterTier; readonly effort: RouterEffort } = { tier: 'opus', effort: 'low' }
/** How long the classifier has to answer before the message goes on the settings the thread has. */
export const ROUTER_TIMEOUT_MS = 20_000
/** How much of the user's message, of the message before it and of the end of the last reply the classifier reads. */
export const ROUTER_MESSAGE_CHARACTERS = 4_000
export const ROUTER_PREVIOUS_CHARACTERS = 300
export const ROUTER_REPLY_CHARACTERS = 400
/** The most of the classifier's reason that is kept. */
export const ROUTER_REASON_CHARACTERS = 120

/** What Settings → Threads holds for model routing. `newThreads`: a new Claude Code thread starts routed. */
export const modelRouterSettingsSchema = z.object({ stayOnFirstModel: z.boolean(), newThreads: z.boolean().optional() }).strict()
export type ModelRouterSettings = z.infer<typeof modelRouterSettingsSchema>
export const DEFAULT_MODEL_ROUTER: ModelRouterSettings = { stayOnFirstModel: false }

/** Read one field at a time, so a damaged value costs only itself. */
export function parseModelRouterSettings(input: unknown): ModelRouterSettings {
  const saved = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  return { stayOnFirstModel: saved.stayOnFirstModel === true, ...saved.newThreads === true ? { newThreads: true } : {} }
}

type RoutedThreadFacts = Pick<AgentThread, 'providerId' | 'kind' | 'delegatedBy' | 'remoteHost' | 'archivedAt' | 'dynamic'>

/** Why a thread cannot be routed, in plain words, or undefined where it can. */
export function whyNotRouted(thread: RoutedThreadFacts): string | undefined {
  if (thread.archivedAt) return 'An archived thread cannot change. Nothing changed.'
  if ((thread.kind ?? 'project') !== 'project') return 'Only a thread in a project can use model routing. Nothing changed.'
  if (thread.remoteHost) return 'A thread on another machine cannot use model routing yet. Nothing changed.'
  if (thread.delegatedBy !== undefined) return 'A thread another thread started cannot use model routing. Nothing changed.'
  if (thread.providerId !== 'claude') return 'Only a Claude Code thread can use model routing. Nothing changed.'
  if (thread.dynamic === true) return 'A Dynamic thread chooses its own models. Turn Dynamic off to use model routing. Nothing changed.'
  return undefined
}

/** Whether a thread is routed now: the mark, on a thread that can hold it, while the Owl feature is on. */
export function isRoutedThread(thread: RoutedThreadFacts & Pick<AgentThread, 'routed'>, enabled: boolean): boolean {
  return enabled && thread.routed === true && whyNotRouted(thread) === undefined
}

/** The classifier's answer once read: a model, an effort and its reason in a few words. */
export interface RouterAnswer { readonly tier: RouterTier; readonly effort: RouterEffort; readonly reason: string }

const routerAnswerSchema = z.object({ model: z.enum(ROUTER_TIERS), effort: z.enum(ROUTER_EFFORTS), reason: z.string().optional() })

/** The classifier's reply as an answer, or undefined when it holds none. The first `{` to the last `}` is read, since a model sometimes wraps its line. */
export function parseRouterAnswer(reply: string | null | undefined): RouterAnswer | undefined {
  if (!reply) return undefined
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try { value = JSON.parse(reply.slice(start, end + 1)) } catch { return undefined }
  const parsed = routerAnswerSchema.safeParse(value)
  if (!parsed.success) return undefined
  return { tier: parsed.data.model, effort: parsed.data.effort, reason: (parsed.data.reason ?? '').replace(/\s+/gu, ' ').trim().slice(0, ROUTER_REASON_CHARACTERS) }
}

/** What a later message's classifier is told of its thread: what it runs on, the message before and the end of the last reply. */
export interface RouterThreadSoFar { readonly model: string; readonly effort: string; readonly previousUser: string; readonly lastReply: string }

/** What the classifier reads on stdin. The shape is the benchmark's (`run_benchmark.py`, `material`), character for character. */
export function routerMaterial(text: string, soFar?: RouterThreadSoFar): string {
  const message = `User message:\n${text.slice(0, ROUTER_MESSAGE_CHARACTERS)}`
  if (!soFar) return message
  return `Thread so far\nCurrent model: ${soFar.model}\nCurrent effort: ${soFar.effort}\nPrevious user message: ${soFar.previousUser.slice(0, ROUTER_PREVIOUS_CHARACTERS)}\nEnd of the last reply: ${soFar.lastReply.slice(-ROUTER_REPLY_CHARACTERS)}\n\n${message}`
}

type RouterModel = Pick<AgentModel, 'id' | 'name' | 'providerId' | 'legacy' | 'ready' | 'reasoningEfforts' | 'defaultReasoningEffort'>

/** The tier a catalog entry is, or undefined for one the router does not choose between (Default, a legacy model). */
export function routerTierOf(model: Pick<AgentModel, 'name'> | undefined): RouterTier | undefined {
  const line = model ? modelLine(model.name) : ''
  return ROUTER_TIERS.find(tier => tier === line)
}

/** A tier's entry in the catalog: Claude Code's newest model of that line. Never an id written down here. */
export function routerModel<T extends RouterModel>(models: readonly T[], tier: RouterTier): T | undefined {
  return models.find(model => model.providerId === 'claude' && !model.legacy && model.ready && routerTierOf(model) === tier)
}

/** The effort a model takes that is nearest the one chosen: itself where the model lists it, else the next lower, else the lowest it lists. */
export function routerEffortFor(model: Pick<AgentModel, 'reasoningEfforts'> | undefined, effort: RouterEffort): string {
  const listed = model?.reasoningEfforts
  if (!listed?.length || listed.includes(effort)) return effort
  for (let index = ROUTER_EFFORTS.indexOf(effort) - 1; index >= 0; index -= 1) if (listed.includes(ROUTER_EFFORTS[index]!)) return ROUTER_EFFORTS[index]!
  return listed[0]!
}

/**
 * The settings an answer puts a thread on. `stay`: the thread keeps its model and takes only the effort, which is every
 * later message while **Stay on the first model** is on. A thread holding a variant of the chosen entry (`opus[1m]`) keeps
 * the id it holds, so the same model is not a change. Undefined when the catalog has no ready model of that tier.
 */
export function routedSettings(models: readonly RouterModel[], answer: RouterAnswer, thread: Pick<AgentThread, 'modelId'>, stay: boolean): { readonly modelId: string; readonly reasoningEffort: string } | undefined {
  const held = catalogEntry(models, thread.modelId)
  if (stay) return { modelId: thread.modelId, reasoningEffort: routerEffortFor(held, answer.effort) }
  const chosen = routerModel(models, answer.tier)
  if (!chosen) return undefined
  return { modelId: held?.id === chosen.id ? thread.modelId : chosen.id, reasoningEffort: routerEffortFor(chosen, answer.effort) }
}
