import { describe, expect, it } from 'vitest'
import { hermesConfig, hermesProjectHome, hermesServers } from '../../../src/main/agents/hermesRuntime'
import { hermesCatalog, hermesModelValue, hermesSettingsOf } from '../../../src/main/agents/hermesModels'
import { hermesAnswer, hermesPending } from '../../../src/main/agents/hermesRequests'
import { hermesActivities } from '../../../src/main/agents/hermesActivity'
import { hermesEnvironment } from '../../../src/main/agents/hermesRpc'
import { heldProvidersOf } from '../../../src/shared/heldProviders'
import { providerProfile } from '../../../src/shared/providerProfile'
import type { OwnServer } from '../../../src/shared/ownModelServers'

const spark: OwnServer = { id: 'own-spark', name: 'Spark', address: 'http://spark.local/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek', context: 131072, thinking: true, images: false }] }

describe('local Owl Hermes', () => {
  it('keeps credentials out of config, disables login adoption and titles, and pins Full access', () => {
    const servers = hermesServers([spark, { ...spark, id: 'keyed', keyed: true }], true, true)
    const config = JSON.parse(hermesConfig(servers, '/project'))
    expect(config.auth.adopt_external_logins).toBe(false)
    expect(config.approvals.mode).toBe('off')
    expect(config.gateway.multiplex_profiles).toBe(true)
    expect(config.fallback_model).toEqual([])
    expect(config.updates.check).toBe(false)
    expect(config.agent.reasoning_effort).toBe('high')
    expect(config.auxiliary.title_generation).toEqual({ enabled: false, model_upgrade_enabled: false })
    expect(config.terminal.cwd).toBe('/project')
    expect(config.custom_providers.map((p: { name: string }) => p.name)).toEqual(['own-spark', 'own-refuseless'])
    expect(config.custom_providers[1]).toMatchObject({ key_cmd: '/usr/bin/security find-generic-password -s refuseless -a default -w' })
    expect(config.custom_providers[1]).not.toHaveProperty('api_key')
    expect(config.providers['own-abliteration']).toEqual({ base_url: 'https://api.abliteration.ai/v1', api_mode: 'chat_completions',
      key_cmd: '/usr/bin/security find-generic-password -s abliteration -a default -w',
      models: ['abliterated-model-large-v2', 'abliterated-model-large-flash', 'abliterated-model'] })
    expect(config.providers['own-abliteration']).not.toHaveProperty('api_key')
    expect(hermesEnvironment('/sotto/hermes', {}, { HOME: '/home', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' }))
      .toEqual({ HOME: '/home', HERMES_HOME: '/sotto/hermes' })
    expect(hermesProjectHome('/sotto/hermes', '/project')).toMatch(/^\/sotto\/hermes\/profiles\/project-/u)
    expect(hermesProjectHome('/sotto/hermes', '/project')).not.toBe(hermesProjectHome('/sotto/hermes', '/other'))
  })

  it('offers Abliteration only when available, keeping Refuseless unchanged and images off', () => {
    const existing = hermesServers([spark], true)
    const servers = hermesServers([spark], true, true)
    expect(servers.slice(0, existing.length)).toEqual(existing)
    expect(JSON.parse(hermesConfig(servers)).custom_providers).toEqual(JSON.parse(hermesConfig(existing)).custom_providers)
    expect(JSON.parse(hermesConfig(existing))).not.toHaveProperty('providers')
    expect(hermesServers([], false, false)).toEqual([])
    expect(hermesServers([], false, true).map(server => server.id)).toEqual(['own-abliteration'])
    expect(servers[2]?.models).toEqual([
      { id: 'abliterated-model-large-v2', name: 'Abliterated Large V2', context: 1048576, thinking: false, images: false },
      { id: 'abliterated-model-large-flash', name: 'Abliterated Large Flash', context: 1048576, thinking: true, images: false },
      { id: 'abliterated-model', name: 'Abliterated Model', context: 262144, thinking: true, images: false },
    ])
    const catalog = hermesCatalog(servers, true).filter(model => model.source === 'Abliteration')
    expect(catalog.map(model => model.id)).toEqual([
      'own-abliteration/abliterated-model-large-v2', 'own-abliteration/abliterated-model-large-flash', 'own-abliteration/abliterated-model',
    ])
    for (const model of catalog) {
      expect(model).not.toHaveProperty('supportsImages')
      expect(hermesModelValue(model.id)).toBe(`custom:own-abliteration:${model.id.split('/')[1]}`)
    }
  })

  it('maps server routes without offering unsupported reasoning or permission modes', () => {
    expect(hermesModelValue('own-spark/deepseek-v4.1-flash')).toBe('custom:own-spark:deepseek-v4.1-flash')
    expect(hermesSettingsOf({ models: { currentModelId: 'custom:own-spark:deepseek-v4.1-flash' } }).model)
      .toBe('own-spark/deepseek-v4.1-flash')
    expect(hermesCatalog([spark])[0]).toMatchObject({ runtimeModes: ['full-access'], source: 'Spark' })
    expect(hermesCatalog([spark])[0]).not.toHaveProperty('reasoningEfforts')
    expect(providerProfile('hermes')).toMatchObject({ takesSottoTools: true, runsWatcher: false, writesShortText: false })
    expect(heldProvidersOf({})).toContain('hermes')
    expect(heldProvidersOf({ hermes: true })).not.toContain('hermes')
  })

  it('renders streamed native reasoning and settles it at the reply', () => {
    const rows = hermesActivities({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Consider the inputs.' } }, { turnId: 'turn', cwd: '/project' }, [], true)
    expect(rows[0]).toMatchObject({ kind: 'reasoning', status: 'running', text: 'Consider the inputs.' })
    expect(hermesActivities({ sessionUpdate: 'agent_message_chunk' }, { turnId: 'turn', cwd: '/project' }, rows, true)[0]?.status).toBe('completed')
  })

  it('renders native terminal and file tools that omit rawInput', () => {
    const context = { turnId: 'turn', cwd: '/project' }
    const rows = hermesActivities({ sessionUpdate: 'tool_call', toolCallId: 'terminal-1', kind: 'execute', title: 'terminal: python3 check.py',
      content: [{ type: 'content', content: { type: 'text', text: '$ python3 check.py' } }] }, context, [], true)
    expect(rows[0]).toMatchObject({ kind: 'command', command: 'python3 check.py', status: 'running' })
    expect(hermesActivities({ sessionUpdate: 'tool_call_update', toolCallId: 'terminal-1', kind: 'execute', status: 'completed' }, context, rows)[0])
      .toMatchObject({ kind: 'command', command: 'python3 check.py', status: 'completed' })
    expect(hermesActivities({ sessionUpdate: 'tool_call', toolCallId: 'file-1', kind: 'edit', title: 'write_file: answer.py', status: 'in_progress',
      locations: [{ path: '/project/answer.py' }] }, context)[0]).toMatchObject({ kind: 'file-change', changes: [{ path: '/project/answer.py' }] })
  })

  it('offers and sends only one-time answers, preserving the native input on the card', () => {
    const pending = hermesPending(7, 'session/request_permission', {
      sessionId: 'session', toolCall: { toolCallId: 'call', title: 'terminal', rawInput: { command: 'cat dummy.txt' } },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Once' },
        { optionId: 'session', kind: 'allow_always', name: 'Session' },
        { optionId: 'no', kind: 'reject_once', name: 'No' },
        { optionId: 'never', kind: 'reject_always', name: 'Never' },
      ],
    }, 'thread')!
    expect(pending.request.text).toBe('Run: cat dummy.txt')
    expect(pending.request.permissionChoices?.map(choice => choice.id)).toEqual(['once', 'no'])
    expect(hermesAnswer(pending, true, 'once')).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(hermesAnswer(pending, false, 'no')).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(() => hermesAnswer(pending, true, 'session')).toThrow()
  })
})
