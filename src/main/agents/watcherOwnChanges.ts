import { posix, win32 } from 'node:path'
import { isVisualMessage, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import type { WatcherOwnChange } from '../../shared/watcherChanges'

const REASON_PREFIX = 'Watcher change reason:'
const REASON_MAX = 2_000

/**
 * The one reason line Sotto reads from a reply, and where it sits among the reply's lines. A line that starts with the
 * exact words is that line even when it misses the space after the colon or runs long: its reason is trimmed, and cut
 * to 2,000 characters with an ellipsis, rather than dropped. An empty one gives no reason. Two such lines give none.
 */
function reasonLine(lines: readonly string[]): { index: number; reason: string | null } | null {
  const found: number[] = []
  let fence: { character: string; length: number } | undefined
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { character: marker[0]!, length: marker.length }
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined
      continue
    }
    if (!fence && line.startsWith(REASON_PREFIX)) found.push(index)
  }
  if (found.length !== 1) return null
  const reason = lines[found[0]!]!.slice(REASON_PREFIX.length).trim()
  return { index: found[0]!, reason: !reason ? null : reason.length <= REASON_MAX ? reason : `${reason.slice(0, REASON_MAX - 1).trimEnd()}…` }
}

/** A defined reply line, never an interpretation of narration or tool output. */
function changeReason(text: string): string | null {
  return reasonLine(text.split(/\r\n|\n|\r/u))?.reason ?? null
}

/**
 * A Watcher reply as Sotto shows it: without the reason line its own-change line already shows. Only that exact line
 * comes off, with one blank line beside it when it stood in a paragraph of its own; every other character, line break
 * and fenced example stays. A reply with no own-change reason, or nothing else in it, is shown as it was written.
 */
export function watcherReplyAsShown(message: AgentMessage): string {
  const mark = message.role === 'assistant' && message.watcherOwnChange?.replyMessageId === message.id ? message.watcherOwnChange : undefined
  if (!mark || !message.text.includes(REASON_PREFIX)) return message.text
  // Even entries are lines, odd entries the break after each, so the reply's own line endings survive.
  const parts = message.text.split(/(\r\n|\n|\r)/u)
  const lines = parts.filter((_, index) => index % 2 === 0), breaks = parts.filter((_, index) => index % 2 === 1)
  const found = reasonLine(lines)
  if (!found || found.reason !== mark.reason) return message.text
  const blank = (index: number): boolean => lines[index]!.trim() === ''
  let start = found.index, end = found.index + 1
  if (start > 0 && blank(start - 1) && (end === lines.length || blank(end))) start--
  // Leading the reply, the line takes the blank line after it too, so the reply does not open on an empty line.
  else if (start === 0 && end < lines.length && blank(end)) end++
  const before = lines.slice(0, start).flatMap((line, index) => index < start - 1 ? [line, breaks[index]!] : [line])
  const after = lines.slice(end).flatMap((line, index) => end + index < lines.length - 1 ? [line, breaks[end + index]!] : [line])
  const shown = [...before, ...(start > 0 && end < lines.length ? [breaks[start - 1]!] : []), ...after].join('')
  return shown.trim() ? shown : message.text
}

const shownReplies = new WeakMap<AgentMessage, { readonly text: string; readonly reason: string | null | undefined; readonly shown: AgentMessage }>()
const isWatcherConversation = (thread: AgentThread): boolean => thread.kind === 'watcher' || thread.kind === 'watcher-history'
const carriesReason = (message: AgentMessage): boolean => Boolean(message.role === 'assistant' && message.watcherOwnChange
  && message.text.includes(REASON_PREFIX))
function shownReply(message: AgentMessage): AgentMessage {
  const cached = shownReplies.get(message)
  const reason = message.watcherOwnChange?.reason
  if (cached?.text === message.text && cached.reason === reason) return cached.shown
  const text = watcherReplyAsShown(message)
  const shown = text === message.text ? message : { ...message, text }
  shownReplies.set(message, { text: message.text, reason, shown })
  return shown
}

/**
 * Every user-facing copy of a Watcher conversation (its pane, Copy, the thread detail, the phone) comes from the
 * coordinator's snapshot, so the reason line its own-change line shows comes off there, from Watcher's own replies only.
 * Taking it off again is a no-op, and the mark keeps the reason, so the own-change line is unchanged.
 */
export function watcherRepliesAsShown(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  if (!snapshot.threads.some(thread => isWatcherConversation(thread) && thread.messages.some(carriesReason))) return snapshot
  return { ...snapshot, threads: snapshot.threads.map(thread => isWatcherConversation(thread) && thread.messages.some(carriesReason)
    ? { ...thread, messages: thread.messages.map(message => carriesReason(message) ? shownReply(message) : message) } : thread) }
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
    // A reply shown without its reason line still has the reason its mark read from the line.
    marks.set(reply.id, { replyMessageId: reply.id, turnId, files: paths, fileCount: paths.length,
      reason: changeReason(reply.text) ?? (previous?.turnId === turnId ? previous.reason : null), source: 'provider-file-change' })
  }
  return messages.flatMap(message => { const mark = marks.get(message.id); return mark ? [mark] : [] })
}

/**
 * A message with the Watcher change metadata it lacks taken from the copy Sotto kept of it: a provider's fresh read of a
 * message never carries Sotto's own marks. The same message when nothing is missing.
 */
export function withKeptWatcherChanges(message: AgentMessage, kept: AgentMessage | undefined): AgentMessage {
  const ownChange = message.watcherOwnChange === undefined ? kept?.watcherOwnChange : undefined
  const observed = message.watcherObservedChanges === undefined ? kept?.watcherObservedChanges : undefined
  return ownChange || observed ? { ...message, ...(ownChange ? { watcherOwnChange: ownChange } : {}), ...(observed ? { watcherObservedChanges: observed } : {}) } : message
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
