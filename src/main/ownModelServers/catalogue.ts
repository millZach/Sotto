import { ownServerAddress, type CatalogueEntry, type FoundModel } from '../../shared/ownModelServers'
import { readBoundedText } from './check'
import { effortRank } from '../../shared/reasoningEfforts'

/** Public metadata only. No credential or provider response is passed to this host. */
export const MODEL_CATALOGUE_URL = 'https://models.dev/api.json'
type ObjectValue = Record<string, unknown>
export const objectValue = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const amount = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined
}
export function modelCost(value: unknown, multiplier = 1): FoundModel['cost'] {
  const raw = objectValue(value), result: NonNullable<FoundModel['cost']> = {}
  for (const [target, source] of [['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read']] as const) {
    const number = amount(raw[source]); if (number !== undefined && Number.isFinite(number * multiplier)) result[target] = number * multiplier
  }
  return Object.keys(result).length ? result : undefined
}
export function confirmedEfforts(value: unknown): FoundModel['reasoningEfforts'] {
  if (!Array.isArray(value)) return undefined
  const levels: string[] = []
  for (const item of value) {
    const option = objectValue(item)
    if (option.type === 'toggle') levels.push('none')
    if (option.type === 'effort' && Array.isArray(option.values)) levels.push(...option.values.filter((v): v is string => typeof v === 'string'))
  }
  const valid = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  const known = [...new Set(levels.filter(level => valid.has(level)))].sort((a, b) => (effortRank(a) ?? 0) - (effortRank(b) ?? 0)) as NonNullable<FoundModel['reasoningEfforts']>
  if (known.length === 1 && known[0] === 'none') known.push('default')
  return known.length ? known : undefined
}
const tokens = (value: unknown): number | undefined => {
  const number = amount(value); return number !== undefined && Number.isInteger(number) && number >= 1024 && number <= 10_000_000 ? number : undefined
}
export interface CatalogueProvider extends CatalogueEntry { models: Map<string, FoundModel> }
export function parseCatalogue(value: unknown): CatalogueProvider[] {
  const providers: CatalogueProvider[] = []
  for (const [id, raw] of Object.entries(objectValue(value))) {
    const entry = objectValue(raw)
    if (typeof entry.api !== 'string' || (entry.npm !== '@ai-sdk/openai-compatible' && id !== 'openrouter')) continue
    const address = entry.api.includes('${') ? { ok: true, address: entry.api } : ownServerAddress(entry.api)
    if (!address.ok) continue
    const models = new Map<string, FoundModel>()
    for (const [modelId, rawModel] of Object.entries(objectValue(entry.models))) {
      const model = objectValue(rawModel), limit = objectValue(model.limit), modalities = objectValue(model.modalities)
      if (!modelId || modelId.length > 200) continue
      const levels = confirmedEfforts(model.reasoning_options)
      const input = Array.isArray(modalities.input) ? modalities.input : undefined
      const cost = modelCost(model.cost)
      models.set(modelId, { id: modelId, name: typeof model.name === 'string' ? model.name.slice(0, 200) : modelId,
        ...((tokens(limit.context) ?? tokens(limit.input)) !== undefined ? { context: (tokens(limit.context) ?? tokens(limit.input))! } : {}),
        ...(amount(limit.output) !== undefined && Number.isInteger(amount(limit.output)) && amount(limit.output)! > 0 && amount(limit.output)! <= 10_000_000 ? { output: amount(limit.output)! } : {}),
        ...(typeof model.reasoning === 'boolean' ? { thinking: model.reasoning } : {}),
        ...(levels ? { reasoningEfforts: levels } : {}),
        ...(typeof model.tool_call === 'boolean' ? { tools: model.tool_call } : {}),
        ...(input ? { images: input.includes('image') } : {}), ...(cost ? { cost } : {}) })
    }
    providers.push({ id, name: typeof entry.name === 'string' ? entry.name.slice(0, 100) : id, api: address.address,
      ...(typeof entry.doc === 'string' && entry.doc.length <= 400 && /^https:\/\//u.test(entry.doc) ? { doc: entry.doc } : {}), models })
  }
  return providers.sort((a, b) => a.name.localeCompare(b.name))
}

/** Provider facts are authoritative, including false and zero; missing facts fall back one field at a time. */
export function mergeModelFacts(api: FoundModel, catalogue?: FoundModel): FoundModel {
  const supplied = Object.fromEntries(Object.entries(api).filter(([, value]) => value !== undefined))
  const result: FoundModel = { ...catalogue, ...supplied, id: api.id, name: api.name, cost: { ...catalogue?.cost, ...api.cost } }
  if (!Object.keys(result.cost ?? {}).length) delete result.cost
  result.reasoningEfforts = result.thinking === false ? [] : api.reasoningEfforts ?? catalogue?.reasoningEfforts ?? ['default']
  if (!api.reportedName && api.name === api.id && catalogue) result.name = catalogue.name
  return result
}

/** One successful download for the app run. A failed attempt can be retried. No disk cache and no logging. */
export class ModelCatalogue {
  private pending: Promise<CatalogueProvider[]> | undefined
  private entries: CatalogueProvider[] = []
  constructor(private readonly request: typeof fetch = fetch) {}
  async load(): Promise<{ entries: CatalogueEntry[]; available: boolean }> {
    try {
      this.pending ??= this.download()
      this.entries = await this.pending
      return { available: true, entries: this.entries.map(({ id, name, api, doc }) => ({ id, name, api, ...(doc ? { doc } : {}) })) }
    } catch { this.pending = undefined; return { available: false, entries: [] } }
  }
  provider(address: string, id?: string): CatalogueProvider | undefined {
    return this.entries.find(entry => (!id || id === entry.id) && (entry.api === address || (!!id && entry.api.includes('${'))))
  }
  private async download(): Promise<CatalogueProvider[]> {
    const response = await this.request(MODEL_CATALOGUE_URL, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Catalogue unavailable') }
    const text = await readBoundedText(response, 32 * 1024 * 1024)
    if (text === null) throw new Error('Catalogue too large')
    return parseCatalogue(JSON.parse(text))
  }
}
