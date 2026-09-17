import type { AgentActivity } from './agentActivity'
import type { AgentActivityDelta, AgentMessage, AgentMessageDelta, AgentThreadDetail,
  AgentThreadDetailDelta, AgentThreadDetailUpdate } from './agents'

/**
 * The detail stream's arithmetic: what changed in one thread's history since the revision the window
 * already holds, how a window turns that back into the history, and how two of them become one.
 * Main diffs, the window applies, and the IPC boundary merges; all three read these rules from here.
 */

export function isAgentThreadDetailDelta(update: AgentThreadDetailUpdate): update is AgentThreadDetailDelta {
  return 'messageDeltas' in update
}

/**
 * What "this activity record changed" means on the detail stream: its identity, its state, and the size
 * of every field that can grow. A same-length replacement of a field's text is not distinguished — the
 * same trade the revision itself makes, and the reason this is cheap enough to run on every frame.
 */
export function agentActivitySignature(record: AgentActivity): string {
  return [record.turnId, record.sequence, record.afterMessageId ?? '', record.parentId ?? '', record.kind, record.status,
    record.title.length, size(record.text), size(record.command), size(record.cwd), size(record.output), size(record.error),
    record.exitCode ?? '', record.startedAt ?? '', record.completedAt ?? '', record.timingSource ?? '', record.durationMs ?? '',
    record.context?.before ?? '', record.context?.after ?? '', record.truncated === true ? '1' : '',
    (record.changes ?? []).map(change => `${change.path.length}:${change.kind.length}:${size(change.diff)}`).join('~'),
    (record.steps ?? []).map(step => `${step.text.length}:${step.status}`).join('~'),
    (record.agents ?? []).map(agent => `${agent.id}:${agent.status}:${size(agent.message)}`).join('~'),
  ].join('|')
}
function size(value: string | undefined): number { return value === undefined ? -1 : value.length }

/**
 * The delta from the detail a window holds to the history a thread now has, or null when no delta can
 * say it — a message removed, renumbered or reordered, an activity record that would land in the wrong
 * place. The caller sends the whole detail instead. Everything the delta carries is copied, so the
 * snapshot built from it never references the live thread.
 */
export function diffAgentThreadDetail(base: AgentThreadDetail,
  next: { readonly messages: readonly AgentMessage[]; readonly activities?: readonly AgentActivity[] | undefined },
  revision: number): AgentThreadDetailDelta | null {
  if ((base.activities === undefined) !== (next.activities === undefined)) return null
  if (next.messages.length < base.messages.length) return null
  const messageDeltas: AgentMessageDelta[] = []
  for (const [index, held] of base.messages.entries()) {
    const message = next.messages[index]!
    if (message.id !== held.id) return null
    if (sameMessage(held, message)) continue
    const appended = message.text.length > held.text.length && message.text.startsWith(held.text)
      && sameMessage(held, { ...message, text: held.text })
    messageDeltas.push(appended ? { id: held.id, appendText: message.text.slice(held.text.length) }
      : { message: structuredClone(message) })
  }
  for (const message of next.messages.slice(base.messages.length)) messageDeltas.push({ message: structuredClone(message) })
  const activityDeltas: AgentActivityDelta[] = []
  const heldActivities = base.activities ?? []
  const nextActivities = next.activities ?? []
  const signatures = new Map(heldActivities.map(record => [record.id, agentActivitySignature(record)]))
  const present = new Set(nextActivities.map(record => record.id))
  for (const record of heldActivities) if (!present.has(record.id)) activityDeltas.push({ id: record.id, removed: true })
  for (const record of nextActivities) {
    if (signatures.get(record.id) === agentActivitySignature(record)) continue
    activityDeltas.push({ record: structuredClone(record) })
  }
  const delta: AgentThreadDetailDelta = { threadId: base.threadId, baseRevision: base.revision, revision, messageDeltas, activityDeltas }
  // A delta must reproduce exactly the history it describes. Applying it here costs references, not
  // copies, and anything the rules above cannot express is caught before it reaches a window.
  const applied = applyAgentThreadDetailDelta(base, delta)
  if (applied === null) return null
  if (!sameOrder(applied.messages, next.messages) || !sameOrder(applied.activities ?? [], nextActivities)) return null
  return delta
}

/**
 * The detail a window holds plus one delta. Every message and record the delta did not touch keeps its
 * identity, so the window's structural sharing still sees an untouched message as the same object.
 * Null when the delta does not follow this detail, which is the window's cue to ask for the whole thing.
 */
export function applyAgentThreadDetailDelta(base: AgentThreadDetail, delta: AgentThreadDetailDelta): AgentThreadDetail | null {
  if (delta.threadId !== base.threadId || delta.baseRevision !== base.revision) return null
  const messages = [...base.messages]
  const positions = new Map(messages.map((message, position) => [message.id, position]))
  for (const item of delta.messageDeltas) {
    if ('appendText' in item) {
      const position = positions.get(item.id)
      if (position === undefined) return null
      const message = messages[position]!
      messages[position] = { ...message, text: message.text + item.appendText }
      continue
    }
    const position = positions.get(item.message.id)
    if (position === undefined) { positions.set(item.message.id, messages.length); messages.push(item.message) }
    else messages[position] = item.message
  }
  if (base.activities === undefined) {
    return delta.activityDeltas.length > 0 ? null : { threadId: base.threadId, revision: delta.revision, messages }
  }
  // Insertion order is the record order, and re-setting a key keeps its place: an updated record stays
  // where it was and a new one lands at the end, which is how the coordinator keeps activity itself.
  const records = new Map(base.activities.map(record => [record.id, record]))
  for (const item of delta.activityDeltas) {
    if ('removed' in item) records.delete(item.id)
    else records.set(item.record.id, item.record)
  }
  return { threadId: base.threadId, revision: delta.revision, messages, activities: [...records.values()] }
}

/**
 * Two updates for one thread as a single update, or null when they must both be sent. A whole detail
 * supersedes anything before it; consecutive deltas concatenate, and a message appended twice is
 * appended once. Removals are left alone: their order against an upsert of the same record matters.
 */
export function mergeAgentThreadDetailUpdates(pending: AgentThreadDetailUpdate, next: AgentThreadDetailUpdate): AgentThreadDetailUpdate | null {
  if (pending.threadId !== next.threadId) return null
  if (!isAgentThreadDetailDelta(next)) return next
  if (!isAgentThreadDetailDelta(pending)) return applyAgentThreadDetailDelta(pending, next)
  if (pending.revision !== next.baseRevision) return null
  if (removes(pending) || removes(next)) return null
  const messageDeltas = [...pending.messageDeltas]
  for (const item of next.messageDeltas) {
    const position = messageDeltas.findIndex(held => messageDeltaId(held) === messageDeltaId(item))
    const held = position === -1 ? undefined : messageDeltas[position]!
    if (held === undefined) { messageDeltas.push(item); continue }
    if (!('appendText' in item)) { messageDeltas[position] = item; continue }
    messageDeltas[position] = 'appendText' in held ? { id: held.id, appendText: held.appendText + item.appendText }
      : { message: { ...held.message, text: held.message.text + item.appendText } }
  }
  const activityDeltas = [...pending.activityDeltas]
  for (const item of next.activityDeltas) {
    const position = activityDeltas.findIndex(held => activityDeltaId(held) === activityDeltaId(item))
    if (position === -1) activityDeltas.push(item)
    else activityDeltas[position] = item
  }
  return { threadId: pending.threadId, baseRevision: pending.baseRevision, revision: next.revision, messageDeltas, activityDeltas }
}

function removes(delta: AgentThreadDetailDelta): boolean { return delta.activityDeltas.some(item => 'removed' in item) }
function messageDeltaId(item: AgentMessageDelta): string { return 'appendText' in item ? item.id : item.message.id }
function activityDeltaId(item: AgentActivityDelta): string { return 'removed' in item ? item.id : item.record.id }
function sameOrder(applied: readonly { id: string }[], next: readonly { id: string }[]): boolean {
  return applied.length === next.length && applied.every((item, index) => item.id === next[index]!.id)
}
function sameMessage(base: AgentMessage, next: AgentMessage): boolean {
  return base.id === next.id && base.role === next.role && base.text === next.text
    && base.createdAt === next.createdAt && base.commandId === next.commandId
    && sameAttachments(base.attachments, next.attachments)
}
function sameAttachments(base: AgentMessage['attachments'], next: AgentMessage['attachments']): boolean {
  if (base === next) return true
  if (base === undefined || next === undefined) return false
  return base.length === next.length && base.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}
