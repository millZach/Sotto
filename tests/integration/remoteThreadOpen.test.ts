// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

/**
 * A desktop paired with a headless host, and how many times one of the host's threads has come to it whole: each whole
 * detail the client stores, pushed or read. The window's reads go through `windowDetail`, as the router makes them.
 */
async function opened() {
  const { client } = await fixture.pair()
  await client.command({ type: 'connect', provider: 'codex' })
  const [threadId] = client.shell().host.threads.map(thread => thread.id)
  const stored = vi.spyOn(client as unknown as { cacheDetail: (id: string, detail: unknown) => void }, 'cacheDetail')
  const transfers = (): number => stored.mock.calls.filter(([id, detail]) => id === threadId && detail !== null).length
  return { client, threadId: threadId!, transfers }
}

/**
 * Opening a remote thread sends it whole once where it can (#996). On a028edc36 a click in the sidebar sent it three
 * times, a thread coming on screen twice, and the window catching up on a thread it followed once more. Since #1990 a
 * click sends it once too: the host holds the copy the window's ask brought, unchanged, for the observe after it. This
 * host's fake provider holds every thread's messages, as a real host holds those of a thread something else observes;
 * one a real host does not hold is read with no history, and its observe brings the one copy.
 */
describe('opening a thread on a remote host (#996)', () => {
  it('sends a thread coming on screen once: the window\'s ask waits for the observe that brings it', async () => {
    const { client, threadId, transfers } = await opened()
    // The window sends the observe before it asks (AgentContext), so the ask finds the observe under way.
    const observing = client.observe([threadId]); const ask = client.windowDetail(threadId)
    await observing
    expect((await ask)?.threadId).toBe(threadId)
    expect(transfers()).toBe(1)
  })

  it('answers the window catching up on a thread it follows from the copy the host keeps current', async () => {
    const { client, threadId, transfers } = await opened()
    await client.observe([threadId])
    const held = await client.windowDetail(threadId)
    expect(transfers()).toBe(1)
    expect(held).toEqual(await client.readThreadDetail(threadId))
  })

  it('sends a thread clicked in the sidebar once: the window\'s ask, which the observe after it holds (#1990)', async () => {
    const { client, threadId, transfers } = await opened()
    await client.command({ type: 'select-thread', threadId })
    const ask = client.windowDetail(threadId)
    await client.observe([threadId]); await ask
    // Selecting reads nothing: the history comes with the ask the window makes for it.
    expect(transfers()).toBe(1)
    // The copy the ask brought is kept current from there: a message the agent writes arrives as a change to it.
    const native = client.shell().host.threads.find(thread => thread.id === threadId)!.title === 'Workshop' ? 'workshop' : 'docs'
    fixture.native.event({ type: 'ready', threadId: native, text: 'After the click' })
    await expect.poll(() => client.threadDetail(threadId)?.messages.some(message => message.text === 'After the click')).toBe(true)
    expect(transfers()).toBe(1)
  })

  it('applies a delta that arrives with a read\'s answer to what the read brings, rather than reading again (#1990)', async () => {
    const { client, threadId, transfers } = await opened()
    const revision = fixture.host.service.threadDetail(threadId)!.revision
    // The host's delta from the revision read to the next, handled before the read's answer is held, as when both frames
    // come in one chunk of the socket.
    const reading = client.readThreadDetail(threadId)
    ;(client as unknown as { applyDelta: (id: string, delta: unknown) => void }).applyDelta(threadId, { threadId, baseRevision: revision, revision: revision + 1, messageDeltas: [], activityDeltas: [] })
    await reading
    await expect.poll(() => client.threadDetail(threadId)?.revision).toBe(revision + 1)
    expect(transfers()).toBe(1)
  })

  it('reads a thread the host said was too large again, rather than answer with an older copy', async () => {
    const { client, threadId, transfers } = await opened()
    await client.observe([threadId])
    ;(client as unknown as { tooLarge: Set<string> }).tooLarge.add(threadId)
    await client.windowDetail(threadId)
    expect(transfers()).toBe(2)
  })

  it('reads a thread nobody observes from the host', async () => {
    const { client, threadId, transfers } = await opened()
    expect((await client.windowDetail(threadId))?.threadId).toBe(threadId)
    expect(transfers()).toBe(1)
  })
})
