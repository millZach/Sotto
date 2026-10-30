// @vitest-environment node
/**
 * A thread read hands the workspace the activity records its provider holds certified, rather than deep copies of them
 * (ADR-0016, October 30 amendment). What the workspace keeps from a read must not depend on that: it keeps exactly what it
 * kept when every read came as a copy, at the record limit too, and the records that did not change stay the same objects.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { certifyActivityView, cloneActivitySnapshot, immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { CertifyingProviderHost } from '../../fixtures/certifyingProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A provider whose reads answer with its own certified records, or with deep copies of them as reads once did. */
class ReadingProvider extends CertifyingProviderHost {
  constructor(private readonly copies: boolean) { super() }
  async refreshThread(): Promise<AgentHostSnapshot> {
    certifyActivityView(this.state, this.state.threads)
    return this.copies ? structuredClone(this.state) : cloneActivitySnapshot(this.state)
  }
}

const record = (index: number): AgentActivity => ({ id: `a${index}`, turnId: `t${index}`, sequence: index, kind: 'command', status: 'completed', title: `Command ${index}` })

/**
 * The thread's records after it held a1..a2000, its provider published a0..a1999 (a list at the limit moving), and a
 * read then brought that same list back unchanged: the read reconciles every record it brings, as reads always did.
 */
async function afterRead(copies: boolean): Promise<{ kept: readonly AgentActivity[]; before: readonly AgentActivity[] }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-read-activity-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  const provider = new ReadingProvider(copies)
  const host = new WorkspaceHost(provider, root)
  cleanup.push(async () => { host.dispose() })
  await host.initialize()
  await host.connect()
  const native = provider.state.threads[0]!
  native.activities = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => record(index + 1))
  provider.emit()
  const threadId = host.workspaceSnapshot().threads.find(item => item.title === native.title)!.id
  await expect.poll(() => host.workspaceSnapshot().threads.find(item => item.id === threadId)?.activities?.length).toBe(MAX_AGENT_ACTIVITIES)
  native.activities = immutableActivities([record(0), ...native.activities.slice(0, -1)])
  provider.emit()
  await expect.poll(() => host.workspaceSnapshot().threads.find(item => item.id === threadId)?.activities?.some(item => item.id === 'a0')).toBe(true)
  const heldBefore = (host as unknown as { state: { snapshot: AgentHostSnapshot } }).state.snapshot.threads.find(item => item.id === threadId)!.activities!
  await host.refreshThread(threadId)
  const now = (host as unknown as { state: { snapshot: AgentHostSnapshot } }).state.snapshot
  return { kept: now.threads.find(item => item.id === threadId)!.activities!, before: heldBefore }
}

it('keeps from a read at the record limit exactly what it kept when reads came as copies', async () => {
  const shared = await afterRead(false), copied = await afterRead(true)
  const shape = (records: readonly AgentActivity[]) => records.map(item => ({ id: item.id, sequence: item.sequence, truncated: item.truncated === true }))
  expect(shape(shared.kept)).toEqual(shape(copied.kept))
  expect(JSON.stringify(shared.kept)).toBe(JSON.stringify(copied.kept))
  // And the records the read did not change are the objects the workspace held: nothing downstream sees them as new.
  const held = new Set(shared.before)
  expect(shared.kept.filter(item => held.has(item)).length).toBeGreaterThan(MAX_AGENT_ACTIVITIES - 10)
})
