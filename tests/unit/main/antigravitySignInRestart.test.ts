// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createAgentRuntime } from '../../../src/main/agents/runtime'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** Antigravity's place, recording each start and stop; its sign-in is read only when it starts, as `agy`'s is. */
function antigravity() {
  const host = new E2EAgentHost()
  return Object.assign(host, { connect: vi.fn(host.connect.bind(host)), disconnect: vi.fn(host.disconnect.bind(host)) })
}

it('starts a connected Antigravity again on a new sign-in, since a running agy keeps the one it started with (ADR-0211)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-antigravity-restart-')); roots.push(root)
  const credentials = await testCredentials(root, { mode: 'xor' })
  const host = antigravity()
  const runtime = await createAgentRuntime({
    directory: root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, openExternal: async () => undefined,
    providers: { codex: new E2EAgentHost(), antigravity: host }, reasoner: e2eAgentReasoner,
  })
  try {
    expect((await runtime.agentControl.command({ type: 'connect', provider: 'antigravity', notice: false })).error).toBeNull()
    const connected = (): string | undefined => runtime.agentControl.get().host.providers?.find(status => status.id === 'antigravity')?.connection
    expect(connected()).toBe('connected')
    host.connect.mockClear(); host.disconnect.mockClear()

    await runtime.agentControl.command({ type: 'configure', patch: { antigravitySignInMethod: 'gemini-api-key' } })
    await vi.waitFor(() => expect(host.connect).toHaveBeenCalledOnce())
    expect(host.disconnect).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(connected()).toBe('connected'))

    host.connect.mockClear(); host.disconnect.mockClear()
    expect((await runtime.agentControl.command({ type: 'credential', slot: 'antigravity', value: 'new-key' })).error).toBeNull()
    await vi.waitFor(() => expect(host.connect).toHaveBeenCalledOnce())
    expect(host.disconnect).toHaveBeenCalledOnce()

    // A setting that is not part of the sign-in leaves it running.
    host.connect.mockClear(); host.disconnect.mockClear()
    await runtime.agentControl.command({ type: 'configure', patch: { museDisableSandbox: true } })
    expect(host.disconnect).not.toHaveBeenCalled()
  } finally { await runtime.close() }
})
