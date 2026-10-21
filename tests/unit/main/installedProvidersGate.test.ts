// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const probes = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), grok: vi.fn(), devin: vi.fn(), muse: vi.fn(), opencode: vi.fn() }))
vi.mock('../../../src/main/agents/subscriptionCodex', () => ({ findExecutable: probes.codex }))
vi.mock('../../../src/main/agents/subscriptionClaude', () => ({ ClaudeSubscriptionClient: class { findExecutable = probes.claude } }))
vi.mock('../../../src/main/agents/grokRpc', () => ({ findGrokExecutable: probes.grok }))
vi.mock('../../../src/main/agents/devinRpc', () => ({ findDevinExecutable: probes.devin }))
vi.mock('../../../src/main/agents/museRpc', () => ({ findMuseExecutable: probes.muse }))
// No OpenCode here, whatever this computer has installed.
vi.mock('../../../src/main/agents/opencodeServer', () => ({ findOpenCodeExecutable: probes.opencode }))
import { detectInstalledProviders } from '../../../src/main/agents/installedProviders'
beforeEach(() => { for (const probe of Object.values(probes)) probe.mockReset().mockResolvedValue('/synthetic/client'); probes.opencode.mockResolvedValue(undefined) })
it.each([undefined, false])('does not even probe Muse installation when the startup gate is %s', async museEnabled => {
  expect(await detectInstalledProviders(museEnabled === undefined ? {} : { museEnabled })).toEqual(['codex', 'claude', 'grok', 'devin'])
  expect(probes.muse).not.toHaveBeenCalled()
})
it('includes an installed Muse only in Owl while preserving ordinary native detection', async () => {
  probes.codex.mockResolvedValue(undefined); probes.devin.mockResolvedValue(undefined)
  expect(await detectInstalledProviders({ museEnabled: true })).toEqual(['claude', 'grok', 'muse'])
  expect(probes.muse).toHaveBeenCalledOnce()
})
it('skips every held provider through the one gate, with a test-only held Grok', async () => {
  expect(await detectInstalledProviders({ heldProviders: new Set(['grok']) })).toEqual(['codex', 'claude', 'devin', 'muse'])
  expect(probes.grok).not.toHaveBeenCalled()
  expect(probes.muse).toHaveBeenCalledOnce()
  expect(await detectInstalledProviders({ heldProviders: new Set(['grok', 'muse']) })).toEqual(['codex', 'claude', 'devin'])
  expect(probes.grok).not.toHaveBeenCalled()
  expect(probes.muse).toHaveBeenCalledOnce()
})
