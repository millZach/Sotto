// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import type { ThreadHostEvent } from '../../src/main/agents/host'

// Each Codex thread's session runs in its own app-server (issue: bumpless client updates, after T3 Code's
// CodexAdapter), so one ending is that thread's failure alone, and an updated client reaches each thread as it
// goes idle while a working one finishes on the app-server it started on.

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup() })

async function fixture(session: Parameters<typeof codexFixture>[3] = {}) {
  const f = await codexFixture(undefined, false, 2000, session); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const create = async (title: string): Promise<string> => {
    const threadId = randomUUID()
    expect(await f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title })).toEqual({ accepted: true })
    return threadId
  }
  const send = (threadId: string, text: string) => f.host.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text })
  const thread = async (threadId: string) => (await f.host.snapshot()).threads.find(candidate => candidate.id === threadId)!
  // A thread nothing is watching lets its messages go from the snapshot when its session stops; its events keep them.
  const said = new Map<string, Map<string, string>>()
  f.adapter.subscribeEvents(({ threadId, event }: ThreadHostEvent) => {
    const messages = said.get(threadId) ?? new Map<string, string>(); said.set(threadId, messages)
    if ((event.kind === 'message-added' || event.kind === 'message-replaced') && event.message.role === 'assistant') messages.set(event.message.id, event.message.text)
    if (event.kind === 'message-text-appended' && messages.has(event.messageId)) messages.set(event.messageId, messages.get(event.messageId)! + event.appendText)
  })
  const replied = async (threadId: string, text: string) => [...said.get(threadId)?.values() ?? []].includes(text)
  return { f, create, send, thread, replied }
}

describe('Codex app-server per thread session', () => {
  it('starts each thread on its own app-server, apart from the provider’s', async () => {
    const { f, create } = await fixture()
    const first = await create('First'), second = await create('Second')
    const [provider] = (await f.servers()).filter(record => record.method === 'initialize')
    const firstServer = await f.serverOf(first), secondServer = await f.serverOf(second)
    expect(firstServer).toBeDefined(); expect(secondServer).toBeDefined()
    expect(new Set([provider!.pid, firstServer, secondServer]).size).toBe(3)
    // Nothing a thread does goes to the provider's app-server.
    expect((await f.servers()).filter(record => record.pid === provider!.pid).map(record => record.method)).toEqual(['initialize'])
  })

  it('fails only the running turn of a thread whose app-server stopped, and keeps the provider and the other thread working', async () => {
    const { f, create, send, thread, replied } = await fixture()
    const lost = await create('Lost'), kept = await create('Kept')
    await send(lost, 'First prompt'); await send(kept, 'Second prompt')
    await expect.poll(async () => (await thread(lost)).status).toBe('running')
    await expect.poll(async () => (await thread(kept)).status).toBe('running')
    const lostServer = await f.serverOf(lost)

    await f.action(lost, { type: 'exit' })
    await expect.poll(async () => (await thread(lost)).status).toBe('error')
    const failed = await thread(lost)
    expect(failed.lastTurn?.status).toBe('failed')
    expect(JSON.stringify(failed.activities)).toContain('Codex stopped before this reply finished')
    expect((await f.host.snapshot()).connected).toBe(true)
    expect(f.adapter.resumedThreads()).toEqual([kept])

    await f.driver.completeTurn(kept, 'Kept reply')
    await expect.poll(() => replied(kept, 'Kept reply')).toBe(true)
    // The reply and the turn ending arrive as separate native notifications.
    await expect.poll(async () => (await thread(kept)).status).toBe('idle')

    // The next action starts the thread's session again, on a new app-server, and it carries on.
    expect(await send(lost, 'Carry on')).toEqual({ accepted: true })
    expect(await f.serverOf(lost)).not.toBe(lostServer)
    await f.driver.completeTurn(lost, 'Carried on')
    await expect.poll(() => replied(lost, 'Carried on')).toBe(true)
    expect((await f.host.snapshot()).connected).toBe(true)
  })

  it('keeps a thread’s app-server, turn and question when a whole read carries more picture bytes than a line may hold', async () => {
    // A Codex thread that had made 106 paintings answered one whole read with a 341 MB line, nearly all of it the
    // paintings' bytes. Sotto stopped its app-server for that line, failing the turn and its open question, and every
    // later send, stop and read asked for the same line again. Here a line may hold 64 KiB and the pictures make 128.
    const { f, create, send, thread, replied } = await fixture({ maxFrameBytes: 64 * 1024 })
    const painting = await create('Painting')
    await send(painting, 'Paint the frames')
    await expect.poll(async () => (await thread(painting)).status).toBe('running')
    const server = await f.serverOf(painting)
    for (let index = 0; index < 4; index++) {
      const drawn = await f.action(painting, { type: 'picture', bytes: 24 * 1024, text: `Frame ${index}` })
      await expect.poll(() => f.acted(drawn)).toBe(true)
    }
    await f.driver.raiseQuestion(painting, 'Which take?')
    await expect.poll(async () => (await thread(painting)).requests.length).toBe(1)

    await expect(f.adapter.refreshThread(painting)).resolves.toBeDefined()
    const read = await thread(painting)
    expect(read.status).toBe('running')
    expect(read.requests).toHaveLength(1)
    expect(JSON.stringify(read.activities)).not.toContain('Codex stopped before this reply finished')
    expect(await f.serverOf(painting)).toBe(server)

    // The question is answered on the app-server that asked it, the turn finishes, and the thread takes the next send.
    expect(await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: painting, requestId: read.requests[0]!.id, answer: 'Blue' })).toEqual({ accepted: true })
    await f.driver.completeTurn(painting, 'Painted')
    await expect.poll(async () => (await thread(painting)).status).toBe('idle')
    expect(await send(painting, 'Now the full video')).toEqual({ accepted: true })
    expect(await f.serverOf(painting)).toBe(server)
    await f.driver.completeTurn(painting, 'Started the full video')
    await expect.poll(() => replied(painting, 'Started the full video')).toBe(true)
  })

  it('stops a thread whose app-server does not answer the Stop, and starts it again for the next send', async () => {
    const { f, create, send, thread, replied } = await fixture()
    const stuck = await create('Stuck')
    await send(stuck, 'Long task')
    await expect.poll(async () => (await thread(stuck)).status).toBe('running')
    const server = await f.serverOf(stuck)

    // The app-server takes the Stop and does nothing with it, as a hung one would.
    await f.script({ hangOnInterrupt: true })
    expect(await f.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: stuck })).toEqual({ accepted: true })
    const stopped = await thread(stuck)
    expect(stopped.status).toBe('idle')
    expect(stopped.lastTurn?.status).toBe('interrupted')
    expect(f.adapter.resumedThreads()).not.toContain(stuck)

    await f.script({})
    expect(await send(stuck, 'Carry on')).toEqual({ accepted: true })
    expect(await f.serverOf(stuck)).not.toBe(server)
    await f.driver.completeTurn(stuck, 'Carried on')
    await expect.poll(() => replied(stuck, 'Carried on')).toBe(true)
  })

  it('finishes creating a thread whose app-server a client update made outdated halfway', async () => {
    const { f, send, replied } = await fixture()
    await f.script({ holdReply: 'thread/start' })
    const threadId = randomUUID()
    const creating = f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Created during the update' })
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'thread/start')).toBe(true)
    // The journal is a handoff: the fake consumed the hold before this test replaces its script.
    expect(JSON.parse(await readFile(join(f.root, 'script.json'), 'utf8'))).not.toHaveProperty('holdReply')
    await f.script({ version: 'codex/0.200.0' })
    await f.adapter.clientUpdated()
    // Codex answers `thread/start` after the update, on the app-server the create started, and the thread is made.
    const released = randomUUID()
    await writeFile(join(f.root, 'control.json'), JSON.stringify({ id: released, type: 'release-reply', method: 'thread/start' }))
    expect(await creating).toEqual({ accepted: true })
    expect(await f.acted(released)).toBe(true)
    // Idle on an outdated app-server, it stops, and its first send starts it on the new client.
    const createdOn = await f.serverOf(threadId)
    await f.script({ reply: 'On the new client' })
    expect(await send(threadId, 'After the update')).toEqual({ accepted: true })
    await expect.poll(() => replied(threadId, 'On the new client')).toBe(true)
    expect(await f.serverOf(threadId)).not.toBe(createdOn)
  })

  it('does nothing for an updated client while Codex is not connected', async () => {
    const f = await codexFixture(); fixtures.push(f)
    await expect(f.adapter.clientUpdated()).resolves.toBeUndefined()
    expect(await f.servers()).toEqual([])
  })

  it('moves idle threads to an updated client now and a working thread once its turn ends on the old one', async () => {
    const { f, create, send, thread, replied } = await fixture()
    const working = await create('Working'), idle = await create('Idle'), watched = await create('Watched')
    await f.script({ reply: 'Done before the update' })
    await send(idle, 'Idle prompt')
    await expect.poll(() => replied(idle, 'Done before the update')).toBe(true)
    await f.script({})
    await send(working, 'Long task')
    await expect.poll(async () => (await thread(working)).status).toBe('running')
    f.adapter.observeThreads([watched])
    const before = { working: await f.serverOf(working), idle: await f.serverOf(idle), watched: await f.serverOf(watched) }

    await f.script({ version: 'codex/0.200.0' })
    await f.adapter.clientUpdated()
    expect((await f.host.snapshot()).version).toBe('codex/0.200.0')
    expect((await f.host.snapshot()).connected).toBe(true)

    // The idle thread's app-server stopped the way the reaper stops one; the watched thread started again at once.
    expect(f.adapter.resumedThreads()).not.toContain(idle)
    await expect.poll(() => f.adapter.resumedThreads().includes(watched)).toBe(true)
    expect(await f.serverOf(watched)).not.toBe(before.watched)

    // The working thread keeps its app-server and its turn, and finishes there.
    expect(f.adapter.resumedThreads()).toContain(working)
    expect((await thread(working)).status).toBe('running')
    await f.driver.completeTurn(working, 'Finished on the old client')
    await expect.poll(() => replied(working, 'Finished on the old client')).toBe(true)
    // The reply and terminal turn arrive as separate provider frames.
    await expect.poll(async () => (await thread(working)).lastTurn?.status).toBe('completed')
    // Once idle, it moves too.
    await expect.poll(() => f.adapter.resumedThreads().includes(working)).toBe(false)
    expect(await f.serverOf(working)).toBe(before.working)

    // A version said by an app-server started later does not replace the one the updated client reported.
    await f.script({ version: 'codex/0.100.0', reply: 'On the new client' })
    expect(await send(idle, 'After the update')).toEqual({ accepted: true })
    await expect.poll(() => replied(idle, 'On the new client')).toBe(true)
    expect(await f.serverOf(idle)).not.toBe(before.idle)
    expect((await f.host.snapshot()).version).toBe('codex/0.200.0')
    // Nothing was interrupted, declined or answered on the user's behalf.
    expect((await f.driver.requests()).filter(record => record.method === 'turn/interrupt')).toEqual([])
  })
})
