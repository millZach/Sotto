import { z } from 'zod'
import { AGENT_IMAGE_MIME_TYPES, agentAttachmentDimensionsSchema, agentAttachmentPreviewRequestSchema, attachmentDigestSchema, agentCommandSchema, agentHostSnapshotSchema, agentStateSchema, agentThreadDetailDeltaSchema, agentThreadDetailResultSchema, type AgentModel, type AgentState, type AgentThreadDetail, type AgentThreadDetailDelta } from './agents'
import { threadEventSchema, type StoredThreadEvent } from './threadEvents'
import { gitRefsRequestSchema } from './gitRefs'
import { gitChangedFilesRequestSchema } from './gitChangedFiles'
import { gitPullRequestRequestSchema } from './gitPullRequests'
import { hostFoldersRequestSchema } from './hostFolders'
import { PASTED_CODE_MAX } from './hostProviders'
import type { AgentActivity } from './agentActivity'
import { providerIdSchema, type ProviderClientUpdate } from './agents'

/**
 * Protocol version 1 is frozen (ADR-0025; every message is listed in docs/host-protocol.md). A later host
 * may add optional fields, a feature it lists in `features`, and push forms a client asks for by name in
 * hello's `accepts`; it never changes or removes what v1 already carries.
 */
export const HOST_PROTOCOL_VERSION = 1 as const
/** Retired account fields stay on v1's wire for desktops that still require them. */
export function shellForProtocolV1<T extends AgentState>(state: T) {
  return { ...state, membership: { status: 'beta' as const, label: '', expiresAt: null },
    configuration: { ...state.configuration, membershipEndpoint: '' } }
}
/**
 * A shell as a client reads it. `host.modelsRevision` is sent only to a client that accepts
 * `model-catalog-revision`, which the desktop's own client does not; it reads it as optional and ignores it,
 * and `host.models` stays required, as v1 has it.
 */
const hostClientShellSchema = agentStateSchema.extend({ clientCapabilities: z.object({ mayAnswer: z.boolean() }).optional(),
  host: agentHostSnapshotSchema.extend({ modelsRevision: z.number().int().positive().optional() }) })
/** Older hosts carry retired fields; strip them before the strict domain schemas read them. */
export const protocolAgentStateSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const state = { ...value } as Record<string, unknown>
  delete state.membership
  const configuration = state.configuration
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return state
  const current = { ...configuration } as Record<string, unknown>
  delete current.membershipEndpoint
  return { ...state, configuration: current }
}, hostClientShellSchema)
/**
 * The host features this build offers: parts of v1 beyond its base, which a client uses only when a
 * host lists them. `detail-delta`: a client that accepts it is sent what changed in an observed thread
 * (a `detail-delta` push) in place of the whole thread on every change. `git-refs`: the host answers the
 * `git-refs` request with a page of a thread's branches for the branch picker. `git-changed-files`: the
 * host answers the `git-changed-files` request with a thread's changed files for the commit dialog.
 * `git-pull-request`: the host answers the `git-pull-request` request with one of a thread's pull requests,
 * read through gh, for the Pull request surface and its dialogs. `attachment-staging`: the host keeps an image a client
 * sends once and answers with its handle (`stage-attachment`), and hands a staged image back by digest
 * (`attachment-content`); drafts and commands carry the handle (ADR-0031). `host-folders`: the host answers the
 * `host-folders` request with one folder's subfolders on the host machine, for the Add project dialog's folder browser.
 * `provider-sign-in`: the host runs one of its providers' own sign-in for the client that asks, and answers the
 * `sign-in-start`, `sign-in-read`, `sign-in-code` and `sign-in-cancel` requests (ADR-0037). Only a headless host offers
 * it: the desktop's phone listener does not. `message-aliases`: event pages may carry
 * message-aliased only after the client explicitly accepts it; other clients read the repaired detail.
 * `client-updates`: the host's shell carries its client updates for the client to show, and the host takes the
 * `queue-client-updates` command, which updates its clients one at a time (ADR-0042, #480). Only a headless host offers
 * it, and a client shows a host's client updates only when the host lists it. `activity-summaries`: a client that
 * accepts it is sent every activity record in a detail, a detail delta and a `detail` answer as its activity summary
 * (`activitySummary`), without the output, text and diffs it would not show (#701).
 * `model-catalog-revision`: to a client that accepts it, every shell's `host` names its model catalog's revision
 * (`modelsRevision`) and carries `models` only when this connection has not yet been sent that revision whole
 * (ADR-0028, October 3 amendment). Every other client is sent the whole catalog in every shell.
 */
export const HOST_FEATURES = ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision'] as const
export type HostFeature = typeof HOST_FEATURES[number]
/**
 * The features a headless host's tailnet listener offers only to a client the launch script recorded as a desktop
 * (ADR-0053). Its health lists them; a phone's hello does not, and their requests are refused for a phone.
 */
export const HOST_DESKTOP_FEATURES: readonly HostFeature[] = ['provider-sign-in', 'client-updates']
/**
 * A client update as a client that does not accept `client-updates` can read it: the mise channel, which such a client
 * does not know, reads as one it will not drive, and a client waiting in the update line reads as not started. Every
 * other field it does not know is optional and ignored.
 */
export function clientUpdateForOlderClient(update: ProviderClientUpdate): ProviderClientUpdate {
  return { ...update, ...(update.channel === 'mise' ? { channel: 'unknown' as const } : {}), ...(update.state === 'queued' ? { state: 'idle' as const } : {}) }
}
/**
 * An activity record as a summary row reads it, for a client that accepts `activity-summaries` (#701): what it is, how
 * it went, how long it took, the command it ran and the files it changed. Its output, text, error, folder, diffs, plan,
 * agents and context stay on the host. It is still an activity record under the same schema, with the same ID and
 * sequence, so a delta of summaries applies to a detail of summaries exactly as a delta of whole records does.
 */
export function activitySummary(record: AgentActivity): AgentActivity {
  return {
    id: record.id, turnId: record.turnId, sequence: record.sequence, kind: record.kind, status: record.status, title: record.title,
    ...(record.command !== undefined ? { command: record.command } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.changes !== undefined ? { changes: record.changes.map(change => ({ path: change.path, kind: change.kind })) } : {}),
  }
}
/** A thread's detail with each activity record as its summary. Messages, revision and the rest are the detail's own. */
export function detailWithActivitySummaries(detail: AgentThreadDetail): AgentThreadDetail {
  return detail.activities === undefined ? detail : { ...detail, activities: detail.activities.map(activitySummary) }
}
/** A detail delta with each record it carries as its summary. Removals and the revisions are unchanged, so it still applies. */
export function deltaWithActivitySummaries(delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
  return delta.activityDeltas.length === 0 ? delta
    : { ...delta, activityDeltas: delta.activityDeltas.map(item => 'record' in item ? { record: activitySummary(item.record) } : item) }
}
/**
 * Whether a host's Sotto version is later than this client's, by release number. A version that cannot
 * be read, such as a host from before v1 froze that advertises none, is never newer.
 */
export function hostIsNewer(hostVersion: string | undefined, clientVersion: string): boolean {
  return compareSottoVersions(hostVersion, clientVersion) === 1
}
/**
 * Whether a host's Sotto version is earlier than this client's, by release number: the host needs an update
 * (ADR-0040). A version that cannot be read is never older, so nothing is offered for a host that says nothing.
 */
export function hostIsOlder(hostVersion: string | undefined, clientVersion: string): boolean {
  return compareSottoVersions(hostVersion, clientVersion) === -1
}
/** -1, 0 or 1 by release number; null when either side is not a release number. */
function compareSottoVersions(hostVersion: string | undefined, clientVersion: string): -1 | 0 | 1 | null {
  const parts = (version: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const host = hostVersion === undefined ? null : parts(hostVersion), client = parts(clientVersion)
  if (!host || !client) return null
  for (let index = 0; index < 3; index += 1) if (host[index] !== client[index]) return host[index]! > client[index]! ? 1 : -1
  return 0
}
/**
 * What a client says when a host speaks a version of the protocol it cannot use: a host from before v1
 * froze, or one of another Sotto version sending what this client cannot read. The host keeps running,
 * so nothing on it is lost. The last sentence is the way out, and it depends on which side is behind:
 * Connect starts whatever is in the host installation folder, so an older host needs this computer's
 * version put there before it is stopped, and a newer one needs this computer updated instead.
 * `owned` says whether Sotto started the host, and so whether Stop host is there to press.
 */
export function hostVersionMismatch(clientVersion: string, hostVersion: string | undefined, owned: boolean): string {
  if (hostIsNewer(hostVersion, clientVersion)) return 'This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.'
  const stop = owned ? 'press Stop host' : 'stop the host on that machine'
  // A host that said which older Sotto it runs is offered an update on the Threads page (ADR-0040).
  const update = hostIsOlder(hostVersion, clientVersion) ? 'Update it from the Threads page, or put' : 'Put'
  return `This host is running a different version of Sotto. Nothing on the host was lost. ${update} the Sotto ${clientVersion} host in its installation folder, ${stop}, then connect again.`
}
export const HOST_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const HOST_EVENT_PAGE_SIZE = 256
const id = z.string().min(1).max(512)
/** Feature names are read leniently, so a name this build does not know is ignored rather than refused. */
const featureList = z.array(z.string().min(1).max(64)).max(64)
const sottoVersion = z.string().min(1).max(64)
const base = { v: z.literal(1), id, session: z.string().min(1).max(2048) }
/** An image as it crosses the socket: base64 inside one frame, at most 10 MiB of bytes. */
const imageData = z.string().max(Math.ceil(10 * 1024 * 1024 / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u)
export const hostAttachmentSchema = z.object({ name: z.string().trim().min(1).max(255), mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), data: imageData,
  dimensions: agentAttachmentDimensionsSchema.optional() }).strict()
export const hostAttachmentContentSchema = z.object({ mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), data: imageData }).strict().nullable()
/** Just enough of a request to answer it: a request the host cannot otherwise read is refused by its id. */
export const hostRequestEnvelopeSchema = z.object(base)
export const hostRequestSchema = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('hello'), afterSeq: z.number().int().nonnegative().optional(), accepts: featureList.optional() }).strict(),
  z.object({ ...base, op: z.literal('shell') }).strict(),
  z.object({ ...base, op: z.literal('detail'), threadId: id }).strict(),
  z.object({ ...base, op: z.literal('events'), afterSeq: z.number().int().nonnegative(), threadId: id.optional() }).strict(),
  z.object({ ...base, op: z.literal('observe'), threadIds: z.array(id).max(100) }).strict(),
  z.object({ ...base, op: z.literal('command'), command: agentCommandSchema }).strict(),
  z.object({ ...base, op: z.literal('preview'), request: agentAttachmentPreviewRequestSchema }).strict(),
  z.object({ ...base, op: z.literal('receipt'), commandId: id }).strict(),
  /** The branches a thread's folder offers, for the picker; read on request, never pushed (ADR-0027). */
  z.object({ ...base, op: z.literal('git-refs'), request: gitRefsRequestSchema }).strict(),
  /** The changed files of a thread's folder with their line counts, for the commit dialog; read on request (ADR-0027). */
  z.object({ ...base, op: z.literal('git-changed-files'), request: gitChangedFilesRequestSchema }).strict(),
  /** One of a thread's pull requests, read through gh for the Pull request surface; read on request (ADR-0027). */
  z.object({ ...base, op: z.literal('git-pull-request'), request: gitPullRequestRequestSchema }).strict(),
  /** An image for a draft on this host, sent once; the answer is its handle (ADR-0031). */
  z.object({ ...base, op: z.literal('stage-attachment'), image: hostAttachmentSchema }).strict(),
  /** A staged image's bytes by digest, for a chip the client holds no copy of; null once the host no longer keeps it. */
  z.object({ ...base, op: z.literal('attachment-content'), digest: attachmentDigestSchema }).strict(),
  /** One folder's subfolders on the host, for the Add project dialog's folder browser; read on request. */
  z.object({ ...base, op: z.literal('host-folders'), request: hostFoldersRequestSchema }).strict(),
  /**
   * A provider's sign-in on the host, for the client that asks and for no other (ADR-0037): start one, read where it
   * stands, hand its client a code pasted from the sign-in page, or cancel it. Each answers with the sign-in, or null.
   */
  z.object({ ...base, op: z.literal('sign-in-start'), provider: providerIdSchema }).strict(),
  z.object({ ...base, op: z.literal('sign-in-read'), signInId: z.uuid() }).strict(),
  z.object({ ...base, op: z.literal('sign-in-code'), signInId: z.uuid(), code: z.string().min(1).max(PASTED_CODE_MAX) }).strict(),
  z.object({ ...base, op: z.literal('sign-in-cancel'), signInId: z.uuid() }).strict(),
])
export type HostRequest = z.infer<typeof hostRequestSchema>
export type HostOperation = HostRequest extends infer R ? R extends HostRequest ? Omit<R, 'v' | 'id' | 'session'> : never : never
export type HostErrorCode = 'unauthenticated' | 'invalid_request' | 'stale_request' | 'forbidden' | 'unavailable' | 'busy' | 'too_large'
export interface HostProtocolError { code: HostErrorCode; message: string }
export type HostResponse = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: HostProtocolError }
/** `error` stands in for a push that would not fit in one frame, instead of the host closing the socket. */
export type HostClientShell = AgentState & { clientCapabilities?: { mayAnswer: boolean } | undefined }
/**
 * A shell as it crosses the socket. To a client that accepts `model-catalog-revision` its `host` names the
 * catalog's revision and leaves `models` out when this connection was already sent that revision; to every
 * other client it is a `HostClientShell` as v1 has it.
 */
export type HostWireShell = Omit<HostClientShell, 'host'> & {
  host: Omit<AgentState['host'], 'models'> & { models?: AgentModel[] | undefined; modelsRevision?: number | undefined }
}
export type HostPush = { v: 1; event: 'shell'; state: HostWireShell; eventPage?: HostEventPage | undefined } | { v: 1; event: 'detail'; detail: AgentThreadDetail | null; threadId: string }
  | { v: 1; event: 'detail-delta'; threadId: string; delta: AgentThreadDetailDelta }
  | { v: 1; event: 'error'; threadId?: string | undefined; error: HostProtocolError }
export interface HostEventPage { events: StoredThreadEvent[]; latestSeq: number; hasMore: boolean }
/**
 * What a headless host says about itself in health and hello (ADR-0053, ADR-0054). `tailnetAddress` is the address
 * Tailscale Serve carries its tailnet listener at, `https://<MagicDNS name>:<port>`, while Serve runs for it. `startedBy`
 * is who started it, as its listener descriptor records: `launch-script`, or `boot` for a host its unit started; absent
 * for a host its owner started by hand. Neither is evidence of identity: the host's ID, its certificate and the pairing are.
 */
export interface HostAbout { tailnetAddress?: string | undefined; startedBy?: string | undefined }
/** A host's phone access in the words its row uses, as hello reports it to a desktop (ADR-0053): off, starting, on with how many phones are paired, or needs the owner. */
export const HOST_PHONE_ACCESS_STATUSES = ['off', 'starting', 'on', 'needs-you'] as const
export interface HostPhoneAccessSummary { status: typeof HOST_PHONE_ACCESS_STATUSES[number]; phones: number }
/**
 * `capabilities` is what this client may do on this host; `features` is what the host's protocol offers this client,
 * which on a headless host's tailnet listener depends on whether it is a desktop (ADR-0053). `phoneAccess` goes only to
 * a desktop, as it stood when the session's hello was answered.
 */
export interface HostHello extends HostEventPage, HostAbout { hostId: string; clientId: string; shell: HostClientShell; capabilities: { mayAnswer: boolean }; sottoVersion: string; features: string[]; phoneAccess?: HostPhoneAccessSummary | undefined }
export interface HostSession { v: 1; hostId: string; clientId: string; session: string; expiresAt: string }
export interface HostPairing { v: 1; hostId: string; clientId: string; token: string }
export interface HostReceipt {
  status: 'pending' | 'completed' | 'unknown'; error?: HostProtocolError | undefined
  /** This answer command's own successful outcome. Older hosts omit it; completion alone proves none. */
  answerDelivered?: boolean | undefined
}
/** Written to host-listener.json and served, with `status`, as /v1/health. */
export interface HostDescriptor extends HostAbout { v: 1; pid: number; hostId: string; port: number; sottoVersion: string; features: string[] }
export interface HostHealth extends HostDescriptor {
  status: 'ready'
  /** The computer's name as its owner set it for phones; only the desktop's phone access sends it (ADR-0033). */
  name?: string
}
export const HOST_SESSION_REJECTED = 'This connection is no longer authorized. Connect again or pair this device on the host.'
/** What an HTTP 429 from the host means to the user: nothing is wrong with this device, and waiting is the fix. */
export const HOST_BUSY = 'The host is busy. Nothing was lost. Try again in a moment.'

const eventPageShape = { events: z.array(z.object({ seq: z.number().int().nonnegative(), threadId: id, event: threadEventSchema })).max(HOST_EVENT_PAGE_SIZE), latestSeq: z.number().int().nonnegative(), hasMore: z.boolean() }
export const hostEventPageSchema = z.object(eventPageShape)
export const hostPairingSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const hostSessionSchema = z.object({ v: z.literal(1), hostId: z.uuid(), clientId: id, session: z.string().min(1).max(2048), expiresAt: z.iso.datetime() })
/**
 * Health's and hello's additions since v1 froze. Each is optional and read leniently: a value this build cannot read,
 * such as a later host's new `startedBy` or phone access status, reads as absent rather than refusing the whole answer.
 */
const aboutShape = {
  tailnetAddress: z.string().min(1).max(300).optional().catch(undefined),
  startedBy: z.string().min(1).max(64).optional().catch(undefined),
}
export const hostPhoneAccessSchema = z.object({ status: z.enum(HOST_PHONE_ACCESS_STATUSES), phones: z.number().int().nonnegative().max(1000) })
export const hostHelloSchema = z.object({ ...eventPageShape, hostId: z.uuid(), clientId: id, shell: protocolAgentStateSchema, capabilities: z.object({ mayAnswer: z.boolean() }), sottoVersion, features: featureList,
  ...aboutShape, phoneAccess: hostPhoneAccessSchema.optional().catch(undefined) })
export const hostHealthSchema = z.object({ v: z.literal(1), status: z.literal('ready'), hostId: z.uuid(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), sottoVersion, features: featureList, ...aboutShape })
/**
 * The Sotto version and features a host's health advertises, or null when the host does not speak the
 * frozen v1: another protocol version, or a host from before the freeze that advertises neither.
 */
export function hostHealthFeatures(value: unknown): { sottoVersion: string; features: string[] } | null {
  const health = hostHealthSchema.safeParse(value)
  return health.success ? { sottoVersion: health.data.sottoVersion, features: health.data.features } : null
}
export const hostProtocolErrorSchema = z.object({ code: z.enum(['unauthenticated', 'invalid_request', 'stale_request', 'forbidden', 'unavailable', 'busy', 'too_large']), message: z.string().min(1).max(1000) })
export const hostResponseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), id, ok: z.literal(true), result: z.unknown() }),
  z.object({ v: z.literal(1), id, ok: z.literal(false), error: hostProtocolErrorSchema }),
])
export const hostPushSchema = z.discriminatedUnion('event', [
  z.object({ v: z.literal(1), event: z.literal('shell'), state: protocolAgentStateSchema, eventPage: hostEventPageSchema.optional() }),
  z.object({ v: z.literal(1), event: z.literal('detail'), threadId: id, detail: agentThreadDetailResultSchema }),
  z.object({ v: z.literal(1), event: z.literal('detail-delta'), threadId: id, delta: agentThreadDetailDeltaSchema }),
  z.object({ v: z.literal(1), event: z.literal('error'), threadId: id.optional(), error: hostProtocolErrorSchema }),
])
export const hostReceiptSchema = z.object({ status: z.enum(['pending', 'completed', 'unknown']), error: hostProtocolErrorSchema.optional(), answerDelivered: z.boolean().optional() })
