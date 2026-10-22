// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentState, AgentThread, AgentThreadDetailUpdate } from '../../../src/shared/agents'
import { agentActivitySignature } from '../../../src/shared/agentThreadDetail'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * A thread detail's revision is worked out from what changed on each broadcast (#1334): the messages are compared in place
 * against what the last revision read, and a wake-up of delegation news alone is known by its own mark, so an unchanged pane
 * keeps its revision without a deep comparison of its history, a projection of it, or a signature of its certified records.
 * It moves at exactly the moments the history-sized signature it replaces did.
 */
const work = vi.hoisted(() => ({ samePlainValue: 0, withoutHiddenWakeUps: 0, activitySignatures: 0 }))
vi.mock('../../../src/main/agents/hiddenWakeUpDisplay', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/agents/hiddenWakeUpDisplay')>()
  return { ...original,
    samePlainValue: (left: unknown, right: unknown) => { work.samePlainValue++; return original.samePlainValue(left, right) },
    withoutHiddenWakeUps: (messages: Parameters<typeof original.withoutHiddenWakeUps>[0]) => { work.withoutHiddenWakeUps++; return original.withoutHiddenWakeUps(messages) } }
})
vi.mock('../../../src/shared/agentThreadDetail', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/shared/agentThreadDetail')>()
  return { ...original, agentActivitySignature: (record: AgentActivity) => { work.activitySignatures++; return original.agentActivitySignature(record) } }
})

type Internals = { detailRevision(thread: AgentThread): number; state: AgentState; viewedThreadIds: string[]; broadcastDetail(): void
  detailMessageKeys: Map<string, unknown>; detailRevisions: Map<string, unknown>; certifiedDetailRevisions: Map<string, unknown>
  subscribeThreadDetail: AgentControl['subscribeThreadDetail']; privacyChanged: AgentControl['privacyChanged'] }
const controls: AgentControl[] = [], roots: string[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-detail-revision-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
function fixture(gate: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'sotto-detail-revision-')); roots.push(directory)
  const control = createAgentControl({ directory, host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never, streamingPublishCost: gate })
  controls.push(control)
  return control as unknown as Internals
}

const at = '2026-10-22T00:00:00.000Z'
const record = (id: string, output = 'first'): AgentActivity => ({ id, turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Synthetic', output })
const message = (id: string, text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'assistant', text, createdAt: at, ...extra })
/** A delegating thread: one wake-up of news alone, which no window or phone shows, among its messages. */
function delegating(): AgentThread {
  return { id: 'thread', projectId: 'project', title: 'Synthetic', modelId: 'fake', status: 'running', historyEpoch: 'epoch',
    messages: [message('prompt', 'Synthetic prompt', { role: 'user' }), message('news', 'Synthetic news', { role: 'user', wakeUp: true, hiddenWakeUp: true }), message('reply', 'First')],
    hiddenWakeUpMessageIds: ['news'], wakeUpMessageIds: ['news'], requests: [], activities: immutableActivities([record('one'), record('two')]) }
}
/** What a publish hands the coordinator: every message a new copy of the same one, certified records shared. */
const published = (thread: AgentThread): AgentThread => ({ ...thread, messages: structuredClone(thread.messages) })

/** The history-sized signature the revision was worked out from before #1334, to check it moves at the same moments. */
function previousSignature(thread: AgentThread): string {
  const hidden = Boolean(thread.hiddenWakeUpMessageIds?.length) && thread.messages.some(item => item.hiddenWakeUp === true)
  const shown = hidden ? new Map(thread.messages.filter(item => item.hiddenWakeUp !== true).map(item => [item.id, item.text.length])) : undefined
  return `${thread.historyEpoch ?? ''}|${thread.messages.length}|` + thread.messages
    .map(item => `${item.id}:${item.text.length}:${shown ? shown.get(item.id) ?? -1 : item.text.length}:${item.attachments?.length ?? 0}`).join(',')
    + '|' + (thread.activities ?? []).map(item => `${item.id}:${agentActivitySignature(item)}`).join(',')
}

describe.each([['under the streaming cost gate', true], ['without it', false]] as const)('a detail revision %s', (_name, gate) => {
  it('keeps an unchanged pane at its revision without comparing its history deeply or signing its certified records', () => {
    const control = fixture(gate), value = delegating()
    control.state.host.threads = [value]; control.viewedThreadIds = [value.id]
    const updates: AgentThreadDetailUpdate[] = []
    const off = control.subscribeThreadDetail(update => updates.push(update))
    try {
      control.broadcastDetail()
      const first = updates.at(-1)!
      expect(first.revision).toBeGreaterThan(0)
      if ('messages' in first) expect(first.messages.map(item => item.id)).toEqual(['prompt', 'reply'])
      work.samePlainValue = 0; work.withoutHiddenWakeUps = 0; work.activitySignatures = 0
      for (let publish = 0; publish < 5; publish++) {
        control.state.host.threads = [published(value)]
        control.broadcastDetail()
        expect(control.detailRevision(control.state.host.threads[0]!)).toBe(first.revision)
      }
      expect(updates).toHaveLength(1)
      expect(work).toEqual({ samePlainValue: 0, withoutHiddenWakeUps: 0, activitySignatures: 0 })
    } finally { off() }
  })

  it('moves once for each kind of change, and only when the signature it replaces would have', () => {
    const control = fixture(gate)
    let value = delegating()
    let revision = control.detailRevision(value), signature = previousSignature(value)
    const changes: [string, (thread: AgentThread) => void][] = [
      ['a chunk added to a message', thread => { thread.messages.at(-1)!.text += ' more' }],
      ['a message arriving', thread => { thread.messages.push(message('next', 'Second')) }],
      ['a message going', thread => { thread.messages.pop() }],
      ['a message replaced by another of the same length', thread => { thread.messages[2] = message('other', thread.messages[2]!.text) }],
      ['an attachment', thread => { thread.messages[0]!.attachments = [{ id: 'image', name: 'image.png', mimeType: 'image/png', size: 1 }] as never }],
      ['a wake-up hidden', thread => { thread.messages[0]!.hiddenWakeUp = true; thread.hiddenWakeUpMessageIds = ['news', 'prompt'] }],
      ['a hidden wake-up shown again', thread => { delete thread.messages[1]!.hiddenWakeUp }],
      ['the last hidden mark gone', thread => { delete thread.messages[0]!.hiddenWakeUp; thread.hiddenWakeUpMessageIds = [] }],
      ['a mark with no list behind it', thread => { thread.messages[1]!.hiddenWakeUp = true }],
      ['the list again', thread => { thread.hiddenWakeUpMessageIds = ['news'] }],
      ['a new history epoch', thread => { thread.historyEpoch = 'reset' }],
      ['an activity record changing', thread => { thread.activities = immutableActivities([{ ...thread.activities![0]!, output: 'longer output' }, thread.activities![1]!]) }],
      ['an activity record replaced by an equal one', thread => { thread.activities = immutableActivities(structuredClone(thread.activities!)) }],
      ['an activity record arriving', thread => { thread.activities = immutableActivities([...thread.activities!, record('three')]) }],
      ['the records turning mutable unchanged', thread => { thread.activities = structuredClone(thread.activities) }],
      ['a mutable record edited in place', thread => { thread.activities![0]!.output = 'edited' }],
      ['the records certified again unchanged', thread => { thread.activities = immutableActivities(thread.activities!) }],
      ['the history emptied', thread => { thread.messages = [] }],
    ]
    for (const [name, change] of changes) {
      value = published(value); change(value)
      const next = control.detailRevision(value), moved = previousSignature(value) !== signature
      expect(next, name).toBe(revision + (moved ? 1 : 0))
      expect(control.detailRevision(published(value)), `${name}, read again`).toBe(next)
      revision = next; signature = previousSignature(value)
    }
  })
})

it('drops what it read of a pane with the pane under the gate, and on a privacy change', async () => {
  const control = fixture(true), value = delegating()
  control.state.host.threads = [value]; control.viewedThreadIds = [value.id]
  const off = control.subscribeThreadDetail(() => undefined)
  try {
    control.broadcastDetail()
    expect(control.detailMessageKeys.has(value.id)).toBe(true)
    control.viewedThreadIds = []; control.broadcastDetail()
    expect(control.detailMessageKeys.size).toBe(0)
    expect(control.detailRevisions.size + control.certifiedDetailRevisions.size).toBe(0)
    control.detailRevision(value)
    expect(control.detailMessageKeys.size).toBe(1)
    await control.privacyChanged()
    expect(control.detailMessageKeys.size).toBe(0)
  } finally { off() }
})
