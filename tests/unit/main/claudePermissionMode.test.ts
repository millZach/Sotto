import { describe, expect, it } from 'vitest'
import { looserModeStopped, permissionModeDrift } from '../../../src/main/agents/claudePermissionMode'

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
  it('says the stop could not be confirmed rather than that nothing ran', () => {
    const words = looserModeStopped('auto', 'bypassPermissions', { confirmed: false })
    expect(words).toContain('so Sotto stopped it, but could not confirm that it ended, so it may have acted. Check the project for changes.')
    expect(words).not.toContain('Nothing ran')
    expect(looserModeStopped('auto', 'bypassPermissions', { ended: [{ label: 'a' }, { label: 'b' }] })).toContain('Nothing from this message ran, and 2 background tasks, started earlier, stopped with it.')
  })
})
