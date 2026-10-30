// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NO_TURN_TO_STEER, queueHold, RUNNING_TURN_HOLD, SLASH_COMMAND_REFUSAL, startsWithSlashCommand, UNCONFIRMED_SEND_HOLD, UNCONFIRMED_SEND_WAITS, USER_TURN_RUNNING, WATCH_PAUSED_HOLD } from '../../../src/main/agents/watcherSendHolds'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { deferred } from '../../fixtures/deferred'

describe('what a refused Watcher send says it waits on (#1203)', () => {
  it('names a different hold for each reason, and never background work as one', () => {
    const said = [RUNNING_TURN_HOLD, NO_TURN_TO_STEER, USER_TURN_RUNNING, WATCH_PAUSED_HOLD, queueHold('pending-work', false), queueHold('pending-work', true),
      queueHold('paused-followups', false), queueHold('failed-followups', false), queueHold('uncertain-send', false), UNCONFIRMED_SEND_WAITS]
    expect(new Set(said).size).toBe(said.length)
    for (const text of said) expect(text).toMatch(/Nothing was sent\.$/u)
    expect(said.filter(text => /background/u.test(text))).toEqual([NO_TURN_TO_STEER])
    expect(NO_TURN_TO_STEER).toContain('does not hold a send')
  })

  it('says an unconfirmed earlier send holds it, and how the user ends that, apart from the user’s running turn (#1222)', () => {
    expect(queueHold('uncertain-send', false)).toBe(UNCONFIRMED_SEND_HOLD)
    expect(UNCONFIRMED_SEND_HOLD).toContain('Continue with a new message')
    expect(UNCONFIRMED_SEND_HOLD).not.toMatch(/turn/u)
    // Where the user cannot set it aside, it names no action they cannot take.
    expect(UNCONFIRMED_SEND_WAITS).not.toContain('Continue with a new message')
    expect(UNCONFIRMED_SEND_WAITS).not.toMatch(/turn/u)
    expect(USER_TURN_RUNNING).not.toMatch(/unconfirmed/u)
    // A pause held by something else names no turn, since none is running.
    expect(WATCH_PAUSED_HOLD).not.toMatch(/turn/u)
  })
})

describe('a prompt that starts with a slash command (#1222)', () => {
  it('is one whose first word is a slash and a name, with or without more words after it', () => {
    for (const text of ['/compact', '/compact now', '  /compact', '/review-pr_2 please', '/compact\nkeep the plan', '/my-plugin:review', '/my-plugin:review this branch']) expect(startsWithSlashCommand(text), text).toBe(true)
  })

  it('is not a path, a slash later in the prompt, or a slash alone', () => {
    for (const text of ['/home/x is the path', '/tmp/foo', 'see /tmp/foo', 'Run /compact when you can', '/', '/ compact', '//compact', '']) expect(startsWithSlashCommand(text), text).toBe(false)
  })

  it('is refused in plain words that send the user to run it', () => {
    expect(SLASH_COMMAND_REFUSAL).toMatch(/Ask the user to run it in the thread/u)
    expect(SLASH_COMMAND_REFUSAL).toMatch(/Nothing was sent\.$/u)
  })
})

describe('the user’s messages while a card waits', () => {
  it.each(['watcher', 'project'] as const)('queues Send and Steer for a %s thread without answering its question, then drains in order', async kind => {
    const host = new FakeProviderHost(), thread = host.state.threads[0]!
    thread.kind = kind
    // A provider may show a card while idle, before it has supplied a confirmed turn. That is not a failed turn.
    thread.status = 'idle'
    thread.requests = [{ id: 'question', kind: 'question', text: 'Which colour?', options: [], skippable: true }]
    const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
    try {
      await f.control.start(); await f.control.command({ type: 'connect' })
      const first = { type: 'manual-send' as const, threadId: thread.id, draftId: randomUUID(), text: 'First follow-up' }
      const second = { type: 'steer' as const, threadId: thread.id, draftId: randomUUID(), text: 'Second follow-up' }
      for (const prompt of [first, second]) expect((await f.control.command(prompt)).error).toBeNull()
      expect(f.control.get().followups?.map(item => ({ text: item.text, status: item.status }))).toEqual([
        { text: first.text, status: 'queued' }, { text: second.text, status: 'queued' },
      ])
      expect(host.commands).toEqual([])
      expect(thread.requests.map(request => request.id)).toEqual(['question'])

      const answer = await f.control.command({ type: 'answer', threadId: thread.id, requestId: 'question', answer: '', skipped: true })
      expect(answer.error).toBeNull()
      expect(host.commands.map(command => command.type)).toEqual(['answer'])
      expect(thread.requests).toEqual([])
      const third = { type: 'manual-send' as const, threadId: thread.id, draftId: randomUUID(), text: 'Later follow-up' }
      expect((await f.control.command(third)).error).toBeNull()
      // The card's answer resumes its turn. The queue's first available slot is after that turn finishes.
      for (const prompt of [first, second, third]) {
        const delivered = deferred<void>()
        const unsubscribe = f.control.subscribe(state => {
          if (state.deliveredDrafts?.some(item => item.draftId === prompt.draftId)
            && !state.followups?.some(item => item.draftId === prompt.draftId)) delivered.resolve()
        })
        thread.status = 'idle'; thread.lastTurn = { id: randomUUID(), status: 'completed' }; host.emit()
        try { await delivered.promise } finally { unsubscribe() }
      }
      expect(host.commands.filter(command => command.type === 'send').map(command => command.text)).toEqual([first.text, second.text, third.text])
      expect(host.commands.filter(command => command.type === 'answer')).toHaveLength(1)
      expect(f.control.get().followups).toEqual([])
    } finally { await f.dispose() }
  })

  it('keeps the phone origin when a steer joins the queue behind a pending card', async () => {
    const host = new FakeProviderHost(), thread = host.state.threads[0]!
    host.state.hostId = randomUUID()
    thread.kind = 'watcher'
    thread.requests = [{ id: 'question', kind: 'question', text: 'Which colour?', options: [], skippable: true }]
    const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
    try {
      await f.control.start(); await f.control.command({ type: 'connect' })
      f.control.useWatcher({ userCommand: () => undefined, beforeDispatch: command => command, observe: () => undefined,
        guardOperation: () => undefined, preserveUserQueue: () => false })
      const phoneOrigin = { kind: 'phone' as const, hostId: host.state.hostId, clientId: 'paired-phone' }
      const prompt = { type: 'steer' as const, threadId: thread.id, draftId: randomUUID(), text: 'After this question' }
      const result = await f.control.commandFromWatcherPhone(prompt, { phoneOrigin, guard: () => undefined },
        { clientId: phoneOrigin.clientId, user: 'Phone', transport: 'socket' })
      expect(result.error).toBeNull()
      expect(f.control.watcherFollowups(thread.id)).toEqual([
        expect.objectContaining({ draftId: prompt.draftId, text: prompt.text, status: 'queued', phoneOrigin }),
      ])
      expect(host.commands).toEqual([])
      expect(thread.requests.map(request => request.id)).toEqual(['question'])
    } finally { await f.dispose() }
  })

  it('keeps a permission card open while accepting a message, and dispatches when it clears on a completed turn', async () => {
    const host = new FakeProviderHost(), thread = host.state.threads[0]!
    thread.kind = 'watcher'; thread.lastTurn = { id: 'finished-turn', status: 'completed' }
    thread.requests = [{ id: 'permission', kind: 'permission', text: 'Allow this command?', options: [] }]
    const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
    try {
      await f.control.start(); await f.control.command({ type: 'connect' })
      const prompt = { type: 'manual-send' as const, threadId: thread.id, draftId: randomUUID(), text: 'After the card' }
      expect((await f.control.command(prompt)).error).toBeNull()
      expect(host.commands).toEqual([])
      expect(thread.requests.map(request => request.id)).toEqual(['permission'])
      const delivered = deferred<void>()
      const unsubscribe = f.control.subscribe(state => {
        if (state.deliveredDrafts?.some(item => item.draftId === prompt.draftId)
          && !state.followups?.some(item => item.draftId === prompt.draftId)) delivered.resolve()
      })
      thread.requests = []; host.emit()
      try { await delivered.promise } finally { unsubscribe() }
      expect(host.commands).toEqual([expect.objectContaining({ type: 'send', text: prompt.text })])
    } finally { await f.dispose() }
  })
})
