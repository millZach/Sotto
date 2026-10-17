// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { providerTakesSottoTools } from '../../../src/shared/agents'
import { coordinatorSetupThreads } from '../../../src/main/hosts/hostSetupThreads'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'

it('offers host setup only the providers checked for it, whatever else takes Sotto’s tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-setup-models-'))
  try {
    const state = emptyDesktopState()
    state.host.models = [
      { id: 'opencode/model', provider: 'OpenCode', providerId: 'opencode', name: 'OpenCode', ready: true },
      { id: 'codex-model', provider: 'Codex', providerId: 'codex', name: 'Codex', ready: true },
      { id: 'claude-model', provider: 'Claude Code', providerId: 'claude', name: 'Claude', ready: true },
      { id: 'grok-model', provider: 'Grok Build', providerId: 'grok', name: 'Grok', ready: true },
      { id: 'devin-model', provider: 'Devin', providerId: 'devin', name: 'Devin', ready: true },
      { id: 'muse-model', provider: 'Muse', providerId: 'muse', name: 'Muse', ready: true },
    ]
    // OpenCode takes Sotto's tools (ADR-0087), but nobody has checked it running a host setup: #1107 decides that.
    expect(providerTakesSottoTools('opencode')).toBe(true)
    const command = vi.fn(async () => undefined)
    const threads = coordinatorSetupThreads({ coordinator: { shell: () => state, command, subscribe: () => () => undefined }, folder: root, localHostRunning: true })
    expect(threads.choice().models.map(model => model.id)).toEqual(['codex-model', 'claude-model', 'grok-model'])
    await expect(threads.start({ title: 'Set up synthetic host', modelId: 'opencode/model', brief: 'Synthetic brief', created: vi.fn() }))
      .rejects.toThrow('That model cannot set up a host.')
    expect(command).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
