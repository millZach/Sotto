// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const MODES = [
  { id: 'ask', name: 'Ask', description: 'Asks first.', asks: 'Before each edit.', allows: 'nothing' as const },
  { id: 'edit', name: 'Edit', description: 'Edits freely.', asks: 'Rarely.', allows: 'edits' as const },
]
const devin = (index: number): AgentModel => ({ id: `devin-${index}`, provider: 'Devin', providerId: 'devin', name: `Devin ${index}`, ready: true, providerModes: MODES, supportsImages: false, reasoningEfforts: [] })
const claude = (index: number): AgentModel => ({ id: `claude-${index}`, provider: 'Claude', providerId: 'claude', name: `Claude ${index}`, ready: true })

function state(root: string): AgentHostSnapshot {
  return {
    ...structuredClone(EMPTY_AGENT_HOST), name: 'Fake provider', version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: root }],
    models: [devin(0), devin(1), devin(2), claude(0), claude(1)],
    threads: [{ id: 'thread-1', projectId: 'project', title: 'Synthetic thread', modelId: 'devin-1', providerMode: 'edit', status: 'idle', messages: [], requests: [] } satisfies AgentThread],
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(enabled: boolean, directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'sotto-catalog-flush-'))
  if (directory === undefined) cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-catalog-flush-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  const adapter = new FakeProviderHost(state(root))
  const host = new WorkspaceHost(adapter, root, () => true, undefined, false, false, enabled)
  cleanup.push(async () => { host.disconnect(); host.dispose() })
  await host.initialize()
  return { root, adapter, host }
}

describe('the catalog in the workspace flush (#991 step 2)', () => {
  it('writes workspace.json compact with a provider\u2019s modes stored once, and reads them back onto every model', async () => {
    const { root, host } = await fixture(true)
    await host.connect()
    await host.flush()
    const text = await readFile(join(root, 'workspace.json'), 'utf8')
    expect(text).not.toContain('\n  "')
    expect(text.split('"providerModes"')).toHaveLength(2)
    host.disconnect(); host.dispose()

    // The other track reads the same file: modes are back on every Devin model before any provider connects.
    const reopened = await fixture(false, root)
    const models = reopened.host.workspaceSnapshot().models
    for (const model of models.filter(model => model.providerId === 'devin')) expect(model.providerModes).toEqual(MODES)
  })

  it('does not rewrite the file when a flush changed no organization', async () => {
    const { root, adapter, host } = await fixture(true)
    await host.connect()
    await host.flush()
    const before = await readFile(join(root, 'workspace.json'), 'utf8')
    const writes = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized')
    adapter.emit()
    await host.flush()
    expect(writes).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'workspace.json'), 'utf8')).toBe(before)
  })

  it('writes workspace.json as stable always has while the Owl feature is off', async () => {
    const { root, host } = await fixture(false)
    await host.connect()
    await host.flush()
    const text = await readFile(join(root, 'workspace.json'), 'utf8')
    expect(text).toContain('\n  "')
    expect(text.split('"providerModes"')).toHaveLength(4)
  })
})
