// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../../src/shared/agents'

import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * A second model beside the fixture's own, missing Allow edits and offering fewer reasoning levels, so a
 * nearest-fit default has something to land on other than the level or mode it was given (issue #347).
 */
class GrokLikeHost extends E2EAgentHost {
  devinModes = false
  attempts: unknown[] = []
  override async execute(command: Parameters<E2EAgentHost['execute']>[0]): ReturnType<E2EAgentHost['execute']> {
    this.attempts.push(command)
    return super.execute(command)
  }
  override async snapshot(): Promise<AgentHostSnapshot> {
    const base = await super.snapshot()
    const grok: AgentHostSnapshot['models'][number] = { id: 'grok:test', provider: 'Grok', providerId: 'grok', name: 'Grok Test', ready: true,
      reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'auto', 'full-access'] }
    const devin = { id: 'devin:test', provider: 'Devin', providerId: 'devin' as const, name: 'Devin Test', ready: true,
      providerModes: [{ id: 'ask-first', name: 'Ask first' }, { id: 'bypass', name: 'Bypass Permissions', asks: 'Sotto asks about nothing.' }] }
    return { ...base, models: [...base.models, grok, ...(this.devinModes ? [devin] : [])] }
  }
}

const roots: string[] = []
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-new-thread-defaults-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function controlFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-new-thread-defaults-')); roots.push(root)
  const host = new GrokLikeHost()
  const credentials = await testCredentials(root, { mode: 'unavailable' });
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
  })
  disposers.push(async () => { control.dispose(); await control.privacyChanged() })
  await control.start(); await control.command({ type: 'connect' })
  return { root, host, control }
}

describe('new-thread defaults applied on create-thread (issue #347)', () => {
  it('leaves a create-thread with nothing configured exactly as before: neither field is sent to the provider', async () => {
    const f = await controlFixture()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Plain', modelId: 'claude:test', managed: false })
    expect(created.error).toBeNull()
    const dispatched = f.host.attempts.find((item): item is { type: string; reasoningEffort?: string; runtimeMode?: string } => (item as { type: string }).type === 'create-thread')
    expect(dispatched).not.toHaveProperty('reasoningEffort')
    expect(dispatched).not.toHaveProperty('runtimeMode')
  })

  it('applies the configured default effort and permission when the caller leaves them unset', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'configure', patch: { newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'full-access' } })
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Defaulted', modelId: 'claude:test', managed: false })
    expect(created.error).toBeNull()
    expect(created.host.threads.find(t => t.id === created.activeThreadId)).toMatchObject({ reasoningEffort: 'high', runtimeMode: 'full-access' })
  })

  it('lets an explicit choice win over the configured default', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'configure', patch: { newThreadReasoningEffort: 'high', newThreadRuntimeMode: 'full-access' } })
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Explicit', modelId: 'claude:test', reasoningEffort: 'low', runtimeMode: 'approval-required', managed: false })
    expect(created.error).toBeNull()
    expect(created.host.threads.find(t => t.id === created.activeThreadId)).toMatchObject({ reasoningEffort: 'low', runtimeMode: 'approval-required' })
  })

  it('starts a provider lacking the chosen permission on its nearest safer mode instead', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'configure', patch: { newThreadRuntimeMode: 'auto-accept-edits' } })
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Grok thread', modelId: 'grok:test', managed: false })
    expect(created.error).toBeNull()
    // Grok has no Allow edits; the nearest safer mode it offers is Ask for approval.
    expect(created.host.threads.find(t => t.id === created.activeThreadId)).toMatchObject({ runtimeMode: 'approval-required' })
  })

  it('maps the chosen reasoning effort onto a model with fewer levels by position', async () => {
    const f = await controlFixture()
    await f.control.command({ type: 'configure', patch: { newThreadModelId: 'claude:test', newThreadReasoningEffort: 'xhigh' } })
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Grok effort', modelId: 'grok:test', managed: false })
    expect(created.error).toBeNull()
    // 'xhigh' sits fourth of five on Claude's list (ratio 3/4); Grok's own list has two levels, landing on 'high'.
    expect(created.host.threads.find(t => t.id === created.activeThreadId)).toMatchObject({ reasoningEffort: 'high' })
  })

  it('starts a provider with its own permission profiles on its first, whatever the configured default is', async () => {
    const f = await controlFixture(); f.host.devinModes = true
    await f.control.command({ type: 'refresh' })
    await f.control.command({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Devin thread', modelId: 'devin:test', managed: false })
    expect(created.error).toBeNull()
    const dispatched = f.host.attempts.find((item): item is { type: string; providerMode?: string } => (item as { type: string }).type === 'create-thread' && (item as { modelId?: string }).modelId === 'devin:test')
    expect(dispatched).toMatchObject({ providerMode: 'ask-first' })
  })
})
