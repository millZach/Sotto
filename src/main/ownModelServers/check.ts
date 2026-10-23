import {
  OWN_SERVER_CONTEXT_MAX, OWN_SERVER_CONTEXT_MIN, OWN_SERVER_MODELS_MAX, ownServerAddress, ownServerRefusalWords,
  type CheckResult, type FoundModel, type OwnServerKind, type OwnServerRefusal,
} from '../../shared/ownModelServers'

/**
 * Checking a model server the user runs (ADR-0124), only when they press Check, Add or Check again. The model list comes
 * from the OpenAI API every such server answers; each model's context and abilities from what that kind of server says
 * about it. A failed extra request only leaves something unknown: the list alone decides whether the check passes.
 * Nothing the server sends reaches a log, and the key goes only to the address the user gave, as a Bearer token.
 */

export interface OwnServerCheckOptions {
  /** Main's own `fetch`; a test gives its own. */
  readonly fetch?: typeof fetch
  /** How long one request may take. */
  readonly requestMs?: number
  /** How long the whole check may take, extra requests included; what is unanswered by then is unknown. */
  readonly totalMs?: number
  /** How many models are asked about at once. */
  readonly concurrency?: number
  readonly now?: () => number
}

const REQUEST_MS = 10_000
const TOTAL_MS = 30_000
const CONCURRENCY = 4
/** The most of an answer Sotto reads; a model list is a few kilobytes, so anything far past this is not one. */
const ANSWER_BYTES_MAX = 8 * 1024 * 1024

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined
/** A context Sotto can save, or undefined for none or one outside what a model may be given. */
const contextOf = (value: unknown): number | undefined => {
  const tokens = integer(value)
  return tokens !== undefined && tokens >= OWN_SERVER_CONTEXT_MIN && tokens <= OWN_SERVER_CONTEXT_MAX ? tokens : undefined
}

class Unanswered extends Error {}
/** A server that answered with a status other than success. */
class Answered extends Error { constructor(readonly status: number) { super('The server answered with an error.') } }

interface Asker {
  /** The answer as JSON. Rejects with `Answered` for a status other than 2xx, and `Unanswered` for no answer or not JSON. */
  json(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown>
}

function asker(key: string | undefined, options: OwnServerCheckOptions, overall: AbortSignal): Asker {
  const request = options.fetch ?? fetch
  const requestMs = options.requestMs ?? REQUEST_MS
  return {
    async json(method, url, body) {
      let response: Response
      try {
        response = await request(url, {
          method,
          headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          // A redirect is not followed: it could carry the key, or plain http, somewhere the user did not give.
          redirect: 'manual',
          signal: AbortSignal.any([overall, AbortSignal.timeout(requestMs)]),
        })
      } catch { throw new Unanswered('Nothing answered.') }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined)
        throw new Answered(response.status)
      }
      const length = Number(response.headers.get('content-length') ?? '0')
      if (length > ANSWER_BYTES_MAX) { await response.body?.cancel().catch(() => undefined); throw new Answered(response.status) }
      const raw = await boundedText(response)
      try { return JSON.parse(raw) as unknown } catch { throw new Answered(response.status) }
    },
  }
}

/**
 * An answer's text, read only up to `ANSWER_BYTES_MAX`: a server that sends more, such as a chunked answer with no
 * length, is cut off there rather than held whole in main's memory.
 */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > ANSWER_BYTES_MAX) { await reader.cancel().catch(() => undefined); throw new Answered(response.status) }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof Answered) throw error
    throw new Unanswered('The answer did not arrive.')
  }
  const whole = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength }
  return new TextDecoder().decode(whole)
}

/** Runs `work` on each item with at most `limit` at once. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => { while (next < items.length) { const item = items[next++]!; await work(item) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
/** An extra request's answer, or undefined when it failed in any way. */
const maybe = (promise: Promise<unknown>): Promise<unknown> => promise.catch(() => undefined)

/** A model as the check found it, before what its server says about it. */
interface Listed { id: string; name: string; context?: number | undefined; output?: number | undefined; thinking?: boolean | undefined; images: boolean; drop?: boolean }

/** The server's root: its OpenAI address without the `/v1` the OpenAI API answers under, where its own routes are. */
export function serverRoot(address: string): string {
  return address.replace(/\/v1$/u, '')
}

/** What the model list says about the kind of server, from its `owned_by` and llama.cpp's `meta`. */
function kindFromList(items: readonly Json[]): OwnServerKind | undefined {
  const owners = new Set(items.map(item => text(item.owned_by)?.toLowerCase()))
  if (owners.has('vllm')) return 'vllm'
  if (owners.has('sglang')) return 'sglang'
  if (owners.has('llamacpp') || items.some(item => isObject(item.meta) && 'n_ctx_train' in item.meta)) return 'llamacpp'
  return undefined
}

/** Ollama: `/api/show` for each model, its architecture's context length and its capabilities. */
async function ollama(ask: Asker, root: string, models: Listed[], concurrency: number): Promise<void> {
  await eachLimited(models, concurrency, async model => {
    const shown = await maybe(ask.json('POST', `${root}/api/show`, { model: model.id }))
    if (!isObject(shown)) return
    const info = isObject(shown.model_info) ? shown.model_info : {}
    const architecture = text(info['general.architecture'])
    if (architecture) model.context = contextOf(info[`${architecture}.context_length`])
    if (Array.isArray(shown.capabilities)) {
      const capabilities = new Set(shown.capabilities.filter((item): item is string => typeof item === 'string'))
      model.thinking = capabilities.has('thinking')
      model.images = capabilities.has('vision')
      // An embedding model answers no chat, so it is not offered.
      if (capabilities.has('embedding') && !capabilities.has('completion')) model.drop = true
    }
  })
}

/**
 * LM Studio: `/api/v1/models` (0.4 and later) or `/api/v0/models` before it. The context the loaded instance of that ID
 * runs with wins over the most the model could take, since that is what the server will hold a prompt to; a model loaded
 * more than once has an instance, and a context, for each ID it lists.
 */
function lmstudio(answer: unknown, models: Listed[]): boolean {
  if (!isObject(answer)) return false
  const list = Array.isArray(answer.models) ? answer.models : Array.isArray(answer.data) ? answer.data : undefined
  if (!list) return false
  const entries = list.filter(isObject)
  for (const model of models) {
    const entry = entries.find(item => text(item.key) === model.id || text(item.id) === model.id
      || (Array.isArray(item.loaded_instances) && item.loaded_instances.some(instance => isObject(instance) && text(instance.id) === model.id)))
    if (!entry) continue
    const instance = Array.isArray(entry.loaded_instances) ? entry.loaded_instances.find(item => isObject(item) && text(item.id) === model.id) : undefined
    const loaded = isObject(instance) && isObject(instance.config) ? contextOf(instance.config.context_length) : undefined
    model.context = loaded ?? contextOf(entry.loaded_context_length) ?? contextOf(entry.max_context_length)
    const capabilities = entry.capabilities
    if (isObject(capabilities)) {
      model.images = capabilities.vision === true
      model.thinking = capabilities.reasoning !== undefined && capabilities.reasoning !== false && capabilities.reasoning !== null
    } else if (entry.type === 'vlm') model.images = true
    if (text(entry.display_name)) model.name = text(entry.display_name)!.slice(0, 200)
    if (typeof entry.type === 'string' && entry.type.startsWith('embedding')) model.drop = true
  }
  return true
}

/** llama.cpp: `/props` for the context each slot runs with, what its chat template can do and whether it takes images. */
function llamacppProps(props: unknown, model: Listed): boolean {
  if (!isObject(props) || !isObject(props.default_generation_settings)) return false
  model.context = contextOf(props.default_generation_settings.n_ctx) ?? model.context
  const caps = isObject(props.chat_template_caps) ? props.chat_template_caps : undefined
  if (caps && typeof caps.supports_reasoning_effort === 'boolean') model.thinking = caps.supports_reasoning_effort
  else if (caps && typeof caps.supports_reasoning === 'boolean') model.thinking = caps.supports_reasoning
  if (isObject(props.modalities) && typeof props.modalities.vision === 'boolean') model.images = props.modalities.vision
  return true
}

/** Text Generation Inference: `/info` says the longest prompt it takes. */
function tgiInfo(info: unknown, models: Listed[]): boolean {
  if (!isObject(info) || !('max_input_tokens' in info || 'max_total_tokens' in info)) return false
  const context = contextOf(info.max_input_tokens)
  for (const model of models) model.context = context ?? model.context
  return true
}

/** SGLang: `/model_info` names the reasoning parser the server runs, which it has only for a model that thinks. */
function sglangInfo(info: unknown, models: Listed[]): void {
  if (!isObject(info)) return
  if ('reasoning_parser' in info) for (const model of models) model.thinking = typeof info.reasoning_parser === 'string' && info.reasoning_parser.length > 0
  if (typeof info.has_image_understanding === 'boolean') for (const model of models) model.images = info.has_image_understanding
}

/** What the server says about each model, and so which kind of server it is. */
async function discover(ask: Asker, root: string, items: readonly Json[], models: Listed[], concurrency: number): Promise<OwnServerKind> {
  const listed = kindFromList(items)
  if (listed === 'vllm') return 'vllm'
  if (listed === 'sglang') { sglangInfo(await maybe(ask.json('GET', `${root}/model_info`)), models); return 'sglang' }
  if (listed === 'llamacpp') { await llamacpp(ask, root, models, concurrency); return 'llamacpp' }
  // Nothing in the list says, so each kind's own route is asked; the first that answers as that kind names it.
  const [tags, studio, props, info] = await Promise.all([
    maybe(ask.json('GET', `${root}/api/tags`)), maybe(ask.json('GET', `${root}/api/v1/models`)), maybe(ask.json('GET', `${root}/props`)), maybe(ask.json('GET', `${root}/info`)),
  ])
  if (isObject(tags) && Array.isArray(tags.models)) { await ollama(ask, root, models, concurrency); return 'ollama' }
  if (lmstudio(studio, models)) return 'lmstudio'
  if (lmstudio(await maybe(ask.json('GET', `${root}/api/v0/models`)).then(answer => isObject(answer) && Array.isArray(answer.data)
    && answer.data.some(item => isObject(item) && 'max_context_length' in item) ? answer : undefined), models)) return 'lmstudio'
  if (isObject(props) && isObject(props.default_generation_settings)) { await llamacpp(ask, root, models, concurrency, props); return 'llamacpp' }
  if (tgiInfo(info, models)) return 'tgi'
  return 'openai-compatible'
}
/** llama.cpp: one `/props` for a server running one model, and each model's own when it runs several. */
async function llamacpp(ask: Asker, root: string, models: Listed[], concurrency: number, props?: unknown): Promise<void> {
  if (models.length === 1) { llamacppProps(props ?? await maybe(ask.json('GET', `${root}/props`)), models[0]!); return }
  await eachLimited(models, concurrency, async model => {
    llamacppProps(await maybe(ask.json('GET', `${root}/props?model=${encodeURIComponent(model.id)}`)), model)
  })
}

const refused = (reason: OwnServerRefusal, host: string): CheckResult => ({ status: 'refused', reason, message: ownServerRefusalWords(reason, host) })

/**
 * Checks the server at the address the user typed: whether it may be reached, whether it answers the OpenAI API with
 * models, and what it says about each. `key` goes with every request as a Bearer token when one is given.
 */
export async function checkOwnServer(typed: string, key: string | undefined, options: OwnServerCheckOptions = {}): Promise<CheckResult> {
  const place = ownServerAddress(typed)
  if (!place.ok) return refused(place.reason, place.host)
  const now = options.now ?? Date.now
  const overall = AbortSignal.timeout(options.totalMs ?? TOTAL_MS)
  const trimmed = key?.trim()
  const ask = asker(trimmed || undefined, options, overall)
  const started = now()
  let answer: unknown
  try { answer = await ask.json('GET', `${place.address}/models`) } catch (error) {
    if (error instanceof Answered) {
      if (error.status === 401 || error.status === 403) return refused(trimmed ? 'key-refused' : 'key-needed', place.host)
      return refused('not-openai', place.host)
    }
    return refused('unreachable', place.host)
  }
  const answeredMs = Math.min(600_000, Math.max(0, Math.round(now() - started)))
  if (!isObject(answer) || !Array.isArray(answer.data)) return refused('not-openai', place.host)
  const items: Json[] = []
  const seen = new Set<string>()
  for (const item of answer.data) {
    const id = isObject(item) ? text(item.id) : undefined
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id); items.push(item as Json)
    if (items.length === OWN_SERVER_MODELS_MAX) break
  }
  if (!items.length) return refused('no-models', place.host)
  const models: Listed[] = items.map(item => {
    const meta = isObject(item.meta) ? item.meta : undefined
    return { id: item.id as string, name: (item.id as string).slice(0, 200), context: contextOf(item.max_model_len) ?? contextOf(meta?.n_ctx_train), images: false }
  })
  const kind = await discover(ask, serverRoot(place.address), items, models, options.concurrency ?? CONCURRENCY).catch((): OwnServerKind => 'openai-compatible')
  const kept = models.filter(model => !model.drop)
  if (!kept.length) return refused('no-models', place.host)
  const found: FoundModel[] = kept.map(model => ({
    id: model.id, name: model.name, images: model.images,
    ...(model.context !== undefined ? { context: model.context } : {}),
    ...(model.output !== undefined ? { output: model.output } : {}),
    ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
  }))
  return { status: 'ok', address: place.address, kind, models: found, answeredMs }
}
