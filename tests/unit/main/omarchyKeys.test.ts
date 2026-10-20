// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { bindIsOn, boundChords, DEFAULT_OMARCHY_SHORTCUTS, hyprlandChord, linuxKeyList, renderSottoBindings } from '../../../src/main/omarchy/keys'

const template = readFileSync(resolve('apps/omarchy/bindings.lua'), 'utf8')

describe('Sotto’s Hyprland keys', () => {
  it('keeps Linux’s defaults: F9 held to talk and Super+Ctrl+X pressed to start and stop', () => {
    expect(DEFAULT_OMARCHY_SHORTCUTS).toEqual({ press: ['Super+CommandOrControl+X'], hold: ['F9'] })
    expect(linuxKeyList(DEFAULT_OMARCHY_SHORTCUTS)).toBe('F9 and Super+Ctrl+X')
  })

  it('renders the bundled snippet unchanged for the defaults, so existing keys stay as they are', () => {
    expect(renderSottoBindings(DEFAULT_OMARCHY_SHORTCUTS, template)).toBe(template)
  })

  it('binds a press shortcut to toggle and a hold shortcut to start on press and stop on release', () => {
    const rendered = renderSottoBindings({ press: ['Super+Alt+D', 'CommandOrControl+Shift+Space'], hold: ['F10'] }, template)!
    const lines = rendered.split('\n')
    expect(lines.filter(line => line.startsWith('hl.unbind('))).toEqual([
      'hl.unbind("F10")', 'hl.unbind("SUPER + ALT + D")', 'hl.unbind("CTRL + SHIFT + SPACE")',
    ])
    expect(lines.filter(line => line.startsWith('o.bind('))).toEqual([
      'o.bind("F10", "Start Sotto dictation (push-to-talk)", dictation("start"))',
      'o.bind("F10", "Stop Sotto dictation (push-to-talk)", dictation("stop"), { release = true })',
      'o.bind("SUPER + ALT + D", "Toggle Sotto dictation", dictation("toggle"))',
      'o.bind("CTRL + SHIFT + SPACE", "Toggle Sotto dictation", dictation("toggle"))',
    ])
    // Sotto gives up F9 and Super+Ctrl+X, so it no longer unbinds them.
    expect(rendered).not.toContain('"F9"')
    expect(rendered).not.toContain('SUPER + CTRL + X')
    // Every other line of the bundled file stays, the launcher guard and the event stamp included.
    expect(rendered).toContain('if o.cmd_present("sotto") then')
    expect(rendered).toContain('--at "$(date +%s%N)"')
    expect(rendered.endsWith('end\n')).toBe(true)
  })

  it('binds no hold lines when no shortcut is held', () => {
    const rendered = renderSottoBindings({ press: ['Super+CommandOrControl+X'], hold: [] }, template)!
    expect(rendered).not.toContain('dictation("start")')
    expect(rendered).not.toContain('dictation("stop")')
    expect(rendered).toContain('o.bind("SUPER + CTRL + X", "Toggle Sotto dictation", dictation("toggle"))')
  })

  it('refuses a template without binding lines rather than writing keys that do nothing', () => {
    expect(renderSottoBindings(DEFAULT_OMARCHY_SHORTCUTS, '-- nothing here\n')).toBeNull()
  })

  it('names chords the way Hyprland binds them, in any saved spelling', () => {
    expect(hyprlandChord('Super+CommandOrControl+X')).toEqual({ bind: 'SUPER + CTRL + X', key: 'X', modmask: 68 })
    expect(hyprlandChord('ctrl+super+x')).toEqual({ bind: 'SUPER + CTRL + X', key: 'X', modmask: 68 })
    expect(hyprlandChord('F9')).toEqual({ bind: 'F9', key: 'F9', modmask: 0 })
    expect(hyprlandChord('Alt+Shift+Enter')).toEqual({ bind: 'ALT + SHIFT + RETURN', key: 'RETURN', modmask: 9 })
    expect(hyprlandChord('Super+PageDown')).toEqual({ bind: 'SUPER + PAGE_DOWN', key: 'PAGE_DOWN', modmask: 64 })
    // No key, two keys, Fn, Esc or a key outside the table cannot be bound.
    expect(hyprlandChord('Super+CommandOrControl')).toBeNull()
    expect(hyprlandChord('Super+A+B')).toBeNull()
    expect(hyprlandChord('Fn+F5')).toBeNull()
    expect(hyprlandChord('Super+Escape')).toBeNull()
    expect(hyprlandChord('Super+Minus')).toBeNull()
  })

  it('matches Hyprland’s own spellings of the same key', () => {
    const enter = hyprlandChord('Super+Enter')!
    expect(bindIsOn({ key: 'Return', modmask: 64 }, enter)).toBe(true)
    expect(bindIsOn({ key: 'ENTER', modmask: 64 }, enter)).toBe(true)
    expect(bindIsOn({ key: 'Return', modmask: 65 }, enter)).toBe(false)
    expect(bindIsOn({ key: 'Prior', modmask: 0 }, hyprlandChord('F1')!)).toBe(false)
    expect(bindIsOn({ key: 'x', modmask: 68 }, hyprlandChord('Super+CommandOrControl+X')!)).toBe(true)
  })

  it('binds each chord once, holds first', () => {
    expect(boundChords({ press: ['F9', 'Super+CommandOrControl+X'], hold: ['F9'] }).map(entry => [entry.role, entry.hypr.bind]))
      .toEqual([['hold', 'F9'], ['press', 'SUPER + CTRL + X']])
  })
})
