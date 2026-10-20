// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hyprlandUses, inspectDictationBindings } from '../../../src/main/omarchy/setup'
import type { DictationShortcutSet } from '../../../src/shared/dictationShortcuts'
import { omarchySetupFixture, snippetBinds } from '../../fixtures/omarchySetup'

const DEFAULTS: DictationShortcutSet = { press: ['Super+CommandOrControl+X'], hold: ['F9'] }

describe('Changing Sotto’s Hyprland keys from Settings', () => {
  let f: Awaited<ReturnType<typeof omarchySetupFixture>>
  let saved: DictationShortcutSet
  let commit: ReturnType<typeof vi.fn<(set: DictationShortcutSet) => Promise<void>>>
  beforeEach(async () => {
    f = await omarchySetupFixture()
    saved = DEFAULTS
    commit = vi.fn(async (set: DictationShortcutSet) => { saved = { press: [...set.press], hold: [...set.hold] } })
  })
  afterEach(async () => { await f?.dispose() })
  const engine = (holdShortcutsEnabled = true) => f.make(f.run, { shortcuts: async () => saved, commitShortcuts: commit, holdShortcutsEnabled })
  const setUpKeys = async (setup = engine()) => {
    const result = await setup.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect(result.pieces.keys.status).toBe('done')
    return setup
  }
  const hyprCalls = () => f.calls.filter(call => call === 'hyprctl reload').length

  it('refuses to write anything until Sotto’s keys are set up, and says so', async () => {
    const result = await engine().replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('aren’t set up in Hyprland yet') })
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(hyprCalls()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })

  it('leaves keys set up by hand alone', async () => {
    f.desktop.binds = snippetBinds(await readFile(join(f.resources, 'bindings.lua'), 'utf8')).binds
    const setup = engine()
    expect((await setup.get()).pieces.keys.status).toBe('manual')
    const result = await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('by hand') })
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBeNull()
  })

  it('rewrites only Sotto’s snippet for a new press shortcut, keeps the setup backup and saves the shortcuts', async () => {
    const setup = await setUpKeys()
    const bindingsAfterSetup = await readFile(f.bindings, 'utf8')
    const backups = (await readdir(join(f.home, '.config/hypr'))).filter(name => name.startsWith('bindings.lua.bak.'))
    expect(backups).toHaveLength(1)

    const result = await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(result).toEqual({ ok: true })
    const snippet = await readFile(f.snippet, 'utf8')
    expect(snippet).toContain('o.bind("SUPER + ALT + D", "Toggle Sotto dictation", dictation("toggle"))')
    expect(snippet).toContain('o.bind("F9", "Stop Sotto dictation (push-to-talk)", dictation("stop"), { release = true })')
    expect(snippet).not.toContain('SUPER + CTRL + X')
    // Backup first: the snippet it replaced sits beside it.
    expect(await readFile(join(f.home, '.config/hypr/sotto-bindings.lua.bak'), 'utf8')).toBe(await readFile(join(f.resources, 'bindings.lua'), 'utf8'))
    // bindings.lua keeps its single require; the backup made at setup is still the original.
    expect(await readFile(f.bindings, 'utf8')).toBe(bindingsAfterSetup)
    expect((await readdir(join(f.home, '.config/hypr'))).filter(name => name.startsWith('bindings.lua.bak.'))).toEqual(backups)
    expect(await readFile(join(f.home, '.config/hypr', backups[0]!), 'utf8')).toBe('-- My keys\n')
    // Hyprland checked the change and loaded the new binding.
    expect(f.calls).toContain('hyprctl configerrors')
    expect(inspectDictationBindings(f.desktop.binds, false, saved).manual).toBe(true)
    expect(commit).toHaveBeenCalledWith({ press: ['Super+Alt+D'], hold: ['F9'] })
    // Sotto owns the new snippet: the next inspection reads it as done, not changed by hand.
    expect((await setup.get()).pieces.keys).toMatchObject({ status: 'done', owned: true })
    // Super+Ctrl+X goes back to Voxtype, which Sotto no longer unbinds.
    expect(f.desktop.binds.some(bind => bind.key === 'X' && bind.modmask === 68 && bind.arg.startsWith('voxtype'))).toBe(true)
  })

  it('never writes bindings.lua for a shortcut change, so an edit made meanwhile stays, even through a rollback', async () => {
    let editing = false
    const setup = await setUpKeys(f.make(async (command, args) => {
      // The user saves bindings.lua while Sotto checks the new snippet.
      if (editing && command === 'luac') await f.write(f.bindings, `${await readFile(f.bindings, 'utf8')}-- edited meanwhile\n`)
      return f.run(command, args)
    }, { shortcuts: async () => saved, commitShortcuts: commit, holdShortcutsEnabled: true }))
    editing = true
    commit.mockRejectedValueOnce(new Error('disk full'))
    const reloads = f.calls.filter(call => call === 'hyprctl reload').length
    await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(await readFile(f.bindings, 'utf8')).toContain('-- edited meanwhile')
    // The keys were written, then put back after the failed save.
    expect(f.calls.filter(call => call === 'hyprctl reload').length).toBe(reloads + 2)
  })

  it('takes the snippet backup away with the keys', async () => {
    const setup = await setUpKeys()
    await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    await setup.command({ type: 'remove', pieces: ['keys'] })
    expect(await readFile(join(f.home, '.config/hypr/sotto-bindings.lua.bak'), 'utf8').catch(() => null)).toBeNull()
  })

  it('refuses a Linux hold shortcut with a modifier, whose release Hyprland can miss', async () => {
    const setup = await setUpKeys()
    expect(await setup.replaceShortcuts({ press: ['Super+CommandOrControl+X'], hold: ['Super+Alt+D'] })).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('one F key on its own') })
    expect(commit).not.toHaveBeenCalled()
  })

  it('binds a hold shortcut to start on press and stop on release', async () => {
    const setup = await setUpKeys()
    expect(await setup.replaceShortcuts({ press: ['Super+CommandOrControl+X'], hold: ['F10'] })).toEqual({ ok: true })
    const loaded = f.desktop.binds.filter(bind => bind.key === 'F10')
    expect(loaded.map(bind => [bind.arg.includes('start'), bind.release])).toEqual([[true, false], [false, true]])
  })

  it('refuses a chord Hyprland already uses, naming what it runs, and changes nothing', async () => {
    const setup = await setUpKeys()
    f.desktop.omarchy = [{ key: 'Q', modmask: 64, dispatcher: 'killactive', arg: '', release: false, description: 'Close window' }]
    await f.run('hyprctl', ['reload'])
    const snippet = await readFile(f.snippet, 'utf8')
    const result = await setup.replaceShortcuts({ press: ['Super+Q'], hold: ['F9'] })
    expect(result).toEqual({ ok: false, reason: 'conflict', chord: 'Super+Q', message: 'Hyprland already uses Super+Q for “Close window”. Pick other keys.' })
    expect(await readFile(f.snippet, 'utf8')).toBe(snippet)
    expect(commit).not.toHaveBeenCalled()
  })

  it('takes a chord from Voxtype or from another of Sotto’s own rows', async () => {
    const setup = await setUpKeys()
    // F9 moves from the hold row to the press row.
    expect(await setup.replaceShortcuts({ press: ['F9'], hold: ['F10'] })).toEqual({ ok: true })
    expect(f.desktop.binds.filter(bind => bind.key === 'F9').map(bind => bind.arg)).toEqual(["sh -c 'sotto dictation toggle --at 1'"])
  })

  it('rolls a new Hyprland error back, restores the previous snippet and shows Hyprland’s line only in the answer', async () => {
    // Hyprland reports the error only while the new snippet is loaded.
    const setup = await setUpKeys(f.make(async (command, args) => {
      const result = await f.run(command, args)
      if (command !== 'hyprctl' || args[0] !== 'configerrors') return result
      const loaded = await readFile(f.snippet, 'utf8').catch(() => '')
      return loaded.includes('SUPER + ALT + D') ? { ...result, stdout: `${result.stdout}line 12: bad bind\n` } : result
    }, { shortcuts: async () => saved, commitShortcuts: commit, holdShortcutsEnabled: true }))
    const snippet = await readFile(f.snippet, 'utf8'), bindings = await readFile(f.bindings, 'utf8')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('line 12: bad bind') })
    expect(result).toMatchObject({ message: expect.stringContaining('Sotto restored your files') })
    expect(await readFile(f.snippet, 'utf8')).toBe(snippet)
    expect(await readFile(f.bindings, 'utf8')).toBe(bindings)
    expect(commit).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    // The Omarchy panel keeps no copy of the error: it belongs to the row.
    expect((await setup.get()).pieces.keys.message).not.toContain('bad bind')
  })

  it('puts the previous keys back when the shortcuts cannot be saved', async () => {
    const setup = await setUpKeys()
    const snippet = await readFile(f.snippet, 'utf8')
    commit.mockRejectedValueOnce(new Error('disk full'))
    const result = await setup.replaceShortcuts({ press: ['Super+Alt+D'], hold: ['F9'] })
    expect(result).toEqual({ ok: false, reason: 'unavailable', message: 'Sotto could not save the shortcut. Your previous keys are back in Hyprland.' })
    expect(await readFile(f.snippet, 'utf8')).toBe(snippet)
    expect((await setup.get()).pieces.keys).toMatchObject({ status: 'done', owned: true })
  })

  it('refuses chords Hyprland cannot bind and one chord in two places', async () => {
    const setup = await setUpKeys()
    expect(await setup.replaceShortcuts({ press: ['Super+CommandOrControl'], hold: ['F9'] })).toMatchObject({ ok: false, reason: 'invalid', chord: 'Super+CommandOrControl' })
    expect(await setup.replaceShortcuts({ press: ['F9'], hold: ['F9'] })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('binds only the main press shortcut and the first hold shortcut in stable, and saves the extras whole', async () => {
    const setup = await setUpKeys(engine(false))
    const result = await setup.replaceShortcuts({ press: ['Super+Alt+D', 'Super+Alt+E'], hold: ['F9', 'F10'] })
    expect(result).toEqual({ ok: true })
    const snippet = await readFile(f.snippet, 'utf8')
    expect(snippet).toContain('SUPER + ALT + D')
    expect(snippet).not.toContain('SUPER + ALT + E')
    expect(snippet).toContain('o.bind("F9", "Start Sotto dictation (push-to-talk)"')
    expect(snippet).not.toContain('"F10"')
    expect(commit).toHaveBeenCalledWith({ press: ['Super+Alt+D', 'Super+Alt+E'], hold: ['F9', 'F10'] })
  })

  it('sets up the saved shortcuts, not the defaults, and refreshes keys whose saved shortcuts changed at start', async () => {
    saved = { press: ['Super+Alt+D'], hold: [] }
    const setup = await setUpKeys()
    expect(await readFile(f.snippet, 'utf8')).toContain('SUPER + ALT + D')
    saved = { press: ['Super+Alt+E'], hold: ['F9'] }
    expect((await setup.get()).pieces.keys.status).toBe('stale')
    const refreshed = await setup.refreshAtStart()
    expect(refreshed.pieces.keys).toMatchObject({ status: 'done', owned: true })
    expect(await readFile(f.snippet, 'utf8')).toContain('SUPER + ALT + E')
  })

  it('names the shortcuts Sotto gives back when its keys are removed', async () => {
    saved = { press: ['Super+Alt+D'], hold: [] }
    const setup = await setUpKeys()
    const result = await setup.command({ type: 'remove', pieces: ['keys'] })
    expect(result.pieces.keys.message).toBe('Super+Alt+D does nothing now.')
  })

  it('reads what Hyprland runs on a chord, leaving out Sotto and Voxtype', () => {
    const binds = [
      { key: 'Q', modmask: 64, dispatcher: 'killactive', arg: '', description: 'Close window' },
      { key: 'F9', modmask: 0, dispatcher: 'exec', arg: 'voxtype record start' },
      { key: 'X', modmask: 68, dispatcher: 'exec', arg: "sh -c 'sotto dictation toggle --at 1'" },
    ]
    expect(hyprlandUses(binds, 'Super+Q')).toBe('Close window')
    expect(hyprlandUses(binds, 'F9')).toBeNull()
    expect(hyprlandUses(binds, 'Super+CommandOrControl+X')).toBeNull()
    expect(hyprlandUses(binds, 'Super+W')).toBeNull()
  })
})
