import { posix, win32 } from 'node:path'
import { isVisualMessage, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import type { WatcherOwnChange } from '../../shared/watcherChanges'

const REASON_PREFIX = 'Watcher change reason: '

/** A defined reply line, never an interpretation of narration or tool output. */
function changeReason(text: string): string | null {
  const lines: string[] = []
  let fence: { character: string; length: number } | undefined
  for (const line of text.split(/\r\n|\n|\r/u)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { character: marker[0]!, length: marker.length }
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined
      continue
    }
    if (!fence && line.startsWith('Watcher change reason:')) lines.push(line)
  }
  if (lines.length !== 1 || !lines[0]!.startsWith(REASON_PREFIX)) return null
  const reason = lines[0]!.slice(REASON_PREFIX.length)
  return reason.length > 0 && reason.length <= 2_000 && reason.trim() ? reason : null
}

/** Compare equivalent provider paths without changing the spelling the provider reported. */
function filePath(path: string, cwd: string | undefined): { identity: string; path: string } | undefined {
  if (!path.trim() || path.length > 4_096 || path.endsWith('/') || path.endsWith('\\')
    || [...path].some(character => character.charCodeAt(0) < 32)) return undefined
  const windows = win32.isAbsolute(path) && !posix.isAbsolute(path) || cwd !== undefined && win32.isAbsolute(cwd) && !posix.isAbsolute(cwd)
  const paths = windows ? win32 : posix
  const normalized = paths.normalize(path.replaceAll('\\', '/'))
  if (normalized === '.' || normalized === '..') return undefined
  const absolute = cwd && paths.isAbsolute(cwd) ? paths.resolve(cwd, normalized) : normalized
  if (absolute.length > 4_096) return undefined
  return { identity: windows ? absolute.toLowerCase() : absolute, path: absolute }
}

/** Retain only successful provider edits, bound to an exact recorded user-message turn anchor. */
function observedChanges(thread: AgentThread) {
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const indexes = new Map(messages.map((message, index) => [message.id, index]))
  const userAt = new Map<string, number>()
  let user: number | undefined
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') user = index
    if (user !== undefined) userAt.set(message.id, user)
  }
  const activities = thread.activities ?? []
  const turns = new Map<string, number>()
  const ambiguous = new Set<string>()
  const anchorTurn = (turnId: string, index: number): void => {
    if (turns.has(turnId) && turns.get(turnId) !== index) ambiguous.add(turnId)
    else turns.set(turnId, index)
  }
  const files = new Map<string, Map<string, string>>()
  const addFile = (turnId: string, path: string, cwd?: string): void => {
    const file = filePath(path, cwd)
    if (!file) return
    const changed = files.get(turnId) ?? new Map<string, string>()
    if (!changed.has(file.identity)) changed.set(file.identity, file.path)
    files.set(turnId, changed)
  }
  for (const [index, message] of messages.entries()) if (message.role === 'user') {
    for (const observed of message.watcherObservedChanges ?? []) {
      anchorTurn(observed.turnId, index)
      for (const path of observed.files) addFile(observed.turnId, path)
    }
  }
  // Claude and Grok use the recorded user-message ID. Codex's turn record names its user anchor.
  for (const activity of activities) {
    const direct = indexes.get(activity.turnId)
    if (direct !== undefined && messages[direct]?.role === 'user') anchorTurn(activity.turnId, direct)
    else if (activity.kind === 'turn' && activity.afterMessageId) {
      const anchor = indexes.get(activity.afterMessageId)
      if (anchor !== undefined && messages[anchor]?.role === 'user') anchorTurn(activity.turnId, anchor)
    }
  }
  for (const activity of activities) {
    if (!successfulChange(activity) || ambiguous.has(activity.turnId)) continue
    let anchor = turns.get(activity.turnId)
    if (anchor === undefined && activity.afterMessageId) anchor = userAt.get(activity.afterMessageId)
    if (anchor === undefined) continue
    // Without the explicit turn record, contradictory anchors cannot prove whose reply this belongs to.
    if (!turns.has(activity.turnId)) {
      const anchors = new Set(activities.filter(item => item.turnId === activity.turnId && item.afterMessageId)
        .flatMap(item => { const index = userAt.get(item.afterMessageId!); return index === undefined ? [] : [index] }))
      if (anchors.size !== 1) continue
      turns.set(activity.turnId, anchor)
    }
    for (const change of activity.changes ?? []) {
      addFile(activity.turnId, change.path, activity.cwd ?? thread.workingDirectory)
    }
  }
  for (const turnId of ambiguous) { turns.delete(turnId); files.delete(turnId) }
  return { messages, activities, turns, files }
}

/**
 * Provider file-change records are attributed by their explicit turn and message anchors. Shared-checkout
 * Git totals and prose never establish a change. History-owned observations survive activity eviction.
 */
export function watcherOwnChanges(thread: AgentThread | undefined): WatcherOwnChange[] {
  if (!thread) return []
  const { messages, activities, turns, files } = observedChanges(thread)
  const marks = new Map<string, WatcherOwnChange>()
  // History-owned user anchors remain boundaries after their lifecycle activity has been evicted.
  const boundaryTurnIds = new Set(activities.filter(activity => activity.kind === 'turn').map(activity => activity.turnId))
  for (const message of messages) if (message.role === 'user') {
    for (const observed of message.watcherObservedChanges ?? []) boundaryTurnIds.add(observed.turnId)
  }
  for (const message of messages) if (message.role === 'assistant' && message.watcherOwnChange?.replyMessageId === message.id) {
    marks.set(message.id, message.watcherOwnChange)
  }
  for (const [turnId, changed] of files) {
    const current = thread.lastTurn
    if (activities.some(activity => activity.kind === 'turn' && activity.turnId === turnId && activity.status === 'running')
      || current?.status === 'running' && (current.id === turnId || current.messageId === turnId)) continue
    const anchor = turns.get(turnId)!
    const currentTerminal = current !== undefined && current.status !== 'running'
      && (current.id === turnId || current.messageId === turnId)
    const laterTurnAnchors = new Set([...boundaryTurnIds].filter(boundaryTurnId => boundaryTurnId !== turnId)
      .flatMap(boundaryTurnId => { const index = turns.get(boundaryTurnId); return index !== undefined && index > anchor ? [index] : [] }))
    let reply: typeof messages[number] | undefined
    for (let index = anchor + 1; index < messages.length; index++) {
      // A steer adds a user message inside the provider's current turn. Only the provider's explicit
      // terminal identity permits crossing it; a different recorded turn is still a hard boundary.
      if (messages[index]!.role === 'user' && (!currentTerminal || laterTurnAnchors.has(index))) break
      if (messages[index]!.role === 'assistant') reply = messages[index]
    }
    if (!reply) continue
    // A retained mark can know files whose activity has since left the bounded window.
    const previous = marks.get(reply.id)
    if (previous?.turnId === turnId) for (const path of previous.files) {
      const file = filePath(path, thread.workingDirectory)
      if (file !== undefined && !changed.has(file.identity)) changed.set(file.identity, file.path)
    }
    const paths = [...changed.values()]
    marks.set(reply.id, { replyMessageId: reply.id, turnId, files: paths, fileCount: paths.length,
      reason: changeReason(reply.text), source: 'provider-file-change' })
  }
  return messages.flatMap(message => { const mark = marks.get(message.id); return mark ? [mark] : [] })
}

/** Attach marks to history-owned assistant messages; the caller records changed messages through its history path. */
export function annotateWatcherOwnChanges(thread: AgentThread): AgentMessage[] {
  const { messages, turns, files } = observedChanges(thread)
  const pending = new Map<string, NonNullable<AgentMessage['watcherObservedChanges']>>()
  for (const [turnId, paths] of files) {
    const anchor = messages[turns.get(turnId)!]
    if (!anchor || anchor.role !== 'user') continue
    const observations = pending.get(anchor.id) ?? []
    observations.push({ turnId, files: [...paths.values()] })
    pending.set(anchor.id, observations)
  }
  const staged = thread.messages.map(message => {
    const observations = pending.get(message.id)
    return observations && JSON.stringify(observations) !== JSON.stringify(message.watcherObservedChanges)
      ? { ...message, watcherObservedChanges: observations } : message
  })
  const marks = new Map(watcherOwnChanges({ ...thread, messages: staged }).map(mark => [mark.replyMessageId, mark]))
  return staged.map(message => {
    const mark = marks.get(message.id)
    return mark && JSON.stringify(mark) !== JSON.stringify(message.watcherOwnChange) ? { ...message, watcherOwnChange: mark } : message
  })
}

function successfulChange(activity: AgentActivity): boolean {
  return activity.kind === 'file-change' && activity.status === 'completed' && !activity.error
    && (activity.exitCode === undefined || activity.exitCode === 0)
}
