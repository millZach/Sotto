// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

// Five pages of a hundred durable updates: long enough that a whole-history read would show up.
const TURNS = 250
const PAGES = 5

const historyReads = async () => (await f!.driver.requests()).filter(request => request.method === '_x.ai/session/updates').length
const userMessages = async () => (await f!.host.snapshot()).threads[0]!.messages.filter(message => message.role === 'user')
const caughtUp = (turns = TURNS) => expect.poll(async () => (await userMessages()).length).toBe(turns)

/** The poll timer never fires here, so every history read in this file belongs to an awaited call. */
async function longHistory() {
  f = await grokFixture(undefined, 2000, 600_000)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Long' })
  const sessionId = await f.realId(id)
  // The fake leader saves its sessions as it stops, so the seeded history is written while it is down.
  f = await f.driver.restart()
  const file = join(f.root, 'native-sessions.json')
  const sessions = JSON.parse(await readFile(file, 'utf8')) as Record<string, { updates: unknown[] }>
  sessions[sessionId]!.updates = Array.from({ length: TURNS }, (_, index) => [
    { timestamp: 1_700_000_000 + index, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `Message ${index}` } }, _meta: { eventId: `user-${index}`, agentTimestampMs: 1_700_000_000_000 + index * 2 } } },
    { timestamp: 1_700_000_000 + index, method: '_x.ai/session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }, _meta: { eventId: `turn-${index}`, agentTimestampMs: 1_700_000_000_000 + index * 2 + 1 } } },
  ]).flat()
  await writeFile(file, JSON.stringify(sessions))
  return { id, sessionId }
}

it('reads a long Grok history from a cursor: a bounded catch-up, then one page per poll', async () => {
  const { id } = await longHistory()
  await f!.host.connect()
  // Connecting reads what one poll is allowed to read rather than the whole history.
  const afterConnect = await historyReads()
  expect(afterConnect).toBeGreaterThan(0)
  expect(afterConnect).toBeLessThan(PAGES)
  // The remaining pages arrive over the next polls, each of which reads on from the cursor.
  await caughtUp()
  expect((await userMessages()).map(message => message.text).at(-1)).toBe(`Message ${TURNS - 1}`)
  // At the end of the history a poll costs one page.
  const settled = await historyReads()
  await f!.host.snapshot()
  expect(await historyReads()).toBe(settled + 1)
  await f!.host.snapshot()
  expect(await historyReads()).toBe(settled + 2)
  // Takeover detection still works from the updates appended after the cursor.
  await f!.driver.typeInProvider(id, 'A CLI-authored prompt')
  await expect.poll(async () => (await userMessages()).at(-1)?.text).toBe('A CLI-authored prompt')
  expect((await userMessages()).at(-1)?.commandId).toBeUndefined()
  expect((await userMessages()).length).toBe(TURNS + 1)
})

it('reads a shortened Grok history again from its start', async () => {
  await longHistory()
  await f!.host.connect()
  await caughtUp()
  // A rewind or a durable coalesce leaves fewer updates than Sotto has already read.
  await f!.script({ historyVisibleCount: 100 })
  await caughtUp(50)
  expect((await userMessages()).map(message => message.text).at(-1)).toBe('Message 49')
  await f!.script({})
  await caughtUp()
})
