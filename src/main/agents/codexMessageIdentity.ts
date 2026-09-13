import { createHash } from 'node:crypto'
import { z } from 'zod'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
export const codexMessageIdentitySchema = z.object({
  id: z.string(), nativeIds: z.array(z.string()), role: z.enum(['user', 'assistant']),
  digest: z.string(), createdAt: z.string(), complete: z.boolean(), clientId: z.string().optional(),
})
export const codexTurnIdentitySchema = z.object({
  turnId: z.string(), ordered: z.boolean(), sealed: z.boolean().default(false), messages: z.array(codexMessageIdentitySchema),
})
export type CodexTurnIdentity = z.infer<typeof codexTurnIdentitySchema>
export type CodexMessageIdentity = z.infer<typeof codexMessageIdentitySchema>
export type CodexOrigin = { messageId: string; commandId: string; digest: string; createdAt: string; turnId?: string | undefined;
  itemId?: string | undefined; clientIdentity?: boolean | undefined }
export type IdentityItem = { id: string; role: 'user' | 'assistant'; digest: string; clientId?: string | null | undefined }
export type RolloutIdentity = { role: 'user' | 'assistant'; digest: string; nativeId?: string | undefined; clientId?: string | undefined; eventId?: string | undefined }

/** Only identity metadata. User response_items (including injected skills) never
 * become authored messages or command origins. Assistant IDs require the paired
 * authored agent_message event, in the same turn and order. */
export class CodexRolloutIdentities {
  private turn: string | undefined
  private pending: RolloutIdentity | undefined
  private readonly turns = new Map<string, RolloutIdentity[]>()
  get(turnId: string): readonly RolloutIdentity[] { return this.turns.get(turnId) ?? [] }
  consume(entry: { type: string; payload: unknown; timestamp: string; ordinal?: number | undefined }): void {
    const parsed = z.object({ type: z.string().optional(), turn_id: z.string().optional(), role: z.string().optional(),
      id: z.string().nullish(), client_id: z.string().nullish(), message: z.string().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() }).safeParse(entry.payload)
    if (!parsed.success) return
    const p = parsed.data
    if ((entry.type === 'turn_context' || entry.type === 'event_msg' && p.type === 'task_started') && p.turn_id) {
      if (this.turn !== p.turn_id) this.pending = undefined
      this.turn = p.turn_id
    }
    if (!this.turn) return
    if (entry.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message') && p.message !== undefined) {
      const rows = this.turns.get(this.turn) ?? []
      const row: RolloutIdentity = { role: p.type === 'user_message' ? 'user' : 'assistant', digest: digest(p.message),
        ...(p.type === 'user_message' ? { eventId: p.id ?? `rollout:${digest(`${entry.ordinal ?? entry.timestamp}:${p.message}`)}` } : {}),
        ...(p.type === 'user_message' && p.client_id ? { clientId: p.client_id } : {}) }
      rows.push(row); this.turns.set(this.turn, rows)
      this.pending = row.role === 'assistant' ? row : undefined
    } else if (entry.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('\n')
      if (this.pending?.digest === digest(text) && p.id) this.pending.nativeId = p.id
      this.pending = undefined
    } else if (entry.type === 'event_msg' && p.type === 'task_complete') {
      this.turn = undefined; this.pending = undefined
    }
  }
}

const matches = (a: { role: string; digest: string }, b: { role: string; digest: string }): boolean => a.role === b.role && a.digest === b.digest
export const compatibleClient = (record: CodexMessageIdentity, item: IdentityItem): boolean =>
  !item.clientId || !record.clientId || item.clientId === record.clientId
const bindNativeId = (record: CodexMessageIdentity, id: string): void => {
  if (!record.nativeIds.includes(id)) record.nativeIds.push(id)
}

/** Scoped to a native turn; a reconstructed item-0 from another turn is unrelated. */
export function messageOrigin(origins: readonly CodexOrigin[], turnId: string, item: IdentityItem): CodexOrigin | undefined {
  return origins.find(origin => origin.digest === item.digest && (!origin.turnId || origin.turnId === turnId) &&
    (origin.messageId === item.clientId || !item.clientId && origin.turnId === turnId && origin.itemId === item.id))
}

export function identityTurn(turns: CodexTurnIdentity[], turnId: string): CodexTurnIdentity {
  let turn = turns.find(turn => turn.turnId === turnId)
  if (!turn) { turn = { turnId, ordered: false, sealed: false, messages: [] }; turns.push(turn) }
  return turn
}

export function messageIdentity(turns: CodexTurnIdentity[], turn: CodexTurnIdentity, item: IdentityItem,
  origin: CodexOrigin | undefined, createdAt: string, complete: boolean, preferredId = item.id): CodexMessageIdentity {
  let record = turn.messages.find(record => record.role === item.role && compatibleClient(record, item) && (record.nativeIds.includes(item.id) || origin?.messageId === record.id))
  if (!record) {
    const candidate = origin?.messageId ?? preferredId
    const id = turns.some(t => t.messages.some(m => m.id === candidate)) ? `codex-message-${digest(JSON.stringify([turn.turnId, candidate]))}` : candidate
    record = { id, nativeIds: [], role: item.role, digest: item.digest, createdAt: origin?.createdAt ?? createdAt, complete,
      ...(item.clientId || origin ? { clientId: item.clientId ?? origin!.messageId } : {}) }
    turn.messages.push(record)
  }
  bindNativeId(record, item.id)
  if (origin) bindNativeId(record, origin.itemId ?? item.id)
  if (complete || !record.complete) { record.digest = item.digest; record.complete = complete }
  return record
}

/** Reconcile complete, ordered native message lists. Positional aliases are only
 * learned for equal-length gaps between agreeing exact-ID/client-ID anchors.
 * A differing count/content/order never proves that repeated text is the same message. */
export function reconcileMessageIdentities(turns: CodexTurnIdentity[], turnId: string, items: readonly IdentityItem[],
  origins: readonly CodexOrigin[], createdAt: string, rollout: readonly RolloutIdentity[] = [], terminal = true): CodexMessageIdentity[] {
  const turn = identityTurn(turns, turnId)
  const old = [...turn.messages]
  // Old records can learn their exact client identity from an existing receipt.
  for (const record of old) record.clientId ??= origins.find(origin => origin.messageId === record.id)?.messageId
  const selected = items.map(item => {
    const origin = item.role === 'user' ? messageOrigin(origins, turnId, item) : undefined
    return old.find(record => record.role === item.role && compatibleClient(record, item) && (record.nativeIds.includes(item.id) || record.id === origin?.messageId))
  })
  const used = new Set(selected.filter(record => record !== undefined))
  if (turn.ordered) {
    const anchors = selected.flatMap((record, index) => record ? [{ before: old.indexOf(record), after: index }] : [])
    if (anchors.every((anchor, index) => index === 0 || anchor.before > anchors[index - 1]!.before)) {
      const bounds = [{ before: -1, after: -1 }, ...anchors, { before: old.length, after: items.length }]
      for (let i = 1; i < bounds.length; i++) {
        const a = bounds[i - 1]!; const b = bounds[i]!
        const previous = old.slice(a.before + 1, b.before); const incoming = items.slice(a.after + 1, b.after)
        if (previous.length !== incoming.length || !previous.every((record, j) => record.complete && matches(record, incoming[j]!) && compatibleClient(record, incoming[j]!))) continue
        previous.forEach((record, j) => { selected[a.after + 1 + j] = record; used.add(record) })
      }
    }
  }

  // A rollout is corroboration, never a substitute transcript. Require the full
  // role/digest sequence and every supplied native client identity to agree.
  const corroborated = rollout.length === items.length && rollout.every((row, i) => matches(row, items[i]!) &&
    (!items[i]!.clientId || items[i]!.clientId === row.clientId))
  if (corroborated) rollout.forEach((row, index) => {
    if (selected[index] || !row.nativeId) return
    const record = old.find(record => record.nativeIds.includes(row.nativeId!) && !used.has(record) && matches(record, row))
    if (record) { selected[index] = record; used.add(record) }
  })

  // Old aliases had no steer client identity. Only already-observed origins
  // from this exact turn are eligible, and all equal-text occurrences must be
  // accounted for in order. An extra native-authored duplicate makes it ambiguous.
  const legacy = new Map<number, CodexOrigin>()
  const direct = items.map((item, index) => item.role === 'user'
    ? origins.find(origin => origin.messageId === selected[index]?.id) ?? messageOrigin(origins, turnId, item) : undefined)
  const claimed = new Set(direct.filter(origin => origin !== undefined))
  for (const hash of new Set((corroborated ? origins : []).filter(origin => origin.turnId === turnId && origin.itemId && !origin.clientIdentity && !claimed.has(origin)).map(origin => origin.digest))) {
    const candidates = origins.filter(origin => origin.turnId === turnId && origin.itemId && !origin.clientIdentity && !claimed.has(origin) && origin.digest === hash)
    const slots = items.flatMap((item, index) => item.role === 'user' && item.digest === hash && !item.clientId && !direct[index] && !selected[index] ? [index] : [])
    if (slots.length === candidates.length) slots.forEach((slot, index) => legacy.set(slot, candidates[index]!))
  }
  const resolved = items.map((item, index) => {
    const origin = direct[index] ?? legacy.get(index)
    let record = selected[index]
    if (!record) {
      const native = corroborated ? rollout[index]?.nativeId : undefined
      record = messageIdentity(turns, turn, item, origin, createdAt, terminal || item.role === 'user', native ?? (corroborated ? rollout[index]?.eventId : undefined) ?? item.id)
      if (native) bindNativeId(record, native)
    } else {
      bindNativeId(record, item.id)
      // An in-progress snapshot can lag a completed live item. Learn its alias
      // without discarding the completion evidence or replacing its content hash.
      if (terminal || item.role === 'user' || !record.complete) {
        record.complete = terminal || item.role === 'user'; record.digest = item.digest
      }
    }
    if (corroborated && rollout[index]?.eventId) bindNativeId(record, rollout[index]!.eventId!)
    if (origin) {
      origin.itemId ??= item.id; origin.turnId = turnId
    }
    return record
  })
  // Preserve unmatched live records until exact evidence resolves them. They are
  // not candidates for positional guessing on the next snapshot.
  const unmatched = old.filter(record => !resolved.includes(record))
  turn.messages = [...resolved, ...unmatched]
  turn.ordered = unmatched.length === 0
  turn.sealed = terminal
  return resolved
}
