// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { attemptOf, hiddenAnswers, integrationSchema, keyLabel, methodsOf, modelSourcesOf, safeSignInPage } from '../../../src/main/agents/opencodeSources'

// Shapes as OpenCode 2.0.31 lists them at GET /api/integration (scratch probe, October 16, 2026).
const integration = (value: unknown) => integrationSchema.parse(value)
const openai = integration({ id: 'openai', name: 'OpenAI', methods: [{ type: 'key' }, { type: 'env', names: ['OPENAI_API_KEY'] },
  { id: 'chatgpt-token-sharing', type: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' },
  { id: 'chatgpt-headless', type: 'oauth', label: 'Codex device code (legacy)' }], connections: [] })
const copilot = integration({ id: 'github-copilot', name: 'GitHub Copilot', methods: [{ type: 'env', names: ['GITHUB_TOKEN'] }, { id: 'device', type: 'oauth', label: 'Login with GitHub Copilot', form: [
  { key: 'deploymentType', title: 'Select GitHub deployment type', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com', description: 'Public' }, { value: 'enterprise', label: 'GitHub Enterprise', description: 'Data residency or self-hosted' }] },
  { key: 'enterpriseUrl', title: 'Enter your GitHub Enterprise URL or domain', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }], type: 'string', placeholder: 'company.ghe.com' }] }], connections: [] })

describe('a model source’s ways to sign in, in Sotto’s words', () => {
  it('leaves out legacy methods and environment variables, and names the rest plainly', () => {
    expect(methodsOf(openai)).toEqual([{ id: 'key', kind: 'key', label: 'API key' }, { id: 'chatgpt-token-sharing', kind: 'browser', label: 'ChatGPT account' }])
    expect(keyLabel('Manually enter API Key')).toBe('API key')
    expect(keyLabel('Paste PAT or bearer token')).toBe('Access token')
    expect(keyLabel('API key (service account)')).toBe('Service account API key')
    expect(keyLabel('Bedrock API key')).toBe('Bedrock API key')
    const poe = integration({ id: 'poe', name: 'Poe', methods: [{ id: 'browser', type: 'oauth', label: 'Login with Poe (browser)' }] })
    expect(methodsOf(poe)[0]!.label).toBe('Poe account')
    const xai = integration({ id: 'xai', name: 'xAI', methods: [{ id: 'device', type: 'oauth', label: 'SuperGrok Subscription' }] })
    expect(methodsOf(xai)[0]!.label).toBe('SuperGrok subscription')
  })

  it('draws the question a method asks first from its form, such as GitHub.com or Enterprise and its address', () => {
    expect(methodsOf(copilot)).toEqual([{ id: 'device', kind: 'browser', label: 'GitHub account', form: [
      { key: 'deploymentType', title: 'Select GitHub deployment type', required: true, options: [{ value: 'github.com', label: 'GitHub.com', description: 'Public' }, { value: 'enterprise', label: 'GitHub Enterprise', description: 'Data residency or self-hosted' }] },
      { key: 'enterpriseUrl', title: 'Enter your GitHub Enterprise URL or domain', required: true, placeholder: 'company.ghe.com', when: { key: 'deploymentType', value: 'enterprise' } },
    ] }])
  })

  it('sends a hidden field’s own value, draws a choice that takes the user’s words as words, and leaves out a form it cannot draw', () => {
    const console = integration({ id: 'opencode', name: 'OpenCode Console', methods: [{ id: 'device', type: 'oauth', label: 'OpenCode Console account', form: [{ key: 'server', hidden: true, type: 'string', default: 'https://opencode.ai/console' }] }] })
    expect(methodsOf(console)).toEqual([{ id: 'device', kind: 'browser', label: 'OpenCode Console account' }])
    expect(hiddenAnswers(console, 'device')).toEqual({ server: 'https://opencode.ai/console' })
    const bedrock = integration({ id: 'amazon-bedrock', name: 'Amazon Bedrock', methods: [{ type: 'external', id: 'aws-profile', label: 'AWS profile (SSO or named profile)', form: [
      { key: 'profile', title: 'AWS profile', required: true, type: 'string', options: [], custom: true, placeholder: 'Profile name' }] }] })
    expect(methodsOf(bedrock)).toEqual([{ id: 'aws-profile', kind: 'external', label: 'AWS profile', form: [{ key: 'profile', title: 'AWS profile', required: true, placeholder: 'Profile name' }] }])
    const switches = integration({ id: 'odd', name: 'Odd', methods: [{ type: 'key' }, { id: 'x', type: 'oauth', label: 'Login with Odd', form: [{ key: 'on', type: 'boolean' }] }] })
    expect(methodsOf(switches).map(method => method.id)).toEqual(['key'])
  })
})

describe('who is signed in, read without a secret', () => {
  it('reads a source’s sign-in from its connections and counts its models, with Zen’s free models apart', () => {
    const signed = integration({ ...openai, connections: [{ type: 'credential', id: 'cred_1', label: 'OpenAI', method: 'oauth' }] })
    const anthropic = integration({ id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred_2', label: 'Anthropic', method: 'key' }] })
    const read = modelSourcesOf([anthropic, signed, copilot], ['opencode', 'opencode', 'anthropic', 'anthropic', 'anthropic', 'openai'])
    expect(read.zenModels).toBe(2)
    expect(read.sources.map(source => [source.id, source.signedIn?.how, source.models])).toEqual([
      ['anthropic', 'API key', 3], ['openai', 'ChatGPT account', 1], ['github-copilot', undefined, 0],
    ])
  })
})

describe('a started browser sign-in', () => {
  it('shows the device code OpenCode’s instructions give, and the page without its query', () => {
    expect(attemptOf('xai', { attemptID: 'con_1', url: 'https://accounts.x.ai/oauth2/device?user_code=QX7M-4LRT', mode: 'auto',
      instructions: 'Open https://accounts.x.ai/oauth2/device on any device and enter code: QX7M-4LRT', time: { created: 1, expires: 1_800_001 } }))
      .toEqual({ id: 'con_1', sourceId: 'xai', mode: 'auto', code: 'QX7M-4LRT', page: 'accounts.x.ai/oauth2/device', expiresAt: 1_800_001 })
  })

  it('says nothing of a code when the page finishes by itself, and keeps the state out of what it shows', () => {
    const shown = attemptOf('gitlab', { attemptID: 'con_2', url: 'https://gitlab.com/oauth/authorize?client_id=a&state=secret-state&code_challenge=c', mode: 'auto',
      instructions: 'Complete authorization in your browser. This window will close automatically.', time: { created: 1, expires: 'Infinity' } })
    expect(shown).toEqual({ id: 'con_2', sourceId: 'gitlab', mode: 'auto', page: 'gitlab.com/oauth/authorize' })
    expect(JSON.stringify(shown)).not.toContain('secret-state')
  })

  it('opens only an https page with no name or password in it', () => {
    expect(safeSignInPage('https://accounts.x.ai/oauth2/device')).toBe(true)
    expect(safeSignInPage('http://accounts.x.ai/oauth2/device')).toBe(false)
    expect(safeSignInPage('file:///C:/Windows/system32/calc.exe')).toBe(false)
    expect(safeSignInPage('https://user:pass@example.com/')).toBe(false)
    expect(safeSignInPage('not a url')).toBe(false)
  })
})
