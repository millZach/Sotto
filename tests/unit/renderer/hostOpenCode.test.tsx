import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostStatus, hostsBridgeFixture } from '../../fixtures/renderer/hostBridges'
import { HOST_PROVIDER_ORDER, HostProviders } from '../../../src/renderer/src/features/settings/HostProviders'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import type { AgentProviderStatus, ProviderId } from '../../../src/shared/agents'
import type { HostsBridge, HostStatus } from '../../../src/shared/hosts'
import { hostKeySentence, opencodeHostNeedsUpdate, opencodeSignInComesBack, SIGN_IN_WORDS, type ModelSources } from '../../../src/shared/opencodeSignIn'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn(),
}))
/** An Owl build, or a stable one: OpenCode's answer comes from the startup answers, as in the running app. */
const owl = (opencode: boolean) => vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { opencode, muse: true } } } as never)
beforeEach(() => owl(true))
afterEach(() => { cleanup(); vi.mocked(useOptionalApp).mockReset() })

// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-host-fixture-made-up-key-41c9e0'
const HOST = '22222222-2222-4222-8222-222222222222'
const forge: HostStatus = hostStatus({ id: HOST, hostId: HOST, name: 'forge', target: 'forge' })
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const status = (id: ProviderId, patch: Partial<AgentProviderStatus>): AgentProviderStatus => ({ id, name: id, version: '', connection: 'disconnected', capabilities, ...patch })
const FORGE = [
  status('codex', { connection: 'connected', account: 'ChatGPT', version: 'codex-cli 0.155.1' }),
  status('opencode', { connection: 'connected', account: 'No model source signed in yet', version: 'opencode v2.0.31' }),
]
const key = { id: 'key', kind: 'key', label: 'API key' } as const
const read = (signed = false): ModelSources => ({ status: 'ok', zenModels: 3, sources: [
  { id: 'anthropic', name: 'Anthropic', methods: [key], models: signed ? 4 : 0, ...(signed ? { signedIn: { how: 'API key' } } : {}) },
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', methods: [{ id: 'aws', kind: 'external', label: 'AWS profile' }], models: 0 },
] })
function bridge(answer: (call: { action: string }) => unknown = call => call.action === 'key' ? { status: 'ok', sources: read(true) } : read()) {
  const opencodeSignIn = vi.fn(async (request: { id: string; call: { action: string } }) => answer(request.call)) as unknown as NonNullable<HostsBridge['opencodeSignIn']>
  return { bridge: hostsBridgeFixture({ commands: { opencodeSignIn } }).bridge, opencodeSignIn: vi.mocked(opencodeSignIn) }
}
async function open(hosts: HostsBridge, providers = FORGE) {
  render(<div className="hosts-settings"><HostProviders host={forge} providers={providers} bridge={hosts} /></div>)
  fireEvent.click(screen.getByRole('button', { name: 'Show providers on forge' }))
}

it('draws OpenCode’s tile on a host, with its version and connection, after the providers that came before it', async () => {
  expect(HOST_PROVIDER_ORDER).toEqual(['claude', 'codex', 'grok', 'devin', 'muse', 'opencode'])
  const { bridge: hosts } = bridge()
  await open(hosts)
  const tiles = within(screen.getByRole('list', { name: 'Providers on forge' })).getAllByRole('listitem')
  const tile = tiles.find(item => within(item).getByRole('heading').textContent === 'OpenCode')!
  expect(within(tile).getByText('Connected')).toBeVisible()
  expect(within(tile).getByText('No model source signed in yet · 2.0.31')).toBeVisible()
  expect(within(tile).getByRole('button', { name: 'Disconnect OpenCode on forge' })).toBeVisible()
  // No sign-in command: OpenCode signs in to model sources, under the tiles.
  expect(within(tile).queryByRole('button', { name: /Copy the OpenCode sign-in command/u })).toBeNull()
})

it('signs forge’s own OpenCode in to a model source with a key, through that host, in words that name it', async () => {
  const { bridge: hosts, opencodeSignIn } = bridge()
  await open(hosts)
  const block = await screen.findByRole('group', { name: 'OpenCode model sources on forge' })
  expect(opencodeSignIn).toHaveBeenCalledWith({ id: HOST, call: { action: 'sources' } })
  expect(within(block).getByRole('list', { name: 'Model sources Sotto’s OpenCode on forge can use' })).toBeVisible()
  fireEvent.click(within(block).getByRole('button', { name: 'Add a model source to OpenCode on forge' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add a model source to OpenCode on forge' })
  expect(dialog).toHaveTextContent('Sign Sotto’s OpenCode on forge in to a model source to use its models in OpenCode threads there. That account pays for them.')
  fireEvent.click(within(within(dialog).getByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^Anthropic/u }))
  const signIn = await screen.findByRole('dialog', { name: 'Sign in to Anthropic' })
  expect(signIn).toHaveTextContent(hostKeySentence('forge'))
  expect(hostKeySentence('forge')).toBe('The key goes to Sotto’s OpenCode on forge once, which keeps it in its own folder there. Sotto keeps no copy on either computer.')
  expect(signIn).toHaveTextContent('Its models join the model menu under OpenCode on forge, billed to your Anthropic account.')
  fireEvent.change(within(signIn).getByLabelText('Anthropic API key'), { target: { value: KEY } })
  fireEvent.click(within(signIn).getByRole('button', { name: 'Sign in to Anthropic with this key' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(opencodeSignIn).toHaveBeenCalledWith({ id: HOST, call: { action: 'key', request: { sourceId: 'anthropic', key: KEY } } })
  expect(within(block).getByRole('status')).toHaveTextContent(SIGN_IN_WORDS.signedIn('Anthropic', 4))
  expect(within(block).getByRole('button', { name: 'Sign out of Anthropic on forge' })).toBeVisible()
  // The key went to forge and stayed nowhere in the window.
  expect(document.body.innerHTML).not.toContain(KEY)
})

// The host may have saved the key all the same, so the list under the tiles is read again and shows what forge holds.
it('reads forge’s model sources again when forge’s answer to a sign-in was lost, and shows what they hold', async () => {
  let reads = 0
  const lost = { status: 'refused', reason: 'answer-lost', message: 'forge did not answer.' }
  const { bridge: hosts, opencodeSignIn } = bridge(call => call.action === 'key' ? lost : read(reads++ > 0))
  await open(hosts)
  const block = await screen.findByRole('group', { name: 'OpenCode model sources on forge' })
  fireEvent.click(within(block).getByRole('button', { name: 'Add a model source to OpenCode on forge' }))
  fireEvent.click(within(within(await screen.findByRole('dialog', { name: 'Add a model source to OpenCode on forge' })).getByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^Anthropic/u }))
  const signIn = await screen.findByRole('dialog', { name: 'Sign in to Anthropic' })
  fireEvent.change(within(signIn).getByLabelText('Anthropic API key'), { target: { value: KEY } })
  fireEvent.click(within(signIn).getByRole('button', { name: 'Sign in to Anthropic with this key' }))
  expect(await within(signIn).findByRole('alert')).toHaveTextContent('forge did not answer.')
  await waitFor(() => expect(opencodeSignIn.mock.calls.filter(([request]) => request.call.action === 'sources')).toHaveLength(2))
  expect(await within(block).findByRole('button', { name: 'Sign out of Anthropic on forge' })).toBeInTheDocument()
})

it('says a sign-in already on a host is the host’s, not this computer’s', async () => {
  const { bridge: hosts } = bridge()
  await open(hosts)
  fireEvent.click(await screen.findByRole('button', { name: 'Add a model source to OpenCode on forge' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add a model source to OpenCode on forge' })
  fireEvent.click(within(within(dialog).getByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^Amazon Bedrock/u }))
  expect(await screen.findByRole('dialog', { name: 'Sign in to Amazon Bedrock' })).toHaveTextContent('Uses a sign-in already on forge. Sotto’s OpenCode on forge reads it there, and Sotto keeps no copy.')
})

it('says in words that an older host needs an update before its OpenCode signs in from here', async () => {
  const { bridge: hosts } = bridge(() => ({ status: 'refused', message: opencodeHostNeedsUpdate('forge') }))
  await open(hosts)
  expect(await screen.findByRole('alert')).toHaveTextContent('The host on forge cannot sign OpenCode in to model sources from here. Nothing was changed. Put this computer’s version of the host on forge, stop the host and connect again.')
})

it('shows no Model sources while OpenCode on the host is not connected, and nothing of OpenCode at all on stable', async () => {
  const { bridge: hosts, opencodeSignIn } = bridge()
  await open(hosts, [FORGE[0]!, status('opencode', { connection: 'error', problem: 'not-installed' })])
  expect(screen.queryByRole('group', { name: 'OpenCode model sources on forge' })).toBeNull()
  expect(opencodeSignIn).not.toHaveBeenCalled()
  cleanup()
  owl(false)
  await open(hosts)
  expect(within(screen.getByRole('list', { name: 'Providers on forge' })).getAllByRole('heading').map(heading => heading.textContent)).not.toContain('OpenCode')
  expect(screen.queryByRole('group', { name: 'OpenCode model sources on forge' })).toBeNull()
  expect(opencodeSignIn).not.toHaveBeenCalled()
})

it('stops offering on a host a browser sign-in that finished on that machine, once forge has said so', async () => {
  const chatgpt = { id: 'chatgpt-token-sharing', kind: 'browser', label: 'ChatGPT account' } as const
  const sources: ModelSources = { status: 'ok', zenModels: 3, sources: [{ id: 'openai', name: 'OpenAI', methods: [key, chatgpt], models: 0 }] }
  const { bridge: hosts, opencodeSignIn } = bridge(call => call.action === 'browser' ? { status: 'refused', reason: 'finishes-on-host', message: opencodeSignInComesBack('forge') } : sources)
  await open(hosts)
  const add = await screen.findByRole('button', { name: 'Add a model source to OpenCode on forge' })
  fireEvent.click(add)
  fireEvent.click(within(await screen.findByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^OpenAI/u }))
  const dialog = await screen.findByRole('dialog', { name: 'Sign in to OpenAI' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /ChatGPT account/u }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(opencodeSignInComesBack('forge'))
  // Asked once; from then on the method says why it is not offered, and cannot be pressed again.
  expect(within(dialog).getByRole('button', { name: 'ChatGPT account cannot finish from this computer' })).toBeDisabled()
  expect(within(dialog).getByText('Finishes on forge itself, so not from this computer.')).toBeVisible()
  expect(opencodeSignIn.mock.calls.filter(([request]) => request.call.action === 'browser')).toHaveLength(1)
  // The next time OpenAI is picked, it opens on its key.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to the list of model sources' }))
  fireEvent.click(within(await screen.findByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^OpenAI/u }))
  expect(await screen.findByLabelText('OpenAI API key')).toBeVisible()
})

// The answer's reason says a sign-in finishes on the host, never its words: a reworded refusal still marks the method, and
// a refusal that only reads like one does not.
for (const [what, refusal, marked] of [
  ['marks a method the answer says finishes on the host, whatever its words', { status: 'refused', reason: 'finishes-on-host', message: 'Reworded, as a later build may.' }, true],
  ['leaves a method offered when only the words of its refusal read like one that finishes on the host', { status: 'refused', message: opencodeSignInComesBack('forge') }, false],
] as const) {
  it(what, async () => {
    const chatgpt = { id: 'chatgpt-token-sharing', kind: 'browser', label: 'ChatGPT account' } as const
    const sources: ModelSources = { status: 'ok', zenModels: 3, sources: [{ id: 'openai', name: 'OpenAI', methods: [key, chatgpt], models: 0 }] }
    const { bridge: hosts } = bridge(call => call.action === 'browser' ? refusal : sources)
    await open(hosts)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a model source to OpenCode on forge' }))
    fireEvent.click(within(await screen.findByRole('listbox', { name: 'Model sources' })).getByRole('option', { name: /^OpenAI/u }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to OpenAI' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /ChatGPT account/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal.message)
    expect(within(dialog).queryByText('Finishes on forge itself, so not from this computer.') !== null).toBe(marked)
  })
}
