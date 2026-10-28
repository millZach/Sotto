import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { claimRoomFocus } from '../../../src/renderer/src/components/AppShell'
import { usePageShortcuts, type PageShortcutsInput } from '../../../src/renderer/src/components/pageShortcuts'
import type { AppNavigation } from '../../../src/renderer/src/state/AppContext'
import type { ThreadShortcutChoices } from '../../../src/shared/threadShortcuts'

// Watcher and Usage are Owl features (ADR-0072); each test says whether this build has them.
const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => owl.on && (id === 'watcher' || id === 'usage'),
}))

// Dictate is a page only while dictation is on (ADR-0107).
const dictation = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/dictationFeature', () => ({ useDictationOn: () => dictation.on }))

afterEach(() => {
  cleanup()
  owl.on = true
  dictation.on = true
  claimRoomFocus('dictate'); claimRoomFocus('watcher'); claimRoomFocus('threads')
})

function Listener(props: PageShortcutsInput): null {
  usePageShortcuts(props)
  return null
}

function setup(options: { navigation?: AppNavigation; choices?: ThreadShortcutChoices; hotkey?: string; onboardingComplete?: boolean; platform?: 'win32' | 'darwin' } = {}) {
  const navigate = vi.fn()
  const settings = {
    onboardingComplete: options.onboardingComplete ?? true,
    hotkey: options.hotkey ?? 'CommandOrControl+Shift+Space',
    pressShortcuts: [] as string[],
    holdShortcuts: [] as string[],
    threadShortcuts: options.choices ?? {},
  }
  render(<Listener settings={settings} platform={options.platform ?? 'win32'} navigation={options.navigation ?? 'settings'} navigate={navigate} />)
  return { navigate }
}

const ctrl = (key: string, target: Element | Window = window, extra: Partial<KeyboardEventInit> = {}): boolean =>
  fireEvent.keyDown(target, { key, ctrlKey: true, ...extra })

describe('page shortcuts (ADR-0158)', () => {
  it('opens Dictate, Watcher, Threads, Usage and Settings on Ctrl+1 to Ctrl+5', () => {
    const { navigate } = setup({ navigation: 'threads' })
    for (const key of ['1', '2', '3', '4', '5']) expect(ctrl(key)).toBe(false)
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual(['home', 'watcher', 'threads', 'usage', 'settings'])
  })

  it('answers ⌘ on a Mac, and the keys the user chose', () => {
    const { navigate } = setup({ platform: 'darwin', choices: { 'page-usage': 'mod+alt+4', 'page-settings': null } })
    fireEvent.keyDown(window, { key: '1', metaKey: true })
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    fireEvent.keyDown(window, { key: '4', metaKey: true })
    fireEvent.keyDown(window, { key: '4', metaKey: true, altKey: true })
    fireEvent.keyDown(window, { key: '5', metaKey: true })
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual(['home', 'usage'])
  })

  it('hands focus to the opened room’s lit tab, as a switch press does, and not for a page link’s page', () => {
    setup({ navigation: 'settings' })
    ctrl('3')
    expect(claimRoomFocus('threads')).toBe(true)
    ctrl('5')
    expect(claimRoomFocus('threads')).toBe(false)
  })

  it('focuses the lit tab of the room already open, as a click on it does', () => {
    const { navigate } = setup({ navigation: 'threads' })
    const composer = document.body.appendChild(document.createElement('textarea'))
    const tab = document.body.appendChild(Object.assign(document.createElement('button'), { role: 'tab' }))
    tab.setAttribute('role', 'tab'); tab.dataset.room = 'threads'; tab.setAttribute('aria-selected', 'true')
    composer.focus()
    ctrl('3', composer)
    expect(navigate).toHaveBeenCalledWith('threads')
    expect(tab).toHaveFocus()
    composer.remove(); tab.remove()
  })

  it('hands focus on from a page that lights the same room, such as Memory', () => {
    setup({ navigation: 'memory' })
    ctrl('3')
    expect(claimRoomFocus('threads')).toBe(true)
  })

  it('puts focus in the main room when no switch on screen takes it', async () => {
    setup({ navigation: 'settings' })
    const main = document.body.appendChild(Object.assign(document.createElement('main'), { id: 'main-content', tabIndex: -1 }))
    ctrl('3')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(main).toHaveFocus()
    main.remove()
  })

  it('puts focus in the main room for the room already open when its switch is folded away', () => {
    setup({ navigation: 'threads' })
    const composer = document.body.appendChild(document.createElement('textarea'))
    const main = document.body.appendChild(Object.assign(document.createElement('main'), { id: 'main-content', tabIndex: -1 }))
    composer.focus()
    ctrl('3', composer)
    expect(main).toHaveFocus()
    composer.remove(); main.remove()
  })

  it('lands on the page’s own link once it draws, as a click on the link leaves focus there', async () => {
    const { navigate } = setup({ navigation: 'home' })
    const link = document.body.appendChild(Object.assign(document.createElement('a'), { href: '#usage' }))
    link.setAttribute('aria-current', 'page')
    ctrl('4')
    expect(navigate).toHaveBeenCalledWith('usage')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(link).toHaveFocus()
    link.remove()
  })

  it('stands down where another page shortcut was saved on its default keys while its page was hidden', () => {
    const { navigate } = setup({ choices: { 'page-threads': 'mod+1' } })
    ctrl('1')
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual(['threads'])
  })

  it('stands down where a thread shortcut was saved on the same keys before, and the other keys still answer', () => {
    const { navigate } = setup({ choices: { 'new-thread': 'mod+1' } })
    ctrl('1')
    ctrl('3')
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual(['threads'])
  })

  it('works from a text box, as thread shortcuts do, but stands down in a terminal and under a dialog', () => {
    const { navigate } = setup()
    const input = document.body.appendChild(document.createElement('textarea'))
    const terminal = document.body.appendChild(document.createElement('div'))
    terminal.className = 'xterm'
    ctrl('3', input)
    ctrl('3', terminal)
    expect(navigate).toHaveBeenCalledTimes(1)
    const dialog = document.body.appendChild(document.createElement('dialog'))
    dialog.setAttribute('open', '')
    ctrl('3')
    expect(navigate).toHaveBeenCalledTimes(1)
    input.remove(); terminal.remove(); dialog.remove()
  })

  it('answers nothing for a page this build or setting leaves out, before setup, or on dictation’s own keys', () => {
    owl.on = false
    dictation.on = false
    const { navigate } = setup({ hotkey: 'CommandOrControl+3' })
    ctrl('1'); ctrl('2'); ctrl('4'); ctrl('3')
    expect(navigate).not.toHaveBeenCalled()
    cleanup()
    const onboarding = setup({ onboardingComplete: false })
    ctrl('5')
    expect(onboarding.navigate).not.toHaveBeenCalled()
  })

  it('leaves a press another handler already took alone, and a repeat', () => {
    const { navigate } = setup()
    window.addEventListener('keydown', taken, { capture: true, once: true })
    ctrl('5')
    ctrl('5', window, { repeat: true })
    expect(navigate).not.toHaveBeenCalled()
  })
})

function taken(event: Event): void { event.preventDefault() }
