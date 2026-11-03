// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseProductEvent, parseProductEventInstall, PRODUCT_EVENT_SCHEMAS, type ProductEventName } from '../../../../src/main/productEvents/schema'
import { publicModelId } from '../../../../src/main/agents/usageRates'

const OWNER = 'a'.repeat(64)
const SAMPLES: { [E in ProductEventName]: Record<string, unknown> } = {
  'install.owner_observed': { ownerSource: 'claude', ownerId: OWNER },
  'app.started': { pairedHosts: 1 },
  'thread.started': { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'approval-required', inWorktree: true, startedBy: 'user' },
  'turn.completed': { provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', speed: 'fast', permissionMode: 'full-access', startedBy: 'watcher', result: 'completed', durationMs: 48211,
    inputTokens: 18204, cachedInputTokens: 15360, outputTokens: 912, reasoningTokens: 240, childInputTokens: 0, childOutputTokens: 0 },
  'feature.used': { feature: 'council' },
}
const EVENTS = Object.keys(PRODUCT_EVENT_SCHEMAS) as ProductEventName[]
/** Every field the hard limits name, and the names they go by here and at the providers. */
const FORBIDDEN = ['prompt', 'prompts', 'text', 'content', 'message', 'response', 'reply', 'transcript', 'audio', 'path', 'filePath', 'file', 'fileName', 'fileContents', 'cwd', 'workingDirectory', 'folder',
  'project', 'projectName', 'repo', 'repository', 'branch', 'branchName', 'token', 'accessToken', 'refreshToken', 'idToken', 'apiKey', 'key', 'threadId', 'thread', 'title', 'sessionId', 'providerThreadId',
  'rawEvent', 'event', 'raw', 'toolInput', 'toolOutput', 'output', 'childOutput', 'email', 'userName', 'hostName', 'hostname', 'error', 'appName', 'ip', 'distinctId', 'accountId']
/** Things that must never fit in any string field. */
const SMUGGLED = ['/home/someone/project/secret.ts', 'C:\\Users\\someone\\file.txt', 'feat/secret-branch', 'please fix the login page', 'sk-or-v1-abcdef', 'someone@example.com', 'my-own-server-model', 'gpt-6-sol ', '019a7c1e-thread']

describe('product event schemas', () => {
  it('has a sample for every event, and takes it', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...EVENTS].sort())
    for (const event of EVENTS) expect(parseProductEvent(event, SAMPLES[event]), event).toEqual(SAMPLES[event])
  })

  it.each(EVENTS)('%s refuses every forbidden field', (event) => {
    for (const field of FORBIDDEN) expect(parseProductEvent(event, { ...SAMPLES[event], [field]: 'x' }), field).toBeNull()
  })

  it.each(EVENTS)('%s lets no free text into a string field', (event) => {
    const fields = Object.entries(SAMPLES[event]).filter(([, value]) => typeof value === 'string').map(([field]) => field)
    for (const field of fields) for (const value of SMUGGLED) expect(parseProductEvent(event, { ...SAMPLES[event], [field]: value }), `${field}: ${value}`).toBeNull()
  })

  it.each(EVENTS)('%s refuses text and objects in a field that holds a number or a list value', (event) => {
    for (const field of Object.keys(SAMPLES[event])) {
      for (const value of [{ nested: 'x' }, ['x'], null]) expect(parseProductEvent(event, { ...SAMPLES[event], [field]: value }), field).toBeNull()
    }
    for (const [field, value] of Object.entries(SAMPLES[event])) if (typeof value === 'number') expect(parseProductEvent(event, { ...SAMPLES[event], [field]: 'x' }), field).toBeNull()
  })

  it('refuses an event it does not know', () => {
    expect(parseProductEvent('dictation.finished' as ProductEventName, { words: 1 })).toBeNull()
    expect(parseProductEvent('constructor' as ProductEventName, {})).toBeNull()
  })

  it('names a model only when it is on the public list', () => {
    expect(publicModelId('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(publicModelId('claude', 'native:claude:model:claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(publicModelId('opencode', 'llama-3-on-my-server')).toBeUndefined()
    expect(publicModelId('deepseek', 'my-own-model')).toBeUndefined()
  })

  it('takes only known shapes for what every event says about the install', () => {
    const install = { appVersion: '0.1.43', channel: 'stable', surface: 'desktop', platform: 'windows', arch: 'x64' }
    expect(parseProductEventInstall(install)).toEqual(install)
    expect(parseProductEventInstall({ ...install, appVersion: '0.1.43-owl.20261102' })).not.toBeNull()
    expect(parseProductEventInstall({ ...install, appVersion: '/home/someone' })).toBeNull()
    expect(parseProductEventInstall({ ...install, appVersion: `0.1.${'4'.repeat(10)}` })).toBeNull()
    expect(parseProductEventInstall({ ...install, hostname: 'forge' })).toBeNull()
  })
})
