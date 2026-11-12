import type { PluginReadKind } from '../../../shared/plugins'
import type { SecretCheck } from '../accounts'

/** Vercel's REST API. An account's token goes to this origin and to no other. */
export const VERCEL_API = 'https://api.vercel.com'
const TIMEOUT_MS = 30_000
/** The most of an answer handed to an agent. A longer one is cut and says so, so the agent asks for less. */
export const VERCEL_READ_MAX_CHARS = 200_000
/** The largest answer read at all: it has to be read whole to take the secrets out of it. */
const BODY_MAX_BYTES = 5_000_000
export const VERCEL_PATH_MAX = 1_000
export const VERCEL_QUERY_MAX = 20
/** What stands where Sotto took a value out of an answer. */
export const REMOVED = '[removed by Sotto]'

/** A path as Vercel documents them, without the leading slash: a version, then names. `v6/deployments`. */
const PATH = /^v[0-9]{1,2}(?:\/[A-Za-z0-9._~%+@,=-]+)+$/u
const QUERY_KEY = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/u

/**
 * Reads Sotto refuses because what they return is other credentials, or may be (ADR-0205, decision 6). Vercel's pages,
 * read on November 12, 2026, do not say whether an environment variable's value comes back in the clear, so every
 * route to one is refused, with the routes to tokens, signing secrets, certificates, stores and a deployment's files.
 * A path is refused when any of its parts is one of these, in any version of the API.
 */
const SECRET_PARTS: ReadonlySet<string> = new Set([
  'env', 'secrets', 'tokens', 'token', 'edge-config', 'drains', 'log-drains', 'webhooks', 'certs', 'integrations', 'storage', 'stores',
  'files', 'bypass', 'oidc', 'connect',
])
/** Query parameters that ask for a secret in the clear, or for an answer that never ends. */
const REFUSED_QUERY: ReadonlySet<string> = new Set(['decrypt', 'follow'])

/**
 * Fields taken out of every answer, wherever they sit, because an allowed read can carry them: a project holds its
 * environment variables, its deploy hooks' addresses and its protection bypass secrets. The user's email address goes
 * too: it is theirs, and an answer goes on to the thread's provider.
 */
const REMOVED_KEYS: ReadonlySet<string> = new Set([
  'env', 'legacyvalue', 'vsmvalue', 'protectionbypass', 'passwordprotection', 'deployhooks', 'gitcredentialid', 'authorization', 'headers', 'email',
])
const REMOVED_ENDINGS = /(?:secret|secrets|token|tokens|password|passphrase|privatekey|apikey|credential|credentials|connectionstring)$/u

export type VercelReadRefusal = 'path' | 'query' | 'secrets'
export type VercelRead =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: VercelReadRefusal | 'no-secret' | 'refused' | 'unreachable' | 'failed'; readonly said?: string }

/** How this module reaches the network: Node's `fetch`, or a stand-in. */
export type VercelFetch = (url: string, init: { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>>; readonly redirect: 'manual'; readonly signal: AbortSignal }) => Promise<Response>

/** A path's parts as Vercel will read them, in lower case. Null for a path this tool does not read. */
function readParts(path: string): string[] | null {
  if (path.length > VERCEL_PATH_MAX || !PATH.test(path)) return null
  const parts: string[] = []
  for (const raw of path.split('/')) {
    let part: string
    try { part = decodeURIComponent(raw) } catch { return null }
    if (part === '.' || part === '..' || /[/\\]/u.test(part) || [...part].some(character => character.charCodeAt(0) < 0x20)) return null
    parts.push(part.toLowerCase())
  }
  return parts
}

/** Why a read is refused before Vercel is asked, or null when it may go. */
export function vercelReadRefusal(path: string, query: Readonly<Record<string, string>>): VercelReadRefusal | null {
  const parts = readParts(path)
  if (!parts) return 'path'
  if (parts.some(part => SECRET_PARTS.has(part))) return 'secrets'
  const entries = Object.entries(query)
  if (entries.some(([key]) => REFUSED_QUERY.has(key.toLowerCase()))) return 'secrets'
  if (entries.length > VERCEL_QUERY_MAX || entries.some(([key, value]) => !QUERY_KEY.test(key) || value.length > 1_000 || [...value].some(character => character.charCodeAt(0) < 0x20))) return 'query'
  return null
}

/** An answer with every field that can hold another credential, and the user's email address, taken out. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    const name = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
    return [key, REMOVED_KEYS.has(name) || REMOVED_ENDINGS.test(name) ? REMOVED : withoutSecrets(inner)]
  }))
}

/** The address a read goes to: always on Vercel's API, whatever the path and query hold. */
function addressOf(base: string, path: string, query: Readonly<Record<string, string>>): string | null {
  const origin = new URL(base).origin
  const url = new URL(`${origin}/${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.append(key, value)
  return url.origin === origin ? url.toString() : null
}

/** Reads an answer's text, giving up past the size Sotto will take apart. */
async function bodyOf(response: Response): Promise<string | null> {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > BODY_MAX_BYTES) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > BODY_MAX_BYTES ? null : new TextDecoder().decode(bytes)
}

/** One line of what Vercel said went wrong, for the agent that asked: its own code and message, nothing else. */
function saidBy(status: number, body: string | null): string {
  try {
    const error = (JSON.parse(body ?? '') as { error?: { code?: unknown; message?: unknown } }).error
    if (typeof error?.message === 'string') return `${error.message.slice(0, 200)} (HTTP ${status})`
  } catch { /* Not JSON: the status alone. */ }
  return `HTTP ${status}`
}

/**
 * Reads from Vercel's REST API with an account's token (ADR-0205): a GET to api.vercel.com and nothing else. The path
 * and query are checked before anything is sent, a redirect is never followed, so the token cannot be carried to
 * another host, and the answer has to be JSON, so the fields that can hold other credentials can be taken out of it.
 * The token is in the request's header and nowhere else: it is not in the address, the answer, a log or the record.
 */
export async function readVercel(fetcher: VercelFetch, token: string, path: string, query: Readonly<Record<string, string>> = {}, options: { readonly base?: string; readonly signal?: AbortSignal } = {}): Promise<VercelRead> {
  const refusal = vercelReadRefusal(path, query)
  if (refusal) return { ok: false, reason: refusal }
  if (!token) return { ok: false, reason: 'no-secret' }
  const address = addressOf(options.base ?? VERCEL_API, path, query)
  if (!address) return { ok: false, reason: 'path' }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  let response: Response
  let body: string | null
  try {
    response = await fetcher(address, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    body = await bodyOf(response)
  } catch { return { ok: false, reason: 'unreachable' } }
  // Vercel marks a token it will not take apart from a token that may not read this one thing, such as another team's.
  if (response.status === 401 || (response.status === 403 && /invalidToken|missingToken/u.test(body ?? ''))) return { ok: false, reason: 'refused' }
  if (response.status >= 300 && response.status < 400) return { ok: false, reason: 'failed', said: 'Vercel sent the read to another address, which Sotto does not follow' }
  if (!response.ok) return { ok: false, reason: 'failed', said: saidBy(response.status, body) }
  if (body === null) return { ok: false, reason: 'failed', said: 'the answer was too large to read. Ask for a smaller page' }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return { ok: false, reason: 'failed', said: 'the answer was not JSON, so Sotto could not check it for credentials' } }
  const text = JSON.stringify(withoutSecrets(parsed))
  if (text.length <= VERCEL_READ_MAX_CHARS) return { ok: true, text, truncated: false }
  // The cut never falls between the halves of a character that takes two.
  const last = text.charCodeAt(VERCEL_READ_MAX_CHARS - 1)
  return { ok: true, text: text.slice(0, last >= 0xd800 && last <= 0xdbff ? VERCEL_READ_MAX_CHARS - 1 : VERCEL_READ_MAX_CHARS), truncated: true }
}

/**
 * Asks Vercel whether a token is good, and what it calls the account: `GET /v2/user`. Only the username is kept, to
 * tell accounts apart on the page. A token Vercel will not take is refused; a Vercel that cannot be asked is not the
 * same thing, and says so.
 */
export async function checkVercelToken(fetcher: VercelFetch, token: string, options: { readonly base?: string; readonly signal?: AbortSignal } = {}): Promise<SecretCheck> {
  const address = addressOf(options.base ?? VERCEL_API, 'v2/user', {})
  if (!address) return { ok: false, problem: 'unreachable' }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(address, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    if (response.status === 401 || response.status === 403) return { ok: false, problem: 'refused' }
    if (!response.ok) return { ok: false, problem: 'unreachable' }
    const user = (JSON.parse(await bodyOf(response) ?? 'null') as { user?: { username?: unknown } } | null)?.user
    const username = typeof user?.username === 'string' && /^[A-Za-z0-9._-]{1,100}$/u.test(user.username) ? user.username : null
    return { ok: true, signedInAs: username }
  } catch { return { ok: false, problem: 'unreachable' } }
}

/** The kind of thing a path reads, for the use record: never which project or deployment. */
export function vercelReadKind(path: string): PluginReadKind {
  const parts = readParts(path)
  if (!parts) return 'other'
  const thing = parts[1]
  if (thing === 'deployments' || thing === 'now') return parts.includes('events') ? 'logs' : 'deployments'
  if (thing === 'projects') return 'projects'
  if (thing === 'domains' || thing === 'aliases' || thing === 'dns') return 'domains'
  if (thing === 'user' || thing === 'teams') return 'account'
  return 'other'
}
