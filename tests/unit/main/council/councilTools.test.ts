// The gate for a thread's agent asking the Council (ADR-0177, November 5, 2026): only the user's own newest message, and
// only one that names the Council, lets the call through. Only Synthetic words are used.
import { describe, expect, it } from 'vitest'
import { councilUserMessage, CouncilToolServer, NOT_ASKED, type CouncilToolHandlers } from '../../../../src/main/agents/councilTools'
import { namesCouncil } from '../../../../src/shared/councilTools'

const user = (id: string, text: string, wakeUp?: boolean) => ({ id, role: 'user', text, ...wakeUp ? { wakeUp } : {} })
const none = { message: () => undefined, newest: () => [] }
const thread = (messages: ReturnType<typeof user>[], extra: Record<string, unknown> = {}) => ({ id: 'thread', messages, ...extra })

describe('councilUserMessage', () => {
  it('reads the newest user message when it is the user\'s own', () => {
    expect(councilUserMessage(thread([user('a', 'Synthetic first'), user('b', 'Synthetic: ask the council')]), none, () => false)).toEqual({ id: 'b', text: 'Synthetic: ask the council' })
  })
  it('refuses a wake-up, a recorded Sotto message, a brief or Watcher\'s send, and a handover', () => {
    expect(councilUserMessage(thread([user('a', 'Synthetic council', true)]), none, () => false)).toBeUndefined()
    expect(councilUserMessage(thread([user('a', 'Synthetic council')], { wakeUpMessageIds: ['a'] }), none, () => false)).toBeUndefined()
    expect(councilUserMessage(thread([user('a', 'Synthetic council')]), none, id => id === 'a')).toBeUndefined()
    expect(councilUserMessage(thread([user('a', 'Synthetic council')], { startedFrom: { handover: { sent: { messageId: 'a' } } } }), none, () => false)).toBeUndefined()
  })
  it('follows the provider\'s newest user message, read from the history when the window holds none', () => {
    expect(councilUserMessage(thread([], { lastUserMessageId: 'c' }), { message: id => [user('b', 'Synthetic older'), user('c', 'Synthetic council please')].find(item => item.id === id), newest: () => [] }, () => false)).toEqual({ id: 'c', text: 'Synthetic council please' })
  })
})

describe('namesCouncil', () => {
  it('names the Council however it is typed or dictated, but not inside a tool name', () => {
    for (const text of ['Have the council review this', 'Council, please', 'ask the Councils']) expect(namesCouncil(text)).toBe(true)
    for (const text of ['Call ask_council now', 'sotto_council__ask_council', 'counsel me']) expect(namesCouncil(text)).toBe(false)
  })
})

describe('CouncilToolServer', () => {
  const handlers = (text: string | undefined, admits = true): CouncilToolHandlers & { asked: number } => {
    const state = { asked: 0 }
    return Object.assign(state, {
      admits: () => admits,
      userMessage: async () => text === undefined ? undefined : { id: 'm', text },
      ask: async () => { state.asked++; return { ok: true as const, council: '00000000-0000-4000-8000-000000000000' } },
      climb: async () => ({ ok: true as const, climb: '00000000-0000-4000-8000-000000000001' }),
      read: () => ({ councils: [] }),
    })
  }
  const text = (result: { content: { type: string }[] }) => JSON.parse((result.content[0] as unknown as { text: string }).text) as Record<string, unknown>
  it('starts nothing when the user did not ask, or the thread may not ask', async () => {
    for (const [said, admits] of [['Synthetic: review this', true], [undefined, true], ['Synthetic: ask the council', false]] as const) {
      const given = handlers(said, admits), server = new CouncilToolServer(given)
      const result = await server.call('thread', 'ask_council', { question: 'Synthetic question' })
      expect(result.isError).toBe(true)
      if (admits) expect(text(result)['message']).toBe(NOT_ASKED)
      expect(given.asked).toBe(0)
      await server.close()
    }
  })
  it('asks when the user\'s own message names the Council, and a Climb when it names a Climb', async () => {
    const given = handlers('Synthetic: have the council look'), server = new CouncilToolServer(given)
    expect(text(await server.call('thread', 'ask_council', { question: 'Synthetic question' }))).toMatchObject({ status: 'started' })
    expect(given.asked).toBe(1)
    const climb = new CouncilToolServer(handlers('Synthetic: climb this page'))
    expect(text(await climb.call('thread', 'start_climb', { goal: 'Synthetic goal' }))).toMatchObject({ status: 'started' })
    // A Climb's word does not ask the Council a question.
    expect((await climb.call('thread', 'ask_council', { question: 'Synthetic' })).isError).toBe(true)
    await server.close(); await climb.close()
  })
})
