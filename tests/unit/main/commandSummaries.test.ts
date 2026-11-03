import { describe, expect, it, vi } from 'vitest'
import { CommandSummaries, type CommandSummaryWrite } from '../../../src/main/agents/commandSummaries'
import { commandSummaryWriter } from '../../../src/main/llm/commandSummary'
import type { AgentHostSnapshot, AgentRequest, AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'

const ask = (id: string, context: NonNullable<AgentRequest['context']> = { command: 'npm test' }): AgentRequest => ({ id, kind: 'permission', text: 'npm test', options: [], context })
const thread = (requests: AgentRequest[], providerId: AgentThread['providerId'] = 'codex', id = 't1') => ({ id, providerId, modelId: 'm', requests } as unknown as AgentThread)
const list = (...threads: AgentThread[]) => ({ threads } as unknown as AgentHostSnapshot)
const shown = (snapshot: AgentHostSnapshot, index = 0) => snapshot.threads[0]!.requests[index]!
const settled = () => new Promise(resolve => setImmediate(resolve))

describe('a summary reaching the card through the coordinator', () => {
  it('publishes the outcome though the thread sends nothing more', async () => {
    const workspace = await workspaceFixture()
    const credentials = await testCredentials(workspace.root, { mode: 'unavailable' })
    const pending = deferred<string | null | undefined>()
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: workspace.root, host: workspace.host, credentials, reasoner: e2eAgentReasoner, writeCommandSummary: () => pending.promise })
    try {
      await control.start()
      await control.command({ type: 'connect' })
      const adapter = workspace.adapters.codex
      const native = adapter.state.threads.find(item => item.title === 'Workshop') ?? adapter.state.threads[0]!
      native.requests = [ask('r')]
      adapter.emit()
      const request = () => control.get().host.threads.flatMap(item => item.requests).find(item => item.id === 'r')
      await vi.waitFor(() => expect(request()?.context?.summaryAsk).toBe('waiting'))
      pending.resolve('Runs the tests.')
      await vi.waitFor(() => expect(request()?.context).toMatchObject({ summary: 'Runs the tests.', summaryAsk: 'answered' }))
    } finally { control.dispose(); await control.closed(); await workspace.stop(); await workspace.remove() }
  })
})

describe('the command summaries Sotto asks for (ADR-0180)', () => {
  it('shows the card at once as waiting, then the answer, and tells the coordinator', async () => {
    const pending = deferred<string | null | undefined>()
    const write = vi.fn<CommandSummaryWrite>(() => pending.promise)
    const summaries = new CommandSummaries(write)
    summaries.onChanged = vi.fn(); summaries.onMoved = vi.fn()
    const snapshot = list(thread([ask('r')]))
    expect(shown(summaries.decorate(snapshot)).context).toEqual({ command: 'npm test', summaryAsk: 'waiting' })
    expect(write).toHaveBeenCalledWith('t1', 'npm test', expect.any(AbortSignal))
    pending.resolve('Runs the tests.')
    await settled()
    expect(summaries.onChanged).toHaveBeenCalledOnce()
    expect(summaries.onMoved).toHaveBeenCalledWith('t1')
    expect(shown(summaries.decorate(snapshot)).context).toEqual({ command: 'npm test', summary: 'Runs the tests.', summaryAsk: 'answered' })
  })

  it('asks once for a request, keeps an unchanged thread’s identity, and asks nothing when no summary is missing', () => {
    const write = vi.fn<CommandSummaryWrite>(() => new Promise(() => {}))
    const summaries = new CommandSummaries(write)
    const asking = thread([ask('r')])
    const first = summaries.decorate(list(asking)).threads[0]
    expect(summaries.decorate(list(asking)).threads[0]).toBe(first)
    expect(write).toHaveBeenCalledOnce()
    const own = list(thread([ask('r2', { command: 'ls', summary: 'Lists it' })], 'claude', 't2'))
    expect(summaries.decorate(own)).toBe(own)
    const other = list(thread([{ ...ask('r3'), context: { action: 'Edit a file' } }], 'claude', 't3'))
    expect(summaries.decorate(other)).toBe(other)
    expect(write).toHaveBeenCalledOnce()
  })

  it('leaves a request another coordinator already asked about', () => {
    const write = vi.fn<CommandSummaryWrite>(async () => 'x')
    const remote = list(thread([ask('r', { command: 'ls', summaryAsk: 'waiting' })]))
    expect(new CommandSummaries(write).decorate(remote)).toBe(remote)
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['devin', 'deepseek', 'muse'] as const)('asks nothing of %s, which has no side call', provider => {
    const write = vi.fn<CommandSummaryWrite>(async () => 'x')
    const asking = list(thread([ask('r')], provider))
    expect(new CommandSummaries(write).decorate(asking)).toBe(asking)
    expect(write).not.toHaveBeenCalled()
  })

  it.each<[string | null, string]>([[null, 'a call with no answer'], ['', 'an empty answer'], ['npm  test', 'an answer that only repeats the command']])('says it could not get one after %s (%s)', async said => {
    const summaries = new CommandSummaries(async () => said)
    const snapshot = list(thread([ask('r')]))
    summaries.decorate(snapshot)
    await settled()
    expect(shown(summaries.decorate(snapshot)).context).toEqual({ command: 'npm test', summaryAsk: 'failed' })
  })

  it('says it could not get one when the call throws', async () => {
    const summaries = new CommandSummaries(() => Promise.reject(new Error('private words')))
    const snapshot = list(thread([ask('r')]))
    summaries.decorate(snapshot)
    await settled()
    expect(shown(summaries.decorate(snapshot)).context?.summaryAsk).toBe('failed')
  })

  it('reads as no summary when the switch is off', async () => {
    const summaries = new CommandSummaries(async () => undefined)
    const snapshot = list(thread([ask('r')]))
    summaries.decorate(snapshot)
    await settled()
    expect(shown(summaries.decorate(snapshot)).context).toEqual({ command: 'npm test' })
  })

  it('stops the call when the request is answered, when its thread goes and when Sotto closes', async () => {
    const signals: AbortSignal[] = []
    const summaries = new CommandSummaries((_, __, signal) => { signals.push(signal); return new Promise(resolve => { signal.addEventListener('abort', () => resolve(null)) }) })
    summaries.decorate(list(thread([ask('a')], 'codex', 't1')))
    summaries.decorate(list(thread([], 'codex', 't1')))
    expect(signals[0]!.aborted).toBe(true)
    await settled()
    summaries.decorate(list(thread([ask('b')], 'codex', 't2')))
    summaries.decorate(list())
    expect(signals[1]!.aborted).toBe(true)
    await settled()
    summaries.decorate(list(thread([ask('c')], 'codex', 't3')))
    summaries.close()
    expect(signals[2]!.aborted).toBe(true)
  })

  it('runs two calls at once and starts the next when one ends, skipping one no longer wanted', async () => {
    const calls: { command: string; finish: (said: string) => void }[] = []
    const summaries = new CommandSummaries((_, command) => new Promise(resolve => { calls.push({ command, finish: resolve }) }))
    const requests = ['a', 'b', 'c', 'd'].map(id => ask(id, { command: `run ${id}` }))
    summaries.decorate(list(thread(requests)))
    expect(calls.map(call => call.command)).toEqual(['run a', 'run b'])
    summaries.decorate(list(thread([requests[0]!, requests[1]!, requests[3]!])))
    calls[0]!.finish('First.')
    await settled()
    expect(calls.map(call => call.command)).toEqual(['run a', 'run b', 'run d'])
    summaries.close()
  })

  it('shows the outcome on a thread taken back with its waiting state on it, as the coordinator takes its own snapshot', async () => {
    const pending = deferred<string | null | undefined>()
    const summaries = new CommandSummaries(() => pending.promise)
    const asOnce = summaries.decorate(list(thread([ask('r')])))
    expect(shown(asOnce).context?.summaryAsk).toBe('waiting')
    pending.resolve('Runs the tests.')
    await settled()
    expect(shown(summaries.decorate(asOnce)).context).toEqual({ command: 'npm test', summary: 'Runs the tests.', summaryAsk: 'answered' })
  })

  it('stops the call when an answer’s arrival is unknown, since the user has answered', () => {
    const write = vi.fn<CommandSummaryWrite>(() => new Promise(() => {}))
    const summaries = new CommandSummaries(write)
    const asOnce = summaries.decorate(list(thread([ask('r')])))
    const answered = list(thread([{ ...shown(asOnce), delivery: 'uncertain' }]))
    expect(shown(summaries.decorate(answered)).context).toEqual({ command: 'npm test' })
    expect(write.mock.calls[0]![2].aborted).toBe(true)
    const fresh = list(thread([{ ...ask('r2'), delivery: 'uncertain' }], 'codex', 't2'))
    expect(summaries.decorate(fresh)).toBe(fresh)
    expect(write).toHaveBeenCalledOnce()
  })

  it('leaves nothing of a request no longer wanted in the line for a call', async () => {
    const calls: { finish: (said: string) => void }[] = []
    const write = vi.fn<CommandSummaryWrite>(() => new Promise(resolve => { calls.push({ finish: resolve }) }))
    const summaries = new CommandSummaries(write)
    const requests = Array.from({ length: 50 }, (_, index) => ask(`r${index}`, { command: `run ${index}` }))
    summaries.decorate(list(thread(requests)))
    summaries.decorate(list(thread(requests.slice(0, 2))))
    calls[0]!.finish('First.')
    await settled()
    expect(write).toHaveBeenCalledTimes(2)
    summaries.close()
  })

  it('asks again when a request keeps its ID but changes its command', () => {
    const write = vi.fn<CommandSummaryWrite>(() => new Promise(() => {}))
    const summaries = new CommandSummaries(write)
    summaries.decorate(list(thread([ask('r', { command: 'one' })])))
    summaries.decorate(list(thread([ask('r', { command: 'two' })])))
    expect(write.mock.calls.map(call => call[1])).toEqual(['one', 'two'])
    expect(write.mock.calls[0]![2].aborted).toBe(true)
  })

  it('writes through the side call, on the switch, with the command as material only', async () => {
    const write = vi.fn(async () => 'Runs the tests.')
    const signal = new AbortController().signal
    const on = commandSummaryWriter({ write }, () => DEFAULT_SETTINGS)
    await expect(on('t1', 'npm test', signal)).resolves.toBe('Runs the tests.')
    expect(write).toHaveBeenCalledWith('t1', expect.objectContaining({ purpose: 'command-summary', material: 'npm test', shape: 'text' }), signal)
    expect(JSON.stringify(write.mock.calls[0])).not.toContain('thread title')
    const off = commandSummaryWriter({ write }, () => ({ ...DEFAULT_SETTINGS, commandSummaries: false }))
    await expect(off('t1', 'npm test', signal)).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledOnce()
    // A command too long to send whole gets no summary: one of its opening would read as the whole of it.
    await expect(on('t1', `true${' '.repeat(20_000)}; rm -rf ./important`, signal)).resolves.toBeNull()
    expect(write).toHaveBeenCalledOnce()
  })
})
