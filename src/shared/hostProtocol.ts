import { z } from 'zod'
import { agentAttachmentPreviewRequestSchema, agentCommandSchema, agentStateSchema, agentThreadDetailResultSchema, type AgentState, type AgentThreadDetail } from './agents'
import { threadEventSchema, type StoredThreadEvent } from './threadEvents'

export const HOST_PROTOCOL_VERSION = 1 as const
export const HOST_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const HOST_EVENT_PAGE_SIZE = 256
const id = z.string().min(1).max(512)
const base = { v: z.literal(1), id, session: z.string().min(1).max(2048) }
export const hostRequestSchema = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('hello'), afterSeq: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...base, op: z.literal('shell') }).strict(),
  z.object({ ...base, op: z.literal('detail'), threadId: id }).strict(),
  z.object({ ...base, op: z.literal('events'), afterSeq: z.number().int().nonnegative(), threadId: id.optional() }).strict(),
  z.object({ ...base, op: z.literal('observe'), threadIds: z.array(id).max(100) }).strict(),
  z.object({ ...base, op: z.literal('command'), command: agentCommandSchema }).strict(),
  z.object({ ...base, op: z.literal('preview'), request: agentAttachmentPreviewRequestSchema }).strict(),
  z.object({ ...base, op: z.literal('receipt'), commandId: id }).strict(),
])
export type HostRequest = z.infer<typeof hostRequestSchema>
export type HostOperation = HostRequest extends infer R ? R extends HostRequest ? Omit<R, 'v' | 'id' | 'session'> : never : never
export type HostErrorCode = 'unauthenticated' | 'invalid_request' | 'stale_request' | 'forbidden' | 'unavailable' | 'busy' | 'too_large'
export interface HostProtocolError { code: HostErrorCode; message: string }
export type HostResponse = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: HostProtocolError }
/** `error` stands in for a push that would not fit in one frame, instead of the host closing the socket. */
export type HostPush = { v: 1; event: 'shell'; state: AgentState; eventPage?: HostEventPage | undefined } | { v: 1; event: 'detail'; detail: AgentThreadDetail | null; threadId: string }
  | { v: 1; event: 'error'; threadId?: string | undefined; error: HostProtocolError }
export interface HostEventPage { events: StoredThreadEvent[]; latestSeq: number; hasMore: boolean }
export interface HostHello extends HostEventPage { hostId: string; clientId: string; shell: AgentState; capabilities: { mayAnswer: boolean } }
export interface HostSession { v: 1; hostId: string; clientId: string; session: string; expiresAt: string }
export interface HostPairing { v: 1; hostId: string; clientId: string; token: string }
export interface HostReceipt { status: 'pending' | 'completed' | 'unknown'; error?: HostProtocolError | undefined }
export interface HostDescriptor { v: 1; pid: number; hostId: string; port: number }
export const HOST_SESSION_REJECTED = 'This connection is no longer authorized. Connect again or pair this device on the host.'
/** What an HTTP 429 from the host means to the user: nothing is wrong with this device, and waiting is the fix. */
export const HOST_BUSY = 'The host is busy. Nothing was lost. Try again in a moment.'


const eventPageShape = { events: z.array(z.object({ seq: z.number().int().nonnegative(), threadId: id, event: threadEventSchema })).max(HOST_EVENT_PAGE_SIZE), latestSeq: z.number().int().nonnegative(), hasMore: z.boolean() }
export const hostEventPageSchema = z.object(eventPageShape)
export const hostPairingSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const hostSessionSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, session: z.string().min(1).max(2048), expiresAt: z.iso.datetime() })
export const hostHelloSchema = z.object({ ...eventPageShape, hostId: z.uuid(), clientId: id, shell: agentStateSchema, capabilities: z.object({ mayAnswer: z.boolean() }) })
export const hostProtocolErrorSchema = z.object({ code: z.enum(['unauthenticated', 'invalid_request', 'stale_request', 'forbidden', 'unavailable', 'busy', 'too_large']), message: z.string().min(1).max(1000) })
export const hostResponseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), id, ok: z.literal(true), result: z.unknown() }),
  z.object({ v: z.literal(1), id, ok: z.literal(false), error: hostProtocolErrorSchema }),
])
export const hostPushSchema = z.discriminatedUnion('event', [
  z.object({ v: z.literal(1), event: z.literal('shell'), state: agentStateSchema, eventPage: hostEventPageSchema.optional() }),
  z.object({ v: z.literal(1), event: z.literal('detail'), threadId: id, detail: agentThreadDetailResultSchema }),
  z.object({ v: z.literal(1), event: z.literal('error'), threadId: id.optional(), error: hostProtocolErrorSchema }),
])
export const hostReceiptSchema = z.object({ status: z.enum(['pending', 'completed', 'unknown']), error: hostProtocolErrorSchema.optional() })
