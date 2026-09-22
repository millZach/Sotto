// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const watch = { id: '59356467-cb76-41bb-8bdf-ab3b89936c90', label: 'Watch the private deployment' }
const agent = { id: '0d5c4b7e-3f5a-4f0e-8a51-2b8f1c9d7e60', label: 'Review the private diff', type: 'subagent' as const }

it('publishes live watches but never saves or restores them, including from older workspace files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-monitoring-workspace-'))
  const native = new FakeProviderHost()
  const host = new WorkspaceHost(native, directory)
  cleanup.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
  await host.connect()
  native.state.threads[0]!.monitoring = [watch]
  native.emit()
  expect(host.workspaceSnapshot().threads[0]?.monitoring).toEqual([watch])
  await host.snapshot()
  const persisted = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
  expect(persisted.snapshot.threads[0].monitoring).toBeUndefined()
  persisted.snapshot.threads[0].monitoring = [watch]
  host.dispose()
  await writeFile(join(directory, 'workspace.json'), JSON.stringify(persisted))
  const reopened = new WorkspaceHost(new FakeProviderHost(), directory)
  cleanup.push(async () => { reopened.dispose() })
  await reopened.initialize()
  expect(reopened.workspaceSnapshot().threads[0]?.monitoring).toBeUndefined()
})

it('clears disconnected watches without reviving them from retained thread snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-monitoring-workspace-'))
  const native = new FakeProviderHost()
  const host = new WorkspaceHost(native, directory)
  cleanup.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
  await host.connect()
  native.state.threads[0]!.monitoring = [watch]
  native.emit()
  expect(host.workspaceSnapshot().threads[0]?.monitoring).toHaveLength(1)
  host.disconnect()
  expect(host.workspaceSnapshot().threads[0]?.monitoring).toBeUndefined()
})

it('publishes background work but never saves, restores or keeps it past a disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-monitoring-workspace-'))
  const native = new FakeProviderHost()
  const host = new WorkspaceHost(native, directory)
  cleanup.push(async () => { host.dispose(); await rm(directory, { recursive: true, force: true }) })
  await host.connect()
  native.state.threads[0]!.backgroundWork = [agent]
  native.emit()
  expect(host.workspaceSnapshot().threads[0]?.backgroundWork).toEqual([agent])
  await host.snapshot()
  const persisted = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
  expect(persisted.snapshot.threads[0].backgroundWork).toBeUndefined()
  expect(JSON.stringify(persisted)).not.toContain(agent.label)
  host.disconnect()
  expect(host.workspaceSnapshot().threads[0]?.backgroundWork).toBeUndefined()
  persisted.snapshot.threads[0].backgroundWork = [agent]
  host.dispose()
  await writeFile(join(directory, 'workspace.json'), JSON.stringify(persisted))
  const reopened = new WorkspaceHost(new FakeProviderHost(), directory)
  cleanup.push(async () => { reopened.dispose() })
  await reopened.initialize()
  expect(reopened.workspaceSnapshot().threads[0]?.backgroundWork).toBeUndefined()
})
