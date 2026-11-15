import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_LABELS, type AgentState } from '../../../src/shared/agents'
import type { DictationState } from '../../../src/shared/dictation'
import type { SottoPlatform } from '../../../src/shared/platform'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../../src/shared/settings'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { onStopMicrophoneTests } from '../../../src/renderer/src/audio/microphoneTest'
import { SetupWalk } from '../../../src/renderer/src/features/setup/SetupWalk'
import type { SetupPage } from '../../../src/renderer/src/features/setup/setupStops'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
/** This computer with Codex connected or not, and one project or none. */
function agentState(options: { ready?: boolean; project?: boolean } = {}): AgentState {
  const state = threadsStateFixture({ cloneOverrides: false })
  state.host.providers = [{ id: 'codex', name: PROVIDER_LABELS.codex, version: '0.59.1', connection: options.ready ? 'connected' : 'disconnected', capabilities: caps }]
  state.host.projects = options.project ? state.host.projects.slice(0, 1) : []
  return state
}

// jsdom lays nothing out: every element reports no box, so the walk would light nothing. Elements given a box here have one.
let layout: { mockRestore: () => void }[] = []
function giveBoxes(): void {
  const box = { top: 100, left: 400, width: 300, height: 60, right: 700, bottom: 160, x: 400, y: 100, toJSON: () => ({}) } as DOMRect
  layout = [
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(box),
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([box] as unknown as DOMRectList),
  ]
}

interface Shown {
  readonly opened: SetupPage[]
  readonly command: ReturnType<typeof vi.fn>
  readonly update: ReturnType<typeof vi.fn<(patch: SettingsPatch) => Promise<boolean>>>
  readonly close: ReturnType<typeof vi.fn<(outcome: { microphoneOpened: boolean }) => Promise<boolean>>>
  readonly rerender: (props?: Partial<Walk>) => void
}
interface Walk { settings: AppSettings; platform: SottoPlatform; speechModelChosen: boolean; dictation: DictationState; dictationOn: boolean; cloudTranscription?: boolean; navigation?: string; state: AgentState }
function show(first: Partial<Walk> = {}, close: (outcome: { microphoneOpened: boolean }) => Promise<boolean> = async () => true): Shown {
  const opened: SetupPage[] = []
  const update = vi.fn<(patch: SettingsPatch) => Promise<boolean>>(async () => true), closed = vi.fn(close)
  const command = vi.fn(async () => null)
  let props: Walk = { settings: DEFAULT_SETTINGS, platform: 'win32', speechModelChosen: false, dictation: { status: 'idle' }, dictationOn: true, state: agentState(), ...first }
  const element = (): React.ReactElement => {
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(props.state, command as never))
    return <SetupWalk settings={props.settings} platform={props.platform} onOpenPage={page => { opened.push(page) }} navigation={props.navigation} onUpdateSettings={update}
      speechModelChosen={props.speechModelChosen} dictation={props.dictation} dictationOn={props.dictationOn} cloudTranscription={props.cloudTranscription === true} onClose={closed} />
  }
  const view = render(element())
  return { opened, command, update, close: closed, rerender: next => { props = { ...props, ...next }; view.rerender(element()) } }
}
const note = (): HTMLElement => screen.getByRole('dialog')
const press = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => { await user.click(within(note()).getByRole('button', { name })) }

beforeEach(() => { vi.stubGlobal('sotto', {}) })
afterEach(() => { cleanup(); for (const spy of layout) spy.mockRestore(); layout = []; vi.unstubAllGlobals(); vi.clearAllMocks(); appearancePreview.reset(); document.body.replaceChildren() })

describe('first-run setup’s walk (ADR-0200)', () => {
  it('starts on a note over the Threads page that says what Sotto is, sets the look at once, and keeps the privacy lines', async () => {
    const user = userEvent.setup()
    const { opened, update } = show()
    expect(opened).toEqual([{ navigation: 'threads' }])
    expect(note()).toHaveAccessibleName('Talk to your computer and your coding agents')
    expect(screen.getByRole('heading', { name: 'Talk to your computer and your coding agents' })).toHaveFocus()
    expect(note()).toHaveTextContent('This walk sets up your first thread, then dictation, other computers and your iPhone. Skip any part.')
    expect(note()).toHaveTextContent('Your audio never leaves this computer. No Sotto account. Product events are on until you turn them off in Settings.')
    const looks = within(screen.getByRole('radiogroup', { name: 'Appearance' })).getAllByRole('radio')
    expect(looks.map(radio => radio.textContent)).toEqual(['Light', 'Match Windows', 'Dark'])
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(update).toHaveBeenCalledWith({ appearance: 'light' })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true'))
    expect(note()).toHaveTextContent('1 of 11')
    expect(within(note()).queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('says a look that could not be saved was not kept', async () => {
    const user = userEvent.setup()
    const { update } = show()
    update.mockResolvedValue(false)
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That look could not be saved. Your previous look is still on. Choose it again to retry.')
  })

  it('opens Settings › Providers for the agents stop and connects every installed agent there, once, leaving Threads quiet', async () => {
    const user = userEvent.setup()
    const { opened, command } = show()
    await press(user, 'Start')
    expect(note()).toHaveAccessibleName('Sign in to a coding agent')
    expect(opened.at(-1)).toEqual({ navigation: 'settings', section: 'settings-providers' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect', notice: false }))
    expect(note()).toHaveTextContent('None is ready yet. A thread needs one.')
    await press(user, 'Back')
    await press(user, 'Start')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('passes over the project and the thread while no agent is ready, and lists them as still to do on the last note', async () => {
    const user = userEvent.setup()
    show()
    await press(user, 'Start')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Check your microphone')
    expect(note()).toHaveTextContent('5 of 11')
    await press(user, 'Back')
    expect(note()).toHaveAccessibleName('Sign in to a coding agent')
    for (let presses = 0; presses < 7; presses += 1) await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('That’s setup')
    const left = within(note()).getAllByRole('listitem').map(item => item.textContent)
    expect(left).toEqual([
      'Sign in to a coding agent: Settings › Providers', 'Add a project folder: Add project, in the sidebar', 'Start your first thread: New thread, in the sidebar',
      'Check your microphone: Settings › Dictation', 'Choose a speech model: Settings › Dictation', 'Try the shortcut: the Dictate page',
      'Tailscale joins your devices: Settings › Hosts & phones', 'Run threads on another computer: Settings › Hosts & phones', 'Answer threads from your iPhone: Settings › Hosts & phones',
    ])
    expect(within(note()).queryByRole('button', { name: 'Skip setup' })).toBeNull()
  })

  it('goes from a ready agent to the project and the thread, and says setup’s first part is done once a thread is open', async () => {
    const user = userEvent.setup()
    giveBoxes()
    const shown = show({ state: agentState({ ready: true }) })
    await press(user, 'Start')
    expect(note()).toHaveTextContent('Codex is ready.')
    await press(user, 'Continue')
    expect(note()).toHaveAccessibleName('Add a project folder')
    expect(within(note()).getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    shown.rerender({ state: agentState({ ready: true, project: true }) })
    await waitFor(() => expect(within(note()).getByRole('button', { name: 'Continue' })).toBeInTheDocument())
    await press(user, 'Continue')
    expect(note()).toHaveAccessibleName('Start your first thread')
    expect(within(note()).getByRole('button', { name: 'Skip setup' })).toBeInTheDocument()
    // The thread's composer arrives on the page: the stop lights it, and everything after is optional.
    const composer = document.createElement('form')
    composer.className = 'thread-prompt'
    act(() => { document.body.append(composer) })
    await waitFor(() => expect(note()).toHaveAccessibleName('This is a thread'))
    expect(note()).toHaveTextContent('Your first thread is open. The rest is optional.')
    expect(within(note()).getByRole('button', { name: 'Continue to dictation' })).toBeInTheDocument()
    expect(within(note()).getByRole('button', { name: 'Finish here' })).toBeInTheDocument()
  })

  it('lights Expand sidebar and says to open the sidebar first where the sidebar is a rail, as in a narrow window', async () => {
    const user = userEvent.setup()
    giveBoxes()
    const rail = document.createElement('button')
    rail.dataset.setup = 'expand-sidebar'
    document.body.append(rail)
    show({ state: agentState({ ready: true }) })
    await press(user, 'Start')
    await press(user, 'Continue')
    await waitFor(() => expect(note()).toHaveTextContent('Open the sidebar, press Add project and choose one.'))
    await press(user, 'Skip for now')
    await waitFor(() => expect(note()).toHaveTextContent('Open the sidebar and press New thread.'))
  })

  it('passes over the dictation stops while dictation is off, and adds Omarchy’s stop only on Linux', async () => {
    const user = userEvent.setup()
    const off = show({ dictationOn: false })
    expect(note()).not.toHaveTextContent('dictation')
    await press(user, 'Start')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Tailscale joins your devices')
    expect(off.opened.at(-1)).toEqual({ navigation: 'settings', section: 'settings-hosts' })
    cleanup()
    vi.stubGlobal('sotto', { omarchySetup: { get: vi.fn(async () => null), onChanged: () => () => undefined, onFocus: () => () => undefined, command: vi.fn() } })
    show({ platform: 'linux' })
    expect(note()).toHaveTextContent('1 of 12')
    expect(within(screen.getByRole('radiogroup', { name: 'Appearance' })).getAllByRole('radio')[1]).toHaveTextContent('Match Linux')
    await press(user, 'Start')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Set up Sotto in Omarchy')
  })

  it('names the speech model setup suggests while none is chosen', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => null)
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(agentState(), command as never))
    render(<SetupWalk settings={DEFAULT_SETTINGS} platform="win32" onOpenPage={() => undefined} onUpdateSettings={async () => true}
      speechModelChosen={false} suggestedSpeechModel="Parakeet Ultra" dictation={{ status: 'idle' }} dictationOn onClose={async () => true} />)
    await press(user, 'Start')
    await press(user, 'Skip for now')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Choose a speech model')
    expect(note()).toHaveTextContent('Choose a model here; Sotto suggests Parakeet Ultra.')
  })

  it('reads the shortcut as tried once a dictation ends in text during its stop, and a chosen speech model as done', async () => {
    const user = userEvent.setup()
    const shown = show({ speechModelChosen: true })
    await press(user, 'Start')
    await press(user, 'Skip for now')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Choose a speech model')
    await press(user, 'Continue')
    expect(note()).toHaveAccessibleName('Try the shortcut')
    expect(shown.opened.at(-1)).toEqual({ navigation: 'home' })
    expect(within(note()).getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    shown.rerender({ dictation: { status: 'success', sessionId: 'one', text: 'Hello', output: 'pasted' } })
    await waitFor(() => expect(note()).toHaveTextContent('That worked.'))
    expect(within(note()).getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  it('stops Settings’ microphone test as it moves on from the microphone stop, and reports whether the test opened the microphone', async () => {
    const user = userEvent.setup()
    const stopped = vi.fn()
    const forget = onStopMicrophoneTests(stopped)
    try {
      const { close } = show()
      await press(user, 'Start')
      await press(user, 'Skip for now')
      expect(note()).toHaveAccessibleName('Check your microphone')
      // Settings' own test row, as its page draws it once the test has heard a voice.
      const test = document.createElement('div')
      test.className = 'settings-microphone-test'
      test.dataset.state = 'ready'
      test.dataset.heard = 'true'
      act(() => { document.body.append(test) })
      await waitFor(() => expect(note()).toHaveTextContent('Sotto heard you. Your microphone works.'))
      expect(stopped).not.toHaveBeenCalled()
      await press(user, 'Continue')
      expect(stopped).toHaveBeenCalledTimes(1)
      await press(user, 'Skip setup')
      await waitFor(() => expect(close).toHaveBeenCalledWith({ microphoneOpened: true }))
    } finally { forget() }
  })

  it('ends from Skip setup and from the last note, and keeps the note with a plain sentence when its end could not be saved', async () => {
    const user = userEvent.setup()
    const saved = show()
    await press(user, 'Skip setup')
    await waitFor(() => expect(saved.close).toHaveBeenCalledWith({ microphoneOpened: false }))
    cleanup()
    const failing = show({}, async () => false)
    await press(user, 'Skip setup')
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup could not be saved. Your choices are intact; please try again.')
    expect(note()).toHaveAccessibleName('Talk to your computer and your coding agents')
    await press(user, 'Skip setup')
    await waitFor(() => expect(failing.close).toHaveBeenCalledTimes(2))
  })

  it('ends on Escape as Skip setup does, unless the lit control used that Escape for itself', async () => {
    const user = userEvent.setup()
    const { close } = show()
    await press(user, 'Start')
    // A control that answers Escape itself, as an opened provider row does, keeps it.
    const row = document.createElement('button')
    row.textContent = 'An opened row'
    row.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault() })
    document.body.append(row)
    row.focus()
    await user.keyboard('{Escape}')
    expect(close).not.toHaveBeenCalled()
    screen.getByRole('heading', { name: 'Sign in to a coding agent' }).focus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(close).toHaveBeenCalledWith({ microphoneOpened: false }))
  })

  it('does not promise that audio stays on this computer, or offer a speech model, while an OpenRouter model transcribes (ADR-0160)', async () => {
    const user = userEvent.setup()
    show({ cloudTranscription: true })
    expect(note()).toHaveTextContent('turns your voice into text. This walk')
    expect(note()).not.toHaveTextContent('never leaves this computer')
    expect(note()).toHaveTextContent('No Sotto account. Product events are on until you turn them off in Settings.')
    await press(user, 'Start')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Check your microphone')
    await press(user, 'Skip for now')
    expect(note()).toHaveAccessibleName('Try the shortcut')
  })

  it('leaves a key the lit control used for itself alone, and lets no key through to the window’s own shortcuts', async () => {
    const user = userEvent.setup()
    giveBoxes()
    const lit = document.createElement('button')
    lit.dataset.setup = 'add-project'
    lit.addEventListener('keydown', event => { if (event.key === 'Tab') event.preventDefault() })
    document.body.append(lit)
    const windowKeys = vi.fn()
    window.addEventListener('keydown', windowKeys)
    try {
      show({ state: agentState({ ready: true }) })
      await press(user, 'Start')
      await press(user, 'Continue')
      await waitFor(() => expect(document.querySelector('.setup-walk__lit')).not.toBeNull())
      lit.focus()
      // The control took Tab itself, as the composer does to accept a suggestion: focus stays where it put it.
      await user.keyboard('{Tab}')
      expect(document.activeElement).toBe(lit)
      await user.keyboard('{F6}')
      expect(windowKeys).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', windowKeys) }
  })

  it('stands aside while the lit control shows a list of its own, which reaches past its box', async () => {
    const user = userEvent.setup()
    giveBoxes()
    const composer = document.createElement('form')
    composer.className = 'thread-prompt'
    document.body.append(composer)
    show({ state: agentState({ ready: true, project: true }) })
    await press(user, 'Start')
    await press(user, 'Continue')
    await press(user, 'Continue')
    await waitFor(() => expect(note()).toHaveAccessibleName('This is a thread'))
    const suggestions = document.createElement('ul')
    suggestions.setAttribute('role', 'listbox')
    act(() => { composer.append(suggestions) })
    await waitFor(() => expect(document.querySelector('.setup-walk')).toBeNull())
    act(() => { suggestions.remove() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'This is a thread' })).toHaveFocus())
  })

  it('waits in the corner, with the page live, when a lit control leads to another page, and comes back on Back to setup', async () => {
    const user = userEvent.setup()
    const windowKeys = vi.fn()
    window.addEventListener('keydown', windowKeys)
    try {
      const shown = show({ navigation: 'threads' })
      await press(user, 'Start')
      // The walk's own move to its next page is not being led away: the note stays until that page has shown.
      expect(note()).toHaveAccessibleName('Sign in to a coding agent')
      shown.rerender({ navigation: 'settings' })
      expect(note()).toHaveAccessibleName('Sign in to a coding agent')
      // A lit control then takes the user to Threads.
      shown.rerender({ navigation: 'threads' })
      const waiting = await screen.findByRole('region', { name: 'Setup' })
      expect(waiting).toHaveTextContent('Setup is waiting')
      expect(waiting).toHaveTextContent('It was on “Sign in to a coding agent”. Come back to it when you are ready.')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.querySelector('.setup-walk__dim')).toBeNull()
      // The page is the user's, keys and all: Escape does not end setup, and the window's shortcuts hear their keys.
      await user.keyboard('{Escape}')
      expect(shown.close).not.toHaveBeenCalled()
      expect(windowKeys).toHaveBeenCalled()
      await user.click(within(waiting).getByRole('button', { name: 'Back to setup' }))
      expect(shown.opened.at(-1)).toEqual({ navigation: 'settings', section: 'settings-providers' })
      shown.rerender({ navigation: 'settings' })
      await waitFor(() => expect(note()).toHaveAccessibleName('Sign in to a coding agent'))
      // Skip setup is offered while it waits, too.
      shown.rerender({ navigation: 'help' })
      await user.click(within(await screen.findByRole('region', { name: 'Setup' })).getByRole('button', { name: 'Skip setup' }))
      await waitFor(() => expect(shown.close).toHaveBeenCalledTimes(1))
    } finally { window.removeEventListener('keydown', windowKeys) }
  })

  it('keeps focus in the note and the control it lights: Tab goes through the note, then the control, and round', async () => {
    const user = userEvent.setup()
    giveBoxes()
    const lit = document.createElement('button')
    lit.dataset.setup = 'add-project'
    lit.textContent = 'Add project'
    const elsewhere = document.createElement('button')
    elsewhere.textContent = 'Elsewhere'
    document.body.append(elsewhere, lit)
    show({ state: agentState({ ready: true }) })
    await press(user, 'Start')
    await press(user, 'Continue')
    expect(note()).toHaveAccessibleName('Add a project folder')
    await waitFor(() => expect(document.querySelector('.setup-walk__lit')).not.toBeNull())
    const order = [...within(note()).getAllByRole('button'), lit]
    order[0]!.focus()
    for (const next of [...order.slice(1), order[0]!]) {
      await user.tab()
      expect(document.activeElement).toBe(next)
    }
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(lit)
    expect(document.activeElement).not.toBe(elsewhere)
  })

  it('stands aside for a dialog a lit control opened, and comes back with focus on its note when the dialog closes', async () => {
    const user = userEvent.setup()
    giveBoxes()
    show()
    await press(user, 'Start')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'Sign in to Codex on This computer')
    act(() => { document.body.append(dialog) })
    await waitFor(() => expect(document.querySelector('.setup-walk')).toBeNull())
    act(() => { dialog.remove() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in to a coding agent' })).toHaveFocus())
  })
})
