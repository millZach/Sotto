import React from 'react'
import { i18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentModel, type AgentState } from '../../../src/shared/agents'
import { OWN_SERVER_WORDS, ownServerRefusalWords, type AddResult, type CheckResult, type OwnServer, type OwnServerRefusal, type OwnServersBridge } from '../../../src/shared/ownModelServers'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ModelPicker } from '../../../src/renderer/src/agents/ModelPicker'
import { AddOwnServerDialog, OwnModelServers, ownServerName, parseContext } from '../../../src/renderer/src/agents/OwnModelServers'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const KEY = 'sk-fixture-made-up-key-3f9a'
const SPARK: OwnServer = { id: 'own-spark1', name: 'spark-head', address: 'http://spark-head:8888/v1', keyed: true,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1_048_576, thinking: true, images: false }] }
/** What an SGLang server on the tailnet answers: one model that says its context and that it thinks, one that says neither. */
const answered: CheckResult = { status: 'ok', address: 'http://spark-head:8888/v1', kind: 'sglang', answeredMs: 84, models: [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1_048_576, thinking: true, images: false },
  { id: 'qwen3-vl', name: 'Qwen3 VL', images: true },
] }
const refused = (reason: OwnServerRefusal, host = 'spark-head:8888'): CheckResult => ({ status: 'refused', reason, message: ownServerRefusalWords(reason, host, 'spark-head') })

function fake(overrides: Partial<OwnServersBridge> = {}): OwnServersBridge {
  return {
    list: vi.fn(async () => []), check: vi.fn(async () => answered),
    add: vi.fn(async request => ({ status: 'ok' as const, server: { id: 'own-new1', name: request.name, address: request.address, keyed: Boolean(request.key), models: request.models } })),
    checkSaved: vi.fn(async () => answered), remove: vi.fn(async () => ({ status: 'ok' as const })), ...overrides,
  }
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Add your own model server' })
const field = (name: RegExp | string): HTMLInputElement => within(dialog()).getByLabelText(name) as HTMLInputElement

describe('the words the dialog works with', () => {
  it('names a server from its host, and a server on this computer by its kind once checked', () => {
    expect(ownServerName('http://spark-head:8888')).toBe('spark-head')
    expect(ownServerName('spark-head.tail1234.ts.net:8888')).toBe('spark-head')
    expect(ownServerName('192.168.1.40:1234')).toBe('192.168.1.40')
    expect(ownServerName('localhost:11434')).toBe('localhost')
    expect(ownServerName('localhost:11434', 'ollama')).toBe('Ollama')
    expect(ownServerName('localhost:8000', 'openai-compatible')).toBe('localhost')
    expect(ownServerName('http://example.com:8000')).toBe('')
  })

  it('reads a context as a number of tokens, with K and M, inside the bounds', () => {
    expect(parseContext('131072')).toBe(131_072)
    expect(parseContext('131,072')).toBe(131_072)
    expect(parseContext('128K')).toBe(131_072)
    expect(parseContext('1m')).toBe(1_048_576)
    expect(parseContext('512')).toBeNull()
    expect(parseContext('20M')).toBeNull()
    expect(parseContext('lots')).toBeNull()
    expect(parseContext('')).toBeNull()
  })
})

describe('Your own model servers on Settings › Providers', () => {
  const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
  async function mount(on: boolean, bridge: OwnServersBridge | undefined): Promise<void> {
    if (bridge) vi.stubGlobal('sotto', { ...window.sotto, ownServers: bridge })
    const state = threadsStateFixture({
      configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'opencode'] },
      host: { connected: true, name: 'Providers', version: '', capabilities, projects: [], threads: [],
        providers: [{ id: 'codex', name: 'Codex', version: '0.155.1', connection: 'connected', capabilities }, { id: 'opencode', name: 'OpenCode', version: '2.1.4', connection: 'connected', capabilities }], models: [] },
    })
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn<(command: AgentCommand) => Promise<AgentState | null>>().mockResolvedValue(state)))
    render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.41-owl.20261023.1', releaseTrack: on ? 'owl' : 'stable',
      owlFeatures: { watcher: false, opencode: true, 'own-model-servers': on }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
    await screen.findByRole('button', { name: 'Codex' })
  }

  it('is above the provider tiles while the Owl feature is on and main gave the window its bridge', async () => {
    await mount(true, fake({ list: vi.fn(async () => [SPARK]) }))
    const group = await screen.findByRole('region', { name: 'Your own model servers' })
    expect(group.compareDocumentPosition(screen.getByRole('navigation', { name: 'Thread providers' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await within(group).findByText('spark-head')).toBeVisible()
  })

  it('is not there on stable, though main gave a bridge', async () => {
    await mount(false, fake())
    expect(screen.queryByRole('region', { name: 'Your own model servers' })).toBeNull()
    expect(screen.queryByText('Your own model servers')).toBeNull()
  })

  it('is not there without the bridge, though the Owl feature is on', async () => {
    await mount(true, undefined)
    expect(screen.queryByText('Your own model servers')).toBeNull()
  })
})

describe('the group', () => {
  async function group(bridge = fake()): Promise<OwnServersBridge> {
    render(<OwnModelServers bridge={bridge} />)
    await screen.findByRole('button', { name: 'Add a server' })
    return bridge
  }

  it('says there are none yet, and reads nothing from any server until a press', async () => {
    const bridge = await group()
    expect(screen.getByText('None yet. Add a model server you run to use its models in OpenCode threads.')).toBeVisible()
    expect(bridge.check).not.toHaveBeenCalled()
    expect(bridge.checkSaved).not.toHaveBeenCalled()
  })

  it('lists a saved server with its address, what runs it, its models and its key, and no status until it is checked', async () => {
    await group(fake({ list: vi.fn(async () => [SPARK]) }))
    const row = screen.getByText('spark-head').closest('li')!
    expect(within(row).getByText('http://spark-head:8888/v1')).toBeVisible()
    expect(within(row).getByText('Runs with OpenCode · 1 model · Key kept by OpenCode')).toBeVisible()
    expect(within(row).queryByRole('status')).toBeNull()
  })

  it('shows what Check again found on that row only, and keeps the saved models', async () => {
    const bridge = fake({ list: vi.fn(async () => [SPARK]) })
    await group(bridge)
    fireEvent.click(screen.getByRole('button', { name: 'Check spark-head again' }))
    const row = screen.getByText('spark-head').closest('li')!
    expect(await within(row).findByRole('status')).toHaveTextContent('SGLang answered in 84 ms. It also lists Qwen3 VL, which is not added. To use it, remove the server and add it again.')
    expect(bridge.checkSaved).toHaveBeenCalledWith({ id: 'own-spark1' })
    expect(within(row).getByText('Runs with OpenCode · 1 model · Key kept by OpenCode')).toBeVisible()
  })

  it('gives focus back to Check again once its check is done', async () => {
    const user = userEvent.setup()
    await group(fake({ list: vi.fn(async () => [SPARK]) }))
    await user.click(screen.getByRole('button', { name: 'Check spark-head again' }))
    await within(screen.getByText('spark-head').closest('li')!).findByRole('status')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check spark-head again' })).toHaveFocus())
  })

  it('says when the saved servers cannot be read, and reads them again on Try again', async () => {
    const list = vi.fn<OwnServersBridge['list']>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue([SPARK])
    render(<OwnModelServers bridge={fake({ list })} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto could not read your saved servers. Nothing was changed. Try again.')
    expect(screen.queryByText(/^None yet/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read your saved servers again' }))
    expect(await screen.findByText('spark-head')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says plainly when a server added with a key asks for it on Check again, and names no models', async () => {
    const keyKept: CheckResult = { status: 'ok', address: SPARK.address, kind: 'sglang', answeredMs: 40, keyKept: true,
      models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1_048_576, thinking: true, images: false }] }
    await group(fake({ list: vi.fn(async () => [SPARK]), checkSaved: vi.fn(async () => keyKept) }))
    fireEvent.click(screen.getByRole('button', { name: 'Check spark-head again' }))
    const row = screen.getByText('spark-head').closest('li')!
    expect(await within(row).findByRole('status')).toHaveTextContent(
      /^spark-head answered in 40 ms and asks for its key, which OpenCode keeps, so Sotto could not read its models again\.$/u)
    expect(within(row).getByRole('status')).not.toHaveTextContent(/model(s)? (found|listed)|also lists|no longer lists|with \d/u)
  })

  it('says on the row when Check again finds the server gone, in main’s words', async () => {
    await group(fake({ list: vi.fn(async () => [SPARK]), checkSaved: vi.fn(async () => refused('unreachable')) }))
    fireEvent.click(screen.getByRole('button', { name: 'Check spark-head again' }))
    expect(await within(screen.getByText('spark-head').closest('li')!).findByRole('alert')).toHaveTextContent(OWN_SERVER_WORDS.unreachable('spark-head:8888'))
  })

  it('removes a server without asking again, says so, and puts focus on Add a server when none is left', async () => {
    const bridge = fake({ list: vi.fn(async () => [SPARK]) })
    await group(bridge)
    fireEvent.click(screen.getByRole('button', { name: 'Remove spark-head' }))
    expect(await screen.findByText(/^Removed spark-head\. Its models are gone from the model menu\./u)).toBeVisible()
    expect(bridge.remove).toHaveBeenCalledWith({ id: 'own-spark1' })
    expect(screen.queryByRole('button', { name: 'Check spark-head again' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a server' })).toHaveFocus())
  })

  it('checks, takes a context the server did not say, adds the server, closes and says where its models are', async () => {
    const user = userEvent.setup()
    const bridge = await group()
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    expect(field('Address')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    await user.type(field('Address'), 'spark-head:8888')
    expect(field('Name')).toHaveValue('spark-head')
    await user.type(field(/^Key/u), KEY)
    expect(within(dialog()).getByText('OpenCode keeps the key in Sotto’s OpenCode folder, and Sotto keeps no copy.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    expect(bridge.check).toHaveBeenCalledWith({ address: 'http://spark-head:8888/v1', key: KEY })
    expect(await within(dialog()).findByText('SGLang answered in 84 ms with 2 models.')).toBeVisible()
    const models = within(dialog()).getAllByRole('listitem')
    // The first model said its context and that it thinks; the second said neither, and takes images.
    expect(within(models[0]!).getByLabelText('Context, in tokens')).toHaveValue('1048576')
    expect(within(models[0]!).getByRole('switch', { name: 'Thinking for DeepSeek V4.1 Flash' })).toHaveAttribute('aria-checked', 'true')
    const unknown = within(models[1]!).getByLabelText('Context, in tokens')
    expect(unknown).toHaveValue('')
    expect(unknown).toHaveAttribute('aria-invalid', 'true')
    expect(unknown).toHaveAccessibleDescription(OWN_SERVER_WORDS.contextUnknown)
    expect(within(models[1]!).getByRole('switch', { name: 'Thinking for Qwen3 VL' })).toHaveAttribute('aria-checked', 'false')
    expect(within(models[1]!).getByText('Takes images.')).toBeVisible()
    expect(within(dialog()).getByText(OWN_SERVER_WORDS.privacy)).toBeVisible()
    // Focus goes to what the check asks for: the context nobody said.
    await waitFor(() => expect(unknown).toHaveFocus())
    const add = screen.getByRole('button', { name: 'Add server' })
    expect(add).toBeDisabled()
    await user.type(unknown, '500')
    expect(within(models[1]!).getByText(/^Type a number of tokens from 1,024/u)).toBeVisible()
    expect(add).toBeDisabled()
    await user.clear(unknown)
    await user.type(unknown, '32K')
    expect(add).toBeEnabled()
    await user.click(within(models[0]!).getByRole('switch', { name: 'Thinking for DeepSeek V4.1 Flash' }))
    await user.clear(field('Name'))
    await user.type(field('Name'), 'Sparks')
    await user.click(add)
    expect(bridge.add).toHaveBeenCalledWith({ name: 'Sparks', address: 'http://spark-head:8888/v1', key: KEY, models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 1_048_576, thinking: false, images: false },
      { id: 'qwen3-vl', name: 'Qwen3 VL', context: 32_768, thinking: false, images: true },
    ] })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Added Sparks. Its models are in the model menu under Sparks, with OpenCode.')).toBeVisible()
    expect(screen.getByText('Sparks').closest('li')).toHaveTextContent('Runs with OpenCode · 2 models · Key kept by OpenCode')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a server' })).toHaveFocus())
  })

  it.each<[OwnServerRefusal, 'Address' | 'Key' | null]>([
    ['unreachable', 'Address'], ['key-needed', 'Key'], ['key-refused', 'Key'], ['no-models', null], ['not-openai', 'Address'], ['public-http', 'Address'],
  ])('says a %s refusal from the check in the dialog, keeps every field and puts focus where it can be put right', async (reason, fixAt) => {
    const user = userEvent.setup()
    await group(fake({ check: vi.fn(async () => refused(reason)) }))
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.type(field(/^Key/u), KEY)
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(ownServerRefusalWords(reason, 'spark-head:8888'))
    expect(field('Address')).toHaveValue('spark-head:8888')
    expect(field('Name')).toHaveValue('spark-head')
    expect(field(/^Key/u)).toHaveValue(KEY)
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    const expected = fixAt === 'Address' ? field('Address') : fixAt === 'Key' ? field(/^Key/u) : screen.getByRole('button', { name: 'Check this server' })
    await waitFor(() => expect(expected).toHaveFocus())
    if (fixAt) expect(expected).toHaveAttribute('aria-invalid', 'true')
  })

  it('says a refusal in the interface language, from its reason, rather than in main\'s English (ADR-0123)', async () => {
    const user = userEvent.setup()
    // A stand-in translation of the words this needs; every other message shows in English.
    const translated = {
      'Add a server': 'Server hinzufügen', 'Add your own model server': 'Eigenen Modellserver hinzufügen', Address: 'Adresse',
      'Check this server': 'Diesen Server prüfen',
      'Nothing answered at {host}. Nothing was saved. Check the server is on and this computer can reach it, over the tailnet if it is there, then try again.':
        'Unter {host} hat nichts geantwortet. Nichts wurde gespeichert.',
    }
    i18n.loadAndActivate({ locale: 'de', messages: Object.fromEntries(Object.entries(translated).map(([english, german]) => [generateMessageId(english), german])) })
    try {
      render(<OwnModelServers bridge={fake({ check: vi.fn(async () => refused('unreachable')) })} />)
      await user.click(await screen.findByRole('button', { name: 'Server hinzufügen' }))
      const shown = screen.getByRole('dialog', { name: 'Eigenen Modellserver hinzufügen' })
      await user.type(within(shown).getByLabelText('Adresse'), 'spark-head:8888')
      await user.click(within(shown).getByRole('button', { name: 'Diesen Server prüfen' }))
      expect(await within(shown).findByRole('alert')).toHaveTextContent('Unter spark-head:8888 hat nichts geantwortet. Nichts wurde gespeichert.')
      expect(within(shown).getByRole('alert')).not.toHaveTextContent(OWN_SERVER_WORDS.unreachable('spark-head:8888'))
    } finally {
      act(() => i18n.activate('en'))
    }
  })

  it.each<OwnServerRefusal>(['opencode-not-running', 'sign-in-failed', 'full'])('says a %s refusal from Add in the dialog and keeps what was checked', async reason => {
    const user = userEvent.setup()
    const bridge = await group(fake({ check: vi.fn(async () => ({ ...answered, models: [answered.models[0]!] }) as CheckResult),
      add: vi.fn(async () => ({ status: 'refused' as const, reason, message: ownServerRefusalWords(reason, 'spark-head:8888', 'spark-head') })) }))
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    expect(bridge.add).toHaveBeenCalled()
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(ownServerRefusalWords(reason, 'spark-head:8888', 'spark-head'))
    expect(within(dialog()).getByText('SGLang answered in 84 ms with 1 model.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add server' })).toHaveFocus()
    expect(screen.queryByText(/^Added/u)).toBeNull()
  })

  it('cannot be closed while an add is with main, says it is adding, and closes when main answers', async () => {
    const user = userEvent.setup()
    let answer: (result: AddResult) => void = () => undefined
    const bridge = await group(fake({ check: vi.fn(async () => ({ ...answered, models: [answered.models[0]!] }) as CheckResult),
      add: vi.fn(() => new Promise<AddResult>(resolve => { answer = resolve })) }))
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    const adding = screen.getByRole('button', { name: 'Adding…' })
    expect(adding).toHaveFocus()
    expect(adding).toHaveAttribute('aria-disabled', 'true')
    expect(dialog()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Close without adding a server' })).toBeDisabled()
    expect(field('Address')).toHaveAttribute('readonly')
    await user.keyboard('{Escape}')
    await user.click(adding)
    expect(dialog()).toBeVisible()
    expect(bridge.add).toHaveBeenCalledTimes(1)
    answer({ status: 'ok', server: { ...SPARK, id: 'own-new1', address: answered.address, keyed: false } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Added spark-head. Its models are in the model menu under spark-head, with OpenCode.')).toBeVisible()
  })

  it('opens again for Cancel once a pending add is refused', async () => {
    const user = userEvent.setup()
    let answer: (result: AddResult) => void = () => undefined
    await group(fake({ check: vi.fn(async () => ({ ...answered, models: [answered.models[0]!] }) as CheckResult),
      add: vi.fn(() => new Promise<AddResult>(resolve => { answer = resolve })) }))
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    answer({ status: 'refused', reason: 'opencode-not-running', message: OWN_SERVER_WORDS.openCodeNotRunning })
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(OWN_SERVER_WORDS.openCodeNotRunning)
    expect(screen.getByRole('button', { name: 'Add server' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close without adding a server' })).toBeEnabled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says a mistyped address itself, without asking main', async () => {
    const user = userEvent.setup()
    const bridge = await group()
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'http://example.com:8000')
    await user.tab()
    expect(field('Address')).toHaveAccessibleDescription(expect.stringContaining(OWN_SERVER_WORDS.publicHttp('example.com:8000')))
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(OWN_SERVER_WORDS.publicHttp('example.com:8000'))
    expect(bridge.check).not.toHaveBeenCalled()
  })

  it('forgets a check when the address changes, since it was about another server', async () => {
    const user = userEvent.setup()
    await group()
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    await within(dialog()).findByText('SGLang answered in 84 ms with 2 models.')
    await user.type(field('Address'), '9')
    expect(within(dialog()).queryByText(/answered in/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Check this server' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
  })

  it('closes on Escape and on Cancel, adds nothing and hands focus back to Add a server', async () => {
    const user = userEvent.setup()
    const bridge = await group()
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a server' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.click(screen.getByRole('button', { name: 'Close without adding a server' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a server' })).toHaveFocus())
    expect(bridge.add).not.toHaveBeenCalled()
  })

  it('moves Tab in the order the eye reads the dialog', async () => {
    const user = userEvent.setup()
    await group()
    await user.click(screen.getByRole('button', { name: 'Add a server' }))
    await user.type(field('Address'), 'spark-head:8888')
    // Address, Name, Key, Check this server, Cancel; Add server waits for a check.
    await user.tab()
    expect(field('Name')).toHaveFocus()
    await user.tab()
    expect(field(/^Key/u)).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Check this server' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Close without adding a server' })).toHaveFocus()
    // The wrap at either end is useDialogFocus's, shared with every dialog. jsdom lists a comma selector's matches by
    // selector rather than in document order, so it is checked in the running app, not here.
  })
})

describe('Your own server… in the model menu', () => {
  const openCode = (id: string, name: string, source: string): AgentModel => ({ id, name, provider: 'OpenCode', providerId: 'opencode', source, ready: true })
  const models: AgentModel[] = [openCode('zen-1', 'Big Pickle', 'OpenCode Zen'), openCode('anthropic-1', 'Claude Sonnet 5', 'Anthropic'), { id: 'codex-1', name: 'GPT-6-Sol', provider: 'Codex', providerId: 'codex', ready: true }]
  const sources = (): HTMLElement => screen.getByRole('group', { name: 'OpenCode model sources' })

  it('ends OpenCode’s source list and opens the Add a server dialog, which hands focus back to the chip', async () => {
    const user = userEvent.setup()
    const bridge = fake()
    render(<ModelPicker models={models} modelId="zen-1" disabled={false} onChange={vi.fn()} ownServers={bridge} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const rows = within(sources()).getAllByRole('button')
    expect(rows.at(-1)).toHaveAccessibleName('Your own server: add a model server you run')
    expect(rows.at(-1)).toHaveTextContent('Your own server…')
    await user.click(rows.at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()
    expect(dialog()).toBeVisible()
    expect(field('Address')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveFocus())
  })

  it('says where the models are after Add and waits for Done', async () => {
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="zen-1" disabled={false} onChange={vi.fn()} ownServers={fake({ check: vi.fn(async () => ({ ...answered, models: [answered.models[0]!] }) as CheckResult) })} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    await user.click(within(sources()).getByRole('button', { name: 'Your own server: add a model server you run' }))
    await user.type(field('Address'), 'spark-head:8888')
    await user.click(screen.getByRole('button', { name: 'Check this server' }))
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    const done = await screen.findByRole('dialog', { name: 'Added spark-head' })
    expect(within(done).getByText('Added spark-head. Its models are in the model menu under spark-head, with OpenCode.')).toBeVisible()
    await waitFor(() => expect(within(done).getByRole('button', { name: 'Done' })).toHaveFocus())
    await user.click(within(done).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveFocus())
  })

  it('is reached with the arrow keys after the last source', async () => {
    const user = userEvent.setup()
    render(<ModelPicker models={models} modelId="zen-1" disabled={false} onChange={vi.fn()} ownServers={fake()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    await user.keyboard('{ArrowDown}{End}')
    expect(within(sources()).getByRole('button', { name: 'Your own server: add a model server you run' })).toHaveFocus()
  })

  it('is not there without the bridge, nor under another provider', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ModelPicker models={models} modelId="zen-1" disabled={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(within(sources()).queryByRole('button', { name: /Your own server/u })).toBeNull()
    unmount()
    render(<ModelPicker models={models} modelId="codex-1" disabled={false} onChange={vi.fn()} ownServers={fake()} />)
    await user.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.queryByRole('button', { name: /Your own server/u })).toBeNull()
  })
})

describe('the dialog alone', () => {
  it('drops a check answered after it closed', async () => {
    let answer: (result: CheckResult) => void = () => undefined
    const bridge = fake({ check: vi.fn(() => new Promise<CheckResult>(resolve => { answer = resolve })) })
    const onClose = vi.fn()
    const { unmount } = render(<AddOwnServerDialog bridge={bridge} onClose={onClose} />)
    fireEvent.change(field('Address'), { target: { value: 'spark-head:8888' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check this server' }))
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Asking the server for its models…')
    unmount()
    answer(answered)
    await Promise.resolve()
    expect(screen.queryByText(/answered in/u)).toBeNull()
  })
})
