// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { commandLine, nativeModelName, providerCommand, TERMINAL_PERMISSION_LABELS } from '../../../src/shared/terminalCommands'

describe('terminal launch commands', () => {
  it('maps every setting to the flags each CLI accepts', () => {
    expect(providerCommand({ provider: 'claude', model: 'claude-sonnet-5', reasoning: 'high', permission: 'edits' }))
      .toEqual(['claude', '--model', 'claude-sonnet-5', '--effort', 'high', '--permission-mode', 'acceptEdits'])
    expect(providerCommand({ provider: 'codex', model: 'gpt-5.4', reasoning: 'medium', permission: 'ask' }))
      .toEqual(['codex', '-m', 'gpt-5.4', '-c', 'model_reasoning_effort=medium', '-a', 'on-request', '-s', 'workspace-write'])
    expect(providerCommand({ provider: 'grok', model: 'grok-4', reasoning: 'low', permission: 'everything' }))
      .toEqual(['grok', '-m', 'grok-4', '--reasoning-effort', 'low', '--permission-mode', 'bypassPermissions'])
  })

  it('uses one Allow everything label but each provider’s own unrestricted flag', () => {
    expect(TERMINAL_PERMISSION_LABELS.everything).toBe('Allow everything')
    expect(providerCommand({ provider: 'claude', model: null, reasoning: null, permission: 'everything' })).toEqual(['claude', '--dangerously-skip-permissions'])
    expect(providerCommand({ provider: 'codex', model: null, reasoning: null, permission: 'everything' })).toEqual(['codex', '--dangerously-bypass-approvals-and-sandbox'])
    expect(providerCommand({ provider: 'codex', model: null, reasoning: null, permission: 'edits' })).toEqual(['codex', '--full-auto'])
    expect(providerCommand({ provider: 'grok', model: null, reasoning: null, permission: 'ask' })).toEqual(['grok', '--permission-mode', 'default'])
  })

  it('leaves out what was not chosen: Claude asks by default, and a bare command is just the CLI', () => {
    expect(providerCommand({ provider: 'claude', model: null, reasoning: null, permission: 'ask' })).toEqual(['claude'])
    expect(providerCommand({ provider: 'claude', model: null, reasoning: null, permission: null })).toEqual(['claude'])
    expect(providerCommand({ provider: null, model: 'x', reasoning: 'high', permission: 'everything' })).toEqual([])
  })

  it('shows the command as one line, quoting only what needs it', () => {
    expect(commandLine(['claude', '--model', 'claude-sonnet-5'])).toBe('claude --model claude-sonnet-5')
    expect(commandLine(['codex', '-c', 'model_reasoning_effort=high'])).toBe('codex -c model_reasoning_effort=high')
    expect(commandLine(['grok', '-m', 'my model'])).toBe('grok -m "my model"')
  })

  it('reads the CLI model name out of Sotto’s public model ID', () => {
    expect(nativeModelName('native:claude:model:claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(nativeModelName('native:codex:model:gpt-5.4%20codex')).toBe('gpt-5.4 codex')
    expect(nativeModelName('claude:sonnet')).toBe('claude:sonnet')
    expect(nativeModelName('')).toBeNull()
  })
})
