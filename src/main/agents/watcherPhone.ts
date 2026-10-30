import type { AgentAttachmentPreviewResult, AgentCommand, AgentThread } from '../../shared/agents'
import { WATCHER_PHONE_FOLLOWUPS_MAX, WATCHER_PHONE_LEGACY_LIMIT, WATCHER_PHONE_TAKEOVERS_MAX, watcherPhoneStateSchema, type WatcherPhoneState, type WatcherPhoneSend, type WatcherPhoneResult,
  type WatcherPhoneSendResult, type WatcherPhonePrepareStopResult, type WatcherPhoneStopResult, type WatcherPhoneRemoveFollowup, type WatcherPhonePreview } from '../../shared/watcherPhone'
import type { WatcherRefusal } from '../../shared/watcher'
import { WATCHER_PHONE_MACHINE_THREADS_MAX, watcherPhoneMachinesSchema, type WatcherPhoneMachines } from '../../shared/watcherPhone'
import { machineEntries, systemWords, unknownWhy } from '../../shared/machineLine'
import { THIS_COMPUTER, countMachineWorkingThreads } from '../../shared/workingThreads'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import type { WatcherCommandOrigin } from './watcherCommands'
import { watcherRefusal, type WatcherService } from './watcher'
import type { AgentControl } from './control'
import type { ClientIdentity } from './hostService'
import { isWatchedRow, takesPartInActiveRequest, watcherTakeovers, type WatcherRoomState, type WatcherSetPermissionRequest, type WatcherTakeover, type WatcherWatchThreadRequest } from '../../shared/watcherRoom'
import type { WatcherOperation, WatcherRequest } from '../../shared/watcher'

/** The phone page's receipt and takeover caps: the newest of each, as protocol version 1 carries them. */
const PHONE_RECEIPTS_MAX = 500
/** What a read back of Watcher's archive gives the phone (#1759), worked out once for each read back. */
interface PhoneRecalled { readonly from: NonNullable<WatcherRoomState['recalled']>; readonly requests: ReadonlyMap<string, WatcherRequest>
  /** Its receipts oldest first, as the room's own run: a read back gives its batches newest first. */
  readonly receipts: readonly WatcherOperation[]
  /** Its takeover lines, which are the current Watcher's, so they are worked out again for another Watcher alone. */
  takeovers?: { readonly watcher: string; readonly lines: readonly WatcherTakeover[] } }

/**
 * Whether a coordinator refusal is plain words a phone may show as they are: short, and with nothing technical in it, such
 * as an error code, a system call or a path (#1229). Anything else is said in the phone's own fixed words.
 */
function plainWords(text: string): boolean {
  return text.length <= 500 && !/\bE[A-Z]{3,}\b|\berrno\b|\bsyscall\b|^\w*Error\b|[A-Za-z]:[\\/]|(?:^|\s)\/[\w.-]+\/|\\[\w.-]+\\/u.test(text)
}
/** A phone reads the room, never the persisted control record or the desktop's aggregate shell. */
export class WatcherPhoneService {
  /** `machinesOn`: Work across machines is on, read once at start, so a phone may be shown the machines line (#1032). */
  constructor(private readonly control: AgentControl, private readonly watcher: WatcherService, private readonly machinesOn = false) {}
  private recalledFor: PhoneRecalled | undefined
  /** The read back of Watcher's archive the room carries, indexed once for it, or undefined while there is none. */
  private recalled(room: WatcherRoomState): PhoneRecalled | undefined {
    const from = room.recalled
    if (!from) return undefined
    if (this.recalledFor?.from === from) return this.recalledFor
    const receipts = from.receipts.map((operation, at) => ({ operation, at, time: Date.parse(operation.createdAt) }))
      .sort((a, b) => a.time - b.time || a.at - b.at).map(item => item.operation)
    this.recalledFor = { from, receipts, requests: new Map(from.requests.map(request => [request.id, request] as const)) }
    return this.recalledFor
  }
  /** The read back's takeover lines for the current Watcher, worked out once for each read back and Watcher. */
  private recalledTakeovers(room: WatcherRoomState): readonly WatcherTakeover[] | undefined {
    const recalled = this.recalled(room)
    if (!recalled) return undefined
    const watcher = room.current ? `${room.current.target.hostId}\n${room.current.target.threadId}` : ''
    if (recalled.takeovers?.watcher !== watcher) recalled.takeovers = { watcher, lines: watcherTakeovers({ current: room.current, requests: recalled.from.requests }) }
    return recalled.takeovers.lines
  }
  /**
   * The phone's receipts, newest last and at most PHONE_RECEIPTS_MAX, with the request each answers to: the room's own,
   * and before them, while there is room under the cap, the newest of what Watcher's conversation shown back recalled
   * (#1759), the room's winning. What it reads of the read back is bounded by the cap, however much was read back.
   */
  private phoneReceipts(room: WatcherRoomState): { receipts: readonly WatcherOperation[]; request: (id: string) => WatcherRequest | undefined } {
    const live = room.receipts.slice(-PHONE_RECEIPTS_MAX)
    const recalled = this.recalled(room)
    const ownRequest = (id: string): WatcherRequest | undefined => room.requests.find(row => row.id === id)
    if (!recalled || live.length >= PHONE_RECEIPTS_MAX) return { receipts: live, request: ownRequest }
    const own = new Set(live.map(operation => operation.id)), older: WatcherOperation[] = []
    const list = recalled.receipts
    for (let index = list.length - 1; index >= 0 && older.length + live.length < PHONE_RECEIPTS_MAX; index--) if (!own.has(list[index]!.id)) older.push(list[index]!)
    return { receipts: [...older.reverse(), ...live], request: id => ownRequest(id) ?? recalled.requests.get(id) }
  }
  /** Whether a phone may be offered the machines line: only with Work across machines on (#1032). */
  get offersMachines(): boolean { return this.machinesOn }
  /** Reads every machine afresh, for a phone whose user opened a machine's numbers or whose Watcher placed work. */
  async readMachines(): Promise<void> { if (this.machinesOn) await this.watcher.machines() }
  /**
   * The machines line for a phone (#1032): each machine as the desktop's line counts it, with its load as last read and,
   * for its panel, what the desktop's panel says. Threads are counted from each machine's own list, read in place.
   */
  machines(): WatcherPhoneMachines {
    const listed = this.watcher.lastMachines(), localId = this.control.hostId()
    const paired = this.watcher.pairedMachines()
    const working = new Map<string, number>([[THIS_COMPUTER, countMachineWorkingThreads(this.watcher.machineThreads(localId ?? ''))]])
    for (const host of paired) working.set(host.hostId, countMachineWorkingThreads(this.watcher.machineThreads(host.hostId)))
    const entries = machineEntries(listed?.machines ?? null, working, listed?.newWorkersStart, paired)
    const now = Date.now()
    const rows = entries.map(entry => {
      const hostId = entry.thisComputer ? localId ?? entry.hostId : entry.hostId
      const machine = entry.machine, load = machine?.load ?? null
      const threads: WatcherPhoneMachines['rows'][number]['threads'] = []
      if (entry.connected) {
        const list = this.watcher.machineThreads(hostId)
        for (const thread of list) {
          if (threads.length >= WATCHER_PHONE_MACHINE_THREADS_MAX) break
          if (thread.kind === 'watcher' || thread.kind === 'watcher-history' || !isThreadTurnRunning(thread)) continue
          // Who started each thread shown comes from an index of Watcher's record, not a walk of its history.
          const who = this.watcher.startedByWatcher(hostId, thread.id) ? 'Watcher'
            : thread.delegatedBy !== undefined ? `delegated by ${list.find(row => row.id === thread.delegatedBy)?.title ?? 'another thread'}` : 'your thread'
          threads.push({ title: thread.title, who })
        }
      }
      return { hostId, name: entry.name, thisComputer: entry.thisComputer, connected: entry.connected, working: entry.working, starting: entry.starting,
        isDefault: entry.isDefault, cpuState: machine === null ? null : machine.cpuState ?? 'unknown', memoryState: machine === null ? null : machine.memoryState ?? 'unknown',
        system: machine === null ? null : systemWords(machine), logicalCpuCount: machine?.facts?.logicalCpuCount ?? null, totalMemoryBytes: machine?.facts?.totalMemoryBytes ?? null,
        cpuBusyPercent: load?.cpuBusyPercent ?? null, windowMs: load?.windowMs ?? null, availableMemoryBytes: load?.availableMemoryBytes ?? null,
        loadObservedAt: load?.observedAt ?? null, unknownWhy: unknownWhy(entry, now), threads }
    })
    return watcherPhoneMachinesSchema.parse({ readAt: listed?.observedAt ?? null, rows })
  }
  /**
   * `standing`: whether this phone negotiated Watcher management, and with it knows standing watches. `steer`: whether it
   * negotiated steering, and with it is shown whether Watcher's provider steers and the follow-ups waiting for Watcher (#1229).
   */
  state(mayAnswer: boolean, standing = true, steer = false): WatcherPhoneState {
    const room = this.watcher.state(), snapshot = this.watcher.phoneSnapshot(), starts = this.watcher.startsInFlight()
    const thread = (target: { hostId: string; threadId: string }): AgentThread | undefined => snapshot.threads.find(row =>
      (row.hostId ?? snapshot.hostId) === target.hostId && row.id === target.threadId)
    const current = room.current && thread(room.current.target)
    const detail = current ? this.control.threadDetail(current.id) : null
    // The coordinator's detail already shows Watcher's messages as typed: an older one's routing footer is off it.
    // A message's photos go as the detail marks them, with no bytes: the phone asks for each through `preview` below.
    const messages = (detail?.messages ?? []).slice(-200).map(message => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}) }))
    const receiptGroups: WatcherPhoneState['receiptGroups'] = []
    const shown = this.phoneReceipts(room)
    for (const operation of shown.receipts) {
      const request = shown.request(operation.requestId)
      if (!request || request.watcher.threadId !== room.current?.target.threadId) continue
      // Use the retained conversation's actual assistant message at this operation's time. Missing history
      // stays an unattached receipt; a root user-message reference is never presented as an assistant reply.
      const rootIndex = messages.findIndex(message => message.id === request.rootUserMessageId)
      const tail = rootIndex < 0 ? [] : messages.slice(rootIndex + 1)
      const nextUser = tail.findIndex(message => message.role === 'user' && message.createdAt > operation.createdAt)
      const window = nextUser < 0 ? tail : tail.slice(0, nextUser)
      const lastUser = window.findLastIndex(message => message.role === 'user')
      const replies = window.slice(lastUser + 1).filter(message => message.role === 'assistant')
      const reply = replies.findLast(message => message.createdAt <= operation.createdAt)
        ?? replies.find(message => message.createdAt >= operation.createdAt)
      const replyMessageId = reply?.id ?? null
      let group = receiptGroups.find(row => row.requestId === request.id && row.replyMessageId === replyMessageId)
      if (!group) { group = { requestId: request.id, replyMessageId, rows: [] }; receiptGroups.push(group) }
      const worker = thread(operation.target)
      const previousRow = group.rows.findIndex(row => row.target.hostId === operation.target.hostId && row.target.threadId === operation.target.threadId)
      if (previousRow >= 0) group.rows.splice(previousRow, 1)
      group.rows.push({ operationId: operation.id, target: operation.target, title: worker?.title ?? 'Unavailable thread',
        provider: worker?.providerId ?? null, action: operation.action, deliveryState: operation.deliveryState,
        createdAt: operation.createdAt, updatedAt: operation.updatedAt,
        ...(operation.delivery ? { delivery: operation.delivery } : {}), ...(operation.refusalCode ? { refusalCode: operation.refusalCode } : {}),
        ...(operation.outcome ? { outcome: operation.outcome } : {}) })
    }
    // Main's own mark, as the room and the Threads page read it: a standing watch, or taking part in an active request.
    // A phone from before standing watches says a send there takes the thread over, which holds only for a thread watched
    // for a request alone: it is shown those, watched as it always counted them, and nothing of standing watches. A thread
    // under a standing watch is left off its page rather than called watched or no longer watched.
    const own = room.current
    const activeRequests = new Set(room.requests.filter(request => request.state === 'active' && own !== null
      && request.watcher.hostId === own.target.hostId && request.watcher.threadId === own.target.threadId).map(request => request.id))
    const rows = standing ? room.watchedThreads : room.watchedThreads.filter(row => row.participation.length > 0
      && !room.standingWatches?.some(watch => watch.target.hostId === row.target.hostId && watch.target.threadId === row.target.threadId))
    const watched = (row: typeof rows[number]): boolean => standing ? isWatchedRow(row, room.requests) : takesPartInActiveRequest(row.participation, activeRequests)
    const watchedThreads = rows.map(row => ({ target: row.target, title: row.title,
      provider: thread(row.target)?.providerId ?? null, status: row.status, connected: row.connected,
      watched: watched(row), ...(standing ? { paused: row.paused } : {}),
      takenOver: row.participation.some(part => part.state === 'taken-over'), backgroundWorkCount: row.backgroundWorkCount }))
    const targets = [...rows.filter(watched).map(row => row.target), ...own ? [own.target] : []]
    const needsYou = targets.flatMap(target => {
      const owner = thread(target), connected = Boolean(owner?.clientConnected)
      return (owner?.requests ?? []).map(request => ({ target, title: owner!.title, provider: owner?.providerId ?? null,
        // The provider's own display card, with no tool-call identity or undisplayed retry marker.
        request: { id: request.id, kind: request.kind, text: request.text, options: request.options,
          ...(request.questions ? { questions: request.questions.map(question => ({ ...question, options: question.options.map(({ preview: _preview, ...option }) => { void _preview; return option }) })) } : {}),
          ...(request.permissionChoices ? { permissionChoices: request.permissionChoices } : {}),
          ...(request.context ? { context: { toolName: request.context.toolName, command: request.context.command,
            cwd: request.context.cwd, details: request.context.details } } : {}), ...(request.delivery ? { delivery: request.delivery } : {}) },
        connected, mayAnswer: mayAnswer && connected && target.hostId === snapshot.hostId }))
    })
    return watcherPhoneStateSchema.parse({ hostId: this.control.hostId()!, current: room.current && room.currentOptions ? {
      target: room.current.target, provider: room.current.provider, ...room.currentOptions,
      ...(steer ? { steers: current ? this.control.watcherPhoneTurn(current.id).steers : false } : {}) } : null,
    conversation: { messages, revision: detail?.revision ?? 0, earlierAvailable: Boolean(detail?.earlierAvailable || (detail?.messages.length ?? 0) > messages.length) },
    // The deliveries alone, read without copying every thread: this runs for each phone on every update.
    draftDeliveries: this.control.watcherSendRecords().deliveries.filter(row => row.threadId === current?.id).map(row => ({ draftId: row.draftId, status: row.status })),
    runtimeMode: room.runtimeMode, ...(standing ? { standingWatches: room.standingWatches } : {}), ownChanges: room.ownChanges,
    // Host protocol version 1 requires a count and a limit of one to eight. The limit is gone (#1183): an iPhone that
    // negotiated Watcher management shows neither, and an older one draws them as "3 of 8 watched" and how many more
    // can start. It is sent the highest limit it accepts and the true count up to one below it, so its meter stays right
    // for seven or fewer and never says Watcher starts nothing new.
    receiptGroups, watchedThreads, needsYou, inFlight: Math.min(starts, WATCHER_PHONE_LEGACY_LIMIT - 1), inFlightLimit: WATCHER_PHONE_LEGACY_LIMIT,
    takeovers: this.takeovers(room, snapshot),
    // What goes next, after Watcher's turn: the user's own follow-ups, read from the queue without copying it (#1229).
    ...(steer ? { followups: (current ? this.control.watcherFollowups(current.id) : []).slice(0, WATCHER_PHONE_FOLLOWUPS_MAX)
      .map(item => ({ itemId: item.id, draftId: item.draftId, text: item.text, status: item.status })) } : {}),
    // Watcher working is its own turn, a news turn included, as the desktop shows it. A thread it started says its own
    // status under Watched: counted here, a few long-running workers kept the phone saying Working while Watcher was idle.
    working: room.currentOptions?.status === 'running', recoveryNotice: room.recoveryNotice, observedAt: room.observedAt })
  }
  /** The newest takeover lines, as many as the page carries receipts, each titled from one index of the threads. */
  private takeovers(room: ReturnType<WatcherService['state']>, snapshot: ReturnType<WatcherService['phoneSnapshot']>): NonNullable<WatcherPhoneState['takeovers']> {
    let lines = watcherTakeovers(room).slice(-WATCHER_PHONE_TAKEOVERS_MAX)
    // Takeover lines Watcher's conversation shown back recalled (#1759), oldest, while there is room under the cap; a line
    // the room carries too goes once. Bounded by the cap, however much was read back.
    const recalled = this.recalledTakeovers(room)
    if (recalled?.length && lines.length < WATCHER_PHONE_TAKEOVERS_MAX) {
      const lineKey = (line: WatcherTakeover): string => `${line.target.hostId}\n${line.target.threadId}\n${line.at}`
      const own = new Set(lines.map(lineKey)), older: WatcherTakeover[] = []
      for (let index = recalled.length - 1; index >= 0 && older.length + lines.length < WATCHER_PHONE_TAKEOVERS_MAX; index--) if (!own.has(lineKey(recalled[index]!))) older.push(recalled[index]!)
      lines = [...older.reverse(), ...lines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    }
    if (lines.length === 0) return []
    const titles = new Map(snapshot.threads.map(row => [JSON.stringify([row.hostId ?? snapshot.hostId, row.id]), row.title] as const))
    return lines.map(line => ({ target: line.target, title: titles.get(JSON.stringify([line.target.hostId, line.target.threadId])) ?? 'Unavailable thread', at: line.at }))
  }
  async send(request: WatcherPhoneSend, client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, standing = true, steer = false): Promise<WatcherPhoneSendResult> {
    if (request.origin.clientId !== client.clientId || request.origin.hostId !== this.control.hostId() || client.transport !== 'socket') {
      return watcherRefusal('INVALID_INPUT', 'This instruction does not belong to this phone and computer. Nothing was sent.')
    }
    const threadId = request.target.threadId
    const check = () => {
      guard()
      const current = this.watcher.state().current
      if (!current || current.target.hostId !== request.target.hostId || current.target.threadId !== threadId
        || !this.watcher.isCurrent(threadId)) throw new Error('Watcher changed. Nothing was sent. Refresh Watcher before sending again.')
      this.watcher.guardPhoneSend(threadId)
    }
    const origin: WatcherCommandOrigin = { phoneOrigin: request.origin, guard: check }
    const phone = { ...client, selectedThreadId: threadId }
    const sent = (): WatcherPhoneSendResult => ({ status: 'ok', draftId: request.draftId, state: this.state(mayAnswer(), standing, steer) })
    // A phone that negotiated steering steers into Watcher's running turn, or queues the message to go next (#1229).
    const steers = request.delivery === 'steer'
    const waitingOnCard = () => Boolean(this.control.watcherSnapshot().threads.find(row => row.id === threadId)?.requests.length)
    try {
      check()
      if (waitingOnCard() || (steers && this.control.watcherPhoneTurn(threadId).running)) return await this.whileWorking(request, origin, phone, sent)
      const result = await this.control.commandFromWatcherPhone({ type: 'send', draft: { threadId,
        draftId: request.draftId, text: request.text, attachments: request.images ?? [], binding: { requestId: null, questionsDigest: null } } }, origin, phone)
      if (!result.error) return sent()
      // Watcher began a turn or asked a question between the check and the send, which sent nothing: steer or queue.
      if ((waitingOnCard() || (steers && this.control.watcherPhoneTurn(threadId).running)) && this.control.watcherPhoneDraftUnsent(threadId, request.draftId)) {
        return await this.whileWorking(request, origin, phone, sent)
      }
      return this.refused(result.error, threadId, request.draftId)
    } catch { return watcherRefusal('TARGET_CHANGED', 'Watcher changed or is unavailable. Nothing new was sent. Refresh Watcher and review its request cards.', true) }
  }
  /**
   * The user's message from the phone while Watcher works (#1229, Zach's pick B). It steers into Watcher's running turn,
   * under the desktop's rules (#1188): Watcher's own dispatch joins it to the request that turn answers, or opens one of its
   * own. While a card waits it only queues: a message never answers the card. When Watcher's provider takes no steer,
   * or the steer surely did not go, as when the turn ended first, it goes
   * next as its own turn, from Watcher's queue, and takes a request of its own when it is delivered, as an idle Send
   * would. A steer that may have gone is never queued too: it is refused, unconfirmed, and the page says where it stands.
   */
  private async whileWorking(request: WatcherPhoneSend, origin: WatcherCommandOrigin, client: ClientIdentity,
    sent: () => WatcherPhoneSendResult): Promise<WatcherPhoneSendResult> {
    const { draftId, text } = request, threadId = request.target.threadId
    // The photos go with the words however they go.
    const photos = request.images ? { attachments: request.images } : {}
    const waitingOnCard = this.control.watcherSnapshot().threads.find(row => row.id === threadId)?.requests.length
    if (!waitingOnCard && this.control.watcherPhoneTurn(threadId).steers) {
      const steered = await this.control.commandFromWatcherPhone({ type: 'steer', threadId, draftId, text, ...photos }, origin, client)
      if (!steered.error) return sent()
      if (!this.control.watcherPhoneDraftUnsent(threadId, draftId)) return this.refused(steered.error, threadId, draftId)
    }
    const queued = await this.control.commandFromWatcherPhone({ type: 'queue-followup', threadId, draftId, text, ...photos }, origin, client)
    return queued.error ? this.refused(queued.error, threadId, draftId) : sent()
  }
  /**
   * One photo of a message in the current Watcher's conversation, as `preview` answers for a thread: null for any other
   * Watcher, or a photo Sotto keeps no copy of. Watcher's thread is hidden from the phone's own reads.
   */
  async preview(request: WatcherPhonePreview): Promise<AgentAttachmentPreviewResult> {
    const { hostId, threadId } = request.target
    if (hostId !== this.control.hostId() || !this.watcher.isCurrent(threadId)) return null
    return await this.control.attachmentPreview({ threadId, messageId: request.messageId, attachmentId: request.attachmentId })
  }
  /** Why a phone's message did not go, in words for the phone: never sent twice, and the words stay on the phone. */
  private refused(error: string, threadId: string, draftId: string): WatcherRefusal {
    if (!this.control.watcherPhoneDraftUnsent(threadId, draftId)) {
      return watcherRefusal('DELIVERY_UNCERTAIN', 'Watcher didn’t confirm your message. Check the conversation before you send it again.', true)
    }
    if (this.control.watcherPhoneTurn(threadId).running) {
      return watcherRefusal('THREAD_BUSY', 'Watcher is working, so your message wasn’t sent. Your words are kept on the phone. Send them again when it finishes.', true)
    }
    return watcherRefusal('PROVIDER_UNAVAILABLE', plainWords(error) ? error
      : 'Watcher could not take this instruction. Your text is kept on the phone. Refresh Watcher and check its delivery before trying again.', true)
  }
  /**
   * Takes one of the user's follow-ups out of Watcher's queue before it goes, through the coordinator's own Remove, from
   * the phone that negotiated steering (#1229). One already gone, delivered or removed elsewhere, leaves nothing to do.
   */
  async removeFollowup(request: WatcherPhoneRemoveFollowup, client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, standing = true): Promise<WatcherPhoneResult> {
    const hostId = this.control.hostId()
    if (client.transport !== 'socket' || !hostId) return watcherRefusal('INVALID_INPUT', 'Watcher phone controls need a paired phone connection.')
    const threadId = request.target.threadId
    const check = () => {
      guard()
      const current = this.watcher.state().current
      if (!current || current.target.hostId !== request.target.hostId || current.target.threadId !== threadId
        || !this.watcher.isCurrent(threadId)) throw new Error('Watcher changed. Nothing was removed. Refresh Watcher.')
    }
    const waiting = () => this.control.watcherFollowups(threadId).find(item => item.id === request.itemId)
    try {
      check()
      const item = waiting()
      if (!item) return this.get(mayAnswer(), standing, true)
      if (item.status === 'dispatching' || item.status === 'uncertain') {
        return watcherRefusal('THREAD_BUSY', 'This message is already on its way to Watcher. Nothing was removed.', false)
      }
      const result = await this.control.commandFromWatcherPhone({ type: 'remove-followup', threadId, itemId: request.itemId },
        { phoneOrigin: { kind: 'phone', hostId, clientId: client.clientId }, guard: check }, { ...client, selectedThreadId: threadId })
      // The coordinator's words may be a file system's; the phone is told what became of its message instead.
      if (result.error && waiting()) return watcherRefusal('PROVIDER_UNAVAILABLE', 'Your message wasn’t removed. It’s still waiting for Watcher. Try again.', true)
      return this.get(mayAnswer(), standing, true)
    } catch { return watcherRefusal('TARGET_CHANGED', 'Watcher changed or is unavailable. Nothing was removed. Refresh Watcher.', true) }
  }
  answer(command: Extract<AgentCommand, { type: 'answer' }>, client: ClientIdentity, decisionId: string, guard: () => void) {
    return this.control.answerWatcherPhoneCard(command, client, decisionId, guard)
  }
  prepareStop(client: ClientIdentity): WatcherPhonePrepareStopResult {
    const preview = this.watcher.prepareStopAll(client.clientId)
    if (preview.status === 'refused') return preview
    const state = this.state(false)
    return { ...preview, targets: preview.targets.map(target => ({ ...target,
      title: state.watchedThreads.find(row => row.target.hostId === target.hostId && row.target.threadId === target.threadId)?.title ?? 'Unavailable thread',
      provider: state.watchedThreads.find(row => row.target.hostId === target.hostId && row.target.threadId === target.threadId)?.provider ?? null })) }
  }
  async stop(confirmationId: string, client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, standing = true, steer = false): Promise<WatcherPhoneStopResult> {
    guard()
    const result = await this.watcher.stopAll(confirmationId, guard, client.clientId)
    return result.status === 'refused' ? result : { status: 'ok', state: this.state(mayAnswer(), standing, steer), results: result.results }
  }
  currentThreadId(): string | undefined { return this.watcher.state().current?.target.threadId }
  /** `steer`: whether this phone negotiated steering, so its page carries what only such a phone reads (#1229). */
  async manage(action: 'permission' | 'watch' | 'unwatch', request: WatcherSetPermissionRequest | WatcherWatchThreadRequest,
    client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, steer = false): Promise<WatcherPhoneResult> {
    if (client.transport !== 'socket') return watcherRefusal('INVALID_INPUT', 'Watcher phone controls need a paired phone connection.')
    const permissionGrant = action === 'permission' && (request as WatcherSetPermissionRequest).runtimeMode !== 'approval-required'
    guard()
    if (permissionGrant && !mayAnswer()) return watcherRefusal('PERMISSION_TOO_WIDE', 'This phone needs Can answer to let Watcher act without asking. Nothing changed.')
    const check = () => {
      guard()
      if (permissionGrant && !mayAnswer()) throw new Error('This phone no longer has permission to change what Watcher may do without asking.')
    }
    const result = action === 'permission'
      ? await this.watcher.setPermission(request as WatcherSetPermissionRequest, check)
      : action === 'watch' ? await this.watcher.watchThread(request as WatcherWatchThreadRequest, check)
        : await this.watcher.unwatchThread(request as WatcherWatchThreadRequest, check)
    check()
    return result.status === 'refused' ? result : this.get(mayAnswer(), true, steer)
  }
  subscribe(listener: () => void): () => void { return this.watcher.subscribe(listener) }
  get(mayAnswer: boolean, standing = true, steer = false): WatcherPhoneResult { return { status: 'ok', state: this.state(mayAnswer, standing, steer) } }
  /** The phone listener's answer to whether a paired phone is still paired and admitted, while it runs (#1229). Returns the release. */
  useAdmission(admits: (clientId: string) => boolean): () => void { return this.control.useWatcherPhoneAdmission(admits) }
}
