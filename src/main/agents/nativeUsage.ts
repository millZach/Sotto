import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { threadUsageSchema, usageTokensSchema, type ThreadUsage, type UsageTokens } from '../../shared/threadUsage'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { estimateUsage, USAGE_RATE_VERSION } from './usageRates'

const entrySchema = z.object({ tokens: usageTokensSchema, model: z.string(), usd: z.number().optional(), lowerBound: z.boolean().optional(), rate: z.string() })
const ledgerSchema = z.object({ view: threadUsageSchema, entries: z.record(z.string(), entrySchema),
  total: usageTokensSchema.optional(), model: z.string().optional(), seen: z.array(z.string()), latestId: z.string().optional(), incomplete: z.boolean().default(false), contextCompacted: z.boolean().optional() })
type Ledger = z.infer<typeof ledgerSchema>
const SYNTHETIC = '<synthetic>'
const GROK_REPORTED_COST = 'grok-reported-cost'
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
function codexTokens(value: unknown): UsageTokens {
  const row = object(value)
  return { input: count(row.inputTokens), output: count(row.outputTokens), cached: count(row.cachedInputTokens), cacheWrite: count(row.cacheWriteInputTokens) }
}
function claudeTokens(value: unknown): UsageTokens {
  const row = object(value); const input = count(row.input_tokens); const cached = count(row.cache_read_input_tokens); const write = count(row.cache_creation_input_tokens)
  const creation = object(row.cache_creation)
  return { input: input !== undefined && cached !== undefined && write !== undefined ? input + cached + write : undefined,
    output: count(row.output_tokens), cached, cacheWrite: write,
    cacheWrite5m: count(creation.ephemeral_5m_input_tokens), cacheWrite1h: count(creation.ephemeral_1h_input_tokens) }
}

/**
 * Claude's result frame keys its per-model figures by the model as the session selected it, which carries a
 * context suffix the assistant messages leave off: `claude-opus-5[1m]` against `claude-opus-5`. Matching only
 * the exact string loses the context window, and the thread then has nothing but a raw token count to show.
 * The suffix is the only difference allowed, so a row is never read off a different model.
 */
function claudeModelUsage(modelUsage: unknown, model: string): unknown {
  const rows = object(modelUsage)
  if (Object.hasOwn(rows, model)) return rows[model]
  const base = (name: string): string => name.replace(/\[[^\]]*\]$/u, '')
  const matches = Object.keys(rows).filter(key => base(key) === base(model))
  return matches.length === 1 ? rows[matches[0]!] : undefined
}

/** Accounting observation only: never changes delivery, native sessions, or billing settings. */
export class NativeUsage {
  private readonly store: AtomicJsonStore<Record<string, Ledger>>
  private data: Record<string, Ledger> = {}
  private readonly streaming = new Map<string, string>()
  private writing = Promise.resolve()
  constructor(directory: string, private readonly provider: 'codex' | 'claude' | 'grok') {
    this.store = new AtomicJsonStore(join(directory, `${provider}-usage.json`), z.record(z.string(), ledgerSchema).parse, () => ({}))
  }
  async load(): Promise<void> {
    await this.writing; this.data = await this.store.read(); this.streaming.clear()
    let changed = false
    for (const ledger of Object.values(this.data)) {
      for (const [key, entry] of Object.entries(ledger.entries)) {
        // Claude's own local notices carry no billed work.
        if (entry.model === SYNTHETIC) { delete ledger.entries[key]; changed = true; continue }
        // Usage recorded before its model had a price is priced once one exists; priced entries keep their rate.
        if (entry.usd !== undefined) continue
        const estimate = estimateUsage(this.provider, entry.model, entry.tokens)
        if (estimate) { ledger.entries[key] = { ...entry, usd: estimate.usd, ...(estimate.lowerBound ? { lowerBound: true } : {}), rate: USAGE_RATE_VERSION }; changed = true }
      }
      const before = JSON.stringify(ledger.view)
      this.summarize(ledger)
      changed ||= JSON.stringify(ledger.view) !== before
    }
    if (changed) this.writing = this.store.write(structuredClone(this.data)).catch(() => undefined)
  }
  async flushed(): Promise<void> { await this.writing }
  get(id: string): ThreadUsage | undefined { return this.data[id]?.view }
  compacted(id: string, used: unknown, updatedAt = new Date().toISOString()): void {
    const ledger = this.ledger(id)
    ledger.view.contextUsed = count(used)
    ledger.view.contextUpdatedAt = updatedAt
    ledger.contextCompacted = true
    this.save(id)
  }
  private ledger(id: string): Ledger {
    return this.data[id] ??= { view: { rateVersions: [], partial: false, updatedAt: new Date().toISOString() }, entries: {}, seen: [], incomplete: false }
  }
  private summarize(ledger: Ledger): void {
    const entries = Object.values(ledger.entries)
    const priced = entries.filter(entry => entry.usd !== undefined)
    ledger.view.estimatedUsd = priced.length ? priced.reduce((sum, entry) => sum + entry.usd!, 0) : undefined
    ledger.view.rateVersions = [...new Set(priced.map(entry => entry.rate))]
    ledger.view.partial = ledger.incomplete || entries.some(entry => entry.usd === undefined || entry.lowerBound === true)
    // Every recorded request, so the thread's tokens add up rather than showing only the latest request.
    const total: UsageTokens = {}
    for (const field of ['input', 'output', 'cached'] as const) {
      const reported = entries.filter(entry => entry.tokens[field] !== undefined)
      if (reported.length) total[field] = reported.reduce((sum, entry) => sum + entry.tokens[field]!, 0)
    }
    ledger.view.total = Object.keys(total).length ? total : undefined
  }
  private save(id: string): void {
    const ledger = this.data[id]!
    this.summarize(ledger)
    this.writing = this.store.write(structuredClone(this.data)).then(() => { delete ledger.view.persistenceError }, () => { ledger.view.persistenceError = true })
  }
  private record(ledger: Ledger, key: string, model: string, tokens: UsageTokens, reported?: { readonly usd: number; readonly rate: string }): void {
    if (model === SYNTHETIC || !Object.values(tokens).some(value => value !== undefined)) return
    const previous = ledger.entries[key]
    if (previous && previous.model === model && JSON.stringify(previous.tokens) === JSON.stringify(tokens)) return
    if (reported) { ledger.entries[key] = { tokens, model, usd: reported.usd, rate: reported.rate }; return }
    const estimate = estimateUsage(this.provider, model, tokens)
    ledger.entries[key] = { tokens, model, usd: estimate?.usd, ...(estimate?.lowerBound ? { lowerBound: true } : {}), rate: USAGE_RATE_VERSION }
  }
  codex(id: string, model: string, value: unknown): void {
    const params = object(value); const usage = object(params.tokenUsage)
    if (!params.turnId || !usage.total || !usage.last) return
    const total = codexTokens(usage.total); const last = codexTokens(usage.last)
    if (!Object.values(last).some(value => value !== undefined)) return
    const ledger = this.ledger(id)
    const key = createHash('sha256').update(JSON.stringify([params.turnId, total])).digest('hex')
    if (ledger.seen.includes(key)) return
    ledger.seen.push(key)
    const previous = ledger.total
    let delta = last
    const reset = previous && (Object.keys(total) as (keyof UsageTokens)[]).some(field => total[field] !== undefined && previous[field] !== undefined && total[field]! < previous[field]!)
    if (reset) {
      // A lower cumulative snapshot can be a reset or unseen historical replay.
      // Its last request cannot safely be charged again. Keep the prior high-water
      // baseline so later unseen historical snapshots cannot charge that work again.
      delta = {}; ledger.incomplete = true
    } else if (previous && total.input !== undefined && total.output !== undefined && ledger.model === model && previous.input !== undefined && previous.output !== undefined
      && total.input >= previous.input && total.output >= previous.output
      && (total.cached === undefined || previous.cached === undefined || total.cached >= previous.cached)
      && (total.cacheWrite === undefined || previous.cacheWrite === undefined || total.cacheWrite >= previous.cacheWrite)) {
      delta = { input: total.input - previous.input, output: total.output - previous.output,
        cached: total.cached !== undefined && previous.cached !== undefined ? total.cached - previous.cached : undefined,
        cacheWrite: total.cacheWrite !== undefined && previous.cacheWrite !== undefined ? total.cacheWrite - previous.cacheWrite : undefined }
    } else if (previous || total.input !== last.input || total.output !== last.output) ledger.incomplete = true
    this.record(ledger, key, model, delta)
    if (!reset) { ledger.total = total; ledger.model = model }
    ledger.view.latest = last
    ledger.view.modelId = model
    ledger.view.contextUsed = count(object(usage.last).totalTokens)
    ledger.view.contextWindow = count(usage.modelContextWindow) || undefined
    ledger.view.updatedAt = new Date().toISOString()
    ledger.view.contextUpdatedAt = ledger.view.updatedAt
    this.save(id)
  }
  claude(id: string, value: unknown, selectedModel?: string): void {
    const frame = object(value)
    // Native child usage is not projected as parent activity or silently double-billed.
    if (frame.parent_tool_use_id || frame.isSidechain === true) return
    if (frame.type === 'stream_event') {
      const event = object(frame.event)
      if (event.type === 'message_start') {
        const message = object(event.message)
        if (typeof message.id === 'string') this.streaming.set(id, message.id)
        this.claude(id, { type: 'assistant', message }, selectedModel); return
      }
      if (event.type === 'message_stop') this.streaming.delete(id)
      if (event.type === 'message_delta') {
        const ledger = this.data[id]; const key = this.streaming.get(id); const entry = key ? ledger?.entries[key] : undefined
        const output = count(object(event.usage).output_tokens)
        if (ledger && key && entry && output !== undefined && output >= (entry.tokens.output ?? 0)) {
          const tokens = { ...entry.tokens, output }
          this.record(ledger, key, entry.model, tokens)
          if (ledger.latestId === key) ledger.view.latest = tokens
          this.save(id)
        }
      }
      return
    }
    const message = object(frame.message)
    // Claude's own local notices carry no billed work or context.
    if (frame.type !== 'assistant' || typeof message.id !== 'string' || !message.usage || message.model === SYNTHETIC) return
    const ledger = this.ledger(id); const tokens = claudeTokens(message.usage)
    const previous = ledger.entries[message.id]
    // History and stream replay often contain an earlier snapshot of the same message.
    const merged = { ...tokens }
    for (const field of Object.keys(previous?.tokens ?? {}) as (keyof UsageTokens)[]) {
      const old = previous?.tokens[field]
      if (old !== undefined && (merged[field] === undefined || merged[field]! < old)) merged[field] = old
    }
    this.record(ledger, message.id, typeof message.model === 'string' ? message.model : '', merged)
    const isNew = !previous
    const older = typeof frame.timestamp === 'string' && Number.isFinite(Date.parse(frame.timestamp)) && Date.parse(frame.timestamp) < Math.max(Date.parse(ledger.view.updatedAt), Date.parse(ledger.view.contextUpdatedAt ?? ledger.view.updatedAt))
    if (ledger.latestId === message.id && !ledger.contextCompacted && !older || isNew && (!ledger.view.latest && !ledger.contextCompacted || !older)) {
      const nextModel = selectedModel ?? (typeof message.model === 'string' ? message.model : undefined)
      if (ledger.view.modelId !== nextModel) delete ledger.view.contextWindow
      const contextChanged = ledger.latestId !== message.id || ledger.view.contextUsed !== merged.input
      ledger.latestId = message.id; ledger.view.latest = merged; ledger.view.contextUsed = merged.input
      if (isNew || ledger.view.modelId === undefined) ledger.view.modelId = nextModel
      ledger.view.updatedAt = typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString()
      if (contextChanged) ledger.view.contextUpdatedAt = ledger.view.updatedAt
      ledger.contextCompacted = false
    }
    this.save(id)
  }
  elapsed(id: string, elapsed: unknown, contextWindow?: unknown): void {
    if (count(elapsed) === undefined && !count(contextWindow)) return
    const ledger = this.ledger(id)
    ledger.view.elapsedMs = count(elapsed)
    ledger.view.contextWindow = count(contextWindow) || ledger.view.contextWindow
    this.save(id)
  }
  claudeResult(id: string, value: unknown): void {
    const frame = object(value); const ledger = this.data[id]
    const model = ledger?.latestId ? ledger.entries[ledger.latestId]?.model : undefined
    this.elapsed(id, frame.duration_ms, model ? object(claudeModelUsage(frame.modelUsage, model)).contextWindow : undefined)
  }
  grok(id: string, selectedModel: string, value: unknown): void {
    const params = object(value); const update = object(params.update); const usage = object(update.usage)
    if (update.sessionUpdate !== 'turn_completed' || !update.usage) return
    const meta = object(params._meta)
    const identity = typeof update.prompt_id === 'string' ? update.prompt_id
      : typeof meta.eventId === 'string' && count(meta.agentTimestampMs) !== undefined ? `${meta.eventId}:${meta.agentTimestampMs}` : undefined
    const tokens = (row: Record<string, unknown>): UsageTokens => ({ input: count(row.inputTokens), output: count(row.outputTokens), cached: count(row.cachedReadTokens), cacheWrite: count(row.cacheCreationTokens) })
    const ledger = this.ledger(id)
    if (identity && ledger.seen.includes(identity)) return
    if (identity) {
      ledger.seen.push(identity)
      const models = Object.entries(object(usage.modelUsage))
      const ticks = count(usage.costUsdTicks)
      // Grok reports what the turn cost (docs.x.ai cost tracking: 1 USD = 10^10 ticks). Its Build models have no published list price.
      if (ticks !== undefined) this.record(ledger, identity, models.length === 1 ? models[0]![0] : selectedModel, tokens(usage), { usd: ticks / 10_000_000_000, rate: GROK_REPORTED_COST })
      else if (models.length) for (const [model, row] of models) this.record(ledger, `${identity}:${model}`, model, tokens(object(row)))
      else this.record(ledger, identity, selectedModel, tokens(usage))
    } else ledger.incomplete = true
    const timestamp = count(meta.agentTimestampMs)
    if (!ledger.view.latest || timestamp === undefined || timestamp >= Date.parse(ledger.view.updatedAt)) {
      ledger.view.latest = tokens(usage); ledger.view.modelId = selectedModel
      // Native turn usage aggregates model calls. It is not a current context size.
      ledger.view.contextUsed = undefined; ledger.view.contextWindow = undefined
      ledger.view.elapsedMs = count(usage.apiDurationMs); ledger.view.elapsedKind = 'api'
      ledger.view.updatedAt = new Date(timestamp ?? Date.now()).toISOString()
    }
    this.save(id)
  }
}
