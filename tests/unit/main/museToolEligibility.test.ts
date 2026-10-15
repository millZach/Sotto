// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { providerTakesSottoTools, providerWritesShortText, threadTakesSottoTools } from '../../../src/shared/agents'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { coordinatorSetupThreads } from '../../../src/main/hosts/hostSetupThreads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

it('offers only tool-capable models for host setup and refuses a stale Muse selection before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-tools-'))
  try {
    const state = emptyDesktopState()
    state.host.models = [
      { id: 'muse-model', provider: 'Muse', providerId: 'muse', name: 'Muse', ready: true },
      { id: 'codex-model', provider: 'Codex', providerId: 'codex', name: 'Codex', ready: true },
    ]
    const command = vi.fn(async () => undefined)
    const threads = coordinatorSetupThreads({ coordinator: { shell: () => state, command, subscribe: () => () => undefined },
      folder: root, localHostRunning: true })
    expect(threads.choice().models.map(model => model.id)).toEqual(['codex-model'])
    await expect(threads.start({ title: 'Set up synthetic host', modelId: 'muse-model', brief: 'Synthetic brief', created: vi.fn() }))
      .rejects.toThrow('That model cannot set up a host.')
    expect(command).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('admits Muse threads to visuals and babysitting in Owl, but offers no side-draft action that cannot run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-tools-'))
  const inner = new FakeProviderHost()
  inner.state.threads[0]!.providerId = 'muse'
  inner.state.threads[1]!.providerId = 'codex'
  const workspace = new WorkspaceHost(inner, root, () => true, undefined, true, true)
  try {
    await workspace.initialize(); await workspace.connect()
    expect(workspace.admitsVisuals('session-workshop')).toBe(true)
    expect(workspace.admitsVisuals('session-docs')).toBe(true)
    expect(workspace.admitsBabysitting('session-workshop')).toBe(true)
    expect(providerTakesSottoTools('muse')).toBe(true)
    expect(providerTakesSottoTools('devin')).toBe(false)
    expect(providerWritesShortText('muse')).toBe(false)
    expect(providerWritesShortText('codex')).toBe(true)
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }) }
})

it('admits no visuals or babysitting for a Muse thread whose client withheld Sotto’s tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-tools-'))
  const inner = new FakeProviderHost()
  inner.state.threads[0]!.providerId = 'muse'
  inner.state.threads[0]!.sottoToolsWithheld = true
  const workspace = new WorkspaceHost(inner, root, () => true, undefined, true, true)
  try {
    await workspace.initialize(); await workspace.connect()
    expect(workspace.admitsVisuals('session-workshop')).toBe(false)
    expect(workspace.admitsBabysitting('session-workshop')).toBe(false)
    expect(threadTakesSottoTools({ providerId: 'muse', sottoToolsWithheld: true })).toBe(false)
    expect(threadTakesSottoTools({ providerId: 'muse' })).toBe(true)
    expect(threadTakesSottoTools(undefined)).toBe(true)
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }) }
})
