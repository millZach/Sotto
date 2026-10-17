// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { watcherReceiptReplies } from '../../../src/main/agents/watcherReceiptReplies'
import { WATCHER_WAKE_UP_PROMPT } from '../../../src/main/agents/watcherNews'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, type WatcherOperation, type WatcherRecord } from '../../../src/shared/watcher'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-16T10:00:00.000Z'
const watcher = { hostId: HOST, threadId: 'watcher' }
const user = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'user', text: `Asked ${id}`, createdAt: AT, ...extra })
const reply = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'assistant', text: `Replied ${id}`, createdAt: AT, ...extra })
const wakeUp = (id: string): AgentMessage => user(id, { text: WATCHER_WAKE_UP_PROMPT, wakeUp: true })

function operation(id: string, promptTurnId: string | undefined, threadId = 'worker'): WatcherOperation {
  return { id, requestId: '22222222-2222-4222-8222-222222222222', retryKey: '33333333-3333-4333-8333-333333333333', digest: '0'.repeat(64),
    ...(promptTurnId ? { promptTurnId } : {}), action: 'send', target: { hostId: HOST, threadId }, generation: 0, deliveryState: 'accepted',
    createdAt: AT, updatedAt: AT, receiptId: `receipt-${id}`, cardId: `card-${id}` }
}

function record(turns: Record<string, string>, operations: WatcherOperation[]): WatcherRecord {
  const value = emptyWatcherRecord()
  value.current = { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '44444444-4444-4444-8444-444444444444', createdAt: AT }
  value.promptTurns = Object.entries(turns).map(([id, root]) => ({ id, watcher, rootUserMessageId: root, createdAt: AT }))
  value.operations = operations
  return value
}
const thread = (messages: AgentMessage[]): AgentThread => ({ id: 'watcher', kind: 'watcher', projectId: 'project', title: 'Watcher', modelId: 'codex:gpt', status: 'idle', messages, requests: [] })

describe('where a receipt shows in Watcher’s conversation', () => {
  it('goes under the last reply of the turn that took it, never another turn’s', () => {
    const placed = watcherReceiptReplies(record({ first: 'u1', second: 'u2' }, [operation('a', 'first'), operation('b', 'first', 'other'), operation('c', 'second')]),
      thread([user('u1'), reply('r1'), reply('r1-final'), user('u2'), reply('r2')]))
    expect(placed).toEqual([{ operationId: 'a', messageId: 'r1-final' }, { operationId: 'b', messageId: 'r1-final' }, { operationId: 'c', messageId: 'r2' }])
  })

  it('goes under the turn’s own message until its reply comes, and nowhere for a hidden wake-up with none yet', () => {
    const placed = watcherReceiptReplies(record({ asked: 'u1', woke: 'w1' }, [operation('a', 'asked'), operation('b', 'woke')]),
      thread([user('u1'), wakeUp('w1')]))
    expect(placed).toEqual([{ operationId: 'a', messageId: 'u1' }])
  })

  it('follows a wake-up’s turn to the reply the transcript shows, since the wake-up itself is not shown', () => {
    const placed = watcherReceiptReplies(record({ woke: 'w1' }, [operation('a', 'woke')]),
      thread([user('u1'), reply('r1'), wakeUp('w1'), reply('r2'), reply('', { id: 'visual:1', visual: undefined, text: '' })]))
    expect(placed).toEqual([{ operationId: 'a', messageId: 'r2' }])
  })

  it('stays under the reply that took the action when a hidden wake-up’s turn replies after it', () => {
    // R1 starts a worker; a wake-up the user is not shown begins another turn; R2 reports progress. R1 took the action.
    const placed = watcherReceiptReplies(record({ asked: 'u1', woke: 'w1' }, [operation('a', 'asked'), operation('b', 'woke')]),
      thread([user('u1'), reply('r1'), wakeUp('w1'), reply('r2')]))
    expect(placed).toEqual([{ operationId: 'a', messageId: 'r1' }, { operationId: 'b', messageId: 'r2' }])
  })

  it('goes under the turn’s reply when the user wrote before it came, never under a message of the user’s', () => {
    const placed = watcherReceiptReplies(record({ asked: 'u1' }, [operation('a', 'asked')]), thread([user('u1'), user('u2'), reply('r1')]))
    expect(placed).toEqual([{ operationId: 'a', messageId: 'r1' }])
    // A wake-up's turn is never crossed for a reply: the card waits under the turn's own message.
    expect(watcherReceiptReplies(record({ asked: 'u1' }, [operation('a', 'asked')]), thread([user('u1'), wakeUp('w1'), reply('r2')])))
      .toEqual([{ operationId: 'a', messageId: 'u1' }])
  })

  it('places nothing without a recorded turn, for another Watcher, or for a turn no longer in the conversation', () => {
    const value = record({ gone: 'u0', mine: 'u1' }, [operation('a', undefined), operation('b', 'gone'), operation('c', 'elsewhere')])
    value.promptTurns!.push({ id: 'elsewhere', watcher: { hostId: HOST, threadId: 'older-watcher' }, rootUserMessageId: 'u1', createdAt: AT })
    expect(watcherReceiptReplies(value, thread([user('u1'), reply('r1')]))).toEqual([])
    expect(watcherReceiptReplies({ ...value, current: null }, thread([user('u1'), reply('r1')]))).toEqual([])
  })
})
