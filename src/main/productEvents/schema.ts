import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema } from '../../shared/agents'
import { isPublicModelId } from '../agents/usageRates'

/**
 * What a product event may say (ADR-0179). Each event has a strict schema, so a field not named here stops the event
 * rather than leaving with it, and every string is a closed list or a fixed shape, so no path, title or sentence fits in
 * one. A new field is a new line here and in the ADR's list, and tests/unit/main/productEvents/schema.test.ts
 * fails on a forbidden name or a free string.
 */

/** A SHA-256 in hexadecimal, the only shape an identifier takes on its way out. */
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const count = z.number().int().min(0).max(1_000_000_000_000)
const milliseconds = z.number().int().min(0).max(31 * 24 * 60 * 60 * 1000)
/** A model's ID as `publicModelId` returns it: on the reviewed list of public models or not at all. */
const publicModel = z.string().refine(isPublicModelId)
export const PRODUCT_EVENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
const effort = z.enum(PRODUCT_EVENT_EFFORTS)
const permissionMode = agentRuntimeModeSchema
const startedBy = z.enum(['user', 'watcher', 'delegation', 'council', 'swarm', 'other'])
/** What a thread and each of its turns say about how it runs. */
const threadRun = { provider: providerIdSchema, model: publicModel.optional(), effort: effort.optional(), permissionMode: permissionMode.optional(), startedBy }

/** The features `feature.used` counts, at most once a day each while Sotto runs. A press on anything else sends nothing. */
export const PRODUCT_EVENT_FEATURES = ['council', 'watcher', 'swarm', 'delegation', 'browser', 'test-iphone', 'terminal', 'files', 'changes', 'usage', 'add-host', 'add-phone', '3d-model'] as const

export const PRODUCT_EVENT_SCHEMAS = {
  'install.owner_observed': z.strictObject({ ownerSource: z.enum(['claude', 'openai']), ownerId: hash }),
  'app.started': z.strictObject({ pairedHosts: z.number().int().min(0).max(10_000) }),
  'thread.started': z.strictObject({ ...threadRun, inWorktree: z.boolean() }),
  'turn.completed': z.strictObject({
    ...threadRun, speed: z.enum(['standard', 'fast', 'ultrafast']).optional(), result: z.enum(['completed', 'failed', 'stopped']), durationMs: milliseconds,
    inputTokens: count.optional(), cachedInputTokens: count.optional(), outputTokens: count.optional(), reasoningTokens: count.optional(),
    childInputTokens: count.optional(), childOutputTokens: count.optional(),
  }),
  'feature.used': z.strictObject({ feature: z.enum(PRODUCT_EVENT_FEATURES) }),
} as const

export type ProductEventName = keyof typeof PRODUCT_EVENT_SCHEMAS
export type ProductEventProperties<E extends ProductEventName> = z.input<(typeof PRODUCT_EVENT_SCHEMAS)[E]>

/** What every event says about the install it came from, read once when the sender is made. */
const productEventInstall = z.strictObject({
  appVersion: z.string().regex(/^\d+\.\d+\.\d+(-[0-9a-z.-]{1,32})?$/),
  channel: z.enum(['stable', 'owl']),
  surface: z.enum(['desktop', 'host']),
  platform: z.enum(['windows', 'macos', 'linux', 'other']),
  arch: z.enum(['x64', 'arm64', 'other']),
})
export type ProductEventInstall = z.input<typeof productEventInstall>

export function parseProductEventInstall(value: unknown): ProductEventInstall | null {
  const parsed = productEventInstall.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The event's own properties when they pass its schema, otherwise null. It never throws. */
export function parseProductEvent<E extends ProductEventName>(event: E, properties: unknown): ProductEventProperties<E> | null {
  if (!Object.hasOwn(PRODUCT_EVENT_SCHEMAS, event)) return null
  const schema: z.ZodType = PRODUCT_EVENT_SCHEMAS[event]
  const parsed = schema.safeParse(properties)
  return parsed.success ? parsed.data as ProductEventProperties<E> : null
}

export function productEventPlatform(platform: NodeJS.Platform): ProductEventInstall['platform'] {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'other'
}
export function productEventArch(arch: string): ProductEventInstall['arch'] {
  return arch === 'x64' || arch === 'arm64' ? arch : 'other'
}
