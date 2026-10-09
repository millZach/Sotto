import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings, settingsSchema } from '../../../../src/shared/settings'
import { followTerminalFontSize, setTerminalPreferences, terminalFontSize, terminalShortcut, zoomTerminal } from '../../../../src/renderer/src/tools/terminalPreferences'

beforeEach(() => setTerminalPreferences(DEFAULT_SETTINGS, async () => true))

it.each(['win32', 'darwin', 'linux'] as const)('claims only terminal chords on %s and leaves a conflicting dictation hotkey alone', platform => {
  const modifiers = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  for (const [key, action] of [['f', 'search'], ['=', 'larger'], ['-', 'smaller'], ['0', 'reset']] as const) {
    const event = new KeyboardEvent('keydown', { key, ...modifiers })
    expect(terminalShortcut(event, platform)).toBe(action)
    setTerminalPreferences({ ...DEFAULT_SETTINGS, hotkey: `${platform === 'darwin' ? 'Command' : 'Control'}+${key}` }, async () => true)
    expect(terminalShortcut(event, platform)).toBeNull()
    setTerminalPreferences(DEFAULT_SETTINGS, async () => true)
    expect(terminalShortcut(new KeyboardEvent('keydown', { key, ...modifiers, altKey: true }), platform)).toBeNull()
    expect(terminalShortcut(new KeyboardEvent('keydown', { key, ...modifiers, shiftKey: true }), platform)).toBeNull()
  }
  expect(terminalShortcut(new KeyboardEvent('keydown', { key: 'j', ...modifiers }), platform)).toBeNull()
  expect(terminalShortcut(new KeyboardEvent('keydown', { key: 'f', ...modifiers, isComposing: true }), platform)).toBeNull()
  for (const [key, code, accelerator, action] of [['-', 'NumpadSubtract', 'numsub', 'smaller'], ['0', 'Numpad0', 'num0', 'reset']] as const) {
    setTerminalPreferences({ ...DEFAULT_SETTINGS, hotkey: `${platform === 'darwin' ? 'Command' : 'Control'}+${accelerator}` }, async () => true)
    expect(terminalShortcut(new KeyboardEvent('keydown', { key, code, ...modifiers }), platform)).toBeNull()
    expect(terminalShortcut(new KeyboardEvent('keydown', { key, ...modifiers }), platform)).toBe(action)
  }
})

it('keeps rapid zoom presses through older settings acknowledgements, bounds sizes and restores a failed save', async () => {
  const first = Promise.withResolvers<boolean>(), second = Promise.withResolvers<boolean>()
  const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(true)
  setTerminalPreferences(DEFAULT_SETTINGS, save)
  const updated = vi.fn(), stop = followTerminalFontSize(updated)
  const a = zoomTerminal('larger'), b = zoomTerminal('larger')
  expect(terminalFontSize()).toBe(15)
  setTerminalPreferences({ ...DEFAULT_SETTINGS, terminalFontSize: 14 }, save)
  expect(terminalFontSize()).toBe(15)
  first.resolve(true); await a
  second.resolve(true); await b
  expect(terminalFontSize()).toBe(15)
  expect(save.mock.calls).toEqual([[{ terminalFontSize: 14 }], [{ terminalFontSize: 15 }]])
  await zoomTerminal('reset')
  expect(terminalFontSize()).toBe(13)
  setTerminalPreferences({ ...DEFAULT_SETTINGS, terminalFontSize: 32 }, save)
  await zoomTerminal('larger'); expect(terminalFontSize()).toBe(32)
  setTerminalPreferences({ ...DEFAULT_SETTINGS, terminalFontSize: 8 }, save)
  await zoomTerminal('smaller'); expect(terminalFontSize()).toBe(8)
  setTerminalPreferences(DEFAULT_SETTINGS, async () => false)
  expect(await zoomTerminal('larger')).toBe(false)
  expect(terminalFontSize()).toBe(13)
  expect(updated).toHaveBeenCalled()
  stop()
})

it('loads old profiles at 13 pixels, preserves a saved size and rejects invalid sizes', () => {
  expect(parseSettings({}).terminalFontSize).toBe(13)
  expect(parseSettings({ terminalFontSize: 19 }).terminalFontSize).toBe(19)
  for (const terminalFontSize of [7, 33, 12.5, '16']) {
    expect(parseSettings({ terminalFontSize }).terminalFontSize).toBe(13)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, terminalFontSize }).success).toBe(false)
  }
})
