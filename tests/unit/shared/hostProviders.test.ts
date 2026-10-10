// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PROVIDER_SIGN_IN_SHAPES, isProviderSignInPage } from '../../../src/shared/hostProviders'

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
    expect(PROVIDER_SIGN_IN_SHAPES).toEqual({ codex: 'device-code', grok: 'device-code', claude: 'paste-code', devin: null })
  })
})
