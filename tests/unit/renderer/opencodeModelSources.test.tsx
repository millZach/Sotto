import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeModelSources } from '../../../src/renderer/src/agents/OpenCodeModelSources'
import { KEY_SENTENCE, SIGN_IN_WORDS, type ModelSource, type ModelSources, type OpenCodeSignInBridge } from '../../../src/shared/opencodeSignIn'

const KEY = 'sk-fixture-made-up-key-7d1e4b'
const key = { id: 'key', kind: 'key', label: 'API key' } as const
const SOURCES: ModelSource[] = [
  { id: 'zenmux', name: 'ZenMux', methods: [key], models: 0 },
  { id: 'xai', name: 'xAI', methods: [key, { id: 'device', kind: 'browser', label: 'SuperGrok subscription' }], models: 0 },
  { id: 'anthropic', name: 'Anthropic', methods: [key], models: 0 },
  { id: 'abacus', name: 'Abacus', methods: [key], models: 0 },
  { id: 'openai', name: 'OpenAI', methods: [key, { id: 'chatgpt-token-sharing', kind: 'browser', label: 'ChatGPT account' }], models: 0 },
  { id: 'gitlab', name: 'GitLab Duo', methods: [{ id: 'pkce', kind: 'browser', label: 'GitLab account' }], models: 0 },
  { id: 'github-copilot', name: 'GitHub Copilot', methods: [{ id: 'device', kind: 'browser', label: 'GitHub account', form: [
    { key: 'deploymentType', title: 'Select GitHub deployment type', required: true, options: [{ value: 'github.com', label: 'GitHub.com', description: 'Public' }, { value: 'enterprise', label: 'GitHub Enterprise' }] },
    { key: 'enterpriseUrl', title: 'Enter your GitHub Enterprise URL or domain', required: true, placeholder: 'company.ghe.com', when: { key: 'deploymentType', value: 'enterprise' } }] }], models: 0 },
  { id: 'openrouter', name: 'OpenRouter', methods: [key], models: 0 },
  { id: 'google', name: 'Google', methods: [key], models: 0 },
]
const read = (patch: Partial<Record<string, Partial<ModelSource>>> = {}): ModelSources => ({ status: 'ok', zenModels: 12,
  sources: SOURCES.map(source => ({ ...source, ...patch[source.id] })) })
const signedAnthropic = () => read({ anthropic: { signedIn: { how: 'API key' }, models: 5 } })

function bridge(overrides: Partial<OpenCodeSignInBridge> = {}): OpenCodeSignInBridge {
  return {
    sources: vi.fn(async () => read()), signInWithKey: vi.fn(async () => ({ status: 'ok' as const, sources: signedAnthropic() })),
    startBrowserSignIn: vi.fn(async () => ({ status: 'refused' as const, message: 'unused' })), useExternalSignIn: vi.fn(async () => ({ status: 'refused' as const, message: 'unused' })),
    wait: vi.fn(async () => ({ status: 'pending' as const })), finish: vi.fn(async () => ({ status: 'pending' as const })),
    reopen: vi.fn(async () => ({ status: 'ok' as const })), cancel: vi.fn(async () => ({ status: 'ok' as const })),
    signOut: vi.fn(async () => ({ status: 'ok' as const, sources: read() })), ...overrides,
  }
}
async function mount(api = bridge(), pollMs = 2_000) {
  render(<OpenCodeModelSources bridge={api} pollMs={pollMs} />)
  await screen.findByRole('button', { name: 'Add a model source' })
  return api
}
const openDialog = async () => { fireEvent.click(screen.getByRole('button', { name: 'Add a model source' })); return screen.findByRole('dialog', { name: 'Add a model source' }) }
const pick = async (name: RegExp) => { fireEvent.click(within(screen.getByRole('listbox', { name: 'Model sources' })).getByRole('option', { name })); return screen.findByRole('dialog') }
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the Model sources block', () => {
  it('starts with OpenCode Zen and says what signing in adds', async () => {
    await mount()
    const list = screen.getByRole('list', { name: 'Model sources Sotto’s OpenCode can use' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('OpenCode Zen')).toBeVisible()
    expect(within(list).getByText('12 models')).toBeVisible()
    expect(within(list).queryByRole('button', { name: /Sign out/u })).toBeNull()
    expect(screen.getByText('Sign in to a model source, such as Anthropic, OpenAI or OpenRouter, to use its models in OpenCode threads. That account pays for them.')).toBeVisible()
  })

  it('lists a signed-in source with how it signed in, its model count and Sign out, and says what Sign out did', async () => {
    const api = await mount(bridge({ sources: vi.fn(async () => signedAnthropic()) }))
    const row = (await screen.findByText('Anthropic')).closest('li')!
    expect(within(row).getByText('API key')).toBeVisible()
    expect(within(row).getByText('5 models')).toBeVisible()
    fireEvent.click(within(row).getByRole('button', { name: 'Sign out of Anthropic' }))
    expect(await screen.findByText('Signed out of Anthropic. Its key is gone from Sotto’s OpenCode.')).toBeVisible()
    expect(api.signOut).toHaveBeenCalledWith({ sourceId: 'anthropic' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a model source' })).toHaveFocus())
  })

  it('says plainly when Sotto’s OpenCode is not running', async () => {
    render(<OpenCodeModelSources bridge={bridge({ sources: vi.fn(async () => ({ status: 'refused' as const, message: SIGN_IN_WORDS.notRunning })) })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto’s OpenCode is not running, so nothing was signed in. Connect OpenCode, then try again.')
  })
})

describe('Add a model source', () => {
  it('searches every source, common ones first and the rest A to Z, and marks the signed-in ones so they cannot be picked', async () => {
    await mount(bridge({ sources: vi.fn(async () => signedAnthropic()) }))
    await openDialog()
    expect(screen.getByRole('textbox', { name: 'Search model sources' })).toHaveFocus()
    const groups = within(screen.getByRole('listbox', { name: 'Model sources' })).getAllByRole('group')
    expect(within(groups[0]!).getAllByRole('option').map(option => option.textContent)).toEqual([
      'AnthropicSigned in', 'OpenAIAPI key or ChatGPT account', 'OpenRouterAPI key', 'GitHub CopilotGitHub account', 'GoogleAPI key', 'xAIAPI key or SuperGrok subscription'])
    expect(groups[1]).toHaveAccessibleName('Every model source, A to Z')
    expect(within(groups[1]!).getAllByRole('option').map(option => option.querySelector('.oc-opt__name')!.textContent)).toEqual(['Abacus', 'GitLab Duo', 'ZenMux'])
    const anthropic = screen.getByRole('option', { name: 'Anthropic, already signed in' })
    expect(anthropic).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(anthropic)
    expect(screen.getByRole('dialog', { name: 'Add a model source' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search model sources' }), { target: { value: 'zen' } })
    expect(screen.getAllByRole('option').map(option => option.querySelector('.oc-opt__name')!.textContent)).toEqual(['ZenMux'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search model sources' }), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No model source matches “nothing like it”.')).toBeVisible()
  })

  it('moves from the search into the list with the arrows, and Escape closes and gives focus back to Add', async () => {
    await mount()
    await openDialog()
    const search = screen.getByRole('textbox', { name: 'Search model sources' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /^Anthropic,/u })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /^OpenAI,/u })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a model source' })).toHaveFocus())
  })

  it('takes a key in a password field, hands it to main once and never shows it, then says what signing in did', async () => {
    const api = await mount()
    await openDialog()
    const dialog = await pick(/^Anthropic,/u)
    expect(dialog).toHaveAccessibleName('Sign in to Anthropic')
    const field = within(dialog).getByLabelText('Anthropic API key')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveFocus()
    expect(within(dialog).getByText(KEY_SENTENCE)).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Sign in to Anthropic with this key' })).toBeDisabled()
    fireEvent.change(field, { target: { value: KEY } })
    expect(document.body.textContent).not.toContain(KEY)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in to Anthropic with this key' }))
    expect(await screen.findByText(/^Signed in to Anthropic\. Its 5 models are in the model menu, under OpenCode\./u)).toHaveTextContent(SIGN_IN_WORDS.keyUnchecked('Anthropic'))
    expect(api.signInWithKey).toHaveBeenCalledTimes(1)
    expect(api.signInWithKey).toHaveBeenCalledWith({ sourceId: 'anthropic', key: KEY })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('clears a refused key and says why, without saving anything', async () => {
    await mount(bridge({ signInWithKey: vi.fn(async () => ({ status: 'refused' as const, message: SIGN_IN_WORDS.keyRefused('Anthropic') })) }))
    await openDialog()
    const dialog = await pick(/^Anthropic,/u)
    fireEvent.change(within(dialog).getByLabelText('Anthropic API key'), { target: { value: KEY } })
    fireEvent.keyDown(within(dialog).getByLabelText('Anthropic API key'), { key: 'Enter' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('OpenCode could not sign in to Anthropic with that key, so nothing was saved. Check the key in your Anthropic account and paste it again.')
    expect(within(dialog).getByLabelText('Anthropic API key')).toHaveValue('')
    expect(within(dialog).getByLabelText('Anthropic API key')).toHaveAttribute('aria-invalid', 'true')
  })

  it('offers each way to sign in as a radio card when there are several', async () => {
    await mount()
    await openDialog()
    const dialog = await pick(/^OpenAI,/u)
    const ways = within(dialog).getByRole('group', { name: 'How to sign in' })
    expect(within(ways).getAllByRole('radio').map(radio => radio.closest('label')!.querySelector('b')!.textContent)).toEqual(['API key', 'ChatGPT account'])
    expect(within(ways).getByRole('radio', { name: /API key/u })).toHaveFocus()
    fireEvent.click(within(ways).getByRole('radio', { name: /ChatGPT account/u }))
    expect(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' })).toBeEnabled()
    expect(within(dialog).queryByLabelText('OpenAI API key')).toBeNull()
  })

  it('shows a device code large with Copy code and the page, waits, and closes once the page has finished', async () => {
    let finished = false
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_1', sourceId: 'xai', mode: 'auto' as const, code: 'QX7M-4LRT', page: 'accounts.x.ai/oauth2/device', expiresAt: Date.now() + 15 * 60_000 } })),
      wait: vi.fn(async () => finished ? { status: 'ok' as const, sources: read({ xai: { signedIn: { how: 'SuperGrok subscription' }, models: 8 } }) } : { status: 'pending' as const }),
    }), 20)
    await openDialog()
    const dialog = await pick(/^xAI,/u)
    fireEvent.click(within(dialog).getByRole('radio', { name: /SuperGrok subscription/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the xAI sign-in page in your browser' }))
    const waiting = await within(dialog).findByRole('group', { name: 'Signing in to xAI' })
    expect(within(waiting).getByText('QX7M-4LRT').tagName).toBe('CODE')
    expect(within(waiting).getByRole('button', { name: 'Copy the code QX7M-4LRT' })).toBeVisible()
    expect(within(waiting).getByText('accounts.x.ai/oauth2/device')).toBeVisible()
    expect(within(waiting).getByRole('status')).toHaveTextContent(/^Waiting for xAI\. This updates by itself once you enter the code\. It expires at /u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the xAI sign-in page again' }))
    await waitFor(() => expect(api.reopen).toHaveBeenCalledWith({ attemptId: 'con_1' }))
    await waitFor(() => expect(api.wait).toHaveBeenCalled())
    act(() => { finished = true })
    expect(await screen.findByText('Signed in to xAI. Its 8 models are in the model menu, under OpenCode.')).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks for the code a page shows, and says when the page expired', async () => {
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_2', sourceId: 'gitlab', mode: 'code' as const, page: 'gitlab.com/oauth/authorize' } })),
      finish: vi.fn(async () => ({ status: 'expired' as const, message: SIGN_IN_WORDS.expired('GitLab Duo') })),
    }))
    await openDialog()
    const dialog = await pick(/^GitLab Duo,/u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' }))
    const field = await within(dialog).findByLabelText('Code from the GitLab Duo page')
    expect(field).toHaveFocus()
    expect(within(dialog).getByRole('button', { name: 'Finish signing in to GitLab Duo with this code' })).toBeDisabled()
    fireEvent.change(field, { target: { value: 'abc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish signing in to GitLab Duo with this code' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The GitLab Duo sign-in page expired before you finished, so nothing was saved. Open the sign-in page again to start over.')
    expect(api.finish).toHaveBeenCalledWith({ attemptId: 'con_2', code: 'abc' })
    expect(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' })).toHaveTextContent('Open sign-in page again')
  })

  it('says when a page finishes by itself, and cancels a waiting sign-in on Cancel or Escape', async () => {
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_3', sourceId: 'openai', mode: 'auto' as const, page: 'auth.openai.com/oauth/authorize' } })),
    }))
    await openDialog()
    const dialog = await pick(/^OpenAI,/u)
    fireEvent.click(within(dialog).getByRole('radio', { name: /ChatGPT account/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }))
    expect(await within(dialog).findByText('Finish signing in on the OpenAI page that opened in your browser.')).toBeVisible()
    expect(within(dialog).getByRole('status')).toHaveTextContent('Waiting for OpenAI. This updates by itself when you are done.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel signing in to OpenAI' }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'con_3' }))
    expect(await within(dialog).findByRole('button', { name: 'Open the OpenAI sign-in page in your browser' })).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }))
    await within(dialog).findByText('Finish signing in on the OpenAI page that opened in your browser.')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.cancel).toHaveBeenCalledTimes(2)
  })

  it('opens the page once the dialog has the sign-in, keeps checking a pasted code OpenCode is still taking, and finishes', async () => {
    let taken = false
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_4', sourceId: 'gitlab', mode: 'code' as const, page: 'gitlab.com/oauth/authorize' } })),
      finish: vi.fn(async () => ({ status: 'pending' as const })),
      wait: vi.fn(async () => taken ? { status: 'ok' as const, sources: read({ gitlab: { signedIn: { how: 'GitLab account' }, models: 3 } }) } : { status: 'pending' as const }),
    }), 20)
    await openDialog()
    const dialog = await pick(/^GitLab Duo,/u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' }))
    fireEvent.change(await within(dialog).findByLabelText('Code from the GitLab Duo page'), { target: { value: 'abc' } })
    expect(api.reopen).toHaveBeenCalledWith({ attemptId: 'con_4' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish signing in to GitLab Duo with this code' }))
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Waiting for GitLab Duo to take the code. This updates by itself.')
    await waitFor(() => expect(api.wait).toHaveBeenCalledWith({ attemptId: 'con_4' }))
    act(() => { taken = true })
    expect(await screen.findByText('Signed in to GitLab Duo. Its 3 models are in the model menu, under OpenCode.')).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('notices while it waits for a pasted code that the page has expired, and says so', async () => {
    let expired = false
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_5', sourceId: 'gitlab', mode: 'code' as const, page: 'gitlab.com/oauth/authorize' } })),
      wait: vi.fn(async () => expired ? { status: 'expired' as const, message: SIGN_IN_WORDS.expired('GitLab Duo') } : { status: 'pending' as const }),
    }), 20)
    await openDialog()
    const dialog = await pick(/^GitLab Duo,/u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' }))
    await within(dialog).findByLabelText('Code from the GitLab Duo page')
    // No code has been pasted yet, and the sign-in is read all the same.
    await waitFor(() => expect(api.wait).toHaveBeenCalledWith({ attemptId: 'con_5' }))
    act(() => { expired = true })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(SIGN_IN_WORDS.expired('GitLab Duo'))
    expect(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' })).toHaveTextContent('Open sign-in page again')
  })

  it('cancels a browser sign-in that starts after the dialog closed, and never opens its page', async () => {
    type Started = Awaited<ReturnType<OpenCodeSignInBridge['startBrowserSignIn']>>
    let answer: (value: Started) => void = () => undefined
    const api = await mount(bridge({ startBrowserSignIn: vi.fn(() => new Promise<Started>(resolve => { answer = resolve })) }))
    await openDialog()
    const dialog = await pick(/^GitLab Duo,/u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the GitLab Duo sign-in page in your browser' }))
    await waitFor(() => expect(api.startBrowserSignIn).toHaveBeenCalled())
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { answer({ status: 'waiting', attempt: { id: 'con_6', sourceId: 'gitlab', mode: 'code', page: 'gitlab.com/oauth/authorize' } }) })
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'con_6' }))
    expect(api.reopen).not.toHaveBeenCalled()
  })

  it('still shows a key OpenCode kept when Cancel was pressed while it was saving', async () => {
    type Saved = Awaited<ReturnType<OpenCodeSignInBridge['signInWithKey']>>
    let answer: (value: Saved) => void = () => undefined
    await mount(bridge({ signInWithKey: vi.fn(() => new Promise<Saved>(resolve => { answer = resolve })) }))
    await openDialog()
    const dialog = await pick(/^Anthropic,/u)
    fireEvent.change(within(dialog).getByLabelText('Anthropic API key'), { target: { value: KEY } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in to Anthropic with this key' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel signing in to Anthropic' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { answer({ status: 'ok', sources: signedAnthropic() }) })
    const list = screen.getByRole('list', { name: 'Model sources Sotto’s OpenCode can use' })
    expect(within(list).getByText('Anthropic')).toBeVisible()
    expect(within(list).getByText('5 models')).toBeVisible()
    expect(screen.getByText(/^Signed in to Anthropic\. Its 5 models are in the model menu/u)).toBeVisible()
  })

  it('reads the sign-ins again when a key Cancel was pressed over answers without saying it was saved', async () => {
    type Saved = Awaited<ReturnType<OpenCodeSignInBridge['signInWithKey']>>
    let answer: (value: Saved) => void = () => undefined
    let saved = false
    const api = await mount(bridge({ signInWithKey: vi.fn(() => new Promise<Saved>(resolve => { answer = resolve })), sources: vi.fn(async () => saved ? signedAnthropic() : read()) }))
    await openDialog()
    const dialog = await pick(/^Anthropic,/u)
    fireEvent.change(within(dialog).getByLabelText('Anthropic API key'), { target: { value: KEY } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in to Anthropic with this key' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    saved = true
    await act(async () => { answer({ status: 'refused', message: SIGN_IN_WORDS.keyUnknown('Anthropic') }) })
    await waitFor(() => expect(api.sources).toHaveBeenCalledTimes(2))
    expect(await within(screen.getByRole('list', { name: 'Model sources Sotto’s OpenCode can use' })).findByText('5 models')).toBeVisible()
  })

  it('cancels a waiting browser sign-in when the page it is on closes under it', async () => {
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_8', sourceId: 'openai', mode: 'auto' as const, page: 'auth.openai.com/oauth/authorize' } })),
    }))
    await openDialog()
    const dialog = await pick(/^OpenAI,/u)
    fireEvent.click(within(dialog).getByRole('radio', { name: /ChatGPT account/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }))
    await within(dialog).findByText('Finish signing in on the OpenAI page that opened in your browser.')
    cleanup()
    expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'con_8' })
  })

  it('says when the browser did not open the page, shows its address to open by hand, and keeps Open the page again', async () => {
    const address = 'https://accounts.x.ai/oauth2/device?user_code=QX7M-4LRT'
    const api = await mount(bridge({
      startBrowserSignIn: vi.fn(async () => ({ status: 'waiting' as const, attempt: { id: 'con_7', sourceId: 'xai', mode: 'auto' as const, code: 'QX7M-4LRT', page: 'accounts.x.ai/oauth2/device' } })),
      reopen: vi.fn(async () => ({ status: 'not-opened' as const, message: SIGN_IN_WORDS.pageNotOpened, address })),
    }))
    await openDialog()
    const dialog = await pick(/^xAI,/u)
    fireEvent.click(within(dialog).getByRole('radio', { name: /SuperGrok subscription/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the xAI sign-in page in your browser' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your browser did not open the sign-in page. Nothing was saved. Open this address in your browser yourself, or press Open the page again.')
    expect(within(dialog).getByText(address).tagName).toBe('CODE')
    expect(within(dialog).queryByText(/page that opened in your browser/u)).toBeNull()
    expect(within(dialog).getByText('Enter this code on the xAI page at the address below.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Copy the xAI sign-in page address' })).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the xAI sign-in page again' }))
    await waitFor(() => expect(api.reopen).toHaveBeenCalledTimes(2))
  })

  it('says when the model menu could not follow a sign-out', async () => {
    await mount(bridge({ sources: vi.fn(async () => signedAnthropic()), signOut: vi.fn(async () => ({ status: 'ok' as const, sources: read(), warning: SIGN_IN_WORDS.catalogUnread })) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of Anthropic' }))
    expect(await screen.findByText(`Signed out of Anthropic. Its key is gone from Sotto’s OpenCode. ${SIGN_IN_WORDS.catalogUnread}`)).toBeVisible()
  })

  it('draws the question a method asks first, such as GitHub.com or Enterprise and its address', async () => {
    const api = await mount()
    await openDialog()
    const dialog = await pick(/^GitHub Copilot,/u)
    const where = within(dialog).getByRole('group', { name: 'Select GitHub deployment type' })
    expect(within(where).getByRole('radio', { name: /GitHub\.com/u })).toBeChecked()
    expect(within(dialog).queryByLabelText('Enter your GitHub Enterprise URL or domain')).toBeNull()
    fireEvent.click(within(where).getByRole('radio', { name: /GitHub Enterprise/u }))
    const open = within(dialog).getByRole('button', { name: 'Open the GitHub Copilot sign-in page in your browser' })
    expect(open).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Enter your GitHub Enterprise URL or domain'), { target: { value: 'company.ghe.com' } })
    expect(open).toBeEnabled()
    fireEvent.click(open)
    await waitFor(() => expect(api.startBrowserSignIn).toHaveBeenCalledWith({ sourceId: 'github-copilot', methodId: 'device', answer: { deploymentType: 'enterprise', enterpriseUrl: 'company.ghe.com' } }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('unused')
  })
})
