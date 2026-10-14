// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { immutableActivities, isImmutableActivities } from '../../../src/main/agents/activitySnapshots'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { watcherDisplayPrompt, type WatcherMessageDisplay } from '../../../src/main/agents/watcherMessageDisplay'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread, AgentThreadDetail, AgentThreadDetailUpdate } from '../../../src/shared/agents'
import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../src/shared/agentThreadDetail'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { watcherRecordFixture } from '../../fixtures/watcher'

const record = (id: string, output = 'first'): AgentActivity => ({ id, turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Synthetic', output, steps: [{ text: 'first', status: 'running' }] })
const thread = (): AgentThread => ({ id: 'thread', projectId: 'project', title: 'Synthetic', modelId: 'fake', status: 'running', messages: [], requests: [], activities: immutableActivities([record('one'), record('two')]) })
function fixture(enabled: boolean, directory = '', watcherEnabled = true) {
  const control = createAgentControl({ directory, host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never, streamingPublishCost: enabled, watcherEnabled })
  const detail = control as unknown as { detailRevision(thread: AgentThread): number; detailUpdate(thread: AgentThread, revision: number): AgentThreadDetailUpdate; detailSnapshots: Map<string, AgentThreadDetail>; state: AgentState; viewedThreadIds: string[]; broadcastDetail(): void; certifiedDetailRevisions: Map<string, { activities: readonly AgentActivity[] }>; detailRevisions: Map<string, unknown>; certifiedDetailCounters: Map<string, number>; watcherMessageDisplay?: WatcherMessageDisplay }
  return { control, detail, publish(value: AgentThread) { const revision = detail.detailRevision(value); return { revision, update: detail.detailUpdate(value, revision) } } }
}

describe('certified activity detail under the streaming cost gate', () => {
  it.each([false, true])('releases a publicly read detail on close without a subscriber, with Watcher %s', async watcherEnabled => {
    const f = fixture(true, '', watcherEnabled), value = thread()
    try {
      f.detail.state.host.threads = [value]
      await f.control.commandShell({ type: 'observe-threads', threadIds: [value.id] })
      const cached = f.control.threadDetail(value.id)!
      expect(f.detail.detailSnapshots.size).toBe(1)
      expect(isImmutableActivities(f.detail.certifiedDetailRevisions.get(value.id)?.activities)).toBe(true)
      await f.control.commandShell({ type: 'observe-threads', threadIds: [] })
      expect(f.detail.detailSnapshots.size).toBe(0)
      expect(f.detail.certifiedDetailRevisions.size).toBe(0)
      expect(f.detail.detailRevisions.size).toBe(0)
      expect(f.detail.certifiedDetailCounters.get(value.id)).toBe(cached.revision)
      await f.control.commandShell({ type: 'observe-threads', threadIds: [value.id] })
      expect(f.control.threadDetail(value.id)!.revision).toBeGreaterThan(cached.revision)
      value.activities = structuredClone(value.activities)
      const mutable = f.control.threadDetail(value.id)!
      expect(f.detail.certifiedDetailRevisions.size).toBe(0)
      expect(f.detail.detailRevisions.size).toBe(1)
      await f.control.commandShell({ type: 'observe-threads', threadIds: [] })
      expect(f.detail.detailSnapshots.size).toBe(0)
      expect(f.detail.certifiedDetailRevisions.size).toBe(0)
      expect(f.detail.detailRevisions.size).toBe(0)
      expect(f.detail.certifiedDetailCounters.get(value.id)).toBe(mutable.revision)
      await f.control.commandShell({ type: 'observe-threads', threadIds: [value.id] })
      expect(f.control.threadDetail(value.id)!.revision).toBeGreaterThan(mutable.revision)
    } finally { f.control.dispose() }
  })

  it.each([false, true])('publishes changed Watcher proof with unchanged native lengths, with streaming cost %s', enabled => {
    const f = fixture(enabled), value = thread(), record = watcherRecordFixture(), request = record.requests[0]!
    const original = 'Inspect the synthetic project', wire = `${original}\n\nSynthetic native-only routing context`
    const proof = watcherDisplayPrompt(original, wire)
    value.id = request.watcher.threadId; value.kind = 'watcher'
    value.messages = [{ id: request.rootUserMessageId, role: 'user', text: wire, createdAt: request.createdAt }]
    request.displayPrompt = proof
    f.detail.state.host.hostId = request.watcher.hostId
    f.detail.state.host.threads = [value]; f.detail.viewedThreadIds = [value.id]
    const updateProof = () => f.detail.watcherMessageDisplay!.update(record.requests)
    updateProof()
    let held = f.control.threadDetail(value.id)!
    expect(held.messages[0]!.text).toBe(original)
    expect(f.detail.certifiedDetailRevisions.has(value.id)).toBe(enabled)
    if (enabled) expect(isImmutableActivities(f.detail.certifiedDetailRevisions.get(value.id)!.activities)).toBe(true)
    const invalid: AgentThreadDetailUpdate[] = []
    const off = f.control.subscribeThreadDetail(update => {
      const next = isAgentThreadDetailDelta(update) ? applyAgentThreadDetailDelta(held, update) : update
      if (next === null) invalid.push(update); else held = next
    })
    const publish = (expected: string) => {
      const previous = held.revision
      updateProof(); f.detail.broadcastDetail()
      expect(held.revision).toBeGreaterThan(previous)
      expect(held.messages[0]!.text).toBe(expected)
      expect(f.detail.detailSnapshots.get(value.id)!.messages[0]!.text).toBe(expected)
    }
    try {
      request.displayPrompt = { ...proof, wireDigest: '0'.repeat(64) }; publish(wire)
      expect(value.messages[0]!.text).toBe(wire)
      request.displayPrompt = proof; publish(original)
      delete request.displayPrompt; publish(wire)
      request.displayPrompt = proof; publish(original)
      value.messages[0]!.text = 'i' + wire.slice(1); publish(value.messages[0]!.text)
      expect(value.messages[0]!.text.length).toBe(wire.length)
      value.messages[0]!.text = wire; publish(original)
      expect(invalid).toEqual([])
      expect(value.messages[0]!.text).toBe(wire)
    } finally { off(); f.control.dispose() }
  })

  it('reopens above a client-held revision while releasing the closed pane records and signatures', () => {
    const f = fixture(true), value = thread()
    const updates: AgentThreadDetailUpdate[] = []
    const off = f.control.subscribeThreadDetail(update => updates.push(update))
    try {
      f.detail.state.host.threads = [value]
      f.detail.viewedThreadIds = [value.id]
      let cached = f.publish(value).revision
      for (let i = 0; i < 3; i++) {
        value.activities = immutableActivities([{ ...value.activities![0]!, output: 'first' + '!'.repeat(i + 1) }])
        cached = f.publish(value).revision
      }
      f.detail.viewedThreadIds = []; f.detail.broadcastDetail()
      expect(f.detail.detailSnapshots.size).toBe(0)
      expect(f.detail.certifiedDetailRevisions.size).toBe(0)
      expect(f.detail.detailRevisions.size).toBe(0)
      value.activities = immutableActivities([{ ...value.activities![0]!, output: 'Changed while closed' }])
      f.detail.viewedThreadIds = [value.id]; f.detail.broadcastDetail()
      expect(updates.at(-1)?.revision).toBeGreaterThan(cached)
      expect(updates.at(-1)).toMatchObject({ activities: [{ output: 'Changed while closed' }] })
    } finally { off(); f.control.dispose() }
  })

  it('keeps revisions monotonic when privacy cleanup releases a client-held detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-certified-detail-privacy-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-certified-detail-privacy-')) throw new Error('Unexpected fixture directory')
    const f = fixture(true, root), value = thread()
    try {
      f.publish(value)
      value.activities = immutableActivities([{ ...value.activities![0]!, output: 'longer output' }])
      const cached = f.publish(value).revision
      await f.control.privacyChanged()
      expect(f.detail.detailSnapshots.size).toBe(0)
      expect(f.detail.certifiedDetailRevisions.size).toBe(0)
      value.activities = immutableActivities([record('new', 'Fresh output after cleanup')])
      const next = f.publish(value)
      expect(next.revision).toBeGreaterThan(cached)
      expect(next.update).toMatchObject({ activities: [{ output: 'Fresh output after cleanup' }] })
    } finally { f.control.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
  })

  it('matches stable revisions and payloads through replacements, reorders, trims, resets and certification changes', () => {
    const stable = fixture(false), owl = fixture(true), value = thread()
    const check = () => expect(owl.publish(value)).toEqual(stable.publish(value))
    try {
      check(); check()
      value.activities = immutableActivities([...value.activities!.slice(0, 1), { ...value.activities![1]!, output: 'longer output' }]); check()
      // A same-length text replacement keeps the existing signature trade exactly.
      value.activities = immutableActivities(value.activities!.map(item => ({ ...item, output: item.output!.replace(/./g, 'z') }))); check()
      value.activities = immutableActivities([...value.activities!].reverse()); check()
      value.activities = immutableActivities(value.activities!.slice(0, 1)); check()
      value.activities = structuredClone(value.activities); check()
      value.activities![0]!.steps![0]!.status = 'completed'; check()
      value.activities = immutableActivities(value.activities!); check()
      value.activities = undefined; check()
      value.historyEpoch = 'reset'; value.activities = immutableActivities([]); check()
      value.messages = [{ id: 'reply', role: 'assistant', text: 'First', createdAt: '2026-10-13' }]; check()
      value.messages[0]!.text += ' more'; check()
      value.activities = structuredClone(value.activities); check()
      value.activities = immutableActivities(value.activities!); check()
    } finally { stable.control.dispose(); owl.control.dispose() }
  })

  it('keeps a public whole detail and delta writable without granting either authority over its baseline', () => {
    const f = fixture(true), value = thread()
    try {
      const whole = f.publish(value).update
      if ('messageDeltas' in whole) throw new Error('Expected whole detail')
      whole.activities![0]!.output = 'caller edits'
      expect(f.detail.detailSnapshots.get(value.id)?.activities?.[0]?.output).toBe('first')
      value.activities = immutableActivities([{ ...value.activities![0]!, output: 'longer' }, value.activities![1]!])
      const delta = f.publish(value).update
      if (!('activityDeltas' in delta) || !('record' in delta.activityDeltas[0]!)) throw new Error('Expected record delta')
      delta.activityDeltas[0].record.output = 'caller edits again'
      expect(f.detail.detailSnapshots.get(value.id)?.activities?.[0]?.output).toBe('longer')
    } finally { f.control.dispose() }
  })

  it('does not trust an externally frozen array with mutable nested records', () => {
    const stable = fixture(false), owl = fixture(true), value = thread()
    value.activities = Object.freeze([record('one')]) as unknown as AgentActivity[]
    try {
      expect(owl.publish(value)).toEqual(stable.publish(value))
      value.activities[0]!.steps![0]!.text = 'changed nested words'
      expect(owl.publish(value)).toEqual(stable.publish(value))
    } finally { stable.control.dispose(); owl.control.dispose() }
  })
})
