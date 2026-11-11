import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HermesKeys, HermesRuntime, forgetHermesKey, hermesConfig, hermesEnvFile, hermesKeyVariable, hermesProjectHome, hermesServers } from '../../../src/main/agents/hermesRuntime'
import { hermesCatalog, hermesModelValue, hermesSettingsOf } from '../../../src/main/agents/hermesModels'
import { hermesAnswer, hermesPending } from '../../../src/main/agents/hermesRequests'
import { hermesActivities } from '../../../src/main/agents/hermesActivity'
import { hermesEnvironment } from '../../../src/main/agents/hermesRpc'
import { heldProvidersOf } from '../../../src/shared/heldProviders'
import { providerProfile } from '../../../src/shared/providerProfile'
import type { OwnServer } from '../../../src/shared/ownModelServers'

const spark: OwnServer = { id: 'own-spark', name: 'Spark', address: 'http://spark.local/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek', context: 131072, thinking: true, images: false }] }

describe('Hermes', () => {
  it('keeps keys out of config, disables login adoption and titles, and pins Full access', () => {
    const keyed: OwnServer = { ...spark, id: 'own-paid', name: 'Paid', address: 'https://api.example.com/v1', keyed: true }
    const servers = hermesServers([spark, keyed, { ...keyed, id: 'own-unkept' }], { 'own-paid': 'secret "key"' })
    expect(servers.map(server => server.id)).toEqual(['own-spark', 'own-paid'])
    const text = hermesConfig(servers, '/project')
    expect(text).not.toContain('secret')
    const config = JSON.parse(text)
    expect(config.auth.adopt_external_logins).toBe(false)
    expect(config.approvals.mode).toBe('off')
    expect(config.gateway.multiplex_profiles).toBe(true)
    expect(config.fallback_model).toEqual([])
    expect(config.updates.check).toBe(false)
    expect(config.agent.reasoning_effort).toBeUndefined()
    expect(config.auxiliary.title_generation).toEqual({ enabled: false, model_upgrade_enabled: false })
    expect(config.terminal.cwd).toBe('/project')
    expect(config.custom_providers).toEqual([{ name: 'own-spark', base_url: 'http://spark.local/v1', api_mode: 'chat_completions', api_key: '', models: ['deepseek-v4.1-flash'] }])
    expect(config.providers).toEqual({ 'own-paid': { base_url: 'https://api.example.com/v1', api_mode: 'chat_completions',
      key_env: hermesKeyVariable('own-paid'), models: ['deepseek-v4.1-flash'] } })
    expect(hermesKeyVariable('own-paid')).toBe('SOTTO_OWN_PAID_KEY')
    expect(hermesEnvFile(servers, { 'own-paid': 'secret "key"' })).toBe('SOTTO_OWN_PAID_KEY="secret \\"key\\""\n')
    expect(JSON.parse(hermesConfig([keyed])).model.key_env).toBe('SOTTO_OWN_PAID_KEY')
    expect(JSON.parse(hermesConfig([spark]))).not.toHaveProperty('providers')
    expect(hermesServers([], {})).toEqual([])
    // The catalog offers what Hermes can run: the keyed server whose key it holds, and not the one it has none for.
    expect(hermesCatalog(servers).map(model => model.id)).toEqual(['own-spark/deepseek-v4.1-flash', 'own-paid/deepseek-v4.1-flash'])
    expect(hermesCatalog(hermesServers([keyed], { 'own-paid': 'k' })).map(model => [model.id, model.source])).toEqual([['own-paid/deepseek-v4.1-flash', 'Paid']])
    expect(hermesEnvironment('/sotto/hermes', {}, { HOME: '/home', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' }))
      .toEqual({ HOME: '/home', HERMES_HOME: '/sotto/hermes' })
    expect(hermesProjectHome('/sotto/hermes', '/project').startsWith(join('/sotto/hermes', 'profiles', 'project-'))).toBe(true)
    expect(hermesProjectHome('/sotto/hermes', '/project')).not.toBe(hermesProjectHome('/sotto/hermes', '/other'))
  })

  it('keeps keys in one file only the user can read, and forgets them one at a time', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sotto-hermes-keys-'))
    try {
      const keys = new HermesKeys(join(folder, 'own-server-keys.json'))
      expect(await keys.read()).toEqual({})
      await keys.keep('own-a', 'one'); await keys.keep('own-b', 'two'); await keys.forget('own-a')
      expect(await keys.read()).toEqual({ 'own-b': 'two' })
      if (process.platform !== 'win32') expect((await stat(join(folder, 'own-server-keys.json'))).mode & 0o777).toBe(0o600)
    } finally { await rm(folder, { recursive: true, force: true }) }
  })

  it('takes a removed key out of every .env at once, the root and each project profile, and keeps the others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-hermes-forget-'))
    try {
      // Made up for this test; no real key goes near it.
      const removed = 'made-up-removed-key-7d2a', kept = 'made-up-kept-key-41c9'
      const paid = (id: string): OwnServer => ({ ...spark, id, name: id, address: `https://${id}.example.com/v1`, keyed: true })
      const servers = [spark, paid('own-gone'), paid('own-stays')]
      const runtime = new HermesRuntime(root, () => {})
      await runtime.keys.keep('own-gone', removed); await runtime.keys.keep('own-stays', kept)
      const homes = [root, hermesProjectHome(root, '/project-a'), hermesProjectHome(root, '/project-b')]
      for (const home of homes) await runtime.writeConfig(home, servers, home === root ? undefined : '/project')
      // A profile written while the Remove runs still never brings the removed key back.
      await Promise.all([runtime.forgetKey('own-gone'), runtime.writeConfig(homes[2]!, servers, '/project')])
      expect(await runtime.keys.read()).toEqual({ 'own-stays': kept })
      for (const home of homes) {
        const env = await readFile(join(home, '.env'), 'utf8')
        expect(env.includes(removed), home).toBe(false)
        expect(env).toContain(kept)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('clears a failed key write’s temporary file even with Hermes stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-hermes-temp-key-'))
    try {
      const path = join(root, 'own-server-keys.json')
      await writeFile(`${path}.next`, JSON.stringify({ 'own-paid': 'made-up-temporary-key' }), { mode: 0o600 })
      await forgetHermesKey(root, 'own-paid')
      await expect(stat(`${path}.next`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(['own-server-keys.json', 'profiles', '.env'])('refuses key cleanup when %s cannot be read as expected', async name => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-hermes-key-cleanup-'))
    try {
      const path = join(root, name)
      if (name === 'profiles') await writeFile(path, 'not a directory')
      else await mkdir(path)
      await expect(forgetHermesKey(root, 'own-paid')).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
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
