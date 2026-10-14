import type { AgentCommand, AgentThread } from '../../shared/agents'
import { watcherPhoneStateSchema, type WatcherPhoneState, type WatcherPhoneSend, type WatcherPhoneResult,
  type WatcherPhoneSendResult, type WatcherPhonePrepareStopResult, type WatcherPhoneStopResult } from '../../shared/watcherPhone'
import { watcherRefusal, watcherGuidancePrefix, WATCHER_GUIDANCE_SUFFIX, type WatcherService } from './watcher'
import type { AgentControl } from './control'
import type { ClientIdentity } from './hostService'
import { isWatchedRow, takesPartInActiveRequest, type WatcherSetPermissionRequest, type WatcherWatchThreadRequest } from '../../shared/watcherRoom'

/** A phone reads the room, never the persisted control record or the desktop's aggregate shell. */
export class WatcherPhoneService {
  constructor(private readonly control: AgentControl, private readonly watcher: WatcherService) {}
  /** `standing`: whether this phone negotiated Watcher management, and with it knows standing watches. */
  state(mayAnswer: boolean, standing = true): WatcherPhoneState {
    const room = this.watcher.state(), snapshot = this.watcher.phoneSnapshot()
    const thread = (target: { hostId: string; threadId: string }): AgentThread | undefined => snapshot.threads.find(row =>
      (row.hostId ?? snapshot.hostId) === target.hostId && row.id === target.threadId)
    const current = room.current && thread(room.current.target)
    const detail = current ? this.control.threadDetail(current.id) : null
    const messages = (detail?.messages ?? []).slice(-200).map(message => {
      const request = message.role === 'user' ? room.requests.find(row => row.rootUserMessageId === message.id
        || row.userFollowups?.some(followup => followup.messageId === message.id)) : undefined
      const footer = request ? message.text.lastIndexOf(`\n\n${watcherGuidancePrefix(request.id, request.watcher.hostId)}`) : -1
      const text = footer >= 0 && message.text.endsWith(WATCHER_GUIDANCE_SUFFIX) ? message.text.slice(0, footer) : message.text
      return { id: message.id, role: message.role, text, createdAt: message.createdAt }
    })
    const receiptGroups: WatcherPhoneState['receiptGroups'] = []
    for (const operation of room.receipts.slice(-500)) {
      const request = room.requests.find(row => row.id === operation.requestId)
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
        ...(operation.delivery ? { delivery: operation.delivery } : {}), ...(operation.refusalCode ? { refusalCode: operation.refusalCode } : {}) })
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
      target: room.current.target, provider: room.current.provider, ...room.currentOptions } : null,
    conversation: { messages, revision: detail?.revision ?? 0, earlierAvailable: Boolean(detail?.earlierAvailable || (detail?.messages.length ?? 0) > messages.length) },
    draftDeliveries: (this.control.shell().deliveries ?? []).filter(row => row.threadId === current?.id).map(row => ({ draftId: row.draftId, status: row.status })),
    runtimeMode: room.runtimeMode, ...(standing ? { standingWatches: room.standingWatches } : {}), ownChanges: room.ownChanges,
    receiptGroups, watchedThreads, needsYou, inFlight: room.inFlight, inFlightLimit: room.inFlightLimit,
    working: room.currentOptions?.status === 'running' || room.inFlight > 0, recoveryNotice: room.recoveryNotice, observedAt: room.observedAt })
  }
  async send(request: WatcherPhoneSend, client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, standing = true): Promise<WatcherPhoneSendResult> {
    if (request.origin.clientId !== client.clientId || request.origin.hostId !== this.control.hostId() || client.transport !== 'socket') {
      return watcherRefusal('INVALID_INPUT', 'This instruction does not belong to this phone and computer. Nothing was sent.')
    }
    const check = () => {
      guard()
      const current = this.watcher.state().current
      if (!current || current.target.hostId !== request.target.hostId || current.target.threadId !== request.target.threadId
        || !this.watcher.isCurrent(request.target.threadId)) throw new Error('Watcher changed. Nothing was sent. Refresh Watcher before sending again.')
      this.watcher.guardPhoneSend(request.target.threadId)
      const thread = this.control.watcherSnapshot().threads.find(row => row.id === request.target.threadId)
      if (thread?.requests.length) throw new Error('Watcher needs your answer on its request card. Nothing was sent.')
    }
    try {
      check()
      const result = await this.control.commandFromWatcherPhone({ type: 'send', draft: { threadId: request.target.threadId,
        draftId: request.draftId, text: request.text, attachments: [], binding: { requestId: null, questionsDigest: null } } },
      { phoneOrigin: request.origin, guard: check }, { ...client, selectedThreadId: request.target.threadId })
      if (result.error) return watcherRefusal('PROVIDER_UNAVAILABLE', 'Watcher could not take this instruction. Your text is kept on the phone. Refresh Watcher and check its delivery before trying again.', true)
      return { status: 'ok', draftId: request.draftId, state: this.state(mayAnswer(), standing) }
    } catch { return watcherRefusal('TARGET_CHANGED', 'Watcher changed or is unavailable. Nothing new was sent. Refresh Watcher and review its request cards.', true) }
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
  async stop(confirmationId: string, client: ClientIdentity, guard: () => void, mayAnswer: () => boolean, standing = true): Promise<WatcherPhoneStopResult> {
    guard()
    const result = await this.watcher.stopAll(confirmationId, guard, client.clientId)
    return result.status === 'refused' ? result : { status: 'ok', state: this.state(mayAnswer(), standing), results: result.results }
  }
  currentThreadId(): string | undefined { return this.watcher.state().current?.target.threadId }
  async manage(action: 'permission' | 'watch' | 'unwatch', request: WatcherSetPermissionRequest | WatcherWatchThreadRequest,
    client: ClientIdentity, guard: () => void, mayAnswer: () => boolean): Promise<WatcherPhoneResult> {
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
    return result.status === 'refused' ? result : this.get(mayAnswer())
  }
  subscribe(listener: () => void): () => void { return this.watcher.subscribe(listener) }
  get(mayAnswer: boolean, standing = true): WatcherPhoneResult { return { status: 'ok', state: this.state(mayAnswer, standing) } }
}
