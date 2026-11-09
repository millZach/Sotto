import { describe, expect, it } from 'vitest'
import { looserModeStopped, permissionModeDrift } from '../../../src/main/agents/providers/claude/claudePermissionMode'

describe('Claude Code permission mode drift (#657)', () => {
  it('ranks plan and dontAsk stricter than default, and auto between acceptEdits and bypassPermissions', () => {
    expect(permissionModeDrift('approval-required', 'plan')).toBe('stricter')
    expect(permissionModeDrift('approval-required', 'dontAsk')).toBe('stricter')
    expect(permissionModeDrift('approval-required', 'manual')).toBeUndefined()
    expect(permissionModeDrift('auto-accept-edits', 'auto')).toBe('looser')
    expect(permissionModeDrift('auto', 'acceptEdits')).toBe('stricter')
    expect(permissionModeDrift('auto', 'bypassPermissions')).toBe('looser')
    expect(permissionModeDrift('full-access', 'auto')).toBe('stricter')
    expect(permissionModeDrift('full-access', 'bypassPermissions')).toBeUndefined()
  })
  it('reads a mode it cannot rank as looser, and a frame without one as saying nothing', () => {
    expect(permissionModeDrift('full-access', 'yolo')).toBe('looser')
    expect(permissionModeDrift('approval-required', undefined)).toBeUndefined()
    expect(looserModeStopped('approval-required', 'yolo')).toContain('Claude Code started in a permission mode Sotto does not know although this thread is set to Ask for approval')
  })
  it('never says nothing ran, and says Claude Code may still be running when the stop is not confirmed', () => {
    const words = looserModeStopped('auto', 'bypassPermissions', { confirmed: false })
    expect(words).toContain('but could not confirm that it ended, so Claude Code may still be running in that mode. End any claude process still running for this project')
    expect(words).not.toContain('Nothing ran')
    expect(words).not.toContain('chose no tool')
    const confirmed = looserModeStopped('auto', 'bypassPermissions', { ended: [{ label: 'a' }, { label: 'b' }], confirmed: true })
    expect(confirmed).toContain('so Claude chose no tool for this message. Anything Claude Code, its startup hooks or a wrapper script did as it started may have run in that mode, so check the project. 2 background tasks, started earlier, stopped with it.')
    expect(confirmed).toMatch(/Ask Claude to start them again if you still need them\.$/)
    expect(confirmed).not.toContain('Nothing ran')
  })
})
