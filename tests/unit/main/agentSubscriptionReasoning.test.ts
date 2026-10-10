// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfiguredAgentReasoner } from '../../../src/main/agents/reasoning'
import { AgentControl } from '../../../src/main/agents/control'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration, type SubscriptionProvider } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

const roots: string[] = []
const controls: AgentControl[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-subscription-'))
  roots.push(root)
  const credentials = await testCredentials(root, { mode: 'plain' })

  const configuration = defaultAgentConfiguration()
  const client = {
    status: vi.fn(async () => ({ provider: 'claude' as const, installed: true, ready: true, label: 'Claude Max', detail: 'Connected', models: [] })),

  }
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  return { root, credentials, configuration, client, fetch }
}
afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose())
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-subscription-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Sotto subscription reasoning integration', () => {
  it('migrates old configuration without resetting effort in unrelated settings patches', () => {
    const legacy = Object.fromEntries(Object.entries(defaultAgentConfiguration()).filter(([key]) => key !== 'reasoningEffort'))
    expect(agentConfigurationSchema.parse(legacy).reasoningEffort).toBe('')
    expect(agentCommandSchema.parse({ type: 'configure', patch: { } })).toEqual({ type: 'configure', patch: { } })
  })

  it('checks a newly selected subscription account without a separate connection check', async () => {
    const f = await fixture()
    const grok = { ...f.client, status: vi.fn(async () => ({ provider: 'grok' as const, installed: true, ready: true, label: 'Grok', detail: 'Connected',
      models: [{ id: 'grok-4.6', name: 'Grok 4.6', reasoningEfforts: ['low', 'high'] }] })) }
    const control: AgentControl = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, credentials: f.credentials, host: new E2EAgentHost(),
      reasoner: new ConfiguredAgentReasoner({ claude: f.client, grok }),
    })
    controls.push(control)
    await control.start()
    const published: string[][] = []
    control.subscribe(state => published.push(state.reasoningAccounts.filter(account => account.ready).map(account => account.provider)))
    // Settings saves only the account choice; its model and effort menus need that account's models.
    await control.command({ type: 'configure', patch: { reasoning: 'grok', reasoningModel: '', reasoningEffort: '' } })
    await vi.waitFor(() => expect(published.at(-1)).toContain('grok'))
    expect(grok.status).toHaveBeenCalledTimes(1)
    expect(control.get().reasoningAccounts.find(account => account.provider === 'grok')?.models).toHaveLength(1)
  })

  it('persists a subscription selection, restores its status, and restores account discovery without a key', async () => {
    const f = await fixture()
    let control: AgentControl
    const reasoner = new ConfiguredAgentReasoner({ claude: f.client })
    const start = async () => {
      control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, credentials: f.credentials, reasoner, host: new E2EAgentHost(),
      })
      controls.push(control)
      await control.start()
      return control
    }
    const initial = await start()
    await f.credentials.set('reasoning', 'fixture-previous-api-key')
    await initial.command({ type: 'configure', patch: { reasoning: 'claude', reasoningModel: 'selected-model', reasoningEffort: 'high' } })
    expect(f.credentials.has('reasoning')).toBe(false)
    const checked = await initial.command({ type: 'check-reasoning', provider: 'claude' as SubscriptionProvider })
    expect(checked.reasoningAccounts).toEqual([expect.objectContaining({ provider: 'claude', ready: true })])
    expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).configuration.reasoning).toBe('claude')
    initial.dispose()
    let finishStatus!: () => void
    f.client.status.mockImplementationOnce(() => { const pending = deferred<Awaited<ReturnType<typeof f.client.status>>>(); finishStatus = () => pending.resolve({
      provider: 'claude', installed: true, ready: true, label: 'Claude Max', detail: 'Connected', models: [],
    }); return pending.promise })
    const restarted = await start()
    // A native client can stall without delaying the rest of Sotto's startup.
    expect(restarted.get().configuration.reasoning).toBe('claude')
    expect(restarted.get().configuration.reasoningModel).toBe('selected-model')
    expect(restarted.get().configuration.reasoningEffort).toBe('high')
    expect(restarted.get().reasoningAccounts).toEqual([])
    finishStatus()
    await vi.waitFor(() => expect(restarted.get().reasoningAccounts[0]?.ready).toBe(true))
    await restarted.command({ type: 'connect' })
    const result = await restarted.command({ type: 'select-project', projectId: 'project' })
    expect(result.error).toBeNull()
    expect(result.activeProjectId).toBe('project')
    expect(result.credentials.reasoning).toBe(false)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
