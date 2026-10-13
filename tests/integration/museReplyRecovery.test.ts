// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { museFixture } from '../fixtures/museFixture'

it.each([false, true])('keeps a newer streamed reply in the window and durable history after an older resume snapshot, completed=%s', async complete => {
  const f = await museFixture()
  const store = new ThreadStore(join(f.root, 'threads.sqlite')); store.open()
  f.adapter.useThreadHistory(store)
  const off = f.adapter.subscribeEvents(({ threadId, event }) => store.append(threadId, event))
  const id = randomUUID()
  const partial = 'The reply began'
  const suffix = ' and finished after the recovery snapshot.'
  const full = partial + suffix
  const thread = async () => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
    await f.host.execute({ type: 'send', commandId: randomUUID(), messageId: 'opening-message', threadId: id, text: 'Synthetic prompt' })
    await f.action(id, { type: 'reply-start', text: partial })
    await expect.poll(async () => (await thread()).messages.find(message => message.role === 'assistant')?.text).toBe(partial)
    // Capture the partial item, deliver a newer suffix (and optional completion), then serve the stale snapshot.
    // The final usage notice proves the resume response has been folded before either projection is checked.
    await f.script({ resumeReplyRace: { suffix, complete } })
    await f.action(id, { type: 'gap' })
    await expect.poll(async () => (await thread()).usage?.contextUsed).toBe(655)
    const visible = (await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text)
    const durable = store.readMessages(id).messages.filter(message => message.role === 'assistant').map(message => message.text)
    store.rebuild()
    const rebuilt = store.readMessages(id).messages.filter(message => message.role === 'assistant').map(message => message.text)
    expect({ visible, durable, rebuilt }).toEqual({ visible: [full], durable: [full], rebuilt: [full] })
    expect((await thread()).status).toBe(complete ? 'idle' : 'running')
    expect((await thread()).lastTurn).toEqual({ id: 'opening-message', status: complete ? 'completed' : 'running' })
    expect((await thread()).activities?.filter(activity => activity.kind === 'turn')).toEqual([
      expect.objectContaining({ turnId: 'opening-message', status: complete ? 'completed' : 'running' }),
    ])
  } finally { off(); store.close(); await f.cleanup() }
})
