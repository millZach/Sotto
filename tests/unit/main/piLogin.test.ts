// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { PiLoginReader } from '../../../src/main/agents/piLogin'
import { PI_SOURCES } from '../../../src/shared/piSignIn'

it('waits for a complete allowed URL and keeps unrelated terminal output private', () => {
  const events = { keyPrompt: vi.fn(), domain: vi.fn(), page: vi.fn() }
  const reader = new PiLoginReader(PI_SOURCES.find(source => source.id === 'openai-codex')!, events)
  reader.push('Untrusted text and a secret.\nOpen https://evil.example and enter code: BAD-CODE\n')
  reader.push('Open https://auth.openai.com/codex/device and enter code: TEST')
  expect(events.page).not.toHaveBeenCalled()
  reader.push('-CODE\r\nWaiting for authentication...\r\n')
  expect(events.page).toHaveBeenCalledExactlyOnceWith('https://auth.openai.com/codex/device', 'TEST-CODE')
})
it('recognizes only its provider’s key prompt and never returns key input', () => {
  const events = { keyPrompt: vi.fn(), domain: vi.fn(), page: vi.fn() }
  const reader = new PiLoginReader(PI_SOURCES.find(source => source.id === 'openai')!, events)
  reader.push('Enter Anthropic API key:')
  expect(events.keyPrompt).not.toHaveBeenCalled()
  reader.push('Enter OpenAI API key:')
  expect(events.keyPrompt).toHaveBeenCalledOnce()
  reader.push('synthetic-private-key\nSaved API key for OpenAI.\n')
  expect(events.page).not.toHaveBeenCalled()
})
