// @vitest-environment node
/**
 * The coordinator checks prototype questions (ADR-0108): it holds a question about a prototype while it looks for the
 * question's pages, shows it with a working page, and otherwise sends it back once, as Sotto, with a fixed note. The next
 * question in the minute shows marked link missing; when none comes, Sotto's own copy shows, and the user's answer to it
 * reaches the thread as the user's message.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { PROTOTYPE_SEND_BACK_CONFIRM_MS, PROTOTYPE_SEND_BACK_NOTE, PROTOTYPE_SEND_BACK_WINDOW_MS } from '../../../src/main/agents/prototypeQuestions'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentRequest, AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-prototype-questions-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** A loopback address nothing answers: a page that is offered but does not work, found without waiting for retries. */
const DEAD_PAGE = 'http://127.0.0.1:9/'

async function start(host = new E2EAgentHost()) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-prototype-questions-'))
  roots.push(directory)
  await host.initializeWorkingFolders(directory)
  await writeFile(join(directory, 'project', 'greeting-prototype.html'), '<h1>Greeting</h1>')
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory, host, credentials, reasoner: e2eAgentReasoner,
    prototypeQuestionTimer: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } } })
  controls.add(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  /** The fixture host's own execute, for a test that stands in for some commands and passes the rest on. */
  const execution = host.execute.bind(host)
  const execute = vi.spyOn(host, 'execute')
  const fire = (ms: number) => { for (const timer of timers.filter(item => item.ms === ms && !item.cancelled)) { timer.cancelled = true; timer.run() } }
  const endMinute = () => fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
  return { host, control, execute, execution, endMinute, fire }
}
const requests = (state: AgentState): readonly AgentRequest[] => state.host.threads.find(thread => thread.id === 'workshop')!.requests
type Executed = { readonly mock: { readonly calls: readonly (readonly [AgentHostCommand])[] } }
const answers = (execute: Executed) => execute.mock.calls.map(([command]) => command).filter(command => command.type === 'answer')

describe('the coordinator’s checked prototype questions', () => {
  it('holds a question about a prototype until its page is found, then shows it with the page and sends nothing', async () => {
    const { host, control, execute } = await start()
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: 'Which prototype variant do you like? It is greeting-prototype.html.', status: 'running' })
    expect(requests(control.shell())).toEqual([])
    await vi.waitFor(() => expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'q1', pages: [expect.objectContaining({ name: 'greeting-prototype.html' })] })]))
    expect(requests(control.shell())[0]!.linkMissing).toBeUndefined()
    expect(answers(execute)).toEqual([])
  })

  it('shows a question that is not about a prototype at once', async () => {
    const { host, control } = await start()
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: 'Merge the branch?', status: 'running' })
    expect(requests(control.shell()).map(request => request.id)).toEqual(['q1'])
  })

  it('sends a question with no working page back once, as Sotto, then shows its copy after the minute and sends the user’s answer as the user’s message', async () => {
    const { host, control, execute, endMinute } = await start()
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: `Which prototype variant do you like? It is at ${DEAD_PAGE}`, status: 'running' })
    expect(requests(control.shell())).toEqual([])
    await vi.waitFor(() => expect(answers(execute)).toEqual([expect.objectContaining({ type: 'answer', requestId: 'q1', answer: PROTOTYPE_SEND_BACK_NOTE })]))
    // The provider took the note and put the question away: nothing was ever shown.
    expect(requests(control.shell())).toEqual([])
    host.event({ type: 'ready', threadId: 'workshop', text: 'I will wait for the user.' })
    await vi.waitFor(() => { endMinute(); expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'sotto:prototype-question:q1', linkMissing: true, text: `Which prototype variant do you like? It is at ${DEAD_PAGE}` })]) })
    const state = await control.command({ type: 'answer', threadId: 'workshop', requestId: 'sotto:prototype-question:q1', answer: 'The second one' })
    expect(state.error).toBeNull()
    expect(requests(control.shell())).toEqual([])
    const message = `Answer to your earlier question "Which prototype variant do you like? It is at ${DEAD_PAGE}": The second one`
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', threadId: 'workshop', text: message })))
    expect(control.get().host.threads.find(thread => thread.id === 'workshop')!.messages.at(-1)).toMatchObject({ role: 'user', text: message })
    expect(answers(execute)).toHaveLength(1)
  })

  it('shows the thread’s next question in the minute, marked link missing, without sending it back', async () => {
    const { host, control, execute } = await start()
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: `Which prototype variant? ${DEAD_PAGE}`, status: 'running' })
    await vi.waitFor(() => expect(answers(execute)).toHaveLength(1))
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q2', text: `The prototype is at ${DEAD_PAGE}. Which variant?`, status: 'running' })
    await vi.waitFor(() => expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'q2', linkMissing: true })]))
    expect(answers(execute)).toHaveLength(1)
  })

  it('shows the question, marked link missing, when the provider cannot say in time whether it took the note', async () => {
    const { host, control, execute, execution, fire } = await start()
    let confirm: (taken: boolean) => void = () => undefined
    execute.mockImplementation(async command => command.type === 'answer'
      ? { accepted: false, uncertain: true, answerCompletion: new Promise<boolean>(resolve => { confirm = resolve }) }
      : execution(command))
    const recorded = vi.fn()
    Object.assign(host, { recordAnswer: recorded })
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: `Which prototype variant? ${DEAD_PAGE}`, status: 'running' })
    await vi.waitFor(() => expect(answers(execute)).toHaveLength(1))
    expect(requests(control.shell())).toEqual([])
    fire(PROTOTYPE_SEND_BACK_CONFIRM_MS)
    expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'q1', linkMissing: true })])
    // The provider confirms after: Sotto is recorded as the one who answered, and the question is not hidden again.
    confirm(true)
    await vi.waitFor(() => expect(recorded).toHaveBeenCalledWith('workshop', expect.objectContaining({ requestId: 'q1' })))
    expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'q1', linkMissing: true })])
  })

  it('shows a question that takes only listed choices at once, marked link missing, and sends nothing', async () => {
    const { host, control, execute } = await start()
    host.event({ type: 'question', threadId: 'workshop', text: '', status: 'running', request: { id: 'q1', kind: 'question', text: `Pick a prototype ${DEAD_PAGE}`, options: [],
      questions: [{ id: 'pick', question: 'Which prototype?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], multiSelect: false, allowFreeText: false }] } })
    await vi.waitFor(() => expect(requests(control.shell())).toEqual([expect.objectContaining({ id: 'q1', linkMissing: true })]))
    expect(answers(execute)).toEqual([])
  })

  it('keeps a queued follow-up back while a question is held, then sends when the request clears', async () => {
    const { host, control, execute } = await start(new E2EAgentHost('queued-steering'))
    await control.command({ type: 'manual-send', threadId: 'workshop', text: 'Start the prototype' })
    host.event({ type: 'ready', threadId: 'workshop', text: 'The turn finished.' })
    execute.mockClear()
    // Named no page at all, the question is looked for a few times before it is sent back. It arrives with the thread at
    // rest on a completed turn, which would send a follow-up at once if nothing held it.
    host.event({ type: 'question', threadId: 'workshop', requestId: 'q1', text: 'Which prototype variant do you like?' })
    expect(requests(control.shell())).toEqual([])
    expect((await control.command({ type: 'queue-followup', threadId: 'workshop', draftId: randomUUID(), text: 'Also add a footer' })).error).toBeNull()
    const queued = control.shell().followups![0]!
    // An edit crosses the queue's mutation lane, after any claim the first pump could have started.
    expect((await control.command({ type: 'edit-followup', threadId: 'workshop', itemId: queued.id, text: queued.text })).error).toBeNull()
    expect(control.shell().followups).toEqual([expect.objectContaining({ text: 'Also add a footer', status: 'queued' })])
    expect(requests(control.shell())).toEqual([])
    expect(execute.mock.calls.some(([command]) => command.type === 'send')).toBe(false)
    // The provider clears its request; the hidden card hold ends without requiring the user to resume the queue.
    host.event({ type: 'history', threadId: 'workshop', messages: [], text: '' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', threadId: 'workshop', text: 'Also add a footer' })))
    expect(answers(execute)).toEqual([])
  })
})
