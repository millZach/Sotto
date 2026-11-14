import { describe, expect, it, vi } from 'vitest'
import type { AgentModel, AgentThread } from '../../../src/shared/agents'
import { RoutedSends, ROUTER_PICKS_MAX, type RoutedSendDependencies } from '../../../src/main/agents/routedSend'
import { ROUTER_INSTRUCTION } from '../../../src/main/agents/modelRouterInstruction'

const model = (id: string, name: string): AgentModel => ({ id, name, provider: 'Claude Code', providerId: 'claude', ready: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' }) as AgentModel
const models = [model('opus', 'Opus 5.5'), model('fable', 'Fable 5.2'), model('sonnet', 'Sonnet 5.5'), model('haiku', 'Haiku 5.5')]
const message = (role: 'user' | 'assistant', text: string): AgentThread['messages'][number] => ({ id: text, role, text, createdAt: '2026-11-13T00:00:00.000Z' }) as AgentThread['messages'][number]
/** A thread with no provider session yet, as a new thread is before its first message goes. */
const routedThread = (extra: Partial<AgentThread> = {}): AgentThread => ({ id: 't', providerId: 'claude', modelId: 'sonnet', reasoningEffort: 'low', routed: true, nativeSessionStarted: false, messages: [], requests: [], ...extra }) as unknown as AgentThread
const started = { nativeSessionStarted: true } as const
const answer = (tier: string, effort: string, reason = 'Because'): string => JSON.stringify({ model: tier, effort, reason })

function setup(thread: AgentThread, reply: string | null | Error, extra: Partial<RoutedSendDependencies> = {}) {
  const events: string[] = []
  const classify = vi.fn<RoutedSendDependencies['classify']>(async () => { if (reply instanceof Error) throw reply; return reply })
  const configure = vi.fn<RoutedSendDependencies['configure']>(async () => undefined)
  const publish = vi.fn()
  const sends = new RoutedSends({ thread: () => thread, models: () => models, settings: () => ({ stayOnFirstModel: false }), classify, configure,
    userChoiceWaits: () => false, publish, logEvent: name => { events.push(name) }, ...extra })
  return { sends, classify, configure, publish, events }
}

describe('a routed thread\'s send', () => {
  it('asks the classifier on Opus at low, then puts the thread on the pick', async () => {
    const { sends, classify, configure, events } = setup(routedThread(), answer('opus', 'high'))
    await sends.beforeSend('t', 'Fix the sync bug.')
    expect(classify).toHaveBeenCalledOnce()
    const [target, prompt] = classify.mock.calls[0]!
    expect(target).toEqual({ modelId: 'opus', effort: 'low' })
    expect(prompt).toEqual({ instruction: ROUTER_INSTRUCTION, material: 'User message:\nFix the sync bug.', purpose: 'model-route' })
    expect(configure).toHaveBeenCalledWith('t', 'opus', 'high')
    expect(sends.list()).toEqual([{ threadId: 't', state: 'chose', modelId: 'opus', reasoningEffort: 'high', reason: 'Because' }])
    expect(events).toEqual(['model-router-chose'])
  })

  it('tells the classifier of the thread so far on a later message, and can move the model down', async () => {
    const thread = routedThread({ ...started, modelId: 'fable', reasoningEffort: 'high', messages: [message('user', 'Port the engine.'), message('assistant', 'Merged. Anything else?')] })
    const { sends, classify, configure } = setup(thread, answer('haiku', 'medium'))
    await sends.beforeSend('t', 'Tag these 40 messages.')
    expect(classify.mock.calls[0]![1].material).toBe('Thread so far\nCurrent model: fable\nCurrent effort: high\nPrevious user message: Port the engine.\nEnd of the last reply: Merged. Anything else?\n\nUser message:\nTag these 40 messages.')
    expect(configure).toHaveBeenCalledWith('t', 'haiku', 'medium')
  })

  it('keeps the model on a later message where the thread stays on its first model, and still routes a first message', async () => {
    const later = routedThread({ ...started, modelId: 'sonnet', reasoningEffort: 'low', messages: [message('user', 'hi'), message('assistant', 'Hello.')] })
    const stay = { settings: () => ({ stayOnFirstModel: true }) }
    const first = setup(routedThread(), answer('fable', 'high'), stay)
    await first.sends.beforeSend('t', 'Design the store.')
    expect(first.configure).toHaveBeenCalledWith('t', 'fable', 'high')
    const second = setup(later, answer('fable', 'xhigh'), stay)
    await second.sends.beforeSend('t', 'Now rewrite auth.')
    expect(second.configure).toHaveBeenCalledWith('t', 'sonnet', 'xhigh')
    // A session whose history Sotto does not hold is still a session: staying keeps its model, and the classifier is told
    // there is a thread so far. A thread whose state does not say is treated as started.
    for (const session of [{ nativeSessionStarted: true }, { nativeSessionStarted: undefined }]) {
      const cleared = setup(routedThread({ ...session, modelId: 'sonnet', reasoningEffort: 'low' }), answer('fable', 'xhigh'), stay)
      await cleared.sends.beforeSend('t', 'Now rewrite auth.')
      expect(cleared.configure).toHaveBeenCalledWith('t', 'sonnet', 'xhigh')
      expect(cleared.classify.mock.calls[0]![1].material).toBe('Thread so far\nCurrent model: sonnet\nCurrent effort: low\nPrevious user message: \nEnd of the last reply: \n\nUser message:\nNow rewrite auth.')
    }
  })

  it('changes nothing when the pick is what the thread runs on', async () => {
    const { sends, configure, events } = setup(routedThread({ ...started, modelId: 'opus', reasoningEffort: 'medium', messages: [message('user', 'a'), message('assistant', 'b')] }), answer('opus', 'medium'))
    await sends.beforeSend('t', 'yes')
    expect(configure).not.toHaveBeenCalled()
    expect(sends.list()[0]).toMatchObject({ state: 'kept', modelId: 'opus', reasoningEffort: 'medium' })
    expect(events).toEqual(['model-router-kept'])
  })

  it('leaves alone a thread that is not routed, one that cannot be, and one whose user pressed a choice', async () => {
    for (const thread of [routedThread({ routed: undefined }), routedThread({ dynamic: true }), routedThread({ providerId: 'codex' }), routedThread({ delegatedBy: 'p' })]) {
      const { sends, classify, publish } = setup(thread, answer('opus', 'high'))
      await sends.beforeSend('t', 'Fix it.')
      expect(classify).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(sends.list()).toEqual([])
    }
    const pressed = setup(routedThread(), answer('opus', 'high'), { userChoiceWaits: () => true })
    await pressed.sends.beforeSend('t', 'Fix it.')
    expect(pressed.classify).not.toHaveBeenCalled()
  })

  it('sends on what the thread has when the classifier is away, throws, or cannot be read', async () => {
    for (const [reply, event] of [[null, 'model-router-failed unavailable'], [new Error('gone'), 'model-router-failed unavailable'], ['I would pick opus.', 'model-router-failed unreadable'], [answer('opus', 'max'), 'model-router-failed unreadable']] as const) {
      const { sends, configure, events } = setup(routedThread(), reply)
      await expect(sends.beforeSend('t', 'Fix it.')).resolves.toBeUndefined()
      expect(configure).not.toHaveBeenCalled()
      expect(sends.list()).toEqual([{ threadId: 't', state: 'failed' }])
      expect(events).toEqual([event])
    }
  })

  it('names no settings when the change does not come back accepted, whatever was thrown', async () => {
    // A refusal, a lost acknowledgement, a change taken in part and a restart that failed after the adapter recorded the
    // pick all reach the router as an exception, and none says what the thread now runs on.
    for (const thrown of ['The provider rejected this action.', 'Claude Code did not confirm the settings change', 'Claude Code took only part of the settings change and would not undo it', 'spawn ENOENT']) {
      const { sends, events } = setup(routedThread(), answer('opus', 'high'), { configure: async () => { throw new Error(thrown) } })
      await expect(sends.beforeSend('t', 'Fix it.')).resolves.toBeUndefined()
      expect(sends.list()).toEqual([{ threadId: 't', state: 'unconfirmed', reason: 'Because' }])
      expect(events).toEqual(['model-router-unconfirmed'])
    }
  })

  it('keeps at most a fixed number of threads\' picks, the newest, so the published list stays inside its schema', async () => {
    let id = 't'
    const { sends } = setup(routedThread(), answer('opus', 'high'), { thread: () => routedThread({ id }) })
    for (let index = 0; index < ROUTER_PICKS_MAX + 5; index += 1) { id = `t${index}`; await sends.beforeSend(id, 'Fix it.') }
    await sends.beforeSend('t5', 'Again.')
    expect(sends.size).toBe(ROUTER_PICKS_MAX)
    const ids = sends.list().map(pick => pick.threadId)
    expect(ids).not.toContain('t0'); expect(ids).not.toContain('t4'); expect(ids.at(-1)).toBe('t5'); expect(ids).toContain(`t${ROUTER_PICKS_MAX + 4}`)
  })

  it('leaves one message to a model or effort the user set by hand, on a routed thread only', () => {
    const { sends } = setup(routedThread(), answer('opus', 'high'))
    expect(sends.takeChoiceByHand('t')).toBe(false)
    sends.choseByHand('t')
    expect(sends.takeChoiceByHand('t')).toBe(true); expect(sends.takeChoiceByHand('t')).toBe(false)
    sends.choseByHand('t'); sends.forget('t')
    expect(sends.takeChoiceByHand('t')).toBe(false)
    const plain = setup(routedThread({ routed: undefined }), answer('opus', 'high'))
    plain.sends.choseByHand('t')
    expect(plain.sends.takeChoiceByHand('t')).toBe(false)
  })

  it('shows it is choosing while the classifier is asked, shares one frozen list, and forgets a thread turned off', async () => {
    let seen: unknown
    const { sends, publish } = setup(routedThread(), answer('opus', 'high'), { classify: async () => { seen = sends.list(); return answer('opus', 'high') } })
    await sends.beforeSend('t', 'Fix it.')
    expect(seen).toEqual([{ threadId: 't', state: 'choosing' }])
    const list = sends.list()
    expect(Object.isFrozen(list)).toBe(true); expect(sends.list()).toBe(list); expect(sends.size).toBe(1)
    expect(sends.routes('t')).toBe(true)
    // A deleted thread's record goes with it, in one publish however many go.
    const published = publish.mock.calls.length
    sends.forget('other', 't', 'another')
    expect(sends.list()).toEqual([]); expect(sends.size).toBe(0); expect(publish.mock.calls.length).toBe(published + 1)
    sends.forget('t')
    expect(publish.mock.calls.length).toBe(published + 1)
  })
})
