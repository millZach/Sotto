import { z } from 'zod'
import { isOpenCodeSignInPage, type ModelSource, type ModelSourceField, type ModelSourceMethod, type SignInAttempt } from '../../shared/opencodeSignIn'
import { OWN_SERVER_ID_PREFIX } from '../../shared/ownModelServers'

/**
 * OpenCode 2's model sources as Sotto shows them (#1104). OpenCode calls a model source an integration and lists every
 * one it knows at `GET /api/integration`, each with its ways to sign in and the sign-ins it holds (`connections`). The
 * connections name a credential by ID, label and method, never its secret, so Sotto reads who is signed in from them and
 * never from `GET /api/credential`, which answers with the secrets themselves (checked against 2.0.31).
 */

/** OpenCode Zen's free models run under this provider ID; the integration of the same ID is OpenCode Console. */
export const ZEN_PROVIDER = 'opencode'

const fieldSchema = z.looseObject({
  key: z.string(), title: z.string().optional(), description: z.string().optional(), required: z.boolean().optional(),
  type: z.string(), hidden: z.boolean().optional(), placeholder: z.string().optional(), default: z.unknown().optional(), pattern: z.string().optional(),
  options: z.array(z.looseObject({ value: z.string(), label: z.string().optional(), description: z.string().optional() })).optional(),
  custom: z.boolean().optional(),
  when: z.array(z.looseObject({ key: z.string(), op: z.string(), value: z.unknown() })).optional(),
})
type NativeField = z.infer<typeof fieldSchema>
const methodSchema = z.looseObject({ type: z.string(), id: z.string().optional(), label: z.string().optional(), form: z.array(fieldSchema).optional() })
type NativeMethod = z.infer<typeof methodSchema>
const connectionSchema = z.looseObject({ type: z.string(), id: z.string().optional(), method: z.string().optional() })
export const integrationSchema = z.looseObject({
  id: z.string().min(1), name: z.string().min(1), methods: z.array(methodSchema).default([]), connections: z.array(connectionSchema).default([]),
})
export type Integration = z.infer<typeof integrationSchema>
export const integrationListSchema = z.looseObject({ data: z.array(integrationSchema) })

/** What OpenCode said about a started browser sign-in (`Integration.AttemptEncoded`). */
export const attemptSchema = z.looseObject({
  attemptID: z.string().min(1), url: z.string().min(1), instructions: z.string().default(''), mode: z.enum(['auto', 'code']),
  time: z.looseObject({ created: z.unknown().optional(), expires: z.unknown().optional() }).optional(),
})
export type NativeAttempt = z.infer<typeof attemptSchema>
export const attemptReplySchema = z.looseObject({ data: attemptSchema })
export const attemptStatusSchema = z.looseObject({ data: z.looseObject({ status: z.string(), message: z.string().optional() }) })

/** The method ID Sotto gives a pasted key, which OpenCode's key method has none of. */
export const KEY_METHOD = 'key'
const LEGACY = /\(legacy\)/iu
/** Sotto's names for the browser sign-ins OpenCode 2.0.31 lists, by source and method. */
const BROWSER_LABELS: Readonly<Record<string, string>> = {
  'openai:chatgpt-token-sharing': 'ChatGPT account', 'github-copilot:device': 'GitHub account', 'xai:device': 'SuperGrok subscription',
  'opencode:device': 'OpenCode Console account', 'gitlab:pkce': 'GitLab account',
}

/** A key method's name in Sotto's words: OpenCode's own label when it says something a plain "API key" would not. */
export function keyLabel(label: string | undefined): string {
  if (!label || /manually enter api key/iu.test(label) || /^api key$/iu.test(label)) return 'API key'
  if (/pat or bearer/iu.test(label)) return 'Access token'
  if (/service account/iu.test(label)) return 'Service account API key'
  return label.charAt(0).toUpperCase() + label.slice(1)
}
/** A browser or on-this-computer sign-in's name: "Login with Poe (browser)" is a Poe account. */
export function methodLabel(source: string, method: NativeMethod): string {
  const known = BROWSER_LABELS[`${source}:${method.id ?? ''}`]
  if (known) return known
  const label = (method.label ?? '').replace(/\s*\([^)]*\)\s*$/u, '').trim()
  if (method.type === 'external') return label.replace(/^use\s+/iu, '') || 'Sign-in on this computer'
  const named = label.replace(/^(?:log ?in|sign in)\s+with\s+/iu, '').trim()
  if (!named) return 'Browser sign-in'
  if (/\b(?:account|subscription)$/iu.test(named)) return named.replace(/\b(Account|Subscription)$/u, word => word.toLowerCase())
  return `${named} account`
}

const asText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
/**
 * A form field in the part of OpenCode's forms Sotto draws: words, or a choice among them, shown always or while one
 * other field holds a value. Anything else (numbers, switches, several choices, a field shown on another test) is
 * undefined, and a method that needs one is left out rather than half drawn.
 */
function drawable(field: NativeField): ModelSourceField | undefined | 'hidden' {
  if (field.hidden) return 'hidden'
  if (field.type !== 'string') return undefined
  if (field.when && (field.when.length !== 1 || field.when[0]!.op !== 'eq' || typeof field.when[0]!.value !== 'string')) return undefined
  const options = field.options?.length ? field.options.slice(0, 32).map(option => ({ value: option.value, label: option.label || option.value,
    ...(option.description ? { description: option.description } : {}) })) : undefined
  const when = field.when?.[0]
  return {
    key: field.key, title: field.title || field.key, required: field.required === true,
    ...(field.description ? { description: field.description.slice(0, 400) } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder.slice(0, 200) } : {}),
    ...(asText(field.default) !== undefined ? { default: asText(field.default)!.slice(0, 400) } : {}),
    ...(field.pattern && field.pattern.length <= 200 ? { pattern: field.pattern } : {}),
    // A choice that also takes the user's own words is drawn as words.
    ...(options && !field.custom ? { options } : {}),
    ...(when ? { when: { key: when.key, value: when.value as string } } : {}),
  }
}
/** The fields Sotto draws for a method, or undefined when the method asks something Sotto cannot draw. */
function formOf(method: NativeMethod): ModelSourceField[] | undefined {
  const fields: ModelSourceField[] = []
  for (const field of method.form ?? []) {
    const drawn = drawable(field)
    if (drawn === 'hidden') continue
    if (!drawn) return undefined
    fields.push(drawn)
  }
  return fields.slice(0, 8)
}
/** A method's hidden fields with the values OpenCode gave them, which Sotto sends as they are. */
export function hiddenAnswers(integration: Integration, methodId: string): Record<string, string> {
  const method = integration.methods.find(item => (item.type === 'key' ? KEY_METHOD : item.id) === methodId)
  return Object.fromEntries((method?.form ?? []).flatMap(field => field.hidden && asText(field.default) !== undefined ? [[field.key, asText(field.default)!]] : []))
}

/** A source's ways to sign in, in OpenCode's order, without legacy ones, environment variables or commands to run. */
export function methodsOf(integration: Integration): ModelSourceMethod[] {
  const methods: ModelSourceMethod[] = []
  for (const method of integration.methods) {
    if (LEGACY.test(method.label ?? '')) continue
    const kind = method.type === 'key' ? 'key' : method.type === 'oauth' ? 'browser' : method.type === 'external' ? 'external' : undefined
    if (!kind || (kind !== 'key' && !method.id)) continue
    const form = formOf(method)
    if (!form) continue
    methods.push({ id: kind === 'key' ? KEY_METHOD : method.id!, kind, label: kind === 'key' ? keyLabel(method.label) : methodLabel(integration.id, method),
      ...(form.length ? { form } : {}) })
  }
  return methods.slice(0, 8)
}
/** The credentials a source holds in Sotto's OpenCode, by ID: what Sign out deletes. */
export function credentialsOf(integration: Integration): string[] {
  return integration.connections.flatMap(connection => connection.type === 'credential' && connection.id ? [connection.id] : [])
}
/** How a source is signed in, from its first credential's method, in the words its sign-in method has. */
function howSignedIn(integration: Integration, methods: readonly ModelSourceMethod[]): string | undefined {
  const connection = integration.connections.find(item => item.type === 'credential' && item.id)
  if (!connection) return undefined
  const kind = connection.method === 'key' ? 'key' : connection.method === 'oauth' ? 'browser' : connection.method === 'external' ? 'external' : undefined
  const method = methods.find(item => item.kind === kind)
  if (method) return method.label
  return kind === 'key' ? 'API key' : kind === 'external' ? 'Sign-in on this computer' : 'Browser sign-in'
}

/**
 * Every source as the dialog lists it, with how it is signed in and how many models it has in the catalog. The user's own
 * model servers (ADR-0123) are listed by OpenCode as sources too, and are left out: they have their own group, added and
 * removed there, apart from any one provider.
 */
export function modelSourcesOf(integrations: readonly Integration[], modelProviders: readonly string[]): { zenModels: number; sources: ModelSource[] } {
  const counts = new Map<string, number>()
  for (const provider of modelProviders) counts.set(provider, (counts.get(provider) ?? 0) + 1)
  const sources = integrations.flatMap((integration): ModelSource[] => {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(integration.id) || integration.id.startsWith(OWN_SERVER_ID_PREFIX)) return []
    const methods = methodsOf(integration)
    const how = howSignedIn(integration, methods)
    return [{ id: integration.id, name: integration.name.slice(0, 200), methods, ...(how ? { signedIn: { how } } : {}),
      models: how ? counts.get(integration.id) ?? 0 : 0 }]
  })
  return { zenModels: counts.get(ZEN_PROVIDER) ?? 0, sources: sources.slice(0, 1_000) }
}

const DEVICE_CODE = /\bcode\b[:\s]+([A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12}){0,3})\b/iu
/**
 * A started sign-in as the dialog draws it. OpenCode says how it ends only now: `code` waits for a pasted code, and an
 * `auto` sign-in either shows a device code in its instructions ("enter code: QX7M-4LRT") or finishes by itself.
 */
export function attemptOf(sourceId: string, attempt: NativeAttempt): SignInAttempt {
  const url = new URL(attempt.url)
  const code = attempt.mode === 'auto' ? DEVICE_CODE.exec(attempt.instructions)?.[1] ?? url.searchParams.get('user_code') ?? undefined : undefined
  const expires = typeof attempt.time?.expires === 'number' && Number.isFinite(attempt.time.expires) ? Math.max(0, Math.round(attempt.time.expires)) : undefined
  return { id: attempt.attemptID.slice(0, 200), sourceId, mode: attempt.mode, ...(code && code.length <= 64 ? { code } : {}),
    page: `${url.host}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 300), ...(expires !== undefined ? { expiresAt: expires } : {}) }
}
/** Only an https page is opened in the user's browser, with no user name or password in its address. */
export const safeSignInPage = isOpenCodeSignInPage
