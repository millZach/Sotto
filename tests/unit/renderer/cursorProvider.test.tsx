import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentModel, type AgentProviderStatus, type AgentState } from '../../../src/shared/agents'
import type { CursorSignInBridge, CursorSignInView } from '../../../src/shared/cursorSignIn'
import type { HostSignInRequest, ProviderSignInView } from '../../../src/shared/hostProviders'
import { cursorPending } from '../../../src/main/agents/cursorRequests'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { ModelPicker } from '../../../src/renderer/src/agents/ModelPicker'
import { ProviderMark } from '../../../src/renderer/src/agents/ProviderMark'
import { modeChoices } from '../../../src/renderer/src/agents/ThreadOptions'
import { AgentRequestCard } from '../../../src/renderer/src/agents/requests/AgentRequestCard'
import { RequestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { HostProviderSignIn } from '../../../src/renderer/src/features/settings/HostProviderSignIn'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'
import { hostStatus, hostsBridgeFixture } from '../../fixtures/renderer/hostBridges'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const SIGN_IN = '44444444-4444-4444-8444-444444444444'
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const cursorModel = (id: string, name: string, source: string): AgentModel => ({ id, name, provider: 'Cursor', providerId: 'cursor', source, ready: true,
  runtimeModes: ['approval-required', 'auto', 'full-access'], reasoningEfforts: ['low', 'medium', 'high'] })
/** Cursor's list as main sends it: by maker in Cursor's order, Cursor's own Auto and Composer first, each maker's models in Cursor's order. */
const CURSOR_MODELS = [
  cursorModel('auto', 'Auto', 'Cursor'), cursorModel('composer-2.5', 'Composer 2.5', 'Cursor'),
  cursorModel('claude-4.5-sonnet', 'Claude Sonnet 4.5', 'Anthropic'), cursorModel('claude-5.5-sonnet', 'Claude Sonnet 5.5', 'Anthropic'),
  cursorModel('gpt-5.4-nano', 'GPT-5.4 Nano', 'OpenAI'), cursorModel('gpt-6', 'GPT-6', 'OpenAI'),
]
const waiting: CursorSignInView = { id: SIGN_IN, provider: 'cursor', shape: 'page', stage: 'waiting', page: 'cursor.com' }

function cursorBridge(patch: Partial<CursorSignInBridge> = {}): CursorSignInBridge {
  return { start: vi.fn(async () => ({ view: waiting })), read: vi.fn(async () => waiting), reopen: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })), signOut: vi.fn(async () => ({ ok: true, message: 'Cursor is signed out on this computer.' })), ...patch }
}

async function mount(cursor: Partial<AgentProviderStatus>, owl = true) {
  const state: AgentState = threadsStateFixture({
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'cursor'] },
    host: { connected: true, name: 'Providers', version: '', capabilities, projects: [], threads: [],
      providers: [{ id: 'codex', name: 'Codex', version: '0.155.1', connection: 'connected', capabilities },
        { id: 'cursor', name: 'Cursor', version: '2026.10.22-27dcf5f', connection: 'connected', capabilities, ...cursor }],
      models: CURSOR_MODELS },
  })
  const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>().mockResolvedValue(state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261023.1', releaseTrack: 'owl', owlFeatures: { watcher: false, cursor: owl }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
  await screen.findByRole('button', { name: 'Codex' })
  return { command }
}
const signedOut: Partial<AgentProviderStatus> = { connection: 'error', problem: 'signed-out', error: 'Cursor is not signed in on this computer. Sign in to Cursor, then connect it again. Your threads are kept.' }

describe('Cursor’s provider tile', () => {
  it('signs in on cursor.com from the tile, waits with Open the page again and Cancel, and stops waiting once Cursor says it signed in', async () => {
    const bridge = cursorBridge({ read: vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue({ ...waiting, stage: 'connected' }) })
    vi.stubGlobal('sotto', { ...window.sotto, cursor: bridge })
    await mount(signedOut)
    const row = await screen.findByRole('button', { name: 'Cursor' })
    expect(row).toHaveTextContent('Not signed in')
    // Sotto's own mark for Cursor, a cube of three faces: not Cursor's logo and not the placeholder outline.
    expect(row.querySelector('svg.provider-mark[data-provider="cursor"] path')?.getAttribute('d')).toMatch(/^M12 2\.4L19\.51 6\.74/u)
    fireEvent.click(row)
    expect(screen.getByText('Sotto uses Cursor’s own sign-in on this computer and keeps no Cursor key. You need a Cursor account.')).toBeVisible()
    // The tile says what to do, so main's sentence about connecting again is not repeated under it.
    expect(screen.queryByText(/then connect it again/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' }))
    expect(await screen.findByText('Finish signing in on cursor.com in your browser.')).toBeVisible()
    expect(screen.getByText('Waiting for Cursor. This connects by itself.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cursor' })).toHaveTextContent('Signing in…')
    expect(screen.getByRole('switch', { name: 'Enable Cursor' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Open Cursor’s sign-in page in your browser again' }))
    await waitFor(() => expect(bridge.reopen).toHaveBeenCalledWith({ id: SIGN_IN }))
    // Looking at Cursor's models, or another provider, while it waits keeps the sign-in waiting.
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }))
    expect(screen.getByText('Finish signing in on cursor.com in your browser.')).toBeVisible()
    await waitFor(() => expect(screen.queryByText('Finish signing in on cursor.com in your browser.')).toBeNull(), { timeout: 5000 })
    expect(bridge.read).toHaveBeenCalledWith({ id: SIGN_IN })
    expect(bridge.cancel).not.toHaveBeenCalled()
  })

  it('cancels a waiting sign-in on Cancel or Escape, and says why one that ended did not connect', async () => {
    const bridge = cursorBridge()
    vi.stubGlobal('sotto', { ...window.sotto, cursor: bridge })
    await mount(signedOut)
    fireEvent.click(await screen.findByRole('button', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' }))
    const again = await screen.findByRole('button', { name: 'Open Cursor’s sign-in page in your browser again' })
    fireEvent.keyDown(again, { key: 'Escape' })
    await waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith({ id: SIGN_IN }))
    expect(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' })).toBeVisible()
    vi.mocked(bridge.read).mockResolvedValue({ ...waiting, stage: 'failed', message: 'Cursor’s sign-in stopped before it finished. Nothing was signed in.' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' }))
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Cursor’s sign-in stopped before it finished. Nothing was signed in.')
    expect(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' })).toBeVisible()
  })

  it('says why a sign-in could not start', async () => {
    vi.stubGlobal('sotto', { ...window.sotto, cursor: cursorBridge({ start: vi.fn(async () => ({ message: 'Cursor’s sign-in is not available right now. Nothing was changed.' })) }) })
    await mount(signedOut)
    fireEvent.click(await screen.findByRole('button', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Cursor in your browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cursor’s sign-in is not available right now. Nothing was changed.')
  })

  it('offers Sign out of Cursor beside Disconnect when connected, then Sign in', async () => {
    const bridge = cursorBridge()
    vi.stubGlobal('sotto', { ...window.sotto, cursor: bridge })
    await mount({})
    fireEvent.click(await screen.findByRole('button', { name: 'Cursor' }))
    expect(screen.getByRole('button', { name: 'Disconnect Cursor' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of Cursor on this computer' }))
    expect(await screen.findByText('Cursor is signed out on this computer.')).toBeVisible()
    expect(bridge.signOut).toHaveBeenCalledOnce()
  })

  it('lists Cursor’s models under their makers, in Cursor’s order', async () => {
    vi.stubGlobal('sotto', { ...window.sotto, cursor: cursorBridge() })
    await mount({})
    fireEvent.click(await screen.findByRole('button', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    const list = screen.getByRole('group', { name: 'Cursor available models' })
    expect(within(list).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Cursor', 'Anthropic', 'OpenAI'])
    expect(within(within(list).getByRole('region', { name: 'Cursor' })).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual(['Auto', 'Composer 2.5'])
  })

  it('offers nothing of Cursor while its Owl feature is off', async () => {
    await mount({}, false)
    expect(screen.queryByRole('button', { name: 'Cursor' })).toBeNull()
    expect(screen.queryByText(/Cursor uses its install script/u)).toBeNull()
  })

  it('says Cursor’s published version comes from its install script', async () => {
    vi.stubGlobal('sotto', { ...window.sotto, cursor: cursorBridge() })
    await mount({})
    expect(screen.getByText(/Cursor uses its install script; the other clients use the npm registry\. No thread text is sent\./u)).toBeVisible()
  })
})

describe('Cursor’s model menu', () => {
  const open = async (modelId = 'claude-5.5-sonnet') => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelPicker models={[{ id: 'astra', name: 'GPT-6-Astra', provider: 'Codex', providerId: 'codex', ready: true }, ...CURSOR_MODELS]} modelId={modelId} disabled={false} onChange={onChange} />)
    const chip = screen.getByRole('combobox', { name: 'Thread model' })
    return { user, onChange, chip }
  }

  it('names the maker on the chip and opens on Cursor’s makers, in Cursor’s order, over the plan line', async () => {
    const { user, chip } = await open()
    expect(chip).toHaveAttribute('title', 'Claude Sonnet 5.5 from Anthropic, in Cursor')
    expect(chip).toHaveTextContent('Anthropic/Claude Sonnet 5.5')
    await user.click(chip)
    const makers = screen.getByRole('group', { name: 'Cursor’s model makers' })
    expect(within(makers).getAllByRole('button').map(row => row.textContent)).toEqual(['Cursor2 models', 'Anthropic2 models', 'OpenAI2 models'])
    expect(screen.getByText('Every model here runs through Cursor, on your Cursor plan.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveAttribute('placeholder', 'Search all Cursor models')
  })

  it('keeps a maker’s models in Cursor’s order under a Makers back control, and Escape steps back one level', async () => {
    const { user } = await open('auto')
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    await user.click(screen.getByRole('button', { name: /^Show Cursor models/u }))
    // Newest first would put Composer 2.5 above Auto; Cursor's own order keeps Auto first.
    expect(within(screen.getByRole('listbox', { name: 'Cursor models in Cursor' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Auto', 'Composer 2.5'])
    const back = screen.getByRole('button', { name: 'Back to Cursor’s model makers' })
    expect(back).toHaveTextContent('Makers')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('group', { name: 'Cursor’s model makers' })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Show Cursor models/u })).toHaveFocus()
  })

  it('searches every maker at once', async () => {
    const { user, onChange } = await open()
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'sonnet')
    const found = screen.getByRole('listbox', { name: 'Cursor models' })
    expect(within(found).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Sonnet 4.5', 'Claude Sonnet 5.5'])
    await user.clear(screen.getByRole('textbox', { name: 'Search models' }))
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'nano')
    await user.click(screen.getByRole('option', { name: 'GPT-5.4 Nano' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('gpt-5.4-nano')
  })
})

describe('Cursor’s permission menu', () => {
  it('offers exactly Cursor’s three modes, each said as Cursor doing it', () => {
    expect(modeChoices(CURSOR_MODELS[0], 'auto', undefined)).toEqual([
      { id: 'approval-required', label: 'Ask for approval', description: 'Cursor asks before commands, web requests and tools. It edits files inside the project without asking.' },
      { id: 'auto', label: 'Auto', description: 'Cursor’s own auto-review decides what runs without asking. Its classifier runs on Cursor’s servers; what it holds back comes to you.' },
      { id: 'full-access', label: 'Full access', description: 'Cursor runs commands, web requests and tools and edits files without asking, in the project and outside it.' },
    ])
    // A saved Allow edits leads, unchoosable: main starts the thread on Ask for approval and says so on the thread.
    expect(modeChoices(CURSOR_MODELS[0], 'auto-accept-edits', undefined)[0]).toEqual({ id: 'auto-accept-edits', label: 'Allow edits', disabled: true })
  })
})

describe('Cursor’s request cards', () => {
  function card(request: Parameters<typeof AgentRequestCard>[0]['request']) {
    const onSubmit = vi.fn(async () => ({ error: null }))
    render(<AgentRequestCard ownerId="thread-a" ownerTitle="Upload tests" request={request} blocked={null} onSubmit={onSubmit} store={new RequestAnswerStore()} />)
    return { onSubmit, user: userEvent.setup() }
  }

  it('shows a plan as a plan card, with its name, overview and steps, answered Accept plan or Reject', async () => {
    const plan = cursorPending(3, 'cursor/create_plan', { toolCallId: 'plan_1', name: 'Make the upload test steady', overview: 'Replace the fixed wait with the upload’s own event.',
      plan: '1. Replace the fixed 200 ms wait.\n2. Run the upload test 50 times.\n3. Run the whole suite.' }, 'thread-a')!
    const { onSubmit, user } = card(plan.request)
    expect(screen.getByText('Plan', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText('Cursor made a plan and waits for you before it starts.')).toBeVisible()
    const shown = screen.getByRole('region', { name: 'Cursor’s plan' })
    expect(within(shown).getByText('Make the upload test steady')).toBeVisible()
    expect(within(shown).getByText('Replace the fixed wait with the upload’s own event.')).toBeVisible()
    expect(within(shown).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Replace the fixed 200 ms wait.', 'Run the upload test 50 times.', 'Run the whole suite.'])
    // Not a generic permission prompt: no tool name tag and no "Use cursor/create_plan" title.
    expect(screen.queryByText(/cursor\/create_plan/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reject Cursor’s plan' })).toHaveTextContent('Reject')
    const accept = screen.getByRole('button', { name: 'Accept Cursor’s plan' })
    expect(accept).toHaveTextContent('Accept plan')
    await user.click(accept)
    expect(onSubmit).toHaveBeenCalledWith({ answer: 'Accept plan', approved: true, permissionChoice: 'accept-plan' })
  })

  it('asks Cursor’s questions with their own options, several where Cursor allows several, and skips them when none is chosen', async () => {
    const asked = cursorPending('q', 'cursor/ask_question', { toolCallId: 'call_q', title: 'Pick', questions: [
      { id: 'q1', prompt: 'Which runner?', options: [{ id: 'vitest', label: 'Vitest' }, { id: 'playwright', label: 'Playwright' }] },
      { id: 'q2', prompt: 'Which suites?', options: [{ id: 'unit', label: 'Unit' }, { id: 'e2e', label: 'End to end' }], allowMultiple: true }] }, 'thread-a')!
    const { onSubmit, user } = card(asked.request)
    expect(screen.getAllByRole('radio').map(radio => radio.getAttribute('value'))).toEqual(['vitest', 'playwright'])
    expect(screen.getAllByRole('checkbox').map(box => box.getAttribute('value'))).toEqual(['unit', 'e2e'])
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Choose an answer, or skip')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Skip questions' }))
    expect(onSubmit).toHaveBeenCalledWith({ answer: '', questionAnswers: {} })
  })

  it('sends the options chosen once one is', async () => {
    const asked = cursorPending('q', 'cursor/ask_question', { questions: [{ id: 'q1', prompt: 'Which runner?', options: [{ id: 'vitest', label: 'Vitest' }, { id: 'playwright', label: 'Playwright' }] }] }, 'thread-a')!
    const { onSubmit, user } = card(asked.request)
    expect(screen.getByRole('button', { name: 'Skip question' })).toBeEnabled()
    await user.click(screen.getByRole('radio', { name: 'Vitest' }))
    await user.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onSubmit).toHaveBeenCalledWith({ answer: '', questionAnswers: { q1: { optionIds: ['vitest'] } } })
  })
})

describe('Cursor’s sign-in on a host', () => {
  it('opens cursor.com from this computer with no code to bring back, and waits for the host to finish', async () => {
    const HOST = '55555555-5555-4555-8555-555555555555'
    const view: ProviderSignInView = { id: SIGN_IN, provider: 'cursor', shape: 'page', stage: 'waiting', page: 'cursor.com' }
    const signIn = vi.fn(async (request: HostSignInRequest) => request.type === 'cancel' ? null : view)
    const { bridge } = hostsBridgeFixture({ commands: { signIn } })
    const user = userEvent.setup()
    render(<HostProviderSignIn host={hostStatus({ id: HOST, hostId: HOST, name: 'forge', target: 'forge' })} provider="cursor" bridge={bridge} onClose={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Cursor on forge' })
    expect(await within(dialog).findByText('Cursor signs in on cursor.com in this computer\'s browser. forge finishes signing in by itself once you do.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Open sign-in page' }))
    expect(signIn).toHaveBeenCalledWith({ type: 'open', id: HOST, signInId: SIGN_IN })
    expect(await within(dialog).findByText('Waiting for you on cursor.com.')).toBeVisible()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Open sign-in page again' })).toBeVisible()
  })
})

describe('Cursor’s mark', () => {
  it('draws Sotto’s own cube in one path', () => {
    const { container } = render(<ProviderMark provider="cursor" name="Cursor" size={18} />)
    const svg = container.querySelector('svg.provider-mark[data-provider="cursor"]')
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg!.querySelectorAll('path')).toHaveLength(1)
    // Three faces, each its own closed shape.
    expect(svg!.querySelector('path')!.getAttribute('d')!.match(/Z/gu)).toHaveLength(3)
  })
})
