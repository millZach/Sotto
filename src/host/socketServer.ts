import { startsThread } from '../shared/threadStarts'
import type { HostDelegationRelay, RelayDesktop } from '../main/agents/delegationRelayHost'
import type { HostRemoteCallers, RemoteDesktop } from '../main/agents/delegationRemoteHost'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import { z } from 'zod'
import { RequestAnswerCheckRefusal, type HostService, type ClientIdentity } from '../main/agents/hostService'
import { PairedClients, originAllowed, SESSION_LIFETIME_MS } from '../main/agents/pairing'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../main/agents/control'
import { ModelCatalogRevisions, ThreadRecordsBroadcast } from '../main/agents/agentStateBroadcast'
import { RefusedImage } from '../main/agents/attachmentStore'
import { FileUploadRefusal, FileUploads } from './fileUploads'
import { pullRequestReadFailureOf } from '../main/agents/gitPullRequests'
import { isPullRequestLimited, needsConfirmationReceipt, type GitPullRequestReadFailure } from '../shared/gitPullRequests'
import { PullRequestConfirmations } from './pullRequestConfirmations'
import { shellForProtocolV1, clientUpdateForOlderClient, clientUpdateWithoutNotListed, deltaWithActivitySummaries, deltaWithoutVisuals, detailWithActivitySummaries, detailWithoutVisuals, HOST_BUSY, HOST_DESKTOP_FEATURES, HOST_EVENT_PAGE_SIZE, HOST_FEATURES, HOST_MAX_FRAME_BYTES, HOST_SESSION_REJECTED, hostRequestEnvelopeSchema, hostRequestSchema, providersUnknownTo, type HostAnswerTarget, type HostAbout, type HostDescriptor, type HostErrorCode, type HostPhoneAccessSummary, type HostPush, type HostReceipt, type HostRequest, type HostResponse, type HostClientShell, type HostWireShell } from '../shared/hostProtocol'
import { hostCatalogKey, isImageAttachment, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate, type AgentThreadSummary } from '../shared/agents'
import { foldAgentThreadDetailUpdates, isAgentThreadDetailDelta } from '../shared/agentThreadDetail'
import { resolveModel } from '../shared/modelCatalog'
import { version as packageVersion } from '../../package.json'
import { REMOTE_PERMISSION_DENIED } from '../main/agents/authority'
import { commandFromProtocolV1, managementCommandRefusal } from '../shared/hostProtocol'
import { REMOTE_OPENCODE_SIGN_IN_OPERATIONS, REMOTE_SIGN_IN_OPERATIONS, remoteCommandRefusal, remoteHostUpdateRefusal, remoteUsageRefusal } from './remoteCommands'
import type { HostSelfUpdate } from './selfUpdate'
import { usageLocalClearResultSchema, usageLocalHostReadSchema, usageProvidersBeforeMuse, usageReadBeforeHistory, usageReadBeforeMuse, type UsageLocalHostRead } from '../shared/usageDashboard'
import { hostMachineReportSchema } from '../shared/hostFacts'
import { projectOriginsSchema, projectSetupResultSchema, type ProjectOrigins } from '../shared/workerMachine'
import { desktopDefaultsReceiptSchema } from '../shared/desktopDefaults'
import { ProviderSignInRefusal, type ProviderSignIns } from './providerSignIn'
import { DEFLATE_RESPONSE, deflateOffered, SocketFrames } from './socketFrames'
import { CutBodies } from '../shared/activityBodies'
import { hostAdminPhonesCommandSchema, type HostAdminPhonesCommand, type PhonesState } from '../shared/phones'
import { CommandReceipts, type CommandReceipt } from './commandReceipts'
import { HttpBudgets } from './httpBudgets'
import { PAGE_REQUESTS_PER_MINUTE, QUESTION_PAGE_PATH, serveQuestionPage } from './questionPageRoute'
import type { WatcherHostRead } from '../shared/watcherHost'
import type { WatcherThreadTarget } from '../shared/watcher'
import { visibleWatcherState } from '../shared/watcherVisibility'
import type { WatcherPhoneCurrent, WatcherPhoneOpen } from '../shared/watcherPhone'
import type { WatcherSetPermissionRequest, WatcherWatchThreadRequest } from '../shared/watcherRoom'
import { deltaWithoutProviders, detailWithoutProviders, eventsWithoutProviders, namesHidden, readWithoutProviders, stateWithoutProviders, stopPreviewWithoutProviders, stopResultWithoutProviders, type ProviderScope } from './providerPeers'
import type { HeldProviders } from '../shared/heldProviders'
import { delegationBriefSchema, delegationsReadSchema, stateWithoutDelegation, DELEGATIONS_CHANGED_MAX } from '../shared/delegation'
import { MAX_AGENT_ACTIVITIES } from '../shared/agentActivity'
import type { OpenCodeHostCall } from '../shared/opencodeSignIn'
import type { OpenCodeSignIn } from '../main/agents/opencodeSignIn'
import type { HostBranchMoves } from './branchMoves'
import type { HostThreadMoves } from '../main/agents/threadMovesHost'

/** Watcher's box on a phone (October 31, 2026): each of its operations and the change it asks of the phone service. */
const COMPOSER_OPS = { 'watcher-phone-open': 'open', 'watcher-phone-new': 'new', 'watcher-phone-stop-turn': 'stop-turn',
  'watcher-phone-dismiss-handover': 'dismiss-handover' } as const
/** The HTTP listener's request bodies, checked against schemas built once rather than on every request. */
const adminPhonesRequest = z.object({}).strict()
const adminPhonesCommandRequest = z.object({ command: hostAdminPhonesCommandSchema }).strict()
const adminTailnetRequest = z.object({ enabled: z.boolean().optional() }).strict()
const adminClientRequest = z.object({ clientId: z.string().min(1).max(512) }).strict()
const pairRequest = z.object({ v: z.literal(1), code: z.string().min(1).max(32), name: z.string().min(1).max(256) }).strict()

const errors: Record<HostErrorCode, string> = {
  unauthenticated: HOST_SESSION_REJECTED,
  invalid_request: 'This request is not supported. Update this client and try again.',
  stale_request: 'This request has already changed or been answered. Refresh the thread before answering.',
  forbidden: REMOTE_PERMISSION_DENIED,
  unavailable: 'The host could not complete this request. Refresh the thread before trying again.',
  busy: 'The host has too many pending requests. Wait for them to finish and try again.',
  too_large: 'A thread on this host is too large to send to this device. Nothing on the host was lost, and the thread keeps working there. Your other threads still load here.',
}
/**
 * A phone's pairing, session or hello on a host's tailnet listener while the host's phone access is off (ADR-0053),
 * naming the host as phones show it. The pairing is kept: this is 403 `forbidden`, not 401's "pair again".
 */
export const phonesOff = (name: string | undefined): string => {
  const host = name?.trim() || 'this computer'
  return `Phone access is off on ${host}. Your pairing is kept. In Sotto on your main computer, open Settings > Hosts & phones, press Phones… on ${host}'s row and turn on Let phones reach ${host}, then try again.`
}
/**
 * An oversize message is named by what it carried: one thread's detail, an attachment preview, one of a thread's
 * tool reads (Files, Changes or Agents), or the thread list (a shell push, the hello, an event page, or the shell a
 * command answers with). The headless host has no window, so none of these sends the user to the host machine; each
 * says what was kept instead.
 */
type Oversize = 'thread' | 'preview' | 'tool' | 'list' | 'body'
const TOO_LARGE: Record<Oversize, string> = {
  thread: errors.too_large,
  body: 'This activity is too large to send to this device. Nothing on the host was lost, and the row keeps the part it was sent.',
  preview: 'This attachment is too large to preview on this device. Nothing on the host was lost, and the attachment is unchanged there.',
  tool: 'This file or comparison is too large to send to this device. Nothing on the host was lost or changed. Open it on the host machine.',
  list: 'The thread list on this host is too large to send to this device. Nothing on the host was lost, and this device keeps the last list it received.',
}
/** A thread's tool reads (ADR-0025, October 5 amendment), whose answer too large to send gets the tool sentence. A file preview and a comparison also take the one-at-a-time guard below. */
const TOOL_READS = new Set<HostRequest['op']>(['thread-files', 'thread-file-preview', 'thread-changes', 'thread-changes-review', 'subagent-page', 'subagent-assignments'])
/** A refusal the client reads: its code, and a sentence, which is the code's own unless the refusal says more. */
/** `reason` rides along on a pull request read's refusal only (#1290), so the client can say what to do next. */
class Refusal extends Error { constructor(readonly code: HostErrorCode, message = errors[code], readonly reason?: GitPullRequestReadFailure) { super(message) } }
/**
 * `deltas` is set by the client's hello: only a client that accepts `detail-delta` is sent one. `clientUpdates` likewise:
 * only a client that accepts `client-updates` is sent the mise channel and the waiting state in its shell's client updates.
 * `catalogRevisions` too: only a client that accepts `model-catalog-revision` is sent a shell without its model catalog,
 * and `catalogSent` is the catalog revision a frame written to this connection last carried whole, or null.
 * `shellSent` is a digest of the state the last shell push to this connection carried, or null once an answer that
 * carried a shell gave the client another picture: a push with the same state and no events is not written again.
 * `activitySummaries` too: only a client that accepts `activity-summaries` is sent activity records as their summaries.
 * `activityBodies` likewise: only a desktop that accepts `activity-bodies`, and not summaries, is sent records with cut
 * bodies (ADR-0025, October 18 amendment).
 *
 * `held` is the revision of each observed thread's detail the client holds, as far as what it was sent says: set by a
 * whole detail that went, moved on by a delta that followed it, and dropped by a push that could not go or a delta that
 * did not follow it. `opening` is each observed thread still owed its first whole detail. `sentAhead` holds each whole
 * detail this client was sent while that copy was still waiting out the coalescing window, so it is not sent again (#700).
 *
 * `desktop` is whether the launch script recorded this client as a desktop (ADR-0053), read when its socket opened and
 * again at its hello. On a listener that tells desktops apart, only a desktop is offered the desktop-only features.
 *
 * `hostUpdate` is whether its hello accepted `host-update`, so it is sent the steps of an update it asked for (ADR-0088);
 * `gone` is aborted once its socket has closed, which ends a download it asked for.
 *
 * `unknownProviders` are the providers whose host feature its hello did not accept (`PROVIDER_HOST_FEATURES`, #1107): it is
 * sent nothing of theirs, and their threads are hidden from it. Until its hello, that is every such provider.
 */
interface Peer { unknownProviders: HeldProviders; hostUpdate: boolean; delegationViews: boolean; checkQueueViews?: boolean; nextPrompts?: { wanted: boolean } | undefined; delegationRelay?: RelayDesktop | undefined; delegationRemote?: RemoteDesktop | undefined; retiredTerminals: boolean; gone: AbortController; usageHistory: boolean; usageMuseOpenCode: boolean; watcherPhone: boolean; watcherPhoneStop: boolean; watcherPhoneManage: boolean; watcherPhoneSteer: boolean; watcherPhoneMachines: boolean; watcherPhoneComposer: boolean; watcherReads: boolean; desktop: boolean; frames: SocketFrames; client: ClientIdentity; session: string; observed: Set<string>; shown: boolean; held: Map<string, number>; opening: Set<string>; sentAhead: WeakSet<AgentThreadDetail>; inFlight: number; window: number; count: number; pageWindow: number; pages: number; preview: boolean; ready: boolean; afterSeq: number; selectedThreadId: string | null; selectedProjectId: string | null; editingThreadId: string | null; deltas: boolean; messageAliases: boolean; clientUpdates: boolean; clientUpdateNotListed: boolean; activitySummaries: boolean; activityBodies: boolean; catalogRevisions: boolean; catalogSent: number | null; shellSent: string | null; answerReceipts: boolean; answerWatches: Map<string, HostAnswerTarget>
  /** The thread records this connection's shell pushes last carried, for a client that accepted `changed-thread-records` (#996). */
  threadRecords?: ThreadRecordsBroadcast | undefined }
/**
 * A desktop from before history import, or from before Muse and OpenCode were counted, is sent only the Usage read its
 * strict schemas know (ADR-0083).
 */
const usageForPeer = (peer: Peer, read: UsageLocalHostRead): UsageLocalHostRead => {
  const providers = peer.usageMuseOpenCode ? read : usageReadBeforeMuse(read)
  return peer.usageHistory ? providers : usageReadBeforeHistory(providers)
}
/** A shell ready to write to one peer, and the catalog revision it carries whole, if any, to record once it is written. */
interface WireShell { state: HostWireShell; carries: number | null }
export interface SocketServerOptions {
  /** SSH-recorded desktops, required even on the administrative listener for machine origin. */
  watcherDesktops?: TailnetAdmission['desktops']
  service: HostService; pairing: PairedClients; port?: number; origins?: readonly string[]
  mayAnswer?: (client: ClientIdentity) => boolean
  setAnswers?: (clientId: string, allowed: boolean) => void
  /**
   * The command receipts this listener answers retries from. A headless host's two listeners share one, so a command
   * retried after a move between them is not run twice (ADR-0053). Without one the listener keeps its own.
   */
  receipts?: CommandReceipts
  /**
   * The confirmation receipts this listener gives and takes for merges, closes and auto-merges (#1691). A headless host's
   * two listeners share one, as they share command receipts. Without one the listener keeps its own.
   */
  pullRequestConfirmations?: PullRequestConfirmations
  /**
   * The key this listener's observed threads are kept under in the host service. Two listeners over one service each
   * need their own, or one's observations would replace the other's.
   */
  observationKey?: string
  /**
   * Who a headless host's tailnet listener admits (ADR-0053). Absent, every client counts as a desktop and is always
   * admitted: the listener with the administrative routes is reached only on the host machine and through SSH, and the
   * desktop's own phone listener offers no desktop-only feature and stops whenever phone access is off.
   */
  tailnet?: TailnetAdmission
  /** The host's tailnet address and who started it, read for each health and hello answer. */
  about?: () => HostAbout
  /** The host's phone access in its row's words, read for each hello to a desktop. */
  phoneAccess?: () => HostPhoneAccessSummary | undefined
  /** Told once a client was revoked here, by the administrative route or by itself, after its sockets close. */
  onRevoked?: (clientId: string) => void
  /** Tests stand in for a host of another Sotto version; the host advertises its own. */
  sottoVersion?: string
  /** Tests set the monotonic clock a phone's Watcher window is timed on (`WATCHER_WRITING_WINDOW_MS`), to tell held from sent. */
  watcherWritingClock?: () => number
  /**
   * False turns the administrative routes off. The desktop administers its phone listener in-process, so
   * it has no admin token to keep; only the headless host, whose own command line uses them, needs them.
   */
  admin?: boolean
  /** The computer's name as paired phones show it, read on each health request (ADR-0033). Health omits it when absent. */
  name?: () => string | undefined
  /** Told once a pairing code is redeemed, so a desktop showing the code can close it and list the new client. */
  onPaired?: (clientId: string) => void
  /** Told when a paired client's socket opens or closes, or a client unpairs itself. */
  onPeersChanged?: () => void
  /**
   * A headless host's providers' own sign-ins, run here for the paired client that asks (ADR-0037). Absent on the
   * desktop's phone listener, which then neither lists `provider-sign-in` nor answers its requests.
   */
  signIns?: Pick<ProviderSignIns, 'start' | 'read' | 'code' | 'cancel'>
  /**
   * A headless host's own OpenCode sign-ins to model sources (#1107), run here for the desktop that asks. Present only where
   * the host's OpenCode runs; without it the listener neither lists `opencode-sign-in` nor answers its request.
   */
  opencodeSignIn?: Pick<OpenCodeSignIn, 'sources' | 'signInWithKey' | 'startBrowserSignIn' | 'useExternalSignIn' | 'wait' | 'finish' | 'pageAddress' | 'cancel' | 'signOut' | 'mayUse'>
  /**
   * The headless host updates its clients for a paired client that asks (`queue-client-updates`, #480). Absent on the
   * desktop's phone listener, which then neither lists `client-updates` nor takes the command.
   */
  clientUpdates?: boolean
  /**
   * The headless host's own phone access (ADR-0050), read and changed on the administrative routes by the desktop that
   * reaches this host over SSH. Absent on the desktop's phone listener, whose administrative routes are off anyway.
   */
  phones?: HostPhonesAdministration
  /**
   * The headless host updating itself for a desktop that asks (ADR-0088). Offered on either listener, to a client in
   * `watcherDesktops` whose `remote-answer` policy lets it answer, and only when the host can update itself at all.
   */
  hostUpdate?: Pick<HostSelfUpdate, 'run' | 'delivered'>
  /**
   * The Owl feature `thread-delegation` is on where this listener runs (ADR-0072, ADR-0081). Off or absent, no client is
   * sent a thread's `delegatedBy`: a thread delegated while the feature was on keeps the link in its record, and a stable
   * phone would otherwise hide it under the thread that delegated to it.
   */
  delegation?: boolean
  /**
   * Branch moves with a desktop (`branch-moves`, ADR-0105 decision 8), present only where the host's Owl answer turns on
   * `cross-machine-work`. Offered on either listener, to a client the launch script recorded as a desktop, and to no other.
   */
  branchMoves?: Pick<HostBranchMoves, 'handle'>
  /**
   * Threads moved here from another machine (`thread-move`, #1178), present only where the host's Owl answer turns on
   * `cross-machine-work`. Offered on either listener, to a client the launch script recorded as a desktop, and to no other.
   */
  threadMoves?: Pick<HostThreadMoves, 'handle' | 'holdsSources'>
  /**
   * The desktop relay (`delegation-relay`, #1316), present only where the host runs delegation for its own threads and its
   * Owl answer turns on Work across machines. Offered on either listener, to a client the launch script recorded as a
   * desktop, and to no other: such a desktop relays a thread here's delegations to other machines once its hello accepts it.
   */
  delegationRelay?: Pick<HostDelegationRelay, 'desktopConnected' | 'desktopGone' | 'answered' | 'news' | 'named'>
  /**
   * Delegations a desktop asks this host for, for a thread on another machine (`delegation-remote`, #1316 part 2), present
   * only where the host runs delegation for its own threads and its Owl answer turns on Work across machines. Offered on
   * either listener, to a client the launch script recorded as a desktop, and to no other.
   */
  delegationRemote?: Pick<HostRemoteCallers, 'desktopConnected' | 'desktopGone' | 'answer' | 'hold'>
}
/**
 * Which paired clients a tailnet listener admits, and as what. `desktops` is read again before a session and a hello,
 * and answered from the last read in between; a client not in it is a phone, offered no desktop-only feature. While
 * `phonesAdmitted` says no, the listener redeems no pairing code, opens no session, hello or socket for a phone, and
 * closes a phone's socket within a second.
 */
export interface TailnetAdmission {
  readonly desktops: { refresh(): Promise<unknown>; has(clientId: string): boolean }
  readonly phonesAdmitted: () => boolean
}
/** What the administrative phone routes answer: the state after the command, and Tailscale's page or a refusal when it gave one. */
export interface HostPhonesAnswer { readonly state: PhonesState; readonly url?: string | undefined; readonly error?: string | undefined }
/**
 * What the administrative tailnet route answers (ADR-0053): the host's `tailnetConnections` setting after the request,
 * its phone access state, whose checks and address say how Serve came out, and the sentence it refused a change with.
 */
export interface HostTailnetAnswer { readonly enabled: boolean; readonly state: PhonesState; readonly error?: string | undefined }
export interface HostPhonesAdministration {
  get(): PhonesState
  command(command: HostAdminPhonesCommand): Promise<HostPhonesAnswer>
  /** Reads `tailnetConnections`, or sets it and waits for Serve to follow. */
  tailnet(request: { readonly enabled?: boolean | undefined }): Promise<HostTailnetAnswer>
}
/** An internal native attempt ID, isolated from other paired clients and local provider attempts. */
const answerDecisionId = (clientId: string, commandId: string): string =>
  'socket-answer:' + createHash('sha256').update(JSON.stringify([clientId, commandId])).digest('hex')
/**
 * A peer sending more than this many messages in a second is closed, except for event pages, which are
 * paced instead: a page past its own budget waits for the next second. A client reading a long log one
 * page after another is doing what the protocol asks, and closing it would only have it start again.
 */
const MESSAGES_PER_SECOND = 100
const EVENT_PAGES_PER_SECOND = 100
/**
 * How long a phone's shell whose only news is Watcher's conversation waits after the last shell to that phone. Watcher
 * writing its reply changes its page with every word, and its page rides on every shell a phone with Watcher is pushed,
 * so without this a phone was pushed its whole shell with every publish while Watcher wrote, about twenty a second
 * (October 28, 2026). A phone shows Watcher's words four times a second instead; anything else still goes at once.
 */
const WATCHER_WRITING_WINDOW_MS = 250
/**
 * HTTP requests a minute, per endpoint class, so no caller can spend another's budget. Health is not
 * counted: refusing it costs as much as answering it, and the launch script polls it while a host starts.
 * Failed pairing redemptions have a small bucket per caller, checked before redemption. The administrative path, and sessions and revocations per paired
 * client, are counted only after their token is checked, so a loop on a bad token spends nobody's budget. A question's
 * pages share one bucket: a page loads many files, and a token nobody holds opens nothing.
 */
const HTTP_BUDGETS = { pair: 10, admin: 120, client: 120, page: PAGE_REQUESTS_PER_MINUTE } as const
/** Selecting and observing only move this client's own view; repeating one is harmless, so they keep no receipt. */
const UNRECEIPTED = new Set<string>(['select-thread', 'select-project', 'observe-threads'])
/** Only this listener owns sockets; clients never get a provider handle or a claimed identity. */
export async function startSocketServer(options: SocketServerOptions) {
  const { service, pairing } = options
  const sottoVersion = options.sottoVersion ?? packageVersion
  const hostId = service.shell().hostId
  if (!hostId) throw new Error('The host must have an identity before listening.')
  const features = HOST_FEATURES.filter(feature => (feature !== 'provider-sign-in' || options.signIns !== undefined)
    && (feature !== 'opencode-sign-in' || options.opencodeSignIn !== undefined)
    && (!feature.startsWith('watcher-phone') || service.watcherPhone !== undefined && options.admin === false && options.watcherDesktops === undefined)
    && (feature !== 'watcher-phone-machines' || service.watcherPhone?.offersMachines === true)
    // Photos for Watcher need the host to stage them and to answer for them (October 23, 2026).
    && (feature !== 'watcher-phone-photos' || service.stageAttachment !== undefined && service.attachmentPreview !== undefined)
    // Files for Watcher ride on its photos, where the host keeps files at all (ADR-0131, October 28 amendment).
    && (feature !== 'watcher-phone-files' || service.stageAttachment !== undefined && service.attachmentPreview !== undefined && service.supportsFileStaging === true)
    && (feature !== 'thread-media' || service.supportsThreadMedia === true && service.threadMedia !== undefined)
    && (feature !== 'watcher-control' || service.supportsWatcherControl === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-reads' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-standing-watch' || service.supportsWatcherStandingWatch === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-work-settled' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-outcomes' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    // A new Watcher takes over the requests an older one of the same desktop made here (#1735).
    && (feature !== 'watcher-new-owner' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-muse' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    && (feature !== 'watcher-cursor' || service.supportsWatcherReads === true && options.watcherDesktops !== undefined)
    // A host keeps its own check queue (#1312) only where its Owl answer turns on Work across machines.
    && (feature !== 'watcher-check-queue' || service.supportsWatcherCheckQueue === true && service.supportsWatcherControl === true && options.watcherDesktops !== undefined)
    // Watcher's stop_thread takes a check out of that queue (#1637), so it goes with the queue.
    && (feature !== 'watcher-check-stop' || service.supportsWatcherCheckQueue === true && service.supportsWatcherControl === true && options.watcherDesktops !== undefined)
    && (feature !== 'answer-check' || service.checkRequestAnswer !== undefined)
    && (feature !== 'next-prompts' || service.supportsNextPrompts === true)
    && (feature !== 'atomic-send' || service.supportsAtomicSend === true)
    && (feature !== 'draft-revisions' || service.supportsDraftRevisions === true)
    && (feature !== 'client-updates' || options.clientUpdates === true)
    // Offered with client updates: the coordinator's check keeps what an update already run said (ADR-0077).
    && (feature !== 'client-update-outcomes' || options.clientUpdates === true)
    && (feature !== 'client-update-not-listed' || options.clientUpdates === true)
    && (feature !== 'usage-dashboard' || (service.supportsUsage === true && service.usageRead !== undefined && service.usageRefresh !== undefined && service.usageClear !== undefined))
    // Usage's place and window filters (ADR-0083) arrived with history import: an older host's strict query refuses them.
    && (feature !== 'usage-history' || (service.supportsUsage === true && service.usageRead !== undefined))
    && (feature !== 'usage-muse-opencode' || (service.supportsUsage === true && service.usageRead !== undefined))
    && (feature !== 'usage-background-refresh' || (service.supportsUsage === true && service.usageRefresh !== undefined))
    && (feature !== 'pull-request-babysit' || service.supportsBabysitting === true)
    // A confirmation receipt is bound to the pull request as the host read it for the client, so only a host that reads them gives one (#1691).
    && (feature !== 'pull-request-confirmation' || service.gitPullRequest !== undefined)
    // Host facts are for a desktop placing work (#1031): a headless host offers them on both listeners, to desktops only,
    // and the desktop's own phone listener, which serves no desktop, never does.
    && (feature !== 'host-facts' || service.supportsHostFacts === true && service.hostFacts !== undefined && (options.admin !== false || options.tailnet !== undefined))
    && (feature !== 'worker-swarms' || service.supportsWorkerSwarms === true && service.supportsHostFacts === true && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // Project origins are for a desktop placing work (#1032), as host facts are, and only where the host's Owl answer
    // turns on Work across machines.
    && (feature !== 'project-origins' || service.supportsProjectOrigins === true && service.projectOrigins !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // Setting up a copy for a worker placed here (#1690) is offered exactly where project origins are.
    && (feature !== 'project-setup' || service.supportsProjectSetup === true && service.setUpProject !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // A host that runs delegation for its own threads (#1310) takes desktop defaults from recorded desktops on both
    // listeners, only where its Owl answer turns on Work across machines. The desktop's own phone listener never lists it.
    && (feature !== 'host-delegation' || service.supportsHostDelegation === true && service.desktopDefaults !== undefined && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // A host that keeps a check queue sends it to a recorded desktop's window (#1312), only where its Owl answer turns on
    // Work across machines; the desktop's own phone listener never lists it.
    && (feature !== 'check-queue-views' || service.supportsCheckQueueViews === true && service.checkQueue !== undefined && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // The same host answers a recorded desktop's read of those threads' delegations, for its window (#1310).
    && (feature !== 'delegation-views' || service.supportsDelegationViews === true && service.delegationViews !== undefined && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // Continuing agents and forking (#1028) only where the host's Owl answer turns them on.
    && (feature !== 'thread-starts' || service.supportsThreadStarts === true && service.startHandover !== undefined)
    // The message scrubber's prompts above a pane's window (ADR-0109) are for a desktop; the desktop's own phone listener serves none.
    && (feature !== 'thread-prompts' || service.threadPrompts !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // A host that keeps which failed threads were seen publishes it and takes Dismiss all (ADR-0092).
    && (feature !== 'failure-seen' || service.supportsFailureSeen === true)
    // The iPhone's pull request sheet (#1281) only where the host's Owl answer turns it on.
    && (feature !== 'pull-request-view' || service.supportsPullRequestView === true)
    // Bringing changes back (#1030) only where the host's Owl answer turns it on.
    && (feature !== 'bring-changes-back' || service.supportsBringBack === true)
    // A host that can update itself offers it on both listeners, to SSH-recorded desktops only (ADR-0088).
    && (feature !== 'host-update' || options.hostUpdate !== undefined && options.watcherDesktops !== undefined)
    // Cut bodies are for a desktop on a slow link (ADR-0025, October 18 amendment); the desktop's own phone listener serves none.
    && (feature !== 'activity-bodies' || options.admin !== false || options.tailnet !== undefined)
    // The iPhone's Agents view (ADR-0103) only where the host's Owl answer turns it on.
    && (feature !== 'agents-view' || service.supportsAgentsView === true)
    // Branch moves (ADR-0105 decision 8) only where the host's Owl answer turns on cross-machine work, for recorded desktops.
    && (feature !== 'branch-moves' || options.branchMoves !== undefined && options.watcherDesktops !== undefined)
    // Moves (#1178) on the same terms as branch moves, whose incoming ref each one starts from.
    && (feature !== 'thread-move' || options.threadMoves !== undefined && options.branchMoves !== undefined && options.watcherDesktops !== undefined)
    // Calling a move off (#1178 part 4, Keep it here) on the same terms as thread-move.
    && (feature !== 'thread-move-keep' || options.threadMoves !== undefined && options.branchMoves !== undefined && options.watcherDesktops !== undefined)
    // Its own threads as a move's source (#1178 part 3) on the same terms, where it holds them.
    && (feature !== 'thread-move-source' || options.threadMoves?.holdsSources === true && options.branchMoves !== undefined && options.watcherDesktops !== undefined)
    // The desktop relay (#1316) only where delegation runs here and the Owl answer turns on cross-machine work, for recorded desktops.
    && (feature !== 'delegation-relay' && feature !== 'delegation-relay-send' || options.delegationRelay !== undefined && service.supportsHostDelegation === true && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // A desktop's delegations here for threads on other machines (#1316 part 2), on the same terms.
    && (feature !== 'delegation-remote' || options.delegationRemote !== undefined && service.supportsHostDelegation === true && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // Starts from a delegating thread's branch, and checks, either way between machines (#1316 part 2), with remote delegation.
    && (feature !== 'delegation-branch-starts' || options.delegationRemote !== undefined && service.supportsHostDelegation === true && options.watcherDesktops !== undefined && (options.admin !== false || options.tailnet !== undefined))
    // Deleting settled threads (ADR-0140) only where the host's Owl answer turns clearing on, and only for a desktop: the
    // desktop's own phone listener, which serves no desktop, never offers it, and neither phone app deletes.
    && (feature !== 'thread-delete' || service.supportsThreadDelete === true && (options.admin !== false || options.tailnet !== undefined))
    // Attached files (ADR-0131) only where the host's Owl answer turns them on and it keeps attachments at all.
    && (feature !== 'file-staging' || service.supportsFileStaging === true && service.stageAttachment !== undefined)
    // A sent file's bytes for the iPhone's Quick Look go with file staging (ADR-0131, October 25 amendment).
    && (feature !== 'attachment-files' || service.supportsFileStaging === true && service.attachmentFile !== undefined))
  /**
   * Each paired client's file on its way here, by its client ID, so a client holds one upload at a time however many
   * sockets it opens (ADR-0131). A part may come on any of its sockets; the upload goes when the last of them closes.
   */
  const uploads = new FileUploads<string>()
  /** The paired clients with a sent file's part being read for them, so a client has one such read at a time however many sockets it opens. */
  const fileReads = new Set<string>()
  const connected = (clientId: string): boolean => {
    for (const peer of peers) if (peer.client.clientId === clientId) return true
    return false
  }
  /**
   * Whether a client may have its host update itself: one the launch script recorded as a desktop, on either listener, whose
   * `remote-answer` policy lets it answer (ADR-0088). Read afresh each time, so `--deny-answers` takes it away at once.
   */
  const mayUpdate = (peer: Peer): boolean => remoteHostUpdateRefusal({ desktop: options.watcherDesktops?.has(peer.client.clientId) ?? false,
    mayAnswer: options.mayAnswer?.(peer.client) ?? false }) === null
  /** What this listener offers a client: every feature to a desktop, and to a phone all but the desktop-only ones (ADR-0053). */
  const featuresFor = (peer: Peer): string[] => (peer.desktop ? [...features] : features.filter(feature => !HOST_DESKTOP_FEATURES.includes(feature)))
    .filter(feature => !feature.startsWith('watcher-') || feature.startsWith('watcher-phone') || options.watcherDesktops?.has(peer.client.clientId))
    .filter(feature => feature !== 'host-update' || mayUpdate(peer))
    .filter(feature => feature !== 'branch-moves' && feature !== 'thread-move' && feature !== 'thread-move-source' && feature !== 'thread-move-keep' || (options.watcherDesktops?.has(peer.client.clientId) ?? false))
    // Desktop defaults come only from a client the launch script recorded as a desktop (#1310).
    .filter(feature => feature !== 'host-delegation' && feature !== 'delegation-views' && feature !== 'delegation-relay' && feature !== 'delegation-relay-send' && feature !== 'delegation-remote' && feature !== 'delegation-branch-starts' && feature !== 'check-queue-views'
      || options.watcherDesktops?.has(peer.client.clientId) === true)
  const watcherScopes = new WeakMap<Peer, WatcherHostRead>()
  const watcherRevisions = new WeakMap<Peer, string>()
  const offers = (peer: Peer, feature: (typeof HOST_FEATURES)[number]): boolean => featuresFor(peer).includes(feature)
  const { tailnet } = options
  const isDesktop = (clientId: string): boolean => !tailnet || tailnet.desktops.has(clientId)
  /** A client the listener serves now: any desktop, and a phone only while phones are admitted. */
  const admits = (clientId: string): boolean => isDesktop(clientId) || (tailnet?.phonesAdmitted() ?? true)
  /**
   * Whether a client that offers `permessage-deflate` is sent compressed messages: a desktop, on a listener that tells
   * desktops apart or is reached only through SSH (ADR-0025, October 18 amendment). No phone is, on any listener: the
   * desktop's own phone listener, which serves no desktop, compresses nothing.
   */
  const compresses = (clientId: string): boolean => (options.admin !== false || tailnet !== undefined) && isDesktop(clientId)
  const phonesOffMessage = (): string => phonesOff(options.name?.())
  const { signIns } = options
  /** A sign-in's own refusal keeps its sentence; anything else is the host's failure to run it. */
  const signingIn = async <T>(peer: Peer, op: HostRequest['op'], run: () => T | Promise<T>): Promise<T> => {
    if (!signIns || !offers(peer, 'provider-sign-in') || !(REMOTE_SIGN_IN_OPERATIONS as readonly string[]).includes(op)) throw new Refusal('invalid_request')
    try { return await run() } catch (error) { throw error instanceof ProviderSignInRefusal ? new Refusal('unavailable', error.message) : new Refusal('unavailable') }
  }
  /**
   * The host's own OpenCode signed in to a model source for the desktop that asks (#1107). Only the client that started a
   * browser sign-in reads it, finishes it, asks for its page or cancels it. The sign-in itself keeps who that is, for as long
   * as it waits, so the host's other listener knows it too (#1143). Whatever OpenCode's sign-in refuses is its own answer;
   * anything else is the host's failure to run it. A key is passed on and never kept, logged or sent back.
   */
  const opencodeCall = async (peer: Peer, op: HostRequest['op'], call: OpenCodeHostCall): Promise<unknown> => {
    const signIn = options.opencodeSignIn
    if (!signIn || !offers(peer, 'opencode-sign-in') || !(REMOTE_OPENCODE_SIGN_IN_OPERATIONS as readonly string[]).includes(op)) throw new Refusal('invalid_request')
    if ((call.action === 'wait' || call.action === 'finish' || call.action === 'page' || call.action === 'cancel')
      && !signIn.mayUse(call.request.attemptId, peer.client.clientId)) throw new Refusal('forbidden')
    try {
      switch (call.action) {
        case 'sources': return await signIn.sources()
        case 'key': return await signIn.signInWithKey(call.request)
        case 'external': return await signIn.useExternalSignIn(call.request)
        case 'sign-out': return await signIn.signOut(call.request)
        case 'browser': return await signIn.startBrowserSignIn(call.request, peer.client.clientId)
        case 'wait': return await signIn.wait(call.request)
        case 'finish': return await signIn.finish(call.request)
        case 'page': return await signIn.pageAddress(call.request)
        case 'cancel': return await signIn.cancel(call.request)
      }
    } catch { throw new Refusal('unavailable') }
  }
  const adminToken = randomBytes(32).toString('base64url')
  const peers = new Set<Peer>(), operations = new Set<Promise<unknown>>()
  const receipts = options.receipts ?? new CommandReceipts()
  const confirmations = options.pullRequestConfirmations ?? new PullRequestConfirmations()
  const observationKey = options.observationKey ?? 'socket-observations'
  let closing = false
  const httpBudgets = new HttpBudgets()
  /** Counts one request against a bucket, dropping buckets whose minute has passed, and refuses past its limit. */
  const spend = (bucket: string, limit: number): (() => void) => {
    const refund = httpBudgets.spend(bucket, limit)
    if (!refund) throw new Refusal('busy')
    return refund
  }
  const identity = (clientId: string): ClientIdentity => ({ clientId, user: pairing.list().find(client => client.clientId === clientId)?.name ?? 'Paired client', transport: 'socket' })
  const isPhonePeer = (peer: Peer): boolean => !peer.desktop || options.admin === false && options.watcherDesktops === undefined
  /** A thread of a provider this peer does not know (#1107), as the host holds it now, read without copying any state. */
  const unknownProviderThread = (peer: Peer, threadId: string): boolean => {
    if (!peer.unknownProviders.size) return false
    const provider = service.threadProvider?.(threadId)
    return provider !== undefined && peer.unknownProviders.has(provider)
  }
  /** A thread a phone is not shown: Watcher's own, and the ones Watcher's phone exclusions name. */
  const hiddenFromPhone = (peer: Peer, threadId: string): boolean => isPhonePeer(peer) && (service.watcherPhoneExclusions?.().threadIds.includes(threadId) || ['watcher', 'watcher-history'].includes(service.threadKind?.(threadId) ?? service.shell().host.threads.find(row => row.id === threadId)?.kind ?? ''))
  const hiddenThread = (peer: Peer, threadId: string): boolean => unknownProviderThread(peer, threadId) || hiddenFromPhone(peer, threadId)
  /** A project of a provider this peer does not know, by its provider as the host holds it (its scoped ID is read as well). */
  const unknownProviderProject = (peer: Peer, projectId: string): boolean => {
    const provider = service.projectProvider?.(projectId)
    return provider !== undefined && peer.unknownProviders.has(provider)
  }
  /** What this peer may not be sent (#1107): the providers it does not know, and their threads and projects as the host holds them. */
  const scopeOf = (peer: Peer): ProviderScope => ({ providers: peer.unknownProviders, thread: id => unknownProviderThread(peer, id), project: id => unknownProviderProject(peer, id) })
  /** A Watcher answer, projection, or phone state as this peer may be sent it: without a row of a provider it does not know. */
  const watcherFor = <T>(peer: Peer, value: T): T => {
    const scoped = peer.unknownProviders.size ? readWithoutProviders(value, scopeOf(peer)) : value
    if (offers(peer, 'worker-swarms') || scoped === null || typeof scoped !== 'object'
      || !('swarm' in scoped || 'queue' in scoped || 'action' in scoped && 'effectiveChoices' in scoped)) return scoped
    const result = { ...scoped } as Record<string, unknown>
    delete result.swarm; delete result.queue
    if ('action' in result) delete result.effectiveChoices
    return result as T
  }
  /** Watcher's phone page with the machines line, for a phone that accepted `watcher-phone-machines` (#1032). */
  const withMachines = <T extends object>(peer: Peer, page: T): T => peer.watcherPhoneMachines && service.watcherPhone ? { ...page, machines: service.watcherPhone.machines() } : page
  /** A phone answer carrying a page, with the machines line on its page for a phone that accepted it. */
  const answerWithMachines = <T>(peer: Peer, answer: T): T => answer !== null && typeof answer === 'object' && 'state' in answer && answer.state !== null && typeof answer.state === 'object'
    ? { ...answer, state: withMachines(peer, answer.state) } : answer
  /**
   * A Watcher request that names a thread, project or model of a provider this peer does not know is refused before the host
   * reads or acts on it, as one for a thread it was never sent is (#1107).
   */
  const refuseHiddenWatcherInput = (peer: Peer, input: unknown): void => {
    if (peer.unknownProviders.size && input !== null && typeof input === 'object' && namesHidden(input as Record<string, unknown>, scopeOf(peer))) throw new Refusal('forbidden')
  }
  /**
   * A shell without the providers a peer does not know (#1107): made once per read and set of providers, however many
   * such peers are sent it, and the read itself for a peer that knows them all or a shell that names none of them.
   */
  const scrubbed = new WeakMap<AgentState, Map<string, AgentState>>()
  const withoutUnknown = (state: AgentState, unknown: HeldProviders): AgentState => {
    if (!unknown.size) return state
    const key = [...unknown].sort().join(',')
    let byKey = scrubbed.get(state)
    if (!byKey) scrubbed.set(state, byKey = new Map())
    let made = byKey.get(key)
    if (!made) byKey.set(key, made = stateWithoutProviders(state, unknown))
    return made
  }
  /**
   * A shell without delegation links while `thread-delegation` is off: made once per read however many peers are sent it,
   * and the read itself when the feature is on or no thread names one.
   */
  const undelegated = new WeakMap<AgentState, AgentState>()
  const withoutDelegation = (state: AgentState): AgentState => {
    if (options.delegation === true) return state
    let made = undelegated.get(state)
    if (!made) undelegated.set(state, made = stateWithoutDelegation(state))
    return made
  }
  /**
   * A shell's thread rows as a phone reads them (October 26, 2026). A row's summary carries the newest messages' opening
   * words and a count of the thread's activity records, which the desktop's sidebar reads and no phone does. Both change
   * with every word and step a working thread streams, so with them no shell to a phone ever repeated the last one: a
   * phone with threads working was pushed its whole shell with every publish, about twenty a second, and the iPhone
   * lagged while typing and scrolling. A phone's rows leave them out, so only what a phone reads makes its shell new.
   * Made once per read however many phones are sent it, and the read itself when no row carries any of them.
   */
  const phoneShells = new WeakMap<AgentState, AgentState>()
  const forPhone = (state: AgentState): AgentState => {
    let made = phoneShells.get(state)
    if (made) return made
    let changed = false
    const threads = state.host.threads.map(thread => {
      const summary = thread.summary
      if (!summary || !('lastUser' in summary || 'lastAssistant' in summary || 'activityCount' in summary)) return thread
      // Without `activityCount` too, which the schema reads as 0: no phone reads it.
      const kept: Partial<AgentThreadSummary> = { ...summary }
      delete kept.lastUser; delete kept.lastAssistant; delete kept.activityCount
      changed = true
      return { ...thread, summary: kept as AgentThreadSummary }
    })
    phoneShells.set(state, made = changed ? { ...state, host: { ...state.host, threads } } : state)
    return made
  }
  /** One phone's view of `original`, which is never edited here, so one read can serve every phone in a publish. */
  const shell = (peer: Peer, read: AgentState = service.shell()) => {
    const original = withoutUnknown(withoutDelegation(read), peer.unknownProviders)
    const visible = isPhonePeer(peer) ? visibleWatcherState(forPhone(original), false) : original
    // `original` names no thread of a provider this peer does not know, so only a phone's own rule is asked here.
    const hiddenProjects = isPhonePeer(peer) ? new Set([...original.host.threads.filter(thread => hiddenFromPhone(peer, thread.id)).map(thread => thread.projectId),
      ...service.watcherPhoneExclusions?.().projectIds ?? []]) : new Set<string>()
    const state = hiddenProjects.size ? { ...visible, host: { ...visible.host, projects: visible.host.projects.filter(project =>
      !hiddenProjects.has(project.id) || visible.host.threads.some(thread => thread.projectId === project.id)) } } : visible
    const draft = peer.editingThreadId === peer.selectedThreadId
      ? state.threadDrafts?.find(item => item.threadId === peer.selectedThreadId) : undefined
    const composer = draft ? { composing: true, draft: draft.text, draftAttachments: draft.attachments,
      draftThreadId: draft.threadId, draftRequestId: draft.requestId }
      : state.draftThreadId === peer.selectedThreadId ? {}
        : { composing: false, draft: '', draftAttachments: [], draftThreadId: null, draftRequestId: null }
    const own = shellForProtocolV1({ ...state, activeThreadId: peer.selectedThreadId, activeProjectId: peer.selectedProjectId,
      ...composer,
      clientCapabilities: { mayAnswer: options.mayAnswer?.(peer.client) ?? false } })
    // A client from before #480 reads the client updates' channel and state against the values it knows, and one it
    // does not know would make it refuse the whole shell: it is sent them as it knew them.
    // Watcher's phone state is the host's own, so it is filtered for this peer as the shell was (#1107).
    const phoneState = peer.watcherPhone && service.watcherPhone ? watcherFor(peer, withMachines(peer, service.watcherPhone.state(options.mayAnswer?.(peer.client) ?? false, peer.watcherPhoneManage === true, peer.watcherPhoneSteer === true))) : undefined
    const projected = phoneState ? { ...own, watcher: phoneState, host: { ...own.host, threads: own.host.threads.map(thread => ({ ...thread,
      watchedByWatcher: phoneState.watchedThreads.some(row => row.target.hostId === hostId && row.target.threadId === thread.id && row.watched) })) } } : own
    // One from before mise's `not-listed` failure reads it as the installer's, for the same reason.
    const shell = !state.clientUpdates || (peer.clientUpdates && peer.clientUpdateNotListed) ? projected
      : { ...projected, clientUpdates: state.clientUpdates.map(peer.clientUpdates ? clientUpdateWithoutNotListed : clientUpdateForOlderClient) }
    // An iPhone from before ADR-0111 settles a terminal answer it was waiting on only once a complete list leaves its
    // terminal out, so a client that still accepts `terminals` reads an empty one. Nothing offers the feature.
    return peer.retiredTerminals ? { ...shell, terminals: [] as [] } : shell
  }
  /**
   * The catalog revisions this listener names to peers that accept `model-catalog-revision`. A peer that does not know a
   * provider is sent the catalog without its models (#1107), so each set of unknown providers has its own counter: a
   * revision names one catalog of that variant for as long as the listener runs, and moves only when that variant's list
   * changes. What each peer was sent is its own.
   */
  const catalogRevisions = new Map<string, ModelCatalogRevisions>()
  const revisionsFor = (peer: Peer): ModelCatalogRevisions => {
    const key = [...peer.unknownProviders].sort().join(',')
    let revisions = catalogRevisions.get(key)
    if (!revisions) catalogRevisions.set(key, revisions = new ModelCatalogRevisions())
    return revisions
  }
  /**
   * A shell as it goes to `peer`, at the moment it is written. A peer that does not accept `model-catalog-revision`
   * gets it whole, as v1 has it. One that does is told the catalog's revision, and sent the catalog itself only when
   * no frame written to this connection has carried that revision whole yet. The caller records `carries` as sent
   * only once its frame was written, never when a too_large error went in its place.
   */
  const wireShell = (peer: Peer, state: HostClientShell): WireShell => {
    if (!peer.catalogRevisions) return { state, carries: null }
    const modelsRevision = revisionsFor(peer).revisionFor(hostCatalogKey(state.host.hostId), state.host.models)
    const host: HostWireShell['host'] = { ...state.host, modelsRevision }
    if (peer.catalogSent !== modelsRevision) return { state: { ...state, host }, carries: modelsRevision }
    delete host.models
    return { state: { ...state, host }, carries: null }
  }
  const recordCatalog = (peer: Peer, shell: WireShell): void => { if (shell.carries !== null) peer.catalogSent = shell.carries }
  /**
   * A shell's state as it is written, and the digests that say whether it repeats the last one pushed. Watcher's page on a
   * phone's shell says when it was read (`observedAt`), a new time on every read, so with it no phone's shell ever
   * repeated: every publish sent a phone its whole shell and Watcher's conversation again. The comparison leaves that
   * time out, so a page with nothing new but its time is not pushed again. `withoutConversation` leaves Watcher's
   * conversation out too, so a shell whose only news is Watcher writing can wait its window. Each part is serialized and
   * hashed once.
   */
  const shellText = (state: HostWireShell): { text: string; digest: string; withoutConversation: string } => {
    const page = state.watcher
    const hash = (text: string): string => createHash('sha1').update(text).digest('base64')
    if (!page) { const text = JSON.stringify(state), digest = hash(text); return { text, digest, withoutConversation: digest } }
    const rest = JSON.stringify({ ...state, watcher: undefined }), untimed = JSON.stringify({ ...page, observedAt: undefined })
    const text = rest.slice(0, -1) + ',"watcher":' + untimed.slice(0, -1) + ',"observedAt":' + JSON.stringify(page.observedAt) + '}}'
    const restDigest = hash(rest), pageWithoutConversation = JSON.stringify({ ...page, observedAt: undefined, conversation: undefined })
    return { text, digest: restDigest + hash(untimed), withoutConversation: restDigest + hash(pageWithoutConversation) }
  }
  /**
   * One read of the service's shell for every phone sent together: each read copies the whole coordinator state. It is
   * read when the first phone sends, so phones that are all backed up read nothing.
   */
  const sharedRead = (): (() => AgentState) => {
    let original: AgentState | undefined
    return () => original ??= service.shell()
  }
  /**
   * What the last shell pushed to each phone carried apart from Watcher's conversation, and when it went. A shell that
   * differs from it only there waits until `WATCHER_WRITING_WINDOW_MS` after it, and the newest then goes. It counts only
   * while `shellSent` stands: once an answer gave the client another picture, the next push goes at once. Its time is the
   * monotonic clock's, so the computer's clock being set back holds no shell longer. Every phone whose window has closed
   * is sent from one read of the service's shell, as a publish sends them.
   */
  const writingClock = options.watcherWritingClock ?? (() => performance.now())
  const lastShell = new WeakMap<Peer, { withoutConversation: string; at: number }>()
  /** Each phone holding a shell, and when its window closes; one timer, for the first of them. */
  const writingHeld = new Map<Peer, number>()
  let writingTimer: { due: number; timer: ReturnType<typeof setTimeout> } | undefined
  const holdWriting = (peer: Peer, due: number): void => {
    if (!writingHeld.has(peer)) writingHeld.set(peer, due)
    const first = Math.min(...writingHeld.values())
    if (writingTimer && writingTimer.due <= first) return
    if (writingTimer) clearTimeout(writingTimer.timer)
    writingTimer = { due: first, timer: setTimeout(sendWriting, Math.max(0, first - writingClock())) }
  }
  const sendWriting = (): void => {
    writingTimer = undefined
    if (closing) return
    const read = sharedRead(), now = writingClock()
    for (const [peer, due] of [...writingHeld]) {
      if (due > now) continue
      writingHeld.delete(peer)
      if (!peer.frames.isClosed && peer.ready) sendShell(peer, read)
    }
    const [next] = writingHeld
    if (next && !writingTimer) holdWriting(...next)
  }
  const authenticated = (peer: Peer): boolean => pairing.verifySession(peer.session) === peer.client.clientId
  const fits = (text: string): boolean => Buffer.byteLength(text) <= HOST_MAX_FRAME_BYTES
  /**
   * Sends one message, or an explicit too_large error in its place when it would not fit in a frame, and
   * says whether the message itself went. Closing the socket instead would only have the client reconnect
   * and be sent the same message again.
   */
  const deliver = (peer: Peer, value: HostPush | HostResponse, carried: Oversize): boolean => {
    const text = JSON.stringify(value)
    if (fits(text)) { peer.frames.sendText(text); return true }
    const error = { code: 'too_large' as const, message: TOO_LARGE[carried] }
    const thread = 'event' in value && (value.event === 'detail' || value.event === 'detail-delta')
    peer.frames.send('event' in value ? { v: 1, event: 'error', ...(thread ? { threadId: value.threadId } : {}), error } : { v: 1, id: value.id, ok: false, error })
    return false
  }
  const push = (peer: Peer, value: HostPush): boolean => { if (!authenticated(peer)) { peer.frames.close(); return false } return deliver(peer, value, value.event === 'detail' || value.event === 'detail-delta' ? 'thread' : 'list') }
  const events = (peer: Peer, afterSeq: number, threadId?: string) => {
    const all = service.events(afterSeq, threadId, HOST_EVENT_PAGE_SIZE + 1), page = all.slice(0, HOST_EVENT_PAGE_SIZE)
    const shown = page.filter(row => !hiddenThread(peer, row.threadId) && (peer.messageAliases || row.event.kind !== 'message-aliased'))
    // A message an event carries loses a handover from a thread of a provider this peer does not know (#1107).
    return { events: eventsWithoutProviders(shown, peer.unknownProviders), latestSeq: page.at(-1)?.seq ?? afterSeq, hasMore: all.length > page.length }
  }
  const observe = async (): Promise<void> => {
    const of = (peer: Peer): string[] => [...peer.observed, ...peer.watcherPhone && service.watcherPhone?.currentThreadId() ? [service.watcherPhone.currentThreadId()!] : []]
    const ids = [...new Set([...peers].flatMap(of))]
    // A desktop whose window is behind another app still observes its panes, but shows none of them (ADR-0092).
    const hidden = [...peers].some(peer => !peer.shown && peer.observed.size > 0)
    const shown = hidden ? [...new Set([...peers].filter(peer => peer.shown).flatMap(of))] : undefined
    await service.command({ type: 'observe-threads', threadIds: ids, ...(shown ? { shownThreadIds: shown } : {}) }, { clientId: observationKey, user: '', transport: 'socket' })
  }
  const track = <T>(task: Promise<T>): Promise<T> => { operations.add(task); void task.finally(() => operations.delete(task)).catch(() => undefined); return task }
  /** A thread let go is no longer kept current for this client, so it starts over when it is observed again. */
  const setObserved = (peer: Peer, threadIds: readonly string[]): void => {
    peer.observed = new Set(threadIds.filter(id => !hiddenThread(peer, id)))
    for (const id of peer.held.keys()) if (!peer.observed.has(id)) peer.held.delete(id)
    for (const id of peer.opening) if (!peer.observed.has(id)) peer.opening.delete(id)
    for (const id of backlogs.get(peer)?.keys() ?? []) if (!peer.observed.has(id)) backlogs.get(peer)!.delete(id)
  }
  /**
   * Each whole detail as a socket client reads it: no client is sent a visual, only its words (ADR-0056), a client
   * that accepts activity summaries is sent them (#701), and a desktop that accepts activity bodies is sent records with
   * cut bodies. Each is made once however many peers are sent it, and each cut record once however many details carry it.
   */
  const withoutVisualsOf = new WeakMap<AgentThreadDetail, AgentThreadDetail>()
  const summarised = new WeakMap<AgentThreadDetail, AgentThreadDetail>()
  const cutBodies = new CutBodies(), cutOf = new WeakMap<AgentThreadDetail, AgentThreadDetail>()
  const forPeer = (peer: Peer, detail: AgentThreadDetail | null): AgentThreadDetail | null => {
    if (detail === null) return detail
    let withoutVisuals = withoutVisualsOf.get(detail)
    if (!withoutVisuals) withoutVisualsOf.set(detail, withoutVisuals = detailWithoutVisuals(detail))
    if (peer.activityBodies) {
      let cut = cutOf.get(detail)
      if (!cut) cutOf.set(detail, cut = cutBodies.detail(withoutVisuals))
      return peer.unknownProviders.size ? detailWithoutProviders(cut, peer.unknownProviders) : cut
    }
    // A handover from a thread of a provider this peer does not know loses its record of where it came from (#1107).
    if (!peer.activitySummaries) return peer.unknownProviders.size ? detailWithoutProviders(withoutVisuals, peer.unknownProviders) : withoutVisuals
    let summary = summarised.get(detail)
    if (!summary) summarised.set(detail, summary = detailWithActivitySummaries(withoutVisuals))
    return peer.unknownProviders.size ? detailWithoutProviders(summary, peer.unknownProviders) : summary
  }
  const sendWhole = (peer: Peer, threadId: string, detail: AgentThreadDetail | null): void => {
    peer.opening.delete(threadId)
    if (push(peer, { v: 1, event: 'detail', threadId, detail: forPeer(peer, detail) }) && detail) peer.held.set(threadId, detail.revision)
    else peer.held.delete(threadId)
  }
  const detail = (peer: Peer, threadId: string): void => { sendWhole(peer, threadId, service.threadDetail(threadId)) }
  // A streaming thread changes the shell many times a second. Pushes go out at most once a window, the
  // same way the desktop's own IPC coalesces them, and each carries the state as it is when it is sent.
  // Details come through their own subscription when the service has one, so a shell change resends no history.
  const detailsFollowShell = service.subscribeThreadDetail === undefined
  // The peer's event cursor moves only once the events have gone or the client has been told to fetch them:
  // a page too large to ride along is left behind and the shell says there is more, so the client reads
  // the events itself from its own cursor instead of never being sent them.
  // A shell goes to a peer only once its socket has drained what it was last sent (#698). A phone on a slow
  // link still reading one shell is owed the next instead, and sent the newest, built then, once it drains:
  // one shell can be a megabyte, and twenty a second would fill the socket until it closed. Its cursor has
  // not moved, so that shell's event page holds every event the skipped ones would have carried. Whole
  // details that follow the shell wait with it, the newest standing for any skipped. A thread's own pushes
  // wait on their own (`holdFor` below); responses are never held.
  const owedShell = new WeakSet<Peer>()
  const sendShell = (peer: Peer, read?: () => AgentState): void => {
    if (!authenticated(peer)) { peer.frames.close(); return }
    if (peer.frames.backlogged) {
      if (owedShell.has(peer)) return
      owedShell.add(peer)
      void track(peer.frames.drained().then(() => { owedShell.delete(peer); if (!closing && !peer.frames.isClosed) sendShell(peer) }))
      return
    }
    // Watcher's projection waits with the shell (#1089): the one sent once the socket drains is the newest, built then.
    const scope = watcherScopes.get(peer)
    if (scope && offers(peer, 'watcher-reads') && service.watcherProjection) {
      const projection = watcherFor(peer, service.watcherProjection(scope, peer.client))
      if (watcherRevisions.get(peer) !== projection.revision && push(peer, { v: 1, event: 'watcher-state', projection })) watcherRevisions.set(peer, projection.revision)
    }
    const wire = wireShell(peer, shell(peer, read?.())), eventPage = events(peer, peer.afterSeq)
    // To a client that accepted `changed-thread-records`, the thread records that changed since its last shell push go
    // beside a state whose own list is empty (#996); they become what it holds once the frame is written.
    const records = peer.threadRecords?.encode(wire.state.host.threads)
    const state = records ? { ...wire.state, host: { ...wire.state.host, threads: [] } } : wire.state
    const threadNews = records !== undefined && (records.payload.base === null || records.payload.changed.length > 0 || records.payload.removed !== undefined || records.payload.order !== undefined)
    // The frame is written out by hand so its state, serialized once, can also be compared with the last one pushed.
    const { text: stateText, digest, withoutConversation } = shellText(state)
    const full = '{"v":1,"event":"shell","state":' + stateText + (records ? ',"threads":' + JSON.stringify(records.payload) : '') + ',"eventPage":' + JSON.stringify(eventPage) + '}'
    // A written push moves the client past its events, and what it carried is what the client now holds.
    const written = (): void => { peer.afterSeq = eventPage.latestSeq; recordCatalog(peer, wire); records?.commit() }
    if (fits(full)) {
      // A shell whose state is byte for byte the last one this client was pushed, with no events to bring, would only
      // cost the link its bytes again. It is not written; the cursor still moves past what the page left out for this
      // client, so those events are not read again on every publish. The catalog it would have carried is the one that
      // shell carried.
      const noEvents = eventPage.events.length === 0 && !eventPage.hasMore, last = lastShell.get(peer), now = writingClock()
      if (digest === peer.shellSent && noEvents && !threadNews) { peer.afterSeq = eventPage.latestSeq; recordCatalog(peer, wire) }
      // One whose only news is Watcher's conversation waits out its window, and is read again when the window closes.
      else if (noEvents && !threadNews && peer.shellSent !== null && last?.withoutConversation === withoutConversation && now < last.at + WATCHER_WRITING_WINDOW_MS) holdWriting(peer, last.at + WATCHER_WRITING_WINDOW_MS)
      else {
        peer.frames.sendText(full); peer.shellSent = digest; lastShell.set(peer, { withoutConversation, at: now }); writingHeld.delete(peer); written()
      }
    } else {
      peer.shellSent = null
      if (push(peer, { v: 1, event: 'shell', state, eventPage: { events: [], latestSeq: peer.afterSeq, hasMore: true }, ...records ? { threads: records.payload } : {} })) written()
    }
    if (detailsFollowShell) for (const threadId of peer.observed) detail(peer, threadId)
  }
  // One read of the service's shell per publish, for every phone (`sharedRead`).
  const shellPublisher = coalesceAgentStatePublishes(() => {
    const read = sharedRead()
    for (const peer of peers) {
      if (!authenticated(peer)) { peer.frames.close(); continue }
      if (peer.ready) sendShell(peer, read)
    }
  })
  // Each observed thread's update goes out as the service published it: a whole detail as one, and a delta
  // (what changed since the revision the client holds) as a detail-delta to every client that accepts
  // one. A client applies a delta only to the revision it was measured from and asks for the whole detail
  // otherwise. A client that never accepted deltas, from before protocol v1 froze, is sent the whole thread.
  // A delta of activity summaries is made once for every peer that accepts both, and a delta of cut bodies likewise; a
  // record whose signature changed is carried cut again, so a growing command's delta carries its new cut.
  // A client still owed its first copy of a thread is sent no delta: the copy it is about to be sent is current.
  // A delta no newer than what the client holds is already covered, and a whole it was sent ahead goes no second time.
  /** The latest whole detail the service published for each thread that has not gone out yet. */
  const waiting = new Map<string, AgentThreadDetail>()
  /** What one update becomes for each kind of peer, made once however many peers are sent it. */
  interface UpdateFor { whole: () => AgentThreadDetail | null; delta: (peer: Peer) => AgentThreadDetailDelta }
  const updateFor = (update: AgentThreadDetailUpdate): UpdateFor => {
    let whole: AgentThreadDetail | null | undefined = isAgentThreadDetailDelta(update) ? undefined : update
    let strippedDelta: AgentThreadDetailDelta | undefined
    let summaries: AgentThreadDetailDelta | undefined
    let cut: AgentThreadDetailDelta | undefined
    return {
      whole: () => whole === undefined ? (whole = service.threadDetail(update.threadId)) : whole,
      delta: peer => {
        strippedDelta ??= deltaWithoutVisuals(update as AgentThreadDetailDelta)
        return peer.activityBodies ? (cut ??= cutBodies.delta(strippedDelta)) : peer.activitySummaries ? (summaries ??= deltaWithActivitySummaries(strippedDelta)) : strippedDelta
      },
    }
  }
  const sendUpdate = (peer: Peer, update: AgentThreadDetailUpdate, made: UpdateFor): void => {
    const threadId = update.threadId
    if (!isAgentThreadDetailDelta(update)) { if (!peer.sentAhead.has(update)) sendWhole(peer, threadId, update); return }
    const held = peer.held.get(threadId)
    if (peer.opening.has(threadId) || held !== undefined && update.revision <= held) return
    if (!peer.deltas) { sendWhole(peer, threadId, made.whole()); return }
    const delta = made.delta(peer)
    if (push(peer, { v: 1, event: 'detail-delta', threadId, delta: peer.unknownProviders.size ? deltaWithoutProviders(delta, peer.unknownProviders) : delta }) && held === update.baseRevision) peer.held.set(threadId, update.revision)
    else peer.held.delete(threadId)
  }
  // A thread's pushes wait for a client whose socket is still backed up, as its shell does (#1089). Each thread holds one
  // update for it, every later one folded in, removals too, so a client that reads slowly is sent one delta for what
  // changed while it was behind rather than every delta in turn. Updates that do not follow each other, or a fold that has
  // grown to name more entries than a thread holds records, give way to the thread as it is when it goes (`CURRENT`), so
  // what is held never outgrows one thread. Once the socket drains each goes, a thread at a time, waiting again whenever
  // the socket backs up. A delta still follows the revision it applies to; answers never wait.
  const CURRENT = null
  const backlogs = new WeakMap<Peer, Map<string, AgentThreadDetailUpdate | typeof CURRENT>>()
  const holdFor = (peer: Peer, update: AgentThreadDetailUpdate): boolean => {
    let threads = backlogs.get(peer)
    const threadId = update.threadId
    if (!threads?.has(threadId)) {
      if (!peer.frames.backlogged) return false
      // An update this client would not be sent now is not held for later either. A thread still owed its first whole
      // copy is sent it as it is then, so its deltas are dropped; once something is held for it, they fold into that.
      if (!isAgentThreadDetailDelta(update) ? peer.sentAhead.has(update) : peer.opening.has(threadId)) return true
      if (!threads) { backlogs.set(peer, threads = new Map()); void track(peer.frames.drained().then(() => release(peer))) }
      threads.set(threadId, update)
      return true
    }
    const queued = threads.get(threadId)!
    if (queued === CURRENT) return true
    const folded = foldAgentThreadDetailUpdates(queued, update)
    threads.set(threadId, folded === null || isAgentThreadDetailDelta(folded) && folded.activityDeltas.length + folded.messageDeltas.length > MAX_AGENT_ACTIVITIES ? CURRENT : folded)
    return true
  }
  const release = (peer: Peer): void => {
    const threads = backlogs.get(peer)
    if (!threads) return
    if (closing || peer.frames.isClosed) { backlogs.delete(peer); return }
    for (const [threadId, queued] of threads) {
      if (peer.frames.backlogged) { void track(peer.frames.drained().then(() => release(peer))); return }
      threads.delete(threadId)
      if (!peer.observed.has(threadId)) continue
      const held = peer.held.get(threadId)
      // A whole sent since, such as the one a new observe sends, already carries what this update would.
      if (queued !== CURRENT && held !== undefined && queued.revision <= held) continue
      // A whole read answered since, which no held push waits behind, can land partway through a held delta: the client
      // then holds a revision the delta does not start from, so it is sent the thread as it is rather than a delta it
      // would only answer by reading the thread again.
      if (queued === CURRENT || isAgentThreadDetailDelta(queued) && held !== undefined && held !== queued.baseRevision) { detail(peer, threadId); continue }
      sendUpdate(peer, queued, updateFor(queued))
    }
    backlogs.delete(peer)
  }
  const detailPublisher = coalesceAgentThreadDetailPublishes(update => {
    const threadId = update.threadId
    waiting.delete(threadId)
    const made = updateFor(update)
    for (const peer of peers) {
      if (!peer.observed.has(threadId) || holdFor(peer, update)) continue
      sendUpdate(peer, update, made)
    }
  })
  // Only exact attempts a peer already read without acceptance are watched. This is an in-memory
  // lookup on a host publication, never a provider read or another socket request.
  const acceptedAnswer = (peer: Peer, decisionId: string, target: HostAnswerTarget): boolean =>
    service.requestAnswerRecovery?.(target.threadId, target.providerId).completed.some(item =>
      item.requestId === target.requestId && item.questionsDigest === target.questionsDigest
      && item.decisionId === answerDecisionId(peer.client.clientId, decisionId)) ?? false
  const unsubscribe = service.subscribe(state => {
    for (const peer of peers) {
      if (!peer.ready || !peer.answerReceipts) continue
      for (const [decisionId, target] of peer.answerWatches) {
        if (!acceptedAnswer(peer, decisionId, target)) continue
        if (push(peer, { v: 1, event: 'answer-receipt', acceptedAnswer: { ...target, decisionId } })) peer.answerWatches.delete(decisionId)
      }
    }
    shellPublisher.publish(state)
  })
  // A whole the service published may still be waiting out the coalescing window when a client starts observing
  // its thread. The client is sent that copy before its observe is acknowledged, and it does not follow a second time.
  // An entry lasts only until the thread's next update goes out, which carries or follows it.
  const unsubscribeDetails = service.subscribeThreadDetail?.(update => {
    if (!isAgentThreadDetailDelta(update)) waiting.set(update.threadId, update)
    detailPublisher.publish(update)
  })
  // Which threads' delegations changed (#1310), named to each desktop whose hello accepts `delegation-views`; it reads again
  // only the ones it shows. A thread this peer is not sent is not named to it.
  const unsubscribeDelegations = service.subscribeDelegationViews?.(change => {
    if (!('threadIds' in change) || closing) return
    for (const peer of peers) {
      if (!peer.ready || !peer.delegationViews || peer.frames.isClosed) continue
      const threadIds = change.threadIds.filter(threadId => !hiddenThread(peer, threadId)).slice(0, DELEGATIONS_CHANGED_MAX)
      if (threadIds.length) push(peer, { v: 1, event: 'delegations-changed', threadIds })
    }
  })
  /**
   * The host's check queue (#1312), pushed whole to a desktop whose hello accepted `check-queue-views`: after its hello and
   * whenever the queue changes. A thread this peer is not sent is not named to it, and nor is a check on a provider it does
   * not know: a waiting check's thread is not made yet, so only the check says its provider (Sol's review of #1678).
   */
  const pushChecks = (peer: Peer): void => {
    const checks = service.checkQueue?.()
    if (checks === undefined || !peer.checkQueueViews || peer.frames.isClosed) return
    const shown = checks.map(entry => (entry.provider !== undefined && peer.unknownProviders.has(entry.provider))
      || (entry.thread !== undefined && hiddenThread(peer, entry.thread)) || (entry.by !== undefined && hiddenThread(peer, entry.by))
      ? { id: entry.id, ...entry.whose ? { whose: entry.whose } : {} } : entry)
    push(peer, { v: 1, event: 'check-queue', checks: shown })
  }
  /**
   * The next prompts this host holds (ADR-0173), pushed whole to a desktop that accepted `next-prompts` once it says it
   * wants them, and each change after that. A thread this peer is not sent is not named to it.
   */
  const pushNextPrompts = (peer: Peer): void => {
    if (!peer.nextPrompts?.wanted || peer.frames.isClosed) return
    push(peer, { v: 1, event: 'next-prompts', entries: (service.nextPrompts?.() ?? []).filter(entry => !hiddenThread(peer, entry.threadId)) })
  }
  const unsubscribeNextPrompts = service.subscribeNextPrompts?.(entry => {
    if (closing) return
    for (const peer of peers) if (peer.ready && peer.nextPrompts?.wanted && !peer.frames.isClosed && !hiddenThread(peer, entry.threadId)) push(peer, { v: 1, event: 'next-prompt', entry })
  })
  const unsubscribeChecks = service.subscribeCheckQueue?.(() => {
    if (closing) return
    for (const peer of peers) if (peer.ready && peer.checkQueueViews) pushChecks(peer)
  })
  /** The permission settings of a new or changed thread's model that let the provider do nothing unasked. */
  const askingProviderModes = (input: AgentCommand): string[] => {
    if (input.type !== 'create-thread' && input.type !== 'configure-thread') return []
    const host = service.shell().host
    const modelId = input.modelId ?? (input.type === 'configure-thread' ? host.threads.find(thread => thread.id === input.threadId)?.modelId : undefined)
    return resolveModel(host.models, modelId)?.providerModes?.filter(mode => mode.allows === 'nothing').map(mode => mode.id) ?? []
  }
  const command = async (peer: Peer, request: Extract<HostRequest, { op: 'command' }>, ownCard?: WatcherThreadTarget): Promise<HostClientShell> => {
    const digest = createHash('sha256').update(JSON.stringify(ownCard ? ['watcher-phone-answer', ownCard, request.command] : request.command)).digest('hex')
    const previous = receipts.get(peer.client.clientId, request.id)
    if (previous) {
      if (previous.digest !== digest) throw new Refusal('invalid_request')
      await previous.task
      if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
      const state = shell(peer)
      return ownCard ? { ...state, error: null } : state
    }
    if (managementCommandRefusal(request.command)) throw new Refusal('forbidden')
    const input = commandFromProtocolV1(request.command)
    if (ownCard) {
      if (ownCard.hostId !== hostId || input.type !== 'answer' || input.threadId !== ownCard.threadId) throw new Refusal('forbidden')
      const state = service.watcherPhone!.state(options.mayAnswer?.(peer.client) ?? false)
      if (!state.needsYou.some(card => card.target.hostId === ownCard.hostId && card.target.threadId === ownCard.threadId && card.request.id === input.requestId)) throw new Refusal('stale_request')
      if (!options.mayAnswer?.(peer.client)) throw new Refusal('forbidden')
    }
    const explicitOwner = 'threadId' in input ? input.threadId : input.type === 'send' ? input.draft?.threadId : peer.selectedThreadId
    if (!ownCard && explicitOwner && hiddenThread(peer, explicitOwner)) throw new Refusal('forbidden')
    if ((input.type === 'send' && input.draft || input.type === 'compose' && input.threadId !== undefined)
      && !offers(peer, 'atomic-send')) throw new Refusal('invalid_request')
    if ((input.type === 'compose' && input.draftId !== undefined || input.type === 'send' && input.draft?.draftId !== undefined
      || input.type === 'save-thread-draft' && input.expectedDraftId !== undefined) && !offers(peer, 'draft-revisions')) throw new Refusal('invalid_request')
    const state = service.shell()
    const targetThreadId = peer.selectedThreadId
    const savedDraft = state.draftThreadId !== targetThreadId || !state.composing && !state.draft.trim() && !state.draftAttachments?.length
      ? state.threadDrafts?.find(draft => draft.threadId === targetThreadId) : undefined
    // A native question needs current answer authority even before any client has saved its draft.
    const nativeQuestion = state.host.threads.find(thread => thread.id === targetThreadId)?.requests
      .find(item => item.kind === 'question')
    const draftRequestId = nativeQuestion?.id ?? (state.composing && state.draftThreadId === targetThreadId ? state.draftRequestId
      : savedDraft ? savedDraft.requestId
        : null)
    // Targeted Compose resolves its binding after earlier admitted saves in the coordinator's lane.
    // The coordinator checks current answer authority before staging that actual binding. Pairing,
    // shape and this peer's exact selected owner are still checked here; Send stays conservative.
    const refusal = remoteCommandRefusal(input, { mayAnswer: options.mayAnswer?.(peer.client) ?? false, askingProviderModes: askingProviderModes(input),
      draftRequestId: input.type === 'send' || input.type === 'compose' && input.threadId === undefined ? draftRequestId : undefined,
      selectedThreadId: targetThreadId, clientUpdates: options.clientUpdates === true && offers(peer, 'client-updates'), threadStarts: offers(peer, 'thread-starts'),
      threadDelete: offers(peer, 'thread-delete'), bringBack: offers(peer, 'bring-changes-back'), desktop: options.watcherDesktops?.has(peer.client.clientId) ?? false })
    if (refusal) throw new Refusal(refusal)
    if (input.type === 'preview-reclaim-thread-worktree') {
      const result = await service.command(input, peer.client)
      return { ...shell(peer), error: result.error, ...(result.worktreeReclaimPreview ? { worktreeReclaimPreview: result.worktreeReclaimPreview } : {}) }
    }
    if (input.type === 'preview-delete-thread') {
      const result = await service.command(input, peer.client)
      return { ...shell(peer), error: result.error, ...(result.threadDeletePreview ? { threadDeletePreview: result.threadDeletePreview } : {}) }
    }
    const recorded = !UNRECEIPTED.has(input.type)
    if (recorded && !receipts.makeRoom()) throw new Refusal('busy')
    if (input.type === 'answer') {
      const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
      if (!thread?.requests.some(item => item.id === input.requestId && !item.delivery)) throw new Refusal('stale_request')
    }
    // A merge, close or auto-merge runs only on this client's own confirmation receipt for exactly this press, spent here
    // (#1691). The coordinator is told the head commit the receipt was given on, never the receipt.
    let dispatched: AgentCommand = input
    if (input.type === 'git-pull-request-action') {
      const { confirmation, ...press } = input
      const { action } = press
      dispatched = press
      if (needsConfirmationReceipt(action)) {
        const redeemed = confirmations.redeem(peer.client.clientId, confirmation, { threadId: press.threadId, url: press.url, action, method: press.method })
        if (!redeemed.ok) throw new Refusal('forbidden', redeemed.message)
        if (redeemed.matchHeadCommit) dispatched = { ...press, matchHeadCommit: redeemed.matchHeadCommit }
      }
    }
    const receipt: HostReceipt = { status: 'pending' }
    let privateError: string | null | undefined
    // A Git command refused because the folder is held says what holds it (#1823), on this reply alone.
    let checkoutHold: AgentState['checkoutHold']
    const task = (async () => {
      try {
        if (input.type === 'select-thread') {
          const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
          if (!thread) throw new Refusal('invalid_request')
          peer.selectedThreadId = thread.id; peer.selectedProjectId = thread.projectId
        } else if (input.type === 'select-project') {
          peer.selectedProjectId = input.projectId; peer.selectedThreadId = null
        } else if (input.type === 'observe-threads') {
          setObserved(peer, input.threadIds); await observe()
        } else {
          const previousEditor = peer.editingThreadId
          if (input.type === 'compose') peer.editingThreadId = peer.selectedThreadId
          const client = { ...peer.client, selectedThreadId: peer.selectedThreadId }
          const result = input.type === 'answer'
            ? ownCard ? await service.watcherPhone!.answer(input, client, answerDecisionId(peer.client.clientId, request.id), () => {
              if (!authenticated(peer) || peer.frames.isClosed || closing || !admits(peer.client.clientId)) throw new Refusal('unauthenticated')
              if (!options.mayAnswer?.(peer.client)) throw new Refusal('forbidden')
            }) : await service.command(input, client, answerDecisionId(peer.client.clientId, request.id))
            : await service.command(dispatched, client)
          if (input.type === 'compose' && result.error) peer.editingThreadId = previousEditor
          if (result.checkoutHold) checkoutHold = result.checkoutHold
          if (['cancel-draft', 'send'].includes(input.type) && !result.error) peer.editingThreadId = null
          // Continuing an agent answers in the agent's row (#1028): its refusal is this command's alone, as a send's is.
          if (input.type === 'answer' || input.type === 'send' || input.type === 'save-thread-draft' || startsThread(input) || input.type === 'compose' && input.threadId !== undefined) privateError = result.error
          if (input.type === 'answer' || input.type === 'send' && draftRequestId) {
            receipt.answerDelivered = result.error == null
            if (!receipt.answerDelivered) receipt.error = { code: 'unavailable', message: errors.unavailable }
          }
        }
        receipt.status = 'completed'
      } catch { receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }; throw new Refusal('unavailable') }
    })()
    if (recorded) receipts.record(peer.client.clientId, request.id, { digest, receipt, task } satisfies CommandReceipt)
    await task
    const answer = privateError === undefined ? shell(peer) : { ...shell(peer), error: privateError }
    return checkoutHold === undefined ? answer : { ...answer, checkoutHold }
  }
  /** A tool read that failed outright is the host's failure to read; what it answered, a refusal included, goes as it is. */
  const toolRead = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read() } catch { throw new Refusal('unavailable') }
  }
  /** A large read, one at a time per peer, on the guard a preview takes. */
  const oneAtATime = async <T>(peer: Peer, read: () => Promise<T>): Promise<T> => {
    if (peer.preview) throw new Refusal('busy')
    peer.preview = true
    try { return await read() } finally { peer.preview = false }
  }
  const dispatch = async (peer: Peer, request: HostRequest): Promise<unknown> => {
    if (closing) throw new Refusal('unavailable')
    if (request.session !== peer.session || !authenticated(peer)) throw new Refusal('unauthenticated')
    if (request.op === 'watcher-control' || request.op === 'watcher-read') {
      await options.watcherDesktops?.refresh()
      if (!options.watcherDesktops?.has(peer.client.clientId)) throw new Refusal('forbidden')
      const feature = request.op === 'watcher-control' ? 'watcher-control' : 'watcher-reads'
      if (!peer.ready || !offers(peer, feature)) throw new Refusal('invalid_request')
      const guard = () => {
        if (closing || peer.frames.isClosed || !authenticated(peer) || !options.watcherDesktops?.has(peer.client.clientId)) throw new Error('Watcher master connection is unavailable.')
      }
      guard()
      // A read or a direction of a thread, project or model this desktop does not know is refused before it runs (#1107).
      refuseHiddenWatcherInput(peer, request.op === 'watcher-control' ? request.request.call.input : request.request.call?.input)
      if (request.op === 'watcher-control' && request.request.call.name === 'start_thread'
        && (request.request.call.input.count !== undefined || request.request.call.input.prompts !== undefined)
        && !offers(peer, 'worker-swarms')) throw new Refusal('invalid_request')
      if (request.op === 'watcher-control') return watcherFor(peer, await service.watcherControl!(request.request, peer.client, guard, () => options.mayAnswer?.(peer.client) ?? false))
      if (request.request.standingWatches !== undefined && !offers(peer, 'watcher-standing-watch')) throw new Refusal('invalid_request')
      if (request.request.adopt !== undefined && !offers(peer, 'watcher-new-owner')) throw new Refusal('invalid_request')
      if (!request.request.call && peer.watcherReads) watcherScopes.set(peer, request.request)
      const read = await service.watcherRead!(request.request, peer.client, guard, () => options.mayAnswer?.(peer.client) ?? false)
      // A desktop that does not know a provider is sent no Watcher row of it (#1107).
      return watcherFor(peer, read)
    }
    if (request.op.startsWith('watcher-phone-')) {
      const phone = service.watcherPhone
      if (!peer.ready || !peer.watcherPhone || !offers(peer, 'watcher-phone') || !phone) throw new Refusal('invalid_request')
      const guard = () => {
        if (closing || peer.frames.isClosed || !authenticated(peer) || !admits(peer.client.clientId)) throw new Refusal('unauthenticated')
      }
      const mayAnswer = () => options.mayAnswer?.(peer.client) ?? false
      // A phone that never negotiated management knows nothing of standing watches, and is shown none (ADR-0073).
      const standing = peer.watcherPhoneManage === true
      // A phone that negotiated steering is shown the user's follow-ups waiting for Watcher and may steer it (#1229).
      const steer = peer.watcherPhoneSteer === true
      guard()
      // Watching, sending to or answering in a thread of a provider this phone does not know is refused before Watcher hears
      // of it, and every answer is Watcher's phone state filtered for this phone as its shell is (#1107).
      refuseHiddenWatcherInput(peer, 'request' in request ? request.request : undefined)
      // Stop all stops every thread Watcher drives, so its confirmation lists every one, a thread of a provider this phone
      // does not know by its title alone; the general filter would leave such a thread out of the list but not out of the stop.
      if (request.op === 'watcher-phone-prepare-stop-all') {
        if (!peer.watcherPhoneStop || !offers(peer, 'watcher-phone-stop-all')) throw new Refusal('invalid_request')
        return stopPreviewWithoutProviders(phone.prepareStop(peer.client), peer.unknownProviders)
      }
      // One photo of a message in Watcher's conversation. Watcher's thread is hidden from a phone's `preview`, so this reads the
      // current Watcher's alone, one image at a time on the same guard.
      if (request.op === 'watcher-phone-preview') {
        if (!offers(peer, 'watcher-phone-photos')) throw new Refusal('invalid_request')
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try { return await phone.preview(request.request) } finally { peer.preview = false }
      }
      const answer = await (async () => { switch (request.op) {
        case 'watcher-phone-set-permission':
        case 'watcher-phone-watch':
        case 'watcher-phone-unwatch':
        case 'watcher-phone-open':
        case 'watcher-phone-new':
        case 'watcher-phone-stop-turn':
        case 'watcher-phone-dismiss-handover': {
          if (!peer.watcherPhoneManage || !offers(peer, 'watcher-phone-manage')) throw new Refusal('invalid_request')
          // Watcher's box (October 31, 2026), only from a phone that negotiated it.
          const composing = request.op in COMPOSER_OPS ? COMPOSER_OPS[request.op as keyof typeof COMPOSER_OPS] : undefined
          if (composing && (!peer.watcherPhoneComposer || !offers(peer, 'watcher-phone-composer'))) throw new Refusal('invalid_request')
          const digest = createHash('sha256').update(JSON.stringify([request.op, request.request])).digest('hex')
          const previous = receipts.get(peer.client.clientId, request.id)
          if (previous) {
            if (previous.digest !== digest) throw new Refusal('invalid_request')
            await previous.task
            guard()
            if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
            const outcome = previous.receipt.watcherManage
            if (!outcome) throw new Refusal('unavailable')
            return outcome.status === 'refused' ? outcome : phone.get(mayAnswer(), standing, steer)
          }
          if (!receipts.makeRoom()) throw new Refusal('busy')
          const receipt: HostReceipt = { status: 'pending' }
          const task = (composing ? phone.compose(composing, request.request as WatcherPhoneOpen | WatcherPhoneCurrent, peer.client, guard, mayAnswer, steer)
            : phone.manage(request.op === 'watcher-phone-set-permission' ? 'permission' : request.op === 'watcher-phone-watch' ? 'watch' : 'unwatch',
              request.request as WatcherSetPermissionRequest | WatcherWatchThreadRequest, peer.client, guard, mayAnswer, steer)).then(result => {
            receipt.watcherManage = result.status === 'refused' ? result : { status: 'ok' }
            receipt.status = 'completed'
            return result
          }).catch(() => {
            receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }
            throw new Refusal('unavailable')
          })
          receipts.record(peer.client.clientId, request.id, { digest, receipt, task })
          return task
        }
        case 'watcher-phone-read': {
          // Read afresh only for a phone that negotiated the machines line (#1032): when its user opens a machine's numbers
          // or Watcher placed work. Nothing reads on a timer.
          if (request.machines === true) {
            if (!peer.watcherPhoneMachines || !offers(peer, 'watcher-phone-machines')) throw new Refusal('invalid_request')
            await phone.readMachines()
          }
          await observe(); return phone.get(mayAnswer(), standing, steer)
        }
        case 'watcher-phone-remove-followup': {
          if (!steer || !offers(peer, 'watcher-phone-steer')) throw new Refusal('invalid_request')
          // As a management change: its outcome is kept under the request's ID, so a lost acknowledgement reads it and a
          // retry removes nothing more.
          const digest = createHash('sha256').update(JSON.stringify([request.op, request.request])).digest('hex')
          const previous = receipts.get(peer.client.clientId, request.id)
          if (previous) {
            if (previous.digest !== digest) throw new Refusal('invalid_request')
            await previous.task
            guard()
            if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
            const outcome = previous.receipt.watcherManage
            if (!outcome) throw new Refusal('unavailable')
            return outcome.status === 'refused' ? outcome : phone.get(mayAnswer(), standing, steer)
          }
          if (!receipts.makeRoom()) throw new Refusal('busy')
          const receipt: HostReceipt = { status: 'pending' }
          const task = phone.removeFollowup(request.request, peer.client, guard, mayAnswer, standing).then(result => {
            receipt.watcherManage = result.status === 'refused' ? result : { status: 'ok' }
            receipt.status = 'completed'
            return result
          }).catch(() => {
            receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }
            throw new Refusal('unavailable')
          })
          receipts.record(peer.client.clientId, request.id, { digest, receipt, task })
          return task
        }
        case 'watcher-phone-send': {
          // Only a phone that negotiated steering may ask for a steer; an older phone's send is unchanged (#1229).
          if (request.request.delivery !== undefined && (!steer || !offers(peer, 'watcher-phone-steer'))) throw new Refusal('invalid_request')
          if (request.request.images !== undefined && !offers(peer, 'watcher-phone-photos')) throw new Refusal('invalid_request')
          if (request.request.handover !== undefined && (!peer.watcherPhoneComposer || !offers(peer, 'watcher-phone-composer'))) throw new Refusal('invalid_request')
          if (request.request.images?.some(handle => !isImageAttachment(handle.mimeType)) && !offers(peer, 'watcher-phone-files')) throw new Refusal('invalid_request')
          const digest = createHash('sha256').update(JSON.stringify([request.op, request.request])).digest('hex')
          const previous = receipts.get(peer.client.clientId, request.id)
          if (previous) {
            if (previous.digest !== digest) throw new Refusal('invalid_request')
            await previous.task
            if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
            return { status: 'ok', draftId: request.request.draftId, state: phone.state(mayAnswer(), standing, steer) }
          }
          if (!receipts.makeRoom()) throw new Refusal('busy')
          const receipt: HostReceipt = { status: 'pending' }
          const task = phone.send(request.request, peer.client, guard, mayAnswer, standing, steer).then(result => {
            receipt.status = 'completed'
            if (result.status === 'refused') receipt.error = { code: 'unavailable', message: result.message }
            return result
          }).catch(() => { receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }; throw new Refusal('unavailable') })
          receipts.record(peer.client.clientId, request.id, { digest, receipt, task })
          return task
        }
        case 'watcher-phone-stop-all': {
          if (!peer.watcherPhoneStop || !offers(peer, 'watcher-phone-stop-all')) throw new Refusal('invalid_request')
          const digest = createHash('sha256').update(JSON.stringify([request.op, request.confirmationId])).digest('hex')
          const previous = receipts.get(peer.client.clientId, request.id)
          if (previous) {
            if (previous.digest !== digest) throw new Refusal('invalid_request')
            await previous.task
            guard()
            if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
            const outcome = previous.receipt.watcherStop!
            return outcome.status === 'refused' ? outcome : { ...outcome, state: phone.state(mayAnswer(), standing, steer) }
          }
          if (!receipts.makeRoom()) throw new Refusal('busy')
          const receipt: HostReceipt = { status: 'pending' }
          const task = phone.stop(request.confirmationId, peer.client, guard, mayAnswer, standing, steer).then(result => {
            receipt.watcherStop = result.status === 'refused' ? result : { status: 'ok', results: result.results }
            receipt.status = 'completed'
            return result
          }).catch(() => {
            receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }
            throw new Refusal('unavailable')
          })
          receipts.record(peer.client.clientId, request.id, { digest, receipt, task })
          return task
        }
        case 'watcher-phone-answer': {
          const { target, command: input } = request.request
          // Receipt replay comes before fresh-card admission, retaining the authenticated user and exact target.
          const result = await command(peer, { ...request, op: 'command', command: input }, target)
          guard()
          if (result.error) throw new Refusal('unavailable')
          return phone.get(mayAnswer(), standing, steer)
        }
      } })()
      // The machines line goes on every page an answer carries, Stop all's included: the iPhone takes that page whole.
      const paged = answerWithMachines(peer, answer)
      // Stop all's result keeps a row for every thread its confirmation listed, so a phone hears which it could not stop.
      return request.op === 'watcher-phone-stop-all' ? stopResultWithoutProviders(paged, scopeOf(peer)) : watcherFor(peer, paged)
    }
    if ('threadId' in request && request.threadId && hiddenThread(peer, request.threadId)) throw new Refusal('forbidden')
    if ('request' in request && request.request && 'threadId' in request.request && hiddenThread(peer, request.request.threadId as string)) throw new Refusal('forbidden')
    switch (request.op) {
      case 'hello': {
        await options.watcherDesktops?.refresh()
        // Whether this client is a desktop is read afresh: the launch script may have recorded it since the socket opened.
        if (tailnet) {
          await tailnet.desktops.refresh().catch(() => undefined)
          peer.desktop = isDesktop(peer.client.clientId)
          if (!admits(peer.client.clientId)) throw new Refusal('forbidden', phonesOffMessage())
        }
        peer.frames.setClientLiveness(request.accepts?.includes('client-liveness') ?? false)
        peer.messageAliases = request.accepts?.includes('message-aliases') ?? false
        peer.afterSeq = request.afterSeq ?? Number.MAX_SAFE_INTEGER; peer.deltas = request.accepts?.includes('detail-delta') ?? false
        peer.clientUpdates = (request.accepts?.includes('client-updates') ?? false) && offers(peer, 'client-updates')
        peer.clientUpdateNotListed = peer.clientUpdates && (request.accepts?.includes('client-update-not-listed') ?? false) && offers(peer, 'client-update-not-listed')
        peer.catalogRevisions = request.accepts?.includes('model-catalog-revision') ?? false
        // Shell pushes carry only the thread records that changed since the last one, measured from a fresh start (#996).
        peer.threadRecords = (request.accepts?.includes('changed-thread-records') ?? false) && offers(peer, 'changed-thread-records') ? new ThreadRecordsBroadcast() : undefined
        peer.activitySummaries = request.accepts?.includes('activity-summaries') ?? false
        // Summaries win over cut bodies: a client that asks for both reads summaries, as it did before cut bodies.
        peer.activityBodies = !peer.activitySummaries && (request.accepts?.includes('activity-bodies') ?? false) && offers(peer, 'activity-bodies')
        peer.watcherPhone = (request.accepts?.includes('watcher-phone') ?? false) && offers(peer, 'watcher-phone')
        peer.watcherPhoneStop = peer.watcherPhone && (request.accepts?.includes('watcher-phone-stop-all') ?? false) && offers(peer, 'watcher-phone-stop-all')
        peer.watcherPhoneManage = peer.watcherPhone && (request.accepts?.includes('watcher-phone-manage') ?? false) && offers(peer, 'watcher-phone-manage')
        peer.watcherPhoneSteer = peer.watcherPhone && (request.accepts?.includes('watcher-phone-steer') ?? false) && offers(peer, 'watcher-phone-steer')
        peer.watcherPhoneMachines = peer.watcherPhone && (request.accepts?.includes('watcher-phone-machines') ?? false) && offers(peer, 'watcher-phone-machines')
        // Watcher's box keeps its changes' outcomes under management's receipts, so it rides with management.
        peer.watcherPhoneComposer = peer.watcherPhoneManage && (request.accepts?.includes('watcher-phone-composer') ?? false) && offers(peer, 'watcher-phone-composer')
        peer.watcherReads = (request.accepts?.includes('watcher-reads') ?? false) && offers(peer, 'watcher-reads'); peer.answerReceipts = (request.accepts?.includes('answer-receipts') ?? false) && offers(peer, 'answer-receipts')
        peer.usageHistory = (request.accepts?.includes('usage-history') ?? false) && offers(peer, 'usage-history')
        peer.retiredTerminals = request.accepts?.includes('terminals') ?? false
        peer.usageMuseOpenCode = (request.accepts?.includes('usage-muse-opencode') ?? false) && offers(peer, 'usage-muse-opencode')
        peer.hostUpdate = (request.accepts?.includes('host-update') ?? false) && offers(peer, 'host-update')
        peer.delegationViews = (request.accepts?.includes('delegation-views') ?? false) && offers(peer, 'delegation-views')
        peer.checkQueueViews = (request.accepts?.includes('check-queue-views') ?? false) && offers(peer, 'check-queue-views')
        // Accepted here; pushed only once the desktop says it wants them, so a desktop with its switch off costs no side call.
        peer.nextPrompts = (request.accepts?.includes('next-prompts') ?? false) && offers(peer, 'next-prompts') ? { wanted: peer.nextPrompts?.wanted ?? false } : undefined
        // A desktop that relays this host's delegations to other machines (#1316): asks go to it from now on.
        if ((request.accepts?.includes('delegation-relay') ?? false) && offers(peer, 'delegation-relay') && options.delegationRelay) {
          const relayPeer = peer
          // A desktop that also accepted `delegation-relay-send` is pushed second briefs too (#1316 part 2).
          const sends = (request.accepts?.includes('delegation-relay-send') ?? false) && offers(peer, 'delegation-relay-send')
          // And one that accepted `delegation-branch-starts` is pushed starts from a thread's branch, and checks (#1316 part 2).
          const branches = (request.accepts?.includes('delegation-branch-starts') ?? false) && offers(peer, 'delegation-branch-starts')
          peer.delegationRelay ??= { clientId: peer.client.clientId, sends, branches,
            push: (askId, ask) => !relayPeer.frames.isClosed && authenticated(relayPeer) && push(relayPeer, { v: 1, event: 'delegation-relay-ask', askId, ask }) }
          // Told once this hello's answer has gone, so the asks a reconnect reads again reach a desktop that knows the feature.
          const relay = options.delegationRelay, handle = peer.delegationRelay
          setImmediate(() => { if (!relayPeer.frames.isClosed) relay.desktopConnected(handle) })
        }
        // A desktop that asks this host for delegations for threads on other machines (#1316 part 2): their news goes to it.
        if ((request.accepts?.includes('delegation-remote') ?? false) && offers(peer, 'delegation-remote') && options.delegationRemote) {
          const remotePeer = peer
          peer.delegationRemote ??= { clientId: peer.client.clientId,
            push: (caller, news, replies) => !remotePeer.frames.isClosed && authenticated(remotePeer)
              && push(remotePeer, { v: 1, event: 'delegation-remote-news', caller, news, ...replies.length ? { replies: [...replies] } : {} }) }
          options.delegationRemote.desktopConnected(peer.delegationRemote)
        }
        // A provider is sent to this client only once its hello says it knows the provider (#1107).
        peer.unknownProviders = providersUnknownTo(request.accepts)
        for (const id of [...peer.observed]) if (hiddenThread(peer, id)) { peer.observed.delete(id); peer.held.delete(id); peer.opening.delete(id) }
        if (peer.selectedThreadId && hiddenThread(peer, peer.selectedThreadId)) { peer.selectedThreadId = null; peer.editingThreadId = null }
        if (peer.watcherPhone) await observe()
        const phoneAccess = peer.desktop ? options.phoneAccess?.() : undefined
        return { hostId, clientId: peer.client.clientId, shell: shell(peer), capabilities: { mayAnswer: options.mayAnswer?.(peer.client) ?? false }, sottoVersion, features: featuresFor(peer),
          ...about(), ...(phoneAccess ? { phoneAccess } : {}), ...events(peer, peer.afterSeq) }
      }
      // A client reading the shell whole holds its threads afresh, so the next push lists every record (#996).
      case 'shell': peer.threadRecords?.reset(); return shell(peer)
      case 'detail': return forPeer(peer, service.threadDetail(request.threadId))
      case 'activity-body': {
        // One record whole, for the row a desktop opened (ADR-0025, October 18 amendment); a hidden thread was refused above.
        // Its visuals are already gone: a record carries none. It is read without copying, and only serialized here.
        if (!peer.activityBodies || !offers(peer, 'activity-bodies')) throw new Refusal('invalid_request')
        return service.threadActivity ? service.threadActivity(request.threadId, request.activityId)
          : service.threadDetail(request.threadId)?.activities?.find(item => item.id === request.activityId) ?? null
      }
      case 'check-answer': {
        if (!offers(peer, 'answer-check') || !service.checkRequestAnswer) throw new Refusal('invalid_request')
        if (!options.mayAnswer?.(peer.client)) throw new Refusal('forbidden')
        try { await service.checkRequestAnswer(request.answer, peer.client) }
        catch (error) {
          throw error instanceof RequestAnswerCheckRefusal ? new Refusal(error.hostCode, error.message) : new Refusal('unavailable')
        }
        if (!authenticated(peer)) throw new Refusal('unauthenticated')
        if (!options.mayAnswer?.(peer.client)) throw new Refusal('forbidden')
        return shell(peer)
      }
      case 'events': return events(peer, request.afterSeq, request.threadId)
      case 'receipt': {
        const receipt = receipts.get(peer.client.clientId, request.commandId)?.receipt ?? { status: 'unknown' as const }
        // The coordinator's receipt survives a host restart. Only acceptance of this authenticated
        // client's exact native attempt and original questions can complete its retained answer.
        if (request.answer) {
          const target = request.answer
          if (acceptedAnswer(peer, request.commandId, target)) {
            peer.answerWatches.delete(request.commandId)
            return { status: 'completed', answerDelivered: true, acceptedAnswer: { ...target, decisionId: request.commandId } }
          }
          // Registration and the acceptance check are synchronous, so a late publish cannot fall
          // between a negative response and its watch. Old clients never ask for this push.
          if (peer.answerReceipts) {
            peer.answerWatches.set(request.commandId, target)
            while (peer.answerWatches.size > 512) peer.answerWatches.delete(peer.answerWatches.keys().next().value!)
          }
        }
        return receipt
      }
      case 'observe': {
        // Only a thread this client does not hold is sent whole: one it holds is kept current by the pushes that follow
        // it. The service publishes a newly observed thread whole as it is observed, and that copy is the one sent.
        peer.shown = request.shown !== false
        setObserved(peer, request.threadIds)
        const owed = [...peer.observed].filter(id => !peer.held.has(id))
        for (const id of owed) peer.opening.add(id)
        try { await observe() } catch (error) { for (const id of owed) peer.opening.delete(id); throw error }
        for (const id of owed) {
          if (!peer.opening.has(id)) continue
          await peer.frames.drained(); if (peer.frames.isClosed) break
          if (!peer.opening.has(id)) continue
          // A copy still waiting is sent now in its place, so the thread is neither read again nor sent twice.
          const offered = waiting.get(id)
          if (offered) { peer.sentAhead.add(offered); sendWhole(peer, id, offered) } else detail(peer, id)
        }
        await peer.frames.drained()
        return null
      }
      case 'command': return command(peer, request)
      case 'git-refs':
        if (!service.gitRefs) throw new Refusal('invalid_request')
        try { return await service.gitRefs(request.request) } catch { throw new Refusal('unavailable') }
      case 'git-changed-files':
        if (!service.gitChangedFiles) throw new Refusal('invalid_request')
        try { return await service.gitChangedFiles(request.request) } catch { throw new Refusal('unavailable') }
      case 'git-pull-request': {
        if (!service.gitPullRequest) throw new Refusal('invalid_request')
        let read: Awaited<ReturnType<NonNullable<HostService['gitPullRequest']>>>
        try { read = await service.gitPullRequest(request.request) } catch (error) { throw new Refusal('unavailable', undefined, pullRequestReadFailureOf(error)) }
        // Each reading goes with an ID of its own, which a confirmation receipt this client asks for names, so the receipt
        // stands for the reading the client shows, whatever other reads finished after it (#1691).
        const readId = read && !isPullRequestLimited(read) ? confirmations.read(peer.client.clientId, request.request.threadId, read.url, read.headId) : undefined
        return read && readId ? { ...read, readId } : read
      }
      // A receipt for the merge, close or auto-merge this client is about to send (#1691). Pairing is enough to ask: it is
      // evidence of a second step, not a grant, and answers no permission.
      case 'pull-request-confirmation': {
        if (!offers(peer, 'pull-request-confirmation')) throw new Refusal('invalid_request')
        const issued = confirmations.issue(peer.client.clientId, request.request)
        if (!issued.ok) throw new Refusal('forbidden', issued.message)
        return issued.receipt
      }
      case 'host-folders':
        if (!service.hostFolders) throw new Refusal('invalid_request')
        try { return await service.hostFolders(request.request) } catch { throw new Refusal('unavailable') }
      // A thread's Files, Changes and Agents (ADR-0025, October 5 amendment). Each answers as the desktop's own IPC does:
      // a Files or Changes refusal (a changed working folder, a path outside it) is an answer, not an error.
      case 'thread-files':
        if (!service.threadFiles) throw new Refusal('invalid_request')
        return toolRead(() => service.threadFiles!(request.request))
      case 'thread-file-preview':
        if (!service.threadFilePreview) throw new Refusal('invalid_request')
        // Up to 8 MiB of image as about 11 MB of base64: one at a time per peer, on the preview's guard.
        return oneAtATime(peer, () => toolRead(() => service.threadFilePreview!(request.request)))
      case 'thread-changes':
        if (!service.gitChanges) throw new Refusal('invalid_request')
        return toolRead(() => service.gitChanges!(request.request))
      case 'thread-changes-review':
        if (!service.gitReview) throw new Refusal('invalid_request')
        // Up to 2 MiB of patches, read by several Git runs: one at a time per peer, on the preview's guard.
        return oneAtATime(peer, () => toolRead(() => service.gitReview!(request.request)))
      case 'subagent-page':
        if (!service.subagentPage) throw new Refusal('invalid_request')
        return toolRead(() => service.subagentPage!(request.request))
      case 'subagent-assignments':
        if (!service.subagentAssignments) throw new Refusal('invalid_request')
        return toolRead(() => service.subagentAssignments!(request.request))
      case 'start-handover':
        if (!offers(peer, 'thread-starts') || !service.startHandover) throw new Refusal('invalid_request')
        if (hiddenThread(peer, request.threadId)) throw new Refusal('forbidden')
        return toolRead(async () => ({ handover: await service.startHandover!(request.threadId) }))
      case 'thread-prompts':
        if (!offers(peer, 'thread-prompts') || !service.threadPrompts) throw new Refusal('invalid_request')
        if (hiddenThread(peer, request.threadId)) throw new Refusal('forbidden')
        return toolRead(() => service.threadPrompts!(request.threadId, request.beforeMessageId))
      case 'thread-delegations': {
        if (!offers(peer, 'agents-view') || !service.threadDelegations) throw new Refusal('invalid_request')
        if (hiddenThread(peer, request.threadId)) throw new Refusal('forbidden')
        // A delegated thread this peer is not sent is not named to it either.
        const read = await toolRead(() => service.threadDelegations!(request.threadId))
        return { ...read, threads: read.threads.filter(row => !hiddenThread(peer, row.thread) && !hiddenThread(peer, row.by)) }
      }
      case 'host-facts': {
        if (!offers(peer, 'host-facts') || !service.hostFacts) throw new Refusal('invalid_request')
        try {
          const report = hostMachineReportSchema.parse(await service.hostFacts())
          if (!offers(peer, 'worker-swarms')) { delete report.workerCeiling; delete report.workerQueued }
          return report
        } catch { throw new Refusal('unavailable') }
      }
      case 'project-origins': {
        if (!offers(peer, 'project-origins') || !service.projectOrigins) throw new Refusal('invalid_request')
        let read: ProjectOrigins
        try { read = projectOriginsSchema.parse(await service.projectOrigins()) } catch { throw new Refusal('unavailable') }
        // A project of a provider this peer does not know is not named to it (#1107).
        return { projects: read.projects.filter(project => !unknownProviderProject(peer, project.projectId)) }
      }
      case 'project-setup': {
        if (!offers(peer, 'project-setup') || !service.setUpProject) throw new Refusal('invalid_request')
        // A setup that cannot finish answers its own plain words; only a failure to answer at all is a refusal.
        try { return projectSetupResultSchema.parse(await service.setUpProject(request.request)) } catch { throw new Refusal('unavailable') }
      }
      case 'delegation-views': {
        // Delegation's own record of one of this host's threads (#1310), read for a recorded desktop's window, never a reply.
        if (!offers(peer, 'delegation-views') || !service.delegationViews) throw new Refusal('invalid_request')
        const read = await toolRead(() => service.delegationViews!(request.threadId))
        let parsed: ReturnType<typeof delegationsReadSchema.parse>
        try { parsed = delegationsReadSchema.parse(read) } catch { throw new Refusal('unavailable') }
        // A thread this peer is not sent is not named to it here either, as its `delegations-changed` push and Watcher's
        // reads leave it out (#1107). A refused start names no thread and stays.
        const shown = (thread: string | undefined) => thread === undefined || !hiddenThread(peer, thread)
        return { ...parsed, delegations: parsed.delegations.filter(row => shown(row.thread)), received: parsed.received.filter(row => shown(row.thread)) }
      }
      case 'delegation-brief': {
        if (!offers(peer, 'delegation-views') || !service.delegationBrief) throw new Refusal('invalid_request')
        const brief = await toolRead(() => service.delegationBrief!(request.threadId))
        try { return delegationBriefSchema.parse(brief) } catch { throw new Refusal('unavailable') }
      }
      case 'next-prompts-wanted': {
        // The desktop's own switch (ADR-0173): while no connected desktop wants them, this host asks its providers nothing.
        if (!peer.nextPrompts) throw new Refusal('invalid_request')
        peer.nextPrompts.wanted = request.wanted
        return { wanted: request.wanted }
      }
      case 'desktop-defaults': {
        // A recorded desktop's new-thread default and worker roles (#1310): settings, never a grant. Whether they may be used
        // as sent is this host's `remote-answer` policy for that desktop, read at every delegated start.
        if (!offers(peer, 'host-delegation') || !service.desktopDefaults) throw new Refusal('invalid_request')
        if (request.defaults.workerCeiling !== undefined && !offers(peer, 'worker-swarms')) throw new Refusal('invalid_request')
        try { return desktopDefaultsReceiptSchema.parse(await service.desktopDefaults(request.defaults, peer.client)) } catch { throw new Refusal('unavailable') }
      }
      case 'delegation-relay-answer': {
        // The relaying desktop's answer to an ask this host pushed it (#1316). An answer nobody waits for is dropped.
        if (!options.delegationRelay || !peer.delegationRelay) throw new Refusal('invalid_request')
        return { taken: options.delegationRelay.answered(peer.delegationRelay, request.askId, request.result) }
      }
      case 'delegation-relay-name': {
        // The name the relaying desktop saved for this host (#1316): words only, kept for the away refusal.
        if (!options.delegationRelay || !peer.delegationRelay) throw new Refusal('invalid_request')
        await options.delegationRelay.named(peer.delegationRelay, request.name)
        return { named: true }
      }
      case 'delegation-relay-news': {
        // A relayed delegation's outcome changed (#1316): the thread here that made it is told, as its hidden wake-up.
        if (!options.delegationRelay || !peer.delegationRelay) throw new Refusal('invalid_request')
        try { await options.delegationRelay.news(request.threadId, request.news, request.replies) } catch { throw new Refusal('unavailable') }
        return { told: true }
      }
      case 'delegation-remote-ask': {
        // A desktop's delegation here for a thread on another machine (#1316 part 2), admitted by this host's own delegation.
        if (!options.delegationRemote || !peer.delegationRemote) throw new Refusal('invalid_request')
        // Held as being admitted from the moment it is taken, before anything here waits, so a read by its retry key on
        // another socket meanwhile says it may still be made (#1316 review).
        const release = options.delegationRemote.hold(peer.client.clientId, request.ask)
        try {
          // Read again at every ask, not only at hello: a desktop the launch script no longer records is refused (#1316 review).
          await options.watcherDesktops?.refresh().catch(() => undefined)
          if (options.watcherDesktops?.has(peer.client.clientId) !== true) throw new Refusal('forbidden')
          // A check's place reserved once this connection closed is never held: its cleanup has already run (#1316 part 2).
          try { return { result: await options.delegationRemote.answer(peer.client.clientId, request.ask, () => !peer.gone.signal.aborted) } } catch { throw new Refusal('unavailable') }
        } finally { release() }
      }
      case 'host-update': {
        // A host update the host runs on itself (ADR-0088): a recorded desktop that may answer, after its hello, and only
        // on a host that can. Failures are answers in the launch script's own words, never a refusal.
        await options.watcherDesktops?.refresh().catch(() => undefined)
        const { hostUpdate } = options
        if (!hostUpdate || !features.includes('host-update') || !peer.ready) throw new Refusal('invalid_request')
        if (!mayUpdate(peer)) throw new Refusal('forbidden')
        try {
          return await hostUpdate.run({ action: request.action, version: request.version, file: request.file, sha256: request.sha256 }, { owner: peer, gone: peer.gone.signal,
            onStep: next => { if (peer.hostUpdate && !peer.frames.isClosed && authenticated(peer)) push(peer, { v: 1, event: 'host-update-step', step: next }) } })
        } catch { throw new Refusal('unavailable') }
      }
      case 'branch-move': {
        // A branch move with a recorded desktop (ADR-0105 decision 8). Refusals are answers in plain words; only a failure to
        // run the step at all is the host's, and Git's own words never cross.
        await options.watcherDesktops?.refresh().catch(() => undefined)
        const { branchMoves } = options
        if (!branchMoves || !offers(peer, 'branch-moves') || !peer.ready) throw new Refusal('invalid_request')
        try { return await branchMoves.handle(request.request, peer, peer.gone.signal) } catch { throw new Refusal('unavailable') }
      }
      case 'thread-move': {
        // A thread moved here from another machine (#1178), for a recorded desktop, read again at every ask. Refusals are
        // answers in plain words; a step that cannot run at all is the host's, and the desktop asks again.
        await options.watcherDesktops?.refresh().catch(() => undefined)
        const { threadMoves } = options
        if (!threadMoves || !offers(peer, 'thread-move') || !peer.ready) throw new Refusal('invalid_request')
        if (request.request.action === 'keep' ? !offers(peer, 'thread-move-keep') : request.request.action !== 'start' && !offers(peer, 'thread-move-source')) throw new Refusal('invalid_request')
        try { return await threadMoves.handle(request.request, peer.client) } catch { throw new Refusal('unavailable') }
      }
      case 'usage-read':
        if (!offers(peer, 'usage-dashboard') || !service.usageRead) throw new Refusal('invalid_request')
        {
          // An earlier desktop's totals hold only the providers it can name, so it is read for those alone.
          const query = peer.usageMuseOpenCode ? request.query : { ...request.query, providerIds: usageProvidersBeforeMuse(request.query.providerIds) }
          try { return usageForPeer(peer, usageLocalHostReadSchema.parse(await service.usageRead(query))) } catch { throw new Refusal('unavailable') }
        }
      case 'usage-refresh':
        if (!offers(peer, 'usage-dashboard') || !service.usageRefresh) throw new Refusal('invalid_request')
        {
          const providerIds = peer.usageMuseOpenCode ? request.providerIds : usageProvidersBeforeMuse(request.providerIds)
          const background = request.background === true && offers(peer, 'usage-background-refresh')
          try { return usageForPeer(peer, usageLocalHostReadSchema.parse(await (background ? service.usageRefresh(providerIds, true) : service.usageRefresh(providerIds)))) } catch { throw new Refusal('unavailable') }
        }
      case 'usage-clear':
        if (!offers(peer, 'usage-dashboard') || !service.usageClear) throw new Refusal('invalid_request')
        if (remoteUsageRefusal(request.op, options.mayAnswer?.(peer.client) ?? false)) throw new Refusal('forbidden')
        try { return usageLocalClearResultSchema.parse(await service.usageClear(request.request, peer.client)) } catch { throw new Refusal('unavailable') }
      case 'stage-attachment': {
        if (!service.stageAttachment) throw new Refusal('invalid_request')
        // Up to about 14 MB of base64 in, and 10 MiB held until it is kept: one at a time per peer, on the preview's guard.
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        const bytes = Buffer.from(request.image.data, 'base64')
        try {
          return await service.stageAttachment({ name: request.image.name, mimeType: request.image.mimeType, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ...(request.image.dimensions ? { dimensions: request.image.dimensions } : {}) })
        }
        catch (error) {
          // An image refused for what it is says so; anything else is the host's failure to keep it.
          if (error instanceof RefusedImage) throw new Refusal('invalid_request', error.message)
          throw new Refusal('unavailable')
        } finally { peer.preview = false }
      }
      case 'stage-file-part': {
        if (!offers(peer, 'file-staging') || !service.stageAttachment) throw new Refusal('invalid_request')
        // Up to about 11 MB of base64 in, one part at a time per socket on the preview's guard, and at most one 25 MiB
        // upload held per paired client across all its sockets.
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try {
          let file
          try { file = uploads.receive(peer.client.clientId, request.part) }
          catch (error) { if (error instanceof FileUploadRefusal) throw new Refusal('invalid_request', error.message); throw error }
          if (!file) return null
          try { return await service.stageAttachment({ name: file.name, mimeType: file.mimeType, bytes: file.bytes }) }
          catch (error) {
            // A file refused for what it is says so; anything else is the host's failure to keep it.
            if (error instanceof RefusedImage) throw new Refusal('invalid_request', error.message)
            throw new Refusal('unavailable')
          }
        } finally { peer.preview = false }
      }
      case 'attachment-content': {
        // Up to about 14 MB of base64: one at a time per peer, on the same guard as a preview.
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try {
          const content = await service.attachmentContent?.(request.digest) ?? null
          return content && { mimeType: content.mimeType, data: Buffer.from(content.bytes).toString('base64') }
        } finally { peer.preview = false }
      }
      // Only the client that started a sign-in reads it, sends its code or cancels it (ADR-0037).
      case 'sign-in-start': return signingIn(peer, request.op, () => signIns!.start(request.provider, peer.client.clientId))
      case 'sign-in-read': return signingIn(peer, request.op, () => signIns!.read(request.signInId, peer.client.clientId))
      case 'sign-in-code': return signingIn(peer, request.op, () => signIns!.code(request.signInId, peer.client.clientId, request.code))
      case 'sign-in-cancel': return signingIn(peer, request.op, () => { signIns!.cancel(request.signInId, peer.client.clientId); return null })
      case 'opencode-sign-in': return opencodeCall(peer, request.op, request.call)
      case 'preview':
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try { return await service.attachmentPreview?.(request.request) ?? null } finally { peer.preview = false }
      // A picture an activity record names (ADR-0170), on the same one-at-a-time guard as a preview: one large frame a socket.
      case 'thread-media':
        if (!offers(peer, 'thread-media') || !service.threadMedia) throw new Refusal('invalid_request')
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try { return await service.threadMedia(request.request) } finally { peer.preview = false }
      // A part of a sent file, on the socket's one-at-a-time guard as a preview is, and one at a time for the paired client
      // across all its sockets (ADR-0131, October 25 amendment).
      case 'attachment-file': {
        if (!offers(peer, 'attachment-files') || !service.attachmentFile) throw new Refusal('invalid_request')
        const clientId = peer.client.clientId
        if (peer.preview || fileReads.has(clientId)) throw new Refusal('busy')
        peer.preview = true; fileReads.add(clientId)
        try { return await service.attachmentFile(request.request) } finally { peer.preview = false; fileReads.delete(clientId) }
      }
    }
  }
  const onMessage = (peer: Peer, text: string): void => {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { peer.frames.close(); return }
    const parsed = hostRequestSchema.safeParse(raw)
    const envelope = parsed.success ? parsed.data : hostRequestEnvelopeSchema.safeParse(raw).data
    if (!envelope) { peer.frames.close(); return }
    const now = Date.now()
    // An unreadable request still spends the message budget, so a client cannot loop on one for free.
    let wait = 0
    if (parsed.success && parsed.data.op === 'events') {
      if (now >= peer.pageWindow + 1000) { peer.pageWindow = now; peer.pages = 0 }
      if (peer.pages >= EVENT_PAGES_PER_SECOND) { peer.pageWindow += 1000; peer.pages = 0 }
      peer.pages++; wait = peer.pageWindow - now
    } else {
      if (now - peer.window > 1000) { peer.window = now; peer.count = 0 }
      if (++peer.count > MESSAGES_PER_SECOND) { peer.frames.close(); return }
    }
    if (peer.inFlight >= 32) { peer.frames.close(); return }
    // A request from this session that the host cannot read, such as a client of a newer Sotto version
    // sending an operation or field this one does not know, is refused by its id rather than by closing
    // the socket: the client can then say what happened instead of reconnecting into the same refusal.
    if (!parsed.success) {
      if (envelope.session !== peer.session || !authenticated(peer)) { peer.frames.close(); return }
      peer.frames.send({ v: 1, id: envelope.id, ok: false, error: { code: 'invalid_request', message: errors.invalid_request } }); return
    }
    const request = parsed.data
    peer.inFlight++
    track((async () => {
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      let response: HostResponse
      // The shell a hello, a shell read or a command answers with is encoded for this peer only here, just before it
      // is written, so what this connection was sent of the model catalog follows the order its frames go out in.
      let carried: WireShell | null = null
      try {
        let result = await dispatch(peer, request)
        if (request.op === 'hello') {
          // Hello starts the client's picture afresh, so it carries the catalog whole whatever this connection was sent before.
          const hello = result as { shell: HostClientShell }
          peer.catalogSent = null; carried = wireShell(peer, hello.shell); result = { ...hello, shell: carried.state }
        } else if (request.op === 'shell' || request.op === 'command') { carried = wireShell(peer, result as HostClientShell); result = carried.state }
        response = { v: 1, id: request.id, ok: true, result }
      }
      catch (error) {
        // Keep stack frames for diagnosis; error messages can contain provider bodies or received values.
        if (!(error instanceof Refusal)) console.error('socket-dispatch-failed', request.op, error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n') : 'Non-Error exception')
        const code = error instanceof Refusal ? error.code : 'unavailable'; response = { v: 1, id: request.id, ok: false, error: { code, message: error instanceof Refusal ? error.message : errors[code], ...error instanceof Refusal && error.reason ? { reason: error.reason } : {} } }
      }
      // An answer that carries a shell gives the client a picture of its own, so the next shell push goes whatever it repeats.
      // So does one that carries Watcher's page: a phone shows the page it was answered with until a shell replaces it.
      if (carried || request.op.startsWith('watcher-phone-')) peer.shellSent = null
      // A revocation while an operation was pending also denies its response.
      if (!authenticated(peer)) { peer.frames.send({ v: 1, id: request.id, ok: false, error: { code: 'unauthenticated', message: errors.unauthenticated } }); peer.frames.close() }
      else if (deliver(peer, response, request.op === 'detail' ? 'thread' : request.op === 'activity-body' ? 'body' : request.op === 'preview' || request.op === 'thread-media' || request.op === 'attachment-content' || request.op === 'attachment-file' ? 'preview' : TOOL_READS.has(request.op) ? 'tool' : 'list')) {
        if (carried) recordCatalog(peer, carried)
        if (!response.ok) return
        if (request.op === 'detail') {
          // A thread read whole is held at that revision, and the deltas that follow it apply.
          const read = response.result as AgentThreadDetail | null
          if (read && peer.observed.has(request.threadId) && !peer.opening.has(request.threadId)) peer.held.set(request.threadId, read.revision)
        } else if (request.op === 'hello' || (request.op === 'events' && !request.threadId)) {
          if (request.op === 'hello') peer.ready = true
          // The queue as it stands follows the hello's answer; each change follows it.
          if (request.op === 'hello' && peer.checkQueueViews) pushChecks(peer)
          const latestSeq = (response.result as { latestSeq: number }).latestSeq
          peer.afterSeq = peer.afterSeq === Number.MAX_SAFE_INTEGER ? latestSeq : Math.max(peer.afterSeq, latestSeq)
        } else if (request.op === 'next-prompts-wanted') {
          // Every next prompt held now follows the answer that turned them on; each change follows it.
          pushNextPrompts(peer)
        }
      }
      // A restart that went ahead waits for its own answer to be on the way before it stops this host (ADR-0088), whether or
      // not the answer could go. Only one restart runs at a time, so its answer is the only update-restarting there is.
      if (request.op === 'host-update' && request.action === 'restart' && response.ok && (response.result as { type?: unknown }).type === 'update-restarting') {
        await peer.frames.drained().finally(() => options.hostUpdate?.delivered())
      }
    })().finally(() => { peer.inFlight-- }))
  }
  const bearer = (request: IncomingMessage): string => /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const body = async (request: IncomingMessage): Promise<unknown> => {
    let size = 0; const chunks: Buffer[] = []
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8192) throw new Refusal('invalid_request'); chunks.push(bytes) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Refusal('invalid_request') }
  }
  const respond = (response: ServerResponse, status: number, result: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)) }
  /** What health and hello say about the host, each only when there is something to say. */
  const about = (): HostAbout => {
    const value = options.about?.() ?? {}
    return { ...(value.tailnetAddress ? { tailnetAddress: value.tailnetAddress } : {}), ...(value.startedBy ? { startedBy: value.startedBy } : {}) }
  }
  /** Revoking a client here closes its sockets at once, then tells the host. */
  const revoked = (clientId: string): void => {
    for (const peer of peers) if (!authenticated(peer)) peer.frames.close()
    options.onRevoked?.(clientId)
  }
  const server = createServer((request, response) => {
    track((async () => {
      try {
        if (closing) throw new Refusal('unavailable')
        // A question's page (ADR-0085) is opened by its token alone, in a browser that holds no session, and its own
        // requests carry the page's origin; the token is the only thing that admits them, and only to that page.
        if (QUESTION_PAGE_PATH.test((request.url ?? '').split('?')[0]!)) {
          spend('page', HTTP_BUDGETS.page)
          await serveQuestionPage(request, response, { target: token => service.questionPage?.(token), ownPort: () => { const own = server.address(); return own && typeof own !== 'string' ? own.port : undefined },
            opened: token => service.questionPageOpened?.(token) })
          return
        }
        if (request.headers.origin && !originAllowed(request.headers.origin, options.origins)) throw new Refusal('unauthenticated')
        if (request.method === 'GET' && request.url === '/v1/health') { const name = options.name?.()?.trim(); respond(response, 200, { ...descriptor, ...about(), status: 'ready', ...(name ? { name } : {}) }); return }
        if (request.method !== 'POST') throw new Refusal('invalid_request')
        if (request.url?.startsWith('/v1/admin/')) {
          if (options.admin === false) throw new Refusal('invalid_request')
          const token = Buffer.from(bearer(request)), expected = Buffer.from(adminToken)
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Refusal('unauthenticated')
          spend('admin', HTTP_BUDGETS.admin)
          if (request.url === '/v1/admin/pairing-code') { respond(response, 200, { v: 1, hostId, ...pairing.issuePairingCode() }); return }
          if (request.url === '/v1/admin/phones' || request.url === '/v1/admin/phones-command') {
            if (!options.phones) throw new Refusal('invalid_request')
            if (request.url === '/v1/admin/phones') { adminPhonesRequest.parse(await body(request)); respond(response, 200, { v: 1, hostId, state: options.phones.get() }); return }
            const { command } = adminPhonesCommandRequest.parse(await body(request))
            respond(response, 200, { v: 1, hostId, ...await options.phones.command(command) }); return
          }
          // Only here, on the listener the tailnet never reaches: a desktop turns its tailnet connections on or off over SSH.
          if (request.url === '/v1/admin/tailnet') {
            if (!options.phones) throw new Refusal('invalid_request')
            const input = adminTailnetRequest.parse(await body(request))
            respond(response, 200, { v: 1, hostId, ...await options.phones.tailnet(input) }); return
          }
          const input = adminClientRequest.parse(await body(request))
          if (request.url === '/v1/admin/revoke-client') { const wasPaired = await pairing.revoke(input.clientId); revoked(input.clientId); respond(response, 200, { v: 1, hostId, revoked: wasPaired }); return }
          else if (request.url === '/v1/admin/allow-answers' || request.url === '/v1/admin/deny-answers') {
            if (!pairing.list().some(client => client.clientId === input.clientId) || !options.setAnswers) throw new Refusal('invalid_request')
            options.setAnswers(input.clientId, request.url.endsWith('/allow-answers'))
            shellPublisher.publish(service.shell())
          } else throw new Refusal('invalid_request')
          respond(response, 200, { v: 1, hostId, ok: true }); return
        }
        if (request.url === '/v1/pair') {
          // A desktop never pairs here (ADR-0053), so with phones off nobody may.
          if (tailnet && !tailnet.phonesAdmitted()) throw new Refusal('forbidden', phonesOffMessage())
          const input = pairRequest.parse(await body(request))
          // This listener binds only loopback. Serve replaces this header with the device address;
          // direct connections use loopback's budget. Neither address grants client authority.
          const forwarded = request.headers['x-forwarded-for']
          const address = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? 'loopback'
          const refund = spend('pair:' + address, HTTP_BUDGETS.pair)
          let paired: Awaited<ReturnType<PairedClients['redeem']>>
          try { paired = await pairing.redeem(input.code, input.name) } catch { throw new Refusal('unauthenticated') }
          refund()
          respond(response, 200, { v: 1, hostId, ...paired }); options.onPaired?.(paired.clientId); return
        }
        if (request.url === '/v1/revoke') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          spend('client:' + clientId, HTTP_BUDGETS.client)
          const wasPaired = await pairing.revoke(clientId)
          revoked(clientId)
          respond(response, 200, { v: 1, hostId, revoked: wasPaired }); options.onPeersChanged?.(); return
        }
        if (request.url === '/v1/session') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          spend('client:' + clientId, HTTP_BUDGETS.client)
          if (tailnet && !tailnet.phonesAdmitted()) {
            await tailnet.desktops.refresh().catch(() => undefined)
            if (!admits(clientId)) throw new Refusal('forbidden', phonesOffMessage())
          }
          const at = Date.now()
          respond(response, 200, { v: 1, hostId, clientId, session: pairing.signSession(clientId, at), expiresAt: new Date(at + SESSION_LIFETIME_MS).toISOString() }); return
        }
        throw new Refusal('invalid_request')
      } catch (error) {
        const code = error instanceof Refusal ? error.code : 'invalid_request'
        const message = code === 'busy' ? HOST_BUSY : error instanceof Refusal ? error.message : errors[code]
        respond(response, code === 'unauthenticated' ? 401 : code === 'forbidden' ? 403 : code === 'busy' ? 429 : 400, { v: 1, error: { code, message } })
      }
    })())
  })
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000
  const refuse = (stream: Duplex, status: string): void => { stream.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n') }
  /** Opens a socket the upgrade was checked for: the session is valid and the listener admits its client. */
  const open = (stream: Duplex, head: Buffer, session: string, clientId: string, key: string, offered: boolean): void => {
    if (closing || peers.size >= 32) { refuse(stream, '503 Service Unavailable'); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const deflate = offered && compresses(clientId)
    stream.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n' + (deflate ? 'Sec-WebSocket-Extensions: ' + DEFLATE_RESPONSE + '\r\n' : '') + '\r\n')
    const frames = new SocketFrames(stream, false, text => onMessage(peer, text), { deflate })
    const peer: Peer = { unknownProviders: providersUnknownTo(undefined), hostUpdate: false, delegationViews: false, retiredTerminals: false, gone: new AbortController(), usageHistory: false, usageMuseOpenCode: false, watcherPhone: false, watcherPhoneStop: false, watcherPhoneManage: false, watcherPhoneSteer: false, watcherPhoneMachines: false, watcherPhoneComposer: false, watcherReads: false, desktop: isDesktop(clientId), frames, client: identity(clientId), session, observed: new Set(), shown: true, held: new Map(), opening: new Set(), sentAhead: new WeakSet<AgentThreadDetail>(), inFlight: 0, window: Date.now(), count: 0, pageWindow: 0, pages: 0, preview: false, ready: false, afterSeq: Number.MAX_SAFE_INTEGER, selectedThreadId: null, selectedProjectId: null, editingThreadId: null, messageAliases: false, deltas: false, clientUpdates: false, clientUpdateNotListed: false, activitySummaries: false, activityBodies: false, catalogRevisions: false, catalogSent: null, shellSent: null, answerReceipts: false, answerWatches: new Map(), threadRecords: undefined }
    peers.add(peer)
    frames.startHeartbeat()
    frames.onClose(() => { peer.gone.abort(); peer.answerWatches.clear(); peers.delete(peer); writingHeld.delete(peer); if (peer.delegationRelay) options.delegationRelay?.desktopGone(peer.delegationRelay); if (peer.delegationRemote) options.delegationRemote?.desktopGone(peer.delegationRemote); if (!connected(peer.client.clientId)) uploads.drop(peer.client.clientId); if (!closing) { track(observe().catch(() => undefined)); options.onPeersChanged?.() } })
    frames.feed(head)
    options.onPeersChanged?.()
  }
  server.on('upgrade', (request, stream: Duplex, head: Buffer) => {
    stream.on('error', () => stream.destroy())
    const session = bearer(request), clientId = pairing.verifySession(session)
    const key = request.headers['sec-websocket-key']
    if (request.url !== '/v1/socket' || !clientId || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || (request.headers.origin && !originAllowed(request.headers.origin, options.origins))) { refuse(stream, '401 Unauthorized'); return }
    const offered = deflateOffered(request.headers['sec-websocket-extensions'])
    // Compression is settled at the upgrade or not at all, so a client offering it that this listener does not know as a
    // desktop has the record read again first: the launch script may have recorded it since the last read.
    if (admits(clientId) && !(offered && tailnet && !isDesktop(clientId))) { open(stream, head, session, clientId, key, offered); return }
    if (!tailnet) { refuse(stream, '403 Forbidden'); return }
    // A desktop the launch script recorded since this listener last read the record is let in; anyone else is not.
    void tailnet.desktops.refresh().catch(() => undefined).then(() => { if (admits(clientId)) open(stream, head, session, clientId, key, offered); else refuse(stream, '403 Forbidden') })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  server.on('error', () => { console.error('host_listener_error') })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The host listener did not receive a loopback port.')
  // The descriptor is also the body of /v1/health: a client reads the host's Sotto version and features
  // there before it opens a session, so it never has to find out what the host supports by trying it.
  const descriptor: HostDescriptor = { v: 1, hostId, pid: process.pid, port: address.port, sottoVersion, features: [...features] }
  // While this listener serves Watcher's phone page, it says whether a phone that queued a follow-up for Watcher is still
  // paired and admitted, so the follow-up goes under that phone's guard as its own send would (#1229).
  const releasePhoneAdmission = features.includes('watcher-phone')
    ? service.watcherPhone?.useAdmission(clientId => pairing.isPaired(clientId) && admits(clientId)) : undefined
  /** Closes every socket whose session ended, and every phone's while phones are not admitted. */
  const dropRefused = (): void => { for (const peer of peers) if (!authenticated(peer) || !admits(peer.client.clientId)) peer.frames.close() }
  const expiry = setInterval(dropRefused, 1000)
  expiry.unref()
  const stopServing = (): void => {
    if (closing) return
    closing = true; clearInterval(expiry); unsubscribe(); unsubscribeDetails?.(); unsubscribeDelegations?.(); unsubscribeChecks?.(); unsubscribeNextPrompts?.(); releasePhoneAdmission?.(); shellPublisher.dispose(); detailPublisher.dispose(); waiting.clear()
    if (writingTimer) clearTimeout(writingTimer.timer)
    writingHeld.clear()
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    server.removeAllListeners('connection')
    server.on('connection', socket => socket.destroy())
    server.unref()
    // A closing peer no longer clears its threads from this listener's observations, so they are cleared here, or the
    // host would keep them loaded and shown with nobody watching (ADR-0046).
    const observing = [...peers].some(peer => peer.observed.size > 0)
    for (const peer of peers) peer.frames.close()
    server.closeAllConnections()
    if (observing) track(service.command({ type: 'observe-threads', threadIds: [] }, { clientId: observationKey, user: '', transport: 'socket' }).catch(() => undefined))
  }
  return {
    descriptor, adminToken,
    /** Ends the host protocol while reserving its loopback port for pending cleanup. */
    stopServing,
    /** How many paired clients hold an open socket: the host's measure of a window being in front. */
    peers: (): number => peers.size,
    /** Whether a connected desktop wants this host's next prompts now (ADR-0173): until one does, no provider is asked for them. */
    nextPromptsWanted: (): boolean => [...peers].some(peer => peer.ready && peer.nextPrompts?.wanted === true && !peer.frames.isClosed),
    /** The paired clients holding an open socket now, each once. */
    connectedClients: (): string[] => [...new Set([...peers].map(peer => peer.client.clientId))],
    /**
     * Closes at once every socket whose client is no longer paired, after a revocation made outside this listener, and
     * every phone's while phones are not admitted, after phone access turned off with the listener staying up.
     */
    dropRevoked: dropRefused,
    close: async (): Promise<void> => {
      stopServing()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await Promise.allSettled([...operations]); await pairing.settled()
    },
  }
}
