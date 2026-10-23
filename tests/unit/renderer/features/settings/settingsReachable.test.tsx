import { threadsStateFixture } from '../../../../fixtures/agentState'
import { phonesBridgeFixture } from '../../../../fixtures/renderer/hostBridges'
import { baseProps, settingsTab } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { i18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import {
  findSettingControl, isSettingsSection, settingsIndex, settingsSectionHome, SETTINGS_PAGES, type SettingEntry, type SettingsSectionId,
} from '../../../../../src/renderer/src/features/settings/settingsPages'
import type { NotificationsBridge } from '../../../../../src/shared/desktopNotifications'
import type { MainActivityBridge, MainActivityState } from '../../../../../src/shared/mainActivity'
import type { OwnServersBridge } from '../../../../../src/shared/ownModelServers'
import type { SottoPlatform } from '../../../../../src/shared/platform'
import { agentContextFixture } from '../../../../fixtures/agentContext'

// Every Owl feature on, so every page and every setting shows; the stable test below turns them off.
const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: () => owl.on,
}))

afterEach(() => { owl.on = true; vi.unstubAllGlobals() })

/** Main answering for the panels that wait on it, Phones, Performance and Notifications, so their rows show as they do in the app. */
function withMain(): void {
  const activity: MainActivityState = { reading: { blockedShare: 0.03, longestFreezeMs: 90, freezesOver100ms: 0, bars: Array.from({ length: 60 }, () => 20), frozen: false }, recording: { phase: 'idle' }, noticeHidden: false }
  const mainActivity: MainActivityBridge = { read: vi.fn(async () => activity), command: vi.fn(async () => activity), onChanged: () => () => undefined }
  const notifications: NotificationsBridge = { test: vi.fn(async () => 'shown' as const), onOpened: () => () => undefined }
  // Your own model servers, with none saved: the group shows only with its bridge (ADR-0124).
  const ownServers: OwnServersBridge = { list: vi.fn(async () => []), check: vi.fn(), add: vi.fn(), checkSaved: vi.fn(), remove: vi.fn() }
  vi.stubGlobal('sotto', { ...window.sotto, phones: phonesBridgeFixture().bridge, mainActivity, notifications, ownServers })
}

function withAgents(): void {
  const state = threadsStateFixture({ cloneOverrides: false })
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn(async () => state)))
}

const pageLabel = (id: string): string => SETTINGS_PAGES.find(page => page.id === id)!.label
const panelOf = (page: string): HTMLElement => document.getElementById(page === 'settings-appearance' ? 'settings-appearance-panel' : page)!

/** Every form control a page shows, outside dialogs, by its element. */
function controlsOn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role="switch"], [role="radiogroup"], select, textarea, input:not([type="hidden"]):not([type="search"])')]
    .filter(control => !control.closest('[role="dialog"]') && !control.closest('[role="radiogroup"]:not(:scope)'))
}

const nameOf = (control: HTMLElement): string => control.getAttribute('aria-label')
  ?? (control as HTMLInputElement).labels?.[0]?.textContent?.trim()
  ?? control.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent?.trim()).join(' ')
  ?? control.outerHTML.slice(0, 80)

describe.each<SottoPlatform>(['win32', 'darwin', 'linux'])('Every setting is reachable on %s', platform => {
  it('names a control on its own page for every entry Find a setting offers, and offers an entry for every control', async () => {
    withAgents()
    withMain()
    render(<SettingsView {...baseProps({ platform })} />)
    await waitFor(() => expect(document.querySelector('.phones-name')).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Tell me when main freezes', hidden: true })).toBeInTheDocument())
    const index = settingsIndex(platform)
    const resolved = new Map<SettingEntry, HTMLElement>()
    const missing: string[] = []
    for (const entry of index) {
      const page = settingsSectionHome(entry.section).page
      // A setting that shows only in some states lands on its fallback until then.
      const control = findSettingControl(panelOf(page), entry.id) ?? (entry.fallback ? findSettingControl(panelOf(page), entry.fallback) : null)
      if (control) resolved.set(entry, control)
      else missing.push(`${entry.label} (${pageLabel(page)})`)
    }
    expect(missing.join('\n')).toBe('')

    // The other way round: a control no entry leads to could only be found by reading every page.
    const unreached: string[] = []
    for (const page of SETTINGS_PAGES) {
      for (const control of controlsOn(panelOf(page.id))) {
        // A control counts when the entry's control holds it, or opens the part of the page that does (Project defaults).
        const reaches = (found: HTMLElement): boolean => found === control || found.contains(control)
          || (found.hasAttribute('aria-controls') && document.getElementById(found.getAttribute('aria-controls')!)?.contains(control) === true)
        if (![...resolved.values()].some(reaches)) unreached.push(`${nameOf(control)} (${page.label})`)
      }
    }
    expect(unreached.join('\n')).toBe('')
  })
})

describe('Find a setting', () => {
  it('lists what matches with its page, opens the page on a press and puts focus on the setting', async () => {
    const user = userEvent.setup()
    withAgents()
    render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'web links')
    // The pages give way to the matches while the field holds text.
    expect(document.querySelector('nav[aria-label="Settings sections"]')).not.toBeVisible()
    const found = screen.getByRole('list', { name: 'Settings found' })
    expect(within(found).getAllByRole('button').map(button => button.textContent)).toEqual(['Web links in threadsThreads'])
    await user.click(within(found).getByRole('button', { name: /Web links in threads/u }))
    expect(settingsTab('Threads')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('radiogroup', { name: 'Web links in threads' })).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByRole('searchbox', { name: 'Find a setting' })).toHaveValue('')
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeVisible()
  })

  it('works from the keyboard: Down into the matches, Up back to the field, Enter opens the first, Escape clears', async () => {
    const user = userEvent.setup()
    withAgents()
    render(<SettingsView {...baseProps()} />)
    const field = screen.getByRole('searchbox', { name: 'Find a setting' })
    await user.type(field, 'paste')
    const matches = within(screen.getByRole('list', { name: 'Settings found' })).getAllByRole('button')
    expect(matches.map(button => button.textContent)).toEqual(['Paste delayDictation', 'Automatic pasteDictation'])
    expect(screen.getByText('2 settings found')).toHaveAttribute('role', 'status')
    await user.keyboard('{ArrowDown}')
    expect(matches[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(matches[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(field).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(field).toHaveValue('')
    await user.type(field, 'merge method{Enter}')
    expect(settingsTab('Git & worktrees')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox', { name: 'Default merge method' })).toHaveFocus()
  })

  it('finds a setting by what the page says under it', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'offline')
    expect(within(screen.getByRole('list', { name: 'Settings found' })).getAllByRole('button').map(button => button.textContent)).toEqual(['AI formattingCleanup'])
  })

  it('matches the words in a row with no description of its own, such as Clear transcript history', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'without changing')
    expect(within(screen.getByRole('list', { name: 'Settings found' })).getAllByRole('button').map(button => button.textContent)).toContain('Clear transcript historyApplication')
  })

  it('leaves out a setting its page is not showing, such as the providers while the local host is off', async () => {
    const user = userEvent.setup()
    // No agent state: Providers shows only Loading providers, with no switch to land on.
    render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'client updates')
    expect(screen.getByText('No setting matches “client updates”.')).toBeVisible()
  })

  it('lands on a setting that shows only in some states, or where it will show until then', async () => {
    const user = userEvent.setup()
    const view = render(<SettingsView {...baseProps()} />)
    const field = screen.getByRole('searchbox', { name: 'Find a setting' })
    await user.type(field, 'custom instructions{Enter}')
    expect(screen.getByRole('combobox', { name: 'Commit and pull request style' })).toHaveFocus()
    view.rerender(<SettingsView {...baseProps({ settings: { ...baseProps().settings, gitWritingStyle: 'custom' } })} />)
    await user.type(field, 'custom instructions{Enter}')
    expect(screen.getByRole('textbox', { name: 'Custom instructions' })).toHaveFocus()
  })

  it('lands on the first computer’s projects folder when each computer has its own', () => {
    document.body.innerHTML = '<section id="root"><label>Default projects directory on this computer<input data-setting="projects-directory" aria-label="Default projects directory on this computer"></label><input data-setting="projects-directory" aria-label="Default projects directory on forge"></section>'
    const control = findSettingControl(document.getElementById('root')!, 'projects-directory')
    expect(control).toHaveAttribute('aria-label', 'Default projects directory on this computer')
    document.body.innerHTML = ''
  })

  it('finds a setting by the other words it goes by, and says so when nothing matches', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    const field = screen.getByRole('searchbox', { name: 'Find a setting' })
    await user.type(field, 'hotkey')
    expect(within(screen.getByRole('list', { name: 'Settings found' })).getByRole('button', { name: /Dictation shortcuts/u })).toBeVisible()
    await user.clear(field)
    await user.type(field, 'zebra')
    expect(screen.getByText('No setting matches “zebra”.')).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Settings found' })).toBeNull()
  })

  it('offers only what the page shows: no Owl settings on stable, no dictation settings while dictation is off', async () => {
    const user = userEvent.setup()
    owl.on = false
    const stable = render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'resume')
    expect(screen.getByText('No setting matches “resume”.')).toBeVisible()
    stable.unmount()
    owl.on = true
    render(<SettingsView {...baseProps({ settings: { ...baseProps().settings, dictationEnabled: false } })} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'paste')
    expect(screen.getByText('No setting matches “paste”.')).toBeVisible()
  })

  it('finds Your own model servers only on Owl, where main gave the window its bridge, and opens Providers at the group', async () => {
    const user = userEvent.setup()
    withAgents()
    withMain()
    owl.on = false
    const stable = render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'model servers')
    expect(screen.getByText('No setting matches “model servers”.')).toBeVisible()
    stable.unmount()
    owl.on = true
    render(<SettingsView {...baseProps()} />)
    await waitFor(() => expect(document.getElementById('settings-providers')?.querySelector('.own-servers')).not.toBeNull())
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'ollama')
    await user.click(within(screen.getByRole('list', { name: 'Settings found' })).getByRole('button', { name: /Your own model servers/u }))
    expect(settingsTab('Providers')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Add a server' })).toHaveFocus()
  })

  it('finds a setting by its translated name and still by its English one, and lands on the translated control', async () => {
    const user = userEvent.setup()
    // A stand-in translation of the names this needs; every other message shows in English.
    const translated = { Microphone: 'Mikrofon', Dictation: 'Diktat', 'Find a setting': 'Einstellung suchen', 'Settings found': 'Gefundene Einstellungen' }
    i18n.loadAndActivate({ locale: 'de', messages: Object.fromEntries(Object.entries(translated).map(([english, german]) => [generateMessageId(english), german])) })
    try {
      render(<SettingsView {...baseProps()} />)
      const field = screen.getByRole('searchbox', { name: 'Einstellung suchen' })
      for (const typed of ['mikro', 'microphone']) {
        await user.clear(field)
        await user.type(field, typed)
        expect(within(screen.getByRole('list', { name: 'Gefundene Einstellungen' })).getAllByRole('button').map(button => button.textContent)[0]).toBe('MikrofonDiktat')
      }
      await user.keyboard('{Enter}')
      expect(screen.getByRole('combobox', { name: 'Mikrofon' })).toHaveFocus()
    } finally {
      act(() => i18n.activate('en'))
    }
  })

  it('lands on a control its page still shows in English while the index shows a translated name', async () => {
    const user = userEvent.setup()
    withMain()
    // Only the index's name and its page are translated here; the switch keeps its English name, as a part of the page
    // another change has not translated yet would.
    const translated = { 'Tell me when main freezes': 'Melden, wenn main hängt', Performance: 'Leistung', 'Find a setting': 'Einstellung suchen', 'Settings found': 'Gefundene Einstellungen' }
    i18n.loadAndActivate({ locale: 'de', messages: Object.fromEntries(Object.entries(translated).map(([english, german]) => [generateMessageId(english), german])) })
    try {
      render(<SettingsView {...baseProps()} />)
      const control = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-setting="main-freeze-notice"]'); expect(found).not.toBeNull(); return found! })
      const field = screen.getByRole('searchbox', { name: 'Einstellung suchen' })
      for (const typed of ['hängt', 'main freezes']) {
        await user.clear(field)
        await user.type(field, typed)
        expect(within(screen.getByRole('list', { name: 'Gefundene Einstellungen' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Melden, wenn main hängtLeistung'])
      }
      await user.keyboard('{Enter}')
      expect(control).toHaveFocus()
    } finally {
      act(() => i18n.activate('en'))
    }
  })

  it('pulls focus to a found setting once, not on every later visit to its page', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Find a setting' }), 'reduced motion{Enter}')
    expect(screen.getByRole('combobox', { name: 'Reduced motion' })).toHaveFocus()
    settingsTab('Appearance').focus()
    await user.keyboard('{ArrowDown}{ArrowUp}')
    expect(settingsTab('Appearance')).toHaveFocus()
  })
})

/** Every section id Settings has answered to: the pages there were before October 22, 2026, and the Updates block. */
const OLD_SECTIONS = [
  ['settings-capture', 'Dictation'], ['settings-transcription', 'Dictation'], ['settings-formatting', 'Cleanup'], ['settings-providers', 'Providers'],
  ['settings-hosts', 'Hosts & phones'], ['settings-phones', 'Hosts & phones'], ['settings-cloud-iphone', 'Cloud iPhone'], ['settings-agents', 'Threads'],
  ['settings-watcher', 'Watcher'], ['settings-output', 'Dictation'], ['settings-appearance', 'Appearance'], ['settings-privacy', 'Application'],
  ['settings-updates', 'Application'], ['settings-git', 'Git & worktrees'], ['settings-performance', 'Performance'],
] as const

describe('Old section links', () => {
  it.each(OLD_SECTIONS)('%s still opens %s, where an element carries the id', async (id, page) => {
    withAgents()
    expect(isSettingsSection(id)).toBe(true)
    const view = render(<SettingsView {...baseProps()} />)
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    view.rerender(<SettingsView {...baseProps()} openSection={{ section: id as SettingsSectionId, key: 1 }} />)
    expect(settingsTab(page)).toHaveAttribute('aria-selected', 'true')
    const visible = screen.getByRole('tabpanel', { name: page })
    const target = document.getElementById(id)!
    expect(visible === target || visible.contains(target) || target.contains(visible)).toBe(true)
    // A group further down the page is brought into view.
    if (settingsSectionHome(id as SettingsSectionId).group) expect(scrolled).toHaveBeenCalled()
  })

  it('opens a page again when the same section is asked for twice, and ignores an id it does not know', () => {
    const view = render(<SettingsView {...baseProps()} openSection={{ section: 'settings-git', key: 1 }} />)
    expect(settingsTab('Git & worktrees')).toHaveAttribute('aria-selected', 'true')
    act(() => { settingsTab('Cleanup').click() })
    view.rerender(<SettingsView {...baseProps()} openSection={{ section: 'settings-git', key: 2 }} />)
    expect(settingsTab('Git & worktrees')).toHaveAttribute('aria-selected', 'true')
    view.rerender(<SettingsView {...baseProps()} openSection={{ section: 'settings-nowhere' as SettingsSectionId, key: 3 }} />)
    expect(settingsTab('Git & worktrees')).toHaveAttribute('aria-selected', 'true')
    expect(isSettingsSection('settings-nowhere')).toBe(false)
  })

  it('falls back to the first page for a section whose page is hidden, such as Cleanup while dictation is off', () => {
    render(<SettingsView {...baseProps({ settings: { ...baseProps().settings, dictationEnabled: false } })} openSection={{ section: 'settings-formatting', key: 1 }} />)
    expect(settingsTab('Dictation')).toHaveAttribute('aria-selected', 'true')
  })
})
