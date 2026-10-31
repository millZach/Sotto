import type { AgentActivity } from './agentActivity'
import type { AgentActivityAppend, AgentActivityDelta, AgentMessage, AgentMessageDelta, AgentThreadDetail,
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
 * same trade the revision itself makes, and the reason this is cheap enough to run on every frame. A record with a cut
 * body adds the whole sizes its `cut` names; a record without one has the signature it always had.
 */
export function agentActivitySignature(record: AgentActivity): string {
  return [record.turnId, record.sequence, record.afterMessageId ?? '', record.parentId ?? '', record.kind, record.status,
    record.title.length, size(record.text), size(record.command), size(record.cwd), size(record.output), size(record.error),
    record.exitCode ?? '', record.startedAt ?? '', record.completedAt ?? '', record.timingSource ?? '', record.durationMs ?? '',
    record.context?.before ?? '', record.context?.after ?? '', record.truncated === true ? '1' : '', record.taskUpdatesExcluded === true ? '1' : '',
    (record.changes ?? []).map(change => `${change.path.length}:${change.kind.length}:${size(change.diff)}`).join('~'),
    (record.steps ?? []).map(step => `${step.text.length}:${step.status}`).join('~'),
    (record.agents ?? []).map(agent => `${agent.id}:${agent.status}:${size(agent.message)}`).join('~'),
    // A cut body's kept part can stay the same length as its whole grows, so its whole size is part of what changed.
    ...record.cut ? [`${record.cut.output ?? ''}:${record.cut.text ?? ''}:${(record.cut.diffs ?? []).map(item => `${item.index}=${item.bytes}`).join(',')}`] : [],
    // A turn on one of the user's own servers (ADR-0124) changes its try and its failure while its status stays the same.
    ...record.ownServer ? [`${record.ownServer.name.length}:${record.ownServer.model.length}:${record.ownServer.host.length}:${record.ownServer.attempt ?? ''}:${record.ownServer.attempts ?? ''}:${record.ownServer.failure ?? ''}`] : [],
  ].join('|')
}
function size(value: string | undefined): number { return value === undefined ? -1 : value.length }

/** What a field grew by at its end, `''` when it is as it was, or undefined when it changed any other way. */
function grownBy(before: string | undefined, after: string | undefined): string | undefined {
  if (before === after) return ''
  return before !== undefined && after !== undefined && after.length > before.length && after.startsWith(before) ? after.slice(before.length) : undefined
}

/**
 * The append that takes `held` to `record`, when the record's output, text or both only grew at their end and every other
 * field holds what it held: a command streaming its output into a running record. Undefined for any other change, which
 * goes as the record whole. The other fields are compared by value, not by the signature, which tells some of them apart
 * only by length: a plan whose explanation grew while a step changed to another of the same length goes whole.
 */
function appendOf(held: AgentActivity, record: AgentActivity): AgentActivityAppend | undefined {
  const output = grownBy(held.output, record.output), text = grownBy(held.text, record.text)
  if (output === undefined || text === undefined || !output && !text || !sameBesideBodies(held, record)) return undefined
  return { id: record.id, ...output ? { appendOutput: output } : {}, ...text ? { appendText: text } : {} }
}
/**
 * Whether two records hold the same value in every field but `output` and `text`: identity first, then the JSON of a field
 * that is an object. A field absent and one present as undefined are the same. Fields written in another key order read as
 * changed, which only sends the record whole.
 */
function sameBesideBodies(held: AgentActivity, record: AgentActivity): boolean {
  const before = held as unknown as Record<string, unknown>, after = record as unknown as Record<string, unknown>
  const same = (key: string): boolean => {
    const left = before[key], right = after[key]
    return left === right || typeof left === 'object' && typeof right === 'object' && left !== null && right !== null
      && JSON.stringify(left) === JSON.stringify(right)
  }
  for (const key in after) if (key !== 'output' && key !== 'text' && !same(key)) return false
  for (const key in before) if (key !== 'output' && key !== 'text' && !(key in after) && before[key] !== undefined) return false
  return true
}
/** `record` as an append leaves it: its output and text with the append's joined at their end, every other field as it was. */
function grown(record: AgentActivity, output: string | undefined, text: string | undefined): AgentActivity {
  return { ...record, ...output ? { output: (record.output ?? '') + output } : {}, ...text ? { text: (record.text ?? '') + text } : {} }
}
function isAppend(item: AgentActivityDelta): item is AgentActivityAppend { return !('record' in item) && !('removed' in item) }

/**
 * The delta from the detail a window holds to the history a thread now has, or null when no delta can
 * say it — a message removed, renumbered or reordered, an activity record that would land in the wrong
 * place. The caller sends the whole detail instead. Everything the delta carries is copied, so the
 * snapshot built from it never references the live thread.
 */
export function diffAgentThreadDetail(base: AgentThreadDetail,
  next: { readonly messages: readonly AgentMessage[]; readonly activities?: readonly AgentActivity[] | undefined },
  revision: number, activitySignature: (record: AgentActivity) => string = agentActivitySignature): AgentThreadDetailDelta | null {
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
  // The very list the detail holds has nothing to say: a streamed word leaves a thread's activity as it was, and reading
  // every record of a long thread on every word was the delta's whole cost (#1248).
  const sameActivities = base.activities === next.activities
  // Records the two lists hold at the same place as the very same object did not change. IDs are unique in each list, so
  // what the lists share as their opening run neither names a record after it nor moves, and only the rest is read: a
  // tool's output growing at the end of a long thread reads the records after the last one that is the same.
  let shared = 0
  if (!sameActivities && base.activities && next.activities) {
    const end = Math.min(base.activities.length, next.activities.length)
    while (shared < end && base.activities[shared] === next.activities[shared]) shared++
  }
  const heldActivities = shared ? base.activities!.slice(shared) : base.activities ?? []
  const nextActivities = shared ? next.activities!.slice(shared) : next.activities ?? []
  const heldRecords = sameActivities ? undefined : new Map(heldActivities.map(record => [record.id, record]))
  const present = new Set(sameActivities ? [] : nextActivities.map(record => record.id))
  if (!sameActivities) for (const record of heldActivities) if (!present.has(record.id)) activityDeltas.push({ id: record.id, removed: true })
  if (!sameActivities) for (const record of nextActivities) {
    const held = heldRecords!.get(record.id)
    if (held === record || held !== undefined && activitySignature(held) === activitySignature(record)) continue
    // Only grown at its end, as a command's output does while it runs: the new text alone (window only, `AgentActivityAppend`).
    const append = held === undefined ? undefined : appendOf(held, record)
    activityDeltas.push(append ?? { record: structuredClone(record) })
  }
  const delta: AgentThreadDetailDelta = { threadId: base.threadId, baseRevision: base.revision, revision, messageDeltas, activityDeltas }
  // A delta must reproduce exactly the history it describes. Applying it here costs references, not
  // copies, and anything the rules above cannot express is caught before it reaches a window.
  const applied = applyAgentThreadDetailDelta(base, delta)
  if (applied === null) return null
  // The shared opening run is left where it was by the delta, so only what follows it is compared.
  if (!sameOrder(applied.messages, next.messages) || !sameActivities && ((applied.activities?.length ?? 0) !== shared + nextActivities.length
    || !sameOrder((applied.activities ?? []).slice(shared), nextActivities))) return null
  return delta
}

/**
 * The detail a window holds plus one delta. Every message and record the delta did not touch keeps its
 * identity, so the window's structural sharing still sees an untouched message as the same object.
 * Null when the delta does not follow this detail, which is the window's cue to ask for the whole thing.
 */
/** How many records a delta may carry and still be applied by looking for each from the end. */
const FEW_RECORDS = 8
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
  // A delta with no record in it keeps the records the detail holds, the same list, when that list is frozen: one a caller
  // could still write into is copied as before, so no detail ever shares a list it does not own.
  if (delta.activityDeltas.length === 0 && Object.isFrozen(base.activities)) return { threadId: base.threadId, revision: delta.revision, messages, activities: base.activities }
  // A few records, as a streaming tool's output gives them, are found from the end, where a thread's activity changes:
  // the same places the map below gives them, without reading every record of a long thread into it (#1248).
  if (delta.activityDeltas.length <= FEW_RECORDS) {
    const activities = [...base.activities]
    for (const item of delta.activityDeltas) {
      const id = activityDeltaId(item)
      let position = activities.length - 1
      while (position >= 0 && activities[position]!.id !== id) position--
      if ('removed' in item) { if (position >= 0) activities.splice(position, 1) }
      // An append grows the record held; one this detail does not hold cannot be applied.
      else if (isAppend(item)) { if (position < 0) return null; activities[position] = grown(activities[position]!, item.appendOutput, item.appendText) }
      else if (position >= 0) activities[position] = item.record
      else activities.push(item.record)
    }
    return { threadId: base.threadId, revision: delta.revision, messages, activities }
  }
  // Insertion order is the record order, and re-setting a key keeps its place: an updated record stays
  // where it was and a new one lands at the end, which is how the coordinator keeps activity itself.
  const records = new Map(base.activities.map(record => [record.id, record]))
  for (const item of delta.activityDeltas) {
    if ('removed' in item) records.delete(item.id)
    else if (isAppend(item)) {
      const held = records.get(item.id)
      if (held === undefined) return null
      records.set(item.id, grown(held, item.appendOutput, item.appendText))
    } else records.set(item.record.id, item.record)
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
  const activityDeltas = [...pending.activityDeltas]
  for (const item of next.activityDeltas) {
    const position = activityDeltas.findIndex(held => activityDeltaId(held) === activityDeltaId(item))
    if (position === -1) activityDeltas.push(item)
    else activityDeltas[position] = joinActivity(activityDeltas[position]!, item)
  }
  return { threadId: pending.threadId, baseRevision: pending.baseRevision, revision: next.revision, messageDeltas: foldMessageDeltas(pending, next), activityDeltas }
}

/**
 * Two updates for one thread as one, removals included: applying the result is applying both in turn. A record's
 * entries keep only what still matters, an upsert replacing the one before it in place and a removal dropping an upsert
 * it follows, so a record has at most a removal and then an upsert, and a fold of any number of deltas is bounded by the
 * records they name. A host folds what it holds for a socket client that reads slowly this way (ADR-0025, October 21
 * amendment), where a long thread's deltas remove a record as often as they add one. Null when the two do not follow
 * each other, or a whole cannot take the delta.
 */
export function foldAgentThreadDetailUpdates(pending: AgentThreadDetailUpdate, next: AgentThreadDetailUpdate): AgentThreadDetailUpdate | null {
  if (pending.threadId !== next.threadId) return null
  if (!isAgentThreadDetailDelta(next)) return next
  if (!isAgentThreadDetailDelta(pending)) return applyAgentThreadDetailDelta(pending, next)
  if (pending.revision !== next.baseRevision) return null
  const activityDeltas = [...pending.activityDeltas]
  for (const item of next.activityDeltas) {
    const id = activityDeltaId(item)
    const last = activityDeltas.findLastIndex(held => activityDeltaId(held) === id)
    const held = last === -1 ? undefined : activityDeltas[last]!
    if (held === undefined) { activityDeltas.push(item); continue }
    if (!('removed' in item)) {
      if ('removed' in held) activityDeltas.push(item)
      else activityDeltas[last] = joinActivity(held, item)
      continue
    }
    if ('removed' in held) continue
    activityDeltas.splice(last, 1)
    // With no removal before it, the record may be one the client holds, so the removal still goes.
    if (!activityDeltas.some(entry => activityDeltaId(entry) === id)) activityDeltas.push(item)
  }
  return { threadId: pending.threadId, baseRevision: pending.baseRevision, revision: next.revision, messageDeltas: foldMessageDeltas(pending, next), activityDeltas }
}

/** Both deltas' message changes as one list: a whole message replaces the one before it, and appended text joins it. */
function foldMessageDeltas(pending: AgentThreadDetailDelta, next: AgentThreadDetailDelta): AgentMessageDelta[] {
  const messageDeltas = [...pending.messageDeltas]
  for (const item of next.messageDeltas) {
    const position = messageDeltas.findIndex(held => messageDeltaId(held) === messageDeltaId(item))
    const held = position === -1 ? undefined : messageDeltas[position]!
    if (held === undefined) { messageDeltas.push(item); continue }
    if (!('appendText' in item)) { messageDeltas[position] = item; continue }
    messageDeltas[position] = 'appendText' in held ? { id: held.id, appendText: held.appendText + item.appendText }
      : { message: { ...held.message, text: held.message.text + item.appendText } }
  }
  return messageDeltas
}

function removes(delta: AgentThreadDetailDelta): boolean { return delta.activityDeltas.some(item => 'removed' in item) }
function messageDeltaId(item: AgentMessageDelta): string { return 'appendText' in item ? item.id : item.message.id }
function activityDeltaId(item: AgentActivityDelta): string { return 'record' in item ? item.record.id : item.id }
/**
 * One record's change after another as one: a whole record replaces what came before it, and an append joins the text
 * before it, an earlier append's or a whole record's.
 */
function joinActivity(held: AgentActivityDelta, item: AgentActivityDelta): AgentActivityDelta {
  if (!isAppend(item) || 'removed' in held) return item
  if ('record' in held) return { record: grown(held.record, item.appendOutput, item.appendText) }
  const output = (held.appendOutput ?? '') + (item.appendOutput ?? ''), text = (held.appendText ?? '') + (item.appendText ?? '')
  return { id: held.id, ...output ? { appendOutput: output } : {}, ...text ? { appendText: text } : {} }
}
/**
 * `delta` with each append as the record it leaves, read from `records`, the history the delta takes its thread to: what a
 * reader that is sent whole records is sent, a socket client among them. Each is looked for from the end, where a running
 * command's record is, so a long thread's history is not read for every chunk of output. Null when `records` does not
 * hold one, which a delta made from that history never names.
 */
export function withAppendsWhole(delta: AgentThreadDetailDelta, records: readonly AgentActivity[]): AgentThreadDetailDelta | null {
  if (!delta.activityDeltas.some(isAppend)) return delta
  const activityDeltas: AgentActivityDelta[] = []
  for (const item of delta.activityDeltas) {
    const record = isAppend(item) ? records.findLast(held => held.id === item.id) : undefined
    if (isAppend(item) && record === undefined) return null
    activityDeltas.push(record === undefined ? item : { record: structuredClone(record) })
  }
  return { ...delta, activityDeltas }
}
function sameOrder(applied: readonly { id: string }[], next: readonly { id: string }[]): boolean {
  return applied.length === next.length && applied.every((item, index) => item.id === next[index]!.id)
}
function sameMessage(base: AgentMessage, next: AgentMessage): boolean {
  return base.id === next.id && base.role === next.role && base.text === next.text
    && base.createdAt === next.createdAt && base.commandId === next.commandId
    && sameAttachments(base.attachments, next.attachments)
    // A handover is told apart from the user's words by its provenance, which can arrive after them (ADR-0073).
    && base.handover?.text === next.handover?.text
}
function sameAttachments(base: AgentMessage['attachments'], next: AgentMessage['attachments']): boolean {
  if (base === next) return true
  if (base === undefined || next === undefined) return false
  return base.length === next.length && base.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}
