// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HOST_OPENCODE_ANSWERS, HOST_PROVIDERS, PROVIDER_SIGN_IN_SHAPES, heldOnHost, hostOpenCodeSignInRequestSchema, hostProviderActionSchema, hostSignInRequestSchema, isProviderSignInPage } from '../../../src/shared/hostProviders'
import { isOpenCodeSignInPage } from '../../../src/shared/opencodeSignIn'
import { hostsCommandSchema } from '../../../src/shared/hosts'

describe('the pages a host sign-in may open (ADR-0037)', () => {
  it('opens only https pages on each provider’s own sign-in host, exactly', () => {
    expect(isProviderSignInPage('codex', 'https://auth.openai.com/codex/device')).toBe(true)
    expect(isProviderSignInPage('grok', 'https://accounts.x.ai/oauth2/device?user_code=K7PX-2QRM')).toBe(true)
    expect(isProviderSignInPage('claude', 'https://claude.com/cai/oauth/authorize?code=true&state=x')).toBe(true)
    expect(isProviderSignInPage('claude', 'https://claude.ai/oauth/authorize?code=true')).toBe(true)
    for (const [provider, page] of [
      ['codex', 'http://auth.openai.com/codex/device'], ['codex', 'https://auth.openai.com:8443/codex/device'],
      ['codex', 'https://user@auth.openai.com/codex/device'], ['codex', 'https://evil.auth.openai.com.example/codex/device'],
      ['codex', 'https://claude.com/cai/oauth/authorize'], ['grok', 'https://auth.x.ai/device'], ['grok', 'https://x.ai/'],
      ['claude', 'https://sub.claude.ai/'], ['devin', 'https://app.devin.ai/auth/cli/continue'], ['codex', 'https://auth.openai.com/a b'],
    ] as const) expect(isProviderSignInPage(provider, page), page).toBe(false)
  })
  it('signs Codex and Grok Build in with a device code, Claude Code with a code pasted back, and leaves Devin to its terminal', () => {
    expect(PROVIDER_SIGN_IN_SHAPES).toEqual({ codex: 'device-code', grok: 'device-code', claude: 'paste-code', devin: null, muse: null, opencode: null })
  })
})

describe('the providers a host offers', () => {
  const HOST = '22222222-2222-4222-8222-222222222222'
  it('takes OpenCode since hosts and phones took it (#1107), so a headless host holds only what its Owl answers hold', () => {
    expect(HOST_PROVIDERS).toEqual(['claude', 'codex', 'grok', 'devin', 'muse', 'opencode'])
    expect([...heldOnHost(new Set())]).toEqual([])
    expect([...heldOnHost(new Set(['opencode']))]).toEqual(['opencode'])
  })
  it('takes a host connect, sign-in or agent job for OpenCode, as for every provider', () => {
    expect(hostProviderActionSchema.safeParse({ id: HOST, provider: 'opencode', action: 'connect' }).success).toBe(true)
    expect(hostSignInRequestSchema.safeParse({ type: 'start', id: HOST, provider: 'opencode' }).success).toBe(true)
    expect(hostsCommandSchema.safeParse({ type: 'start-provider-job', id: HOST, hostId: HOST, provider: 'opencode', modelId: 'claude:opus' }).success).toBe(true)
  })
  it('lets the window ask a host’s OpenCode for its dialog’s calls, and never for a page’s address', () => {
    const attempt = { attemptId: 'con_1' }
    expect(hostOpenCodeSignInRequestSchema.safeParse({ id: HOST, call: { action: 'reopen', request: attempt } }).success).toBe(true)
    expect(hostOpenCodeSignInRequestSchema.safeParse({ id: HOST, call: { action: 'page', request: attempt } }).success).toBe(false)
    expect(hostOpenCodeSignInRequestSchema.safeParse({ id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: 'k' } }, extra: true }).success).toBe(false)
    expect(Object.keys(HOST_OPENCODE_ANSWERS).sort()).toEqual(['browser', 'cancel', 'external', 'finish', 'key', 'reopen', 'sign-out', 'sources', 'wait'])
    // A page Sotto opens for a host's OpenCode is https, with no user name or password in it.
    expect(isOpenCodeSignInPage('https://sign-in.fixture.invalid/xai/device?user_code=QX7M')).toBe(true)
    for (const page of ['http://sign-in.fixture.invalid/', 'https://user:pass@sign-in.fixture.invalid/', 'javascript:alert(1)', 'not a page']) expect(isOpenCodeSignInPage(page), page).toBe(false)
  })
})
