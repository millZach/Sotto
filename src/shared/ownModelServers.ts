import { z } from 'zod'

/**
 * Your own model servers (ADR-0124): model servers the user runs, such as SGLang, vLLM, Ollama, LM Studio or llama.cpp,
 * on this computer, their network or their tailnet, which a provider drives as a model source. OpenCode is the first
 * provider to run them. Main keeps the record and checks a server only when the user presses Check or Add; a key goes
 * from the dialog to main once and from main to Sotto's OpenCode once, and nothing here carries one back.
 */

/** Passed to the main window's preload only while the `own-model-servers` Owl feature is on; without it there is no bridge. */
export const OWN_SERVERS_RENDERER_ARGUMENT = '--sotto-own-model-servers'
export const OWN_SERVERS_LIST = 'sotto:own-servers:list'
export const OWN_SERVERS_CHECK = 'sotto:own-servers:check'
export const OWN_SERVERS_ADD = 'sotto:own-servers:add'
export const OWN_SERVERS_CHECK_SAVED = 'sotto:own-servers:check-saved'
export const OWN_SERVERS_REMOVE = 'sotto:own-servers:remove'

/** Every server's ID starts with this, so it never meets an OpenCode provider ID of its own, such as `ollama` or `vllm`. */
export const OWN_SERVER_ID_PREFIX = 'own-'
/** The longest key Sotto passes on, as for OpenCode's other model sources. */
export const OWN_SERVER_KEY_MAX = 4_096
/** The most models one server may bring; a server listing more is cut to these, by its own order. */
export const OWN_SERVER_MODELS_MAX = 64
/** The smallest and largest context a model may be given, in tokens. */
export const OWN_SERVER_CONTEXT_MIN = 1_024
export const OWN_SERVER_CONTEXT_MAX = 10_000_000

const serverId = z.string().min(OWN_SERVER_ID_PREFIX.length + 1).max(64).regex(/^own-[a-z0-9-]+$/u)
const name = z.string().trim().min(1).max(80)
const address = z.string().min(1).max(400)
const modelId = z.string().min(1).max(200)
const context = z.number().int().min(OWN_SERVER_CONTEXT_MIN).max(OWN_SERVER_CONTEXT_MAX)
const key = z.string().max(OWN_SERVER_KEY_MAX)

/** A model as Sotto saves it: what OpenCode is told about it, since OpenCode never asks the server for its models. */
export const ownServerModelSchema = z.object({
  id: modelId, name: z.string().min(1).max(200), context, output: context.optional(),
  /** Thinking on: OpenCode offers low, medium and high effort and sends `reasoning_effort`. Off: no effort levels. */
  thinking: z.boolean(),
  /** Whether the server says the model takes images; false unless it does. */
  images: z.boolean(),
}).strict()
export type OwnServerModel = z.infer<typeof ownServerModelSchema>

/** A saved server. It holds no key: `keyed` only says one was given to OpenCode when it was added. */
export const ownServerSchema = z.object({
  id: serverId, name, address, keyed: z.boolean(), models: z.array(ownServerModelSchema).min(1).max(OWN_SERVER_MODELS_MAX),
}).strict()
export type OwnServer = z.infer<typeof ownServerSchema>
export const ownServerListSchema = z.array(ownServerSchema).max(32)

/** What kind of server answered, as far as its answers tell. Only shown in words; nothing depends on it but discovery. */
export const ownServerKindSchema = z.enum(['vllm', 'sglang', 'ollama', 'lmstudio', 'llamacpp', 'tgi', 'openai-compatible'])
export type OwnServerKind = z.infer<typeof ownServerKindSchema>

/** A model the check found, before the user adds it. `context` is absent when the server does not say. */
export const foundModelSchema = z.object({
  id: modelId, name: z.string().min(1).max(200), context: context.optional(), output: context.optional(),
  /** Whether the server says the model can think, and so whether Thinking starts on. Absent when it does not say. */
  thinking: z.boolean().optional(),
  images: z.boolean(),
}).strict()
export type FoundModel = z.infer<typeof foundModelSchema>

/** Why a check or an add went no further. Each has its words in `OWN_SERVER_WORDS`. */
export const ownServerRefusalSchema = z.enum([
  'bad-address', 'public-http', 'unreachable', 'key-needed', 'key-refused', 'no-models', 'not-openai', 'opencode-not-running', 'sign-in-failed',
  'not-found', 'full',
  /** Something in Sotto went wrong before the request was done, such as the record not being written. */
  'failed',
])
export type OwnServerRefusal = z.infer<typeof ownServerRefusalSchema>
const refused = z.object({ status: z.literal('refused'), reason: ownServerRefusalSchema, message: z.string().min(1).max(600) }).strict()

export const checkRequestSchema = z.object({ address, key: key.optional() }).strict()
export type CheckRequest = z.infer<typeof checkRequestSchema>
export const checkResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    /** The address as Sotto will save it, after `ownServerAddress`. */
    address, kind: ownServerKindSchema, models: z.array(foundModelSchema).min(1).max(OWN_SERVER_MODELS_MAX),
    /** How long the server took to list its models, or with `keyKept` to ask for its key, in milliseconds. */
    answeredMs: z.number().int().min(0).max(600_000),
    /**
     * Check again on a server added with a key: it answered and asked for the key, which OpenCode keeps and Sotto does not,
     * so its models could not be read again and `models` are the saved ones. Absent on every other check.
     */
    keyKept: z.literal(true).optional(),
  }).strict(),
  refused,
])
export type CheckResult = z.infer<typeof checkResultSchema>

export const addRequestSchema = z.object({
  name, address, key: key.optional(), models: z.array(ownServerModelSchema).min(1).max(OWN_SERVER_MODELS_MAX),
}).strict()
export type AddRequest = z.infer<typeof addRequestSchema>
export const addResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), server: ownServerSchema }).strict(), refused])
export type AddResult = z.infer<typeof addResultSchema>

/** Check again: the saved server is checked as it is saved, and its models are not changed until the user adds again. */
export const checkSavedRequestSchema = z.object({ id: serverId }).strict()
export const removeRequestSchema = z.object({ id: serverId }).strict()
export const removeResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok') }).strict(), refused])
export type RemoveResult = z.infer<typeof removeResultSchema>

/** The main window's bridge, present only while the Owl feature is on. */
export interface OwnServersBridge {
  list(): Promise<OwnServer[]>
  check(request: CheckRequest): Promise<CheckResult>
  add(request: AddRequest): Promise<AddResult>
  checkSaved(request: { id: string }): Promise<CheckResult>
  remove(request: { id: string }): Promise<RemoveResult>
}

/** The words each outcome is told in, shared by main and the dialog. `host` is the address's host and port. */
export const OWN_SERVER_WORDS = {
  badAddress: 'That is not an address Sotto can reach. Type it like http://localhost:11434 or http://spark-head:8888.',
  publicHttp: (host: string) => `${host} is on the internet, so Sotto needs https:// to send it a key and your code. Use the server’s https address, or reach it over your tailnet.`,
  unreachable: (host: string) => `Nothing answered at ${host}. Nothing was saved. Check the server is on and this computer can reach it, over the tailnet if it is there, then try again.`,
  keyNeeded: (host: string) => `${host} asks for a key. Nothing was saved. Paste the key whoever runs the server gave you, then check again.`,
  keyRefused: (host: string) => `${host} turned down the key. Nothing was saved. Check the key with whoever runs the server, then try again.`,
  noModels: (host: string) => `${host} answered but has no models loaded. Nothing was saved. Load a model on the server, then check again.`,
  notOpenAI: (host: string) => `Something answered at ${host}, but not as an OpenAI-compatible server. Nothing was saved. Check the port and the path, such as http://localhost:11434/v1, then try again.`,
  openCodeNotRunning: 'Your own servers run with OpenCode, and Sotto’s OpenCode is not running, so nothing was saved. Connect OpenCode under Providers, then add the server again.',
  signInFailed: (name: string) => `OpenCode did not take the key for ${name}, so nothing was saved. Try adding the server again.`,
  notFound: 'That server is no longer saved. Nothing was changed.',
  full: 'Sotto keeps up to 32 servers. Remove one you no longer use, then add this one.',
  removeNeedsOpenCode: (name: string) => `Sotto’s OpenCode holds the key for ${name} and is not running, so nothing was removed. Connect OpenCode under Providers, then remove the server again.`,
  signOutFailed: (name: string) => `OpenCode did not forget the key for ${name}, so nothing was removed. Try removing the server again.`,
  removePartly: (name: string) => `OpenCode no longer has the key for ${name}, but Sotto could not take ${name} off its list. Remove it again.`,
  failed: 'Sotto could not finish that, so nothing was changed. Try again.',
  contextUnknown: 'The server does not say how much context this model has. Type it from the model’s page.',
  privacy: 'Threads on this server send your code and messages to it, so whoever runs it can read them.',
} as const

/** The words for a refusal, for the address the user gave. */
export function ownServerRefusalWords(reason: OwnServerRefusal, host: string, serverName = host): string {
  switch (reason) {
    case 'bad-address': return OWN_SERVER_WORDS.badAddress
    case 'public-http': return OWN_SERVER_WORDS.publicHttp(host)
    case 'unreachable': return OWN_SERVER_WORDS.unreachable(host)
    case 'key-needed': return OWN_SERVER_WORDS.keyNeeded(host)
    case 'key-refused': return OWN_SERVER_WORDS.keyRefused(host)
    case 'no-models': return OWN_SERVER_WORDS.noModels(host)
    case 'not-openai': return OWN_SERVER_WORDS.notOpenAI(host)
    case 'opencode-not-running': return OWN_SERVER_WORDS.openCodeNotRunning
    case 'sign-in-failed': return OWN_SERVER_WORDS.signInFailed(serverName)
    case 'not-found': return OWN_SERVER_WORDS.notFound
    case 'full': return OWN_SERVER_WORDS.full
    case 'failed': return OWN_SERVER_WORDS.failed
  }
}

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.ts.net', '.localhost']

function ipv4(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/u.test(part))) return undefined
  const numbers = parts.map(Number)
  return numbers.every(value => value <= 255) ? numbers : undefined
}

/**
 * Whether a host is private: this computer, a home or office network, or the tailnet. Tailscale's addresses are in
 * 100.64.0.0/10 and its names end in `.ts.net`; a single-label name such as `forge` is a local or MagicDNS name.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return true
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
  }
  if (host.includes(':')) {
    if (host === '::1') return true
    const first = Number.parseInt(host.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return !host.includes('.')
}

export type OwnServerAddress =
  | { readonly ok: true; readonly address: string; readonly host: string }
  | { readonly ok: false; readonly reason: 'bad-address' | 'public-http'; readonly host: string }

/**
 * The address the user typed, as Sotto saves it: http:// when no scheme was given, no user name, password, query or
 * fragment, and `/v1` when no path was given, since that is where OpenAI-compatible servers answer. Plain http only to a
 * private host (Zach's pick, October 23, 2026); a public one needs https.
 */
export function ownServerAddress(typed: string): OwnServerAddress {
  const trimmed = typed.trim()
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`) } catch { return { ok: false, reason: 'bad-address', host: trimmed.slice(0, 80) } }
  const host = url.host
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'bad-address', host: host || trimmed.slice(0, 80) }
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) return { ok: false, reason: 'public-http', host }
  const path = url.pathname.replace(/\/+$/u, '')
  const address = `${url.protocol}//${host}${path || '/v1'}`
  // The record holds addresses up to 400 characters; a longer one would make it unreadable.
  if (address.length > 400) return { ok: false, reason: 'bad-address', host: host.slice(0, 80) }
  return { ok: true, address, host }
}
