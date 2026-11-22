import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentModel, type AgentProviderStatus, type AgentState } from '../../../src/shared/agents'
import type { AntigravitySignInMethod } from '../../../src/shared/antigravity'
import type { AntigravityAccountBridge } from '../../../src/shared/antigravityAccount'
import type { ProviderSignInView } from '../../../src/shared/hostProviders'
import type { LocalSignInRequest } from '../../../src/shared/localProviderSignIn'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/features/settings/ProvidersSettings'
import { HostProviderSignIn } from '../../../src/renderer/src/features/settings/HostProviderSignIn'
import { modeChoices } from '../../../src/renderer/src/agents/permissionPresentation'
import { modelSources } from '../../../src/renderer/src/agents/ModelPicker'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const SIGN_IN = '55555555-5555-4555-8555-555555555555'
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const waiting: ProviderSignInView = { id: SIGN_IN, provider: 'antigravity', shape: 'paste-code', stage: 'waiting', page: 'accounts.google.com' }
const signedOut: Partial<AgentProviderStatus> = { connection: 'error', problem: 'signed-out', error: 'Antigravity is not signed in on this computer. Sign in, then connect it again.' }

function accountBridge(patch: Partial<AntigravityAccountBridge> = {}): AntigravityAccountBridge {
  return { enterpriseSignIn: vi.fn(async () => ({ ok: true })), signOut: vi.fn(async () => ({ ok: true })), install: vi.fn(async () => ({ ok: true })),
    installProgress: vi.fn(async () => ({ installing: true, text: 'Downloading agy 1.5.12…' })), cancelInstall: vi.fn(async () => ({ ok: true })),
    removeDownloaded: vi.fn(async () => ({ ok: true })), ...patch }
}

async function mount(status: Partial<AgentProviderStatus>, { method = 'oauth-personal', project = '', location = '', keySaved = false, signIn, account = accountBridge() }: {
  method?: AntigravitySignInMethod; project?: string; location?: string; keySaved?: boolean
  signIn?: (request: LocalSignInRequest) => Promise<ProviderSignInView | null>; account?: AntigravityAccountBridge
} = {}) {
  const signInFn = vi.fn(signIn ?? (async () => waiting))
  vi.stubGlobal('sotto', { ...window.sotto, antigravity: account, providerSignIn: { signIn: signInFn } })
  const base = threadsStateFixture({
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'antigravity'], antigravitySignInMethod: method, antigravityProject: project, antigravityLocation: location },
    host: { connected: true, name: 'Providers', version: '', capabilities, projects: [], threads: [],
      providers: [{ id: 'codex', name: 'Codex', version: '0.155.1', connection: 'connected', capabilities },
        { id: 'antigravity', name: 'Antigravity', version: '1.5.12', connection: 'connected', capabilities, ...status }],
      models: [] },
  })
  const state: AgentState = { ...base, credentials: { ...base.credentials, antigravity: keySaved } }
  const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  render(<AppProvider bridge={createBridge()} createController={createController}><ProvidersSettings /></AppProvider>)
  const header = await screen.findByRole('button', { name: 'Antigravity' })
  fireEvent.click(header)
  return { command, signIn: signInFn, account, header, details: screen.getByRole('region', { name: 'Antigravity details' }) }
}

describe('Antigravity’s provider row (variant B)', () => {
  it('draws Sotto’s arrow on its badge and offers the four sign-in methods, saving a new one through configure', async () => {
    const { command, header, details } = await mount(signedOut)
    expect(header.querySelector('.provider-badge[data-provider="antigravity"] svg.provider-mark path')?.getAttribute('d')).toBe('M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z')
    // The row signs in itself, so the header offers no Sign in and repeats no sentence about connecting again.
    expect(within(header.closest('.provider-row__head') as HTMLElement).queryByRole('button', { name: 'Sign in to Antigravity' })).toBeNull()
    expect(screen.queryByText(/then connect it again/u)).toBeNull()
    const methods = within(details).getByRole('radiogroup', { name: 'Sign-in method' })
    expect(within(methods).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Google account', 'Gemini Enterprise', 'Gemini API key', 'Agent Platform'])
    expect(within(methods).getByRole('radio', { name: 'Google account' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(methods).getByRole('radio', { name: 'Gemini API key' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', patch: { antigravitySignInMethod: 'gemini-api-key' } })))
  })

  it('says in the opened row, signed in or not, that the user’s own Google account carries the risk under Google’s terms', async () => {
    for (const status of [signedOut, {}]) {
      const { details } = await mount(status)
      const note = within(details).getByRole('note', { name: 'Your Google account carries the risk' })
      expect(within(note).getAllByRole('listitem').map(item => item.textContent)).toEqual([
        'Sotto never reads agy’s sign-in or calls Google’s servers with it.',
        'Only Gemini models. Google allows Claude and other models only in its own app, CLI and IDEs, so Sotto does not list them.',
        'Running agy from another app is still a gray area. Google may count it against the account you sign in with here.'])
      // It comes before the sign-in method, so it is read before an account is chosen.
      expect(note.compareDocumentPosition(within(details).getByRole('radiogroup', { name: 'Sign-in method' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      cleanup()
    }
  })

  it('signs in with a Google account in the row: Open sign-in page, then the code pasted back, and Escape cancels a waiting one', async () => {
    const signIn = vi.fn(async (request: LocalSignInRequest): Promise<ProviderSignInView | null> => request.type === 'code' ? { ...waiting, stage: 'finishing' } : waiting)
    const { signIn: sent, header, details } = await mount(signedOut, { signIn })
    fireEvent.click(within(details).getByRole('button', { name: 'Sign in to Antigravity with your Google account' }))
    const open = await within(details).findByRole('button', { name: 'Open Google’s sign-in page in your browser' })
    expect(sent).toHaveBeenCalledWith({ type: 'start', provider: 'antigravity' })
    expect(header).toHaveTextContent('Signing in…')
    expect(screen.getByRole('switch', { name: 'Enable Antigravity' })).toBeDisabled()
    // Every method waits while a Google sign-in does.
    expect(within(details).getByRole('radio', { name: 'Gemini API key' })).toBeDisabled()
    fireEvent.click(open)
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ type: 'open', signInId: SIGN_IN }))
    expect(await within(details).findByRole('button', { name: 'Open Google’s sign-in page in your browser again' })).toBeVisible()
    const field = within(details).getByLabelText('Code from the Antigravity page')
    const finish = within(details).getByRole('button', { name: 'Finish sign-in' })
    expect(finish).toBeDisabled()
    fireEvent.change(field, { target: { value: ' https://antigravity.google/auth?code=4/abc ' } })
    fireEvent.click(finish)
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ type: 'code', signInId: SIGN_IN, code: 'https://antigravity.google/auth?code=4/abc' }))
    expect(await within(details).findByText('Signed in with Google. Connecting Antigravity…')).toBeVisible()
    fireEvent.keyDown(within(details).getByLabelText('Code from the Antigravity page'), { key: 'Escape' })
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ type: 'cancel', signInId: SIGN_IN }))
    expect(within(details).getByRole('button', { name: 'Sign in to Antigravity with your Google account' })).toBeVisible()
    // That Escape was the sign-in's own: the row stays open.
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps Gemini Enterprise’s Sign in off until its project and location are filled, saves them, then runs its browser sign-in', async () => {
    const account = accountBridge()
    const { command, details } = await mount(signedOut, { method: 'oauth-business', account })
    const signIn = within(details).getByRole('button', { name: 'Sign in to Gemini Enterprise with Google in your browser' })
    expect(signIn).toBeDisabled()
    fireEvent.change(within(details).getByLabelText('Google Cloud project'), { target: { value: 'acme-agents' } })
    expect(signIn).toBeDisabled()
    // Leaving the project field saves it, and the next field and Sign in stay usable meanwhile, so Tab moves on in order.
    fireEvent.blur(within(details).getByLabelText('Google Cloud project'))
    expect(within(details).getByLabelText('Location')).toBeEnabled()
    fireEvent.change(within(details).getByLabelText('Location'), { target: { value: 'us-central1' } })
    fireEvent.blur(within(details).getByLabelText('Location'))
    expect(signIn).toBeEnabled()
    fireEvent.click(signIn)
    await waitFor(() => expect(account.enterpriseSignIn).toHaveBeenCalledTimes(1))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure', patch: { antigravityProject: 'acme-agents', antigravityLocation: 'us-central1' } }))
    // No code field: Google tells agy itself.
    expect(within(details).queryByLabelText('Code from the Antigravity page')).toBeNull()
  })

  it('saves a Gemini API key masked and connects, and never shows a saved key back: Key saved with Replace and Remove key', async () => {
    const first = await mount({ connection: 'disconnected' }, { method: 'gemini-api-key' })
    const field = within(first.details).getByLabelText('Gemini API key')
    expect(field).toHaveAttribute('type', 'password')
    expect(within(first.details).getByText('The key stays on this computer, in Sotto’s credential store. Sotto hands it to agy and never shows it again.')).toBeVisible()
    fireEvent.change(field, { target: { value: 'AIza-test-key' } })
    fireEvent.click(within(first.details).getByRole('button', { name: 'Save this Gemini API key and connect Antigravity' }))
    await waitFor(() => expect(first.command).toHaveBeenCalledWith({ type: 'credential', slot: 'antigravity', value: 'AIza-test-key' }))
    await waitFor(() => expect(first.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'connect', provider: 'antigravity' })))
    cleanup()

    const second = await mount({ connection: 'connected' }, { method: 'gemini-api-key', keySaved: true })
    expect(within(second.details).getByText('Key saved')).toBeVisible()
    expect(within(second.details).queryByLabelText('Gemini API key')).toBeNull()
    expect(second.details.textContent).not.toContain('AIza')
    fireEvent.click(within(second.details).getByRole('button', { name: 'Replace the saved Gemini API key' }))
    expect(within(second.details).getByLabelText('Gemini API key')).toHaveValue('')
    fireEvent.click(within(second.details).getByRole('button', { name: 'Keep the saved key' }))
    fireEvent.click(within(second.details).getByRole('button', { name: 'Remove the saved Gemini API key from this computer' }))
    await waitFor(() => expect(second.command).toHaveBeenCalledWith({ type: 'credential', slot: 'antigravity', value: '' }))
  })

  it('installs agy from the row when it is missing, showing how far it has got, with Cancel install', async () => {
    let finish: (done: { ok: boolean }) => void = () => undefined
    const account = accountBridge({ install: vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve })) })
    const { details, header } = await mount({ connection: 'error', problem: 'not-installed', error: 'agy is not installed.' }, { account })
    expect(within(header.closest('.provider-row__head') as HTMLElement).queryByRole('button', { name: 'Open the Antigravity install guide' })).toBeNull()
    fireEvent.click(within(details).getByRole('button', { name: 'Download and install Antigravity’s agy from Google' }))
    expect(await within(details).findByText('Downloading agy 1.5.12…', {}, { timeout: 3000 })).toBeVisible()
    fireEvent.click(within(details).getByRole('button', { name: 'Cancel installing Antigravity' }))
    await waitFor(() => expect(account.cancelInstall).toHaveBeenCalledTimes(1))
    finish({ ok: true })
  })
})

describe('Antigravity in a thread', () => {
  const model = (id: string, name: string): AgentModel => ({ id, name, provider: 'Antigravity', providerId: 'antigravity', ready: true,
    runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'], reasoningEfforts: ['low', 'medium', 'high'] })
  const MODELS = [model('gemini-4-carbon', 'Gemini 4 Carbon'), model('gemini-3.8-flash', 'Gemini 3.8 Flash')]

  it('lists its Gemini models as one list, with no makers to choose between (ADR-0212)', () => {
    expect(modelSources(MODELS, 'Antigravity')).toBeUndefined()
  })

  it('says plainly who answers under each permission mode', () => {
    const lines = Object.fromEntries(modeChoices(MODELS[0], 'approval-required', undefined).map(choice => [choice.id, choice.description]))
    expect(lines['auto-accept-edits']).toBe('Sotto answers Antigravity’s requests to change files for you. Commands and anything else still come to you, and so do its questions.')
    expect(lines['full-access']).toMatch(/^Sotto answers every Antigravity request for you/u)
    expect(lines.auto).toBe('Antigravity’s own Auto decides what runs without asking. What it asks about comes to you.')
  })

  it('says Google account rather than Claude subscription in the paired host sign-in dialog', async () => {
    render(<AppProvider bridge={createBridge()} createController={createController}>
      <HostProviderSignIn place="forge" provider="antigravity" signIn={async () => waiting} onClose={vi.fn()} />
    </AppProvider>)
    expect(await screen.findByText(/signs in with your Google account in this computer's browser/u)).toBeVisible()
    expect(screen.queryByText(/Claude subscription/u)).toBeNull()
  })
})
