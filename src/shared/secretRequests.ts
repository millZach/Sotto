import { z } from 'zod'

/**
 * Secret requests (ADR-0219, CONTEXT.md): an agent asks the user for values it must never see, such as an API key, a
 * password or a pairing code, on a private card in its thread. The value goes to Sotto, never to the agent's provider:
 * the agent gets a one-use **secret reference** Sotto's own tools take, or a **secret file** its commands read.
 */
export const SECRET_REQUESTS_MCP_SERVER = 'sotto_secrets'
export const REQUEST_SECRET_TOOL = 'request_secret'
export const RELEASE_SECRET_TOOL = 'release_secret'
/** Every secret request's ID starts with this after Sotto's own `sotto:`, so the window can tell one from any other request. */
export const SECRET_REQUEST_ID_PREFIX = 'sotto:secret:'
/** A secret reference as an agent holds it: the word and 32 hex digits, nothing that says what it stands for. */
export const SECRET_REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/u
/** How long a card waits for the user unless the agent says otherwise, and the longest it may say. */
export const SECRET_REQUEST_DEFAULT_WAIT_MS = 10 * 60_000
export const SECRET_REQUEST_MAX_WAIT_MS = 60 * 60_000
/** How long a saved value is kept for its agent, as a reference or a file, unless it is used or let go first. */
export const SECRET_KEEP_MS = 60 * 60_000
/** The longest value one field takes: enough for a private key, not for a file's worth of anything. */
export const SECRET_VALUE_MAX = 16_384
export const SECRET_FIELDS_MAX = 8

/** Words the agent writes: a label or placeholder, and a reason. */
const shortWords = z.string().trim().min(1).max(120)
const reasonWords = z.string().trim().min(1).max(600)
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u, 'Name a field with letters, digits and underscores, starting with a letter.')
const fieldInputSchema = z.object({
  name: fieldName.describe('How the result names this value, such as api_key.'),
  label: shortWords.describe('What the user is asked for, such as "API key".'),
  placeholder: shortWords.optional(),
  secret: z.boolean().optional().describe('False shows what is typed, as for a user name or an email address. Default true.'),
}).strict()
const fieldsSchema = z.array(fieldInputSchema).min(1).max(SECRET_FIELDS_MAX)
  .refine(fields => new Set(fields.map(field => field.name.toLowerCase())).size === fields.length, 'Give each field its own name.')

/** What `request_secret` takes. One value unless `fields` names up to eight. */
export const requestSecretInputSchema = z.object({
  label: shortWords.describe('The card\'s title, such as "Stripe test key".'),
  reason: reasonWords.describe('What it is for and where the user gets it.'),
  placeholder: shortWords.optional(),
  secret: z.boolean().optional().describe('For one value: false shows what is typed. Default true.'),
  fields: fieldsSchema.optional().describe('Several values on one card, up to eight; each comes back by its name.'),
  url: z.string().max(2048).optional().describe('A sign-in or setup page, shown as a button that opens it in the user\'s browser.'),
  delivery: z.enum(['secretRef', 'file']).optional().describe('secretRef (default) for a Sotto tool; file for a command, as `sudo -S` or `"$(cat <file>)"`.'),
  timeoutMs: z.number().int().min(1_000).max(SECRET_REQUEST_MAX_WAIT_MS).optional().describe('How long to wait for the user. Default ten minutes.'),
}).strict()
export type RequestSecretInput = z.infer<typeof requestSecretInputSchema>

export const releaseSecretInputSchema = z.object({
  secretRefs: z.array(z.string().regex(SECRET_REF_PATTERN)).max(SECRET_FIELDS_MAX * 4).optional(),
  files: z.array(z.string().min(1).max(4096)).max(SECRET_FIELDS_MAX * 4).optional(),
}).strict()

/** One field as the card shows it: never a value. */
export const secretRequestFieldSchema = z.object({ name: fieldName, label: z.string().max(120), placeholder: z.string().max(120).optional(), secret: z.boolean() }).strict()
export type SecretRequestField = z.infer<typeof secretRequestFieldSchema>
/**
 * What a thread's request carries for its card (ADR-0219): the fields by name and label, the sign-in page, how the value
 * goes to the agent and when the card closes. It never holds a value.
 */
export const secretRequestCardSchema = z.object({
  label: z.string().max(120),
  reason: z.string().max(600),
  fields: z.array(secretRequestFieldSchema).min(1).max(SECRET_FIELDS_MAX),
  url: z.string().max(2048).optional(),
  delivery: z.enum(['secretRef', 'file']),
  expiresAt: z.number().int(),
}).strict()
export type SecretRequestCard = z.infer<typeof secretRequestCardSchema>

/** The window's answer: the values by field name, or Decline. Sent only on its own channel, never as a request's answer. */
export const SECRET_REQUESTS_ANSWER = 'sotto:secrets:answer'
export const secretRequestAnswerSchema = z.discriminatedUnion('answer', [
  z.object({ answer: z.literal('save'), threadId: z.string().min(1).max(512), requestId: z.string().min(1).max(512), values: z.record(fieldName, z.string().max(SECRET_VALUE_MAX)) }).strict(),
  z.object({ answer: z.literal('decline'), threadId: z.string().min(1).max(512), requestId: z.string().min(1).max(512) }).strict(),
])
export type SecretRequestAnswer = z.infer<typeof secretRequestAnswerSchema>
/** What the window hears back: nothing but whether it worked, and in words when it did not. */
export const secretRequestAnswerResultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), message: z.string().max(500) }).strict()])
export type SecretRequestAnswerResult = z.infer<typeof secretRequestAnswerResultSchema>

export interface SecretRequestsBridge {
  answer(request: SecretRequestAnswer): Promise<SecretRequestAnswerResult>
}

/** The window's argument while the `secret-requests` Owl feature is on and this computer runs threads; stable has none. */
export const SECRET_REQUESTS_RENDERER_ARGUMENT = '--sotto-secret-requests'

export const isSecretRequestId = (id: string): boolean => id.startsWith(SECRET_REQUEST_ID_PREFIX)

/** The fields a request asks for: its own list, or its one value under the name `value`. */
export function secretRequestFields(input: RequestSecretInput): SecretRequestField[] {
  if (input.fields) return input.fields.map(field => ({ name: field.name, label: field.label, ...(field.placeholder ? { placeholder: field.placeholder } : {}), secret: field.secret !== false }))
  return [{ name: 'value', label: input.label, ...(input.placeholder ? { placeholder: input.placeholder } : {}), secret: input.secret !== false }]
}
