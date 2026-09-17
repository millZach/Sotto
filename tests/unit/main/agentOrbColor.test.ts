// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const workspace = resolve('.')
const roots: string[] = []
const controls = new Set<AgentControl>()
const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)),
  decryptString: value => Buffer.from(value.map(byte => byte ^ 0xa5)).toString('utf8'),
}

async function fixture(directory?: string) {
  const root = directory ?? await mkdtemp(join(workspace, '.tmp-agent-orb-color-'))
  if (directory === undefined) roots.push(root)
  const credentials = new AgentCredentials(join(root, 'vault'), encryption)
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler,
    directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner,
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    },
  })
  controls.add(control)
  await control.start()
  return { root, control }
}

function dispose(control: AgentControl) {
  control.dispose()
  controls.delete(control)
}

function configure(control: AgentControl, patch: unknown) {
  // Preload and main IPC each validate the command before it reaches the coordinator.
  const command = agentCommandSchema.parse({ type: 'configure', patch })
  return control.command(agentCommandSchema.parse(command))
}

afterEach(async () => {
  for (const control of controls) dispose(control)
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== workspace || !basename(root).startsWith('.tmp-agent-orb-color-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('agent orb color configuration', () => {
  it('defaults a fresh coordinator to teal', async () => {
    const { control } = await fixture()
    expect(control.get().configuration.orbColor).toBe('teal')
  })

  it('persists ice in agents.json and restores it after a restart', async () => {
    const { root, control } = await fixture()
    expect((await configure(control, { orbColor: 'ice' })).error).toBeNull()
    expect(control.get().configuration.orbColor).toBe('ice')
    expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))).toMatchObject({
      configuration: { orbColor: 'ice' },
    })
    dispose(control)

    const restarted = await fixture(root)
    expect(restarted.control.get().configuration.orbColor).toBe('ice')
  })

  it('preserves ice when a validated configure patch omits orbColor', async () => {
    const { control } = await fixture()
    expect((await configure(control, { orbColor: 'ice' })).error).toBeNull()
    expect((await configure(control, { followupLimit: 3 })).error).toBeNull()
    expect(control.get().configuration).toMatchObject({ orbColor: 'ice', followupLimit: 3 })
  })

  it('defaults an older configuration without orbColor to teal', () => {
    const configuration: Record<string, unknown> = { ...defaultAgentConfiguration() }
    delete configuration.orbColor
    expect(agentConfigurationSchema.parse(configuration).orbColor).toBe('teal')
  })

  it('loads an older agents.json without resetting its other configuration', async () => {
    const { root, control } = await fixture()
    expect((await configure(control, { followupLimit: 3 })).error).toBeNull()
    dispose(control)
    const file = join(root, 'agents.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { configuration: Record<string, unknown> }
    delete saved.configuration.orbColor
    await writeFile(file, JSON.stringify(saved), 'utf8')

    const restarted = await fixture(root)
    expect(restarted.control.get().configuration).toMatchObject({ orbColor: 'teal', followupLimit: 3 })
  })

  it('rejects an invalid orb color and unknown patch fields', () => {
    expect(() => agentCommandSchema.parse({ type: 'configure', patch: { orbColor: 'plaid' } })).toThrow()
    expect(() => agentCommandSchema.parse({ type: 'configure', patch: { orbColor: 'ice', extra: true } })).toThrow()
  })
})
