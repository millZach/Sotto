// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { deferred } from '../../fixtures/deferred'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
const gates = [
  { watcherEnabled: false, museEnabled: false },
  { watcherEnabled: true, museEnabled: false },
  { watcherEnabled: false, museEnabled: true },
  { watcherEnabled: true, museEnabled: true },
]
const gatedStartup = gates.filter(({ watcherEnabled, museEnabled }) => !watcherEnabled || !museEnabled)

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture({ watcherEnabled, museEnabled }: typeof gates[number]) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-lifecycle-'))
  const adapter = new FakeProviderHost()
  const host = new WorkspaceHost(adapter, root, () => true, undefined, watcherEnabled, museEnabled)
  cleanup.push(async () => {
    host.dispose()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-workspace-lifecycle-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  return { root, adapter, host }
}

describe('workspace observation at shutdown', () => {
  it.each(gates.flatMap(gate => ['close', 'dispose'].map(stop => ({ ...gate, stop }))))(
    'ignores observation after $stop starts with Watcher=$watcherEnabled and Muse=$museEnabled', async gate => {
      const f = await fixture(gate)
      await f.host.initialize()
      const observed = vi.spyOn(f.adapter, 'observeThreads')
      // Reject forbidden startup instead of allowing the old resolved-promise loop to starve the test runner.
      const initialize = vi.spyOn(f.host, 'initialize').mockRejectedValue(new Error('Startup is forbidden after shutdown'))
      let closing: Promise<void> | undefined
      if (gate.stop === 'close') closing = f.host.close()
      else f.host.dispose()

      f.host.observeThreads(['session-workshop'])
      await closing
      await Promise.resolve()

      expect(initialize).not.toHaveBeenCalled()
      expect(observed).not.toHaveBeenCalled()
    },
  )

  it.each(gatedStartup)('drops an already-queued observation across disposal with Watcher=$watcherEnabled and Muse=$museEnabled', async gate => {
    const f = await fixture(gate)
    const observed = vi.spyOn(f.adapter, 'observeThreads')
    const initialized = f.host.initialize()
    const release = deferred()
    const queued = initialized.then(() => release.promise)
    // Keep the first real startup result behind a barrier, and make a forbidden second startup finite.
    const initialize = vi.spyOn(f.host, 'initialize')
      .mockImplementationOnce(() => queued)
      .mockRejectedValue(new Error('Repeated startup is forbidden after shutdown'))
    f.host.observeThreads(['session-workshop'])
    expect(initialize).toHaveBeenCalledTimes(1)

    try {
      await initialized
      f.host.dispose()
    } finally { release.resolve() }
    await queued
    await Promise.resolve()

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(observed).not.toHaveBeenCalled()
  })

  it.each(gatedStartup)('still reads dormant gates before observing during startup with Watcher=$watcherEnabled and Muse=$museEnabled', async gate => {
    const f = await fixture(gate)
    const snapshot = globalThis.structuredClone(f.adapter.state)
    const thread = snapshot.threads[0]!
    snapshot.threads = [
      { ...thread, id: 'ordinary', kind: 'project', providerId: 'codex' },
      { ...thread, id: 'watcher', kind: 'watcher', providerId: 'codex' },
      { ...thread, id: 'muse', kind: 'project', providerId: 'muse' },
    ]
    await writeFile(join(f.root, 'workspace.json'), JSON.stringify({ snapshot, projectAliases: [], creations: [] }))
    const initialize = vi.spyOn(f.host, 'initialize')
    const observed = vi.spyOn(f.adapter, 'observeThreads')

    f.host.observeThreads(['ordinary', 'watcher', 'muse'])
    expect(observed).not.toHaveBeenCalled()
    expect(initialize).toHaveBeenCalledTimes(1)
    await initialize.mock.results[0]!.value

    expect(observed).toHaveBeenCalledExactlyOnceWith([
      'ordinary', ...(gate.watcherEnabled ? ['watcher'] : []), ...(gate.museEnabled ? ['muse'] : []),
    ])
  })
})
