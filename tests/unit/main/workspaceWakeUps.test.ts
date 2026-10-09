// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { WAKE_UP_IDS_KEPT } from '../../../src/main/agents/workspace'
import { WAKE_UP_MESSAGE_IDS_MAX } from '../../../src/shared/agents'

/**
 * A wake-up is Sotto's message (ADR-0061 decision 8): the workspace records its ID on the thread before the provider
 * hears it, and marks the message from that record, never from its text, so the mark survives the history being read
 * again from the provider and a restart.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(root?: string, history = true) {
  const f = await workspaceFixture(root, { history })
  cleanup.push(async () => { await f.stop(); if (!root) await f.remove() })
  return f
}

describe('a wake-up in the workspace', () => {
  it('is marked as Sotto\'s from the thread\'s record, through a history reset and a restart, and the adapter never sees the mark', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: model.id })
    f.host.observeThreads(['local'])
    await f.host.execute({ type: 'send', commandId: 'user-send', threadId: 'local', messageId: 'from-user', text: 'Open the pull request.' })
    const session = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!
    session.status = 'idle'
    await f.host.execute({ type: 'send', commandId: 'wake-send', threadId: 'local', messageId: 'wake-1', text: 'Sotto is babysitting a pull request for this thread, and it needs you.', wakeUp: true })
    const messages = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages
    await expect.poll(() => messages().map(message => [message.id, message.wakeUp ?? false])).toEqual([['from-user', false], ['wake-1', true]])
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.wakeUpMessageIds).toEqual(['wake-1'])
    expect(f.adapters.codex.commands.filter(command => command.type === 'send').every(command => !('wakeUp' in command))).toBe(true)

    // The provider's history is read again from the start: the mark comes from the record, so it is still there.
    session.historyEpoch = 'rebuilt'
    session.messages = session.messages.map(message => ({ ...message, text: `${message.text} ` }))
    f.adapters.codex.emit()
    await expect.poll(() => messages().find(message => message.id === 'wake-1')?.text.endsWith(' ')).toBe(true)
    expect(messages().map(message => [message.id, message.wakeUp ?? false])).toEqual([['from-user', false], ['wake-1', true]])

    await f.stop()
    const reopened = await fixture(f.root)
    const thread = reopened.host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    expect(thread.wakeUpMessageIds).toEqual(['wake-1'])
  })

  it('names only the newest wake-ups on the thread, and still marks every older one, through a history reset and a restart', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: model.id })
    for (let index = 0; index <= WAKE_UP_MESSAGE_IDS_MAX; index++) {
      await f.host.execute({ type: 'send', commandId: `wake-${index}`, threadId: 'local', messageId: `wake-${index}`, text: 'Wake-up', wakeUp: true })
      f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!.status = 'idle'
    }
    const ids = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.wakeUpMessageIds!
    expect(ids).toHaveLength(WAKE_UP_MESSAGE_IDS_MAX)
    expect(ids[0]).toBe('wake-1')
    expect(ids.at(-1)).toBe(`wake-${WAKE_UP_MESSAGE_IDS_MAX}`)

    f.host.observeThreads(['local'])
    for (let load = 0; load < 3; load++) await f.host.loadEarlierMessages('local')
    const session = f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!
    const unmarked = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages.filter(message => !message.wakeUp).map(message => message.id)
    await expect.poll(() => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages.length).toBe(WAKE_UP_MESSAGE_IDS_MAX + 1)
    expect(unmarked()).toEqual([])
    session.historyEpoch = 'rebuilt'
    session.messages = session.messages.map(message => ({ ...message, text: `${message.text} ` }))
    f.adapters.codex.emit()
    await expect.poll(() => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages[0]?.text).toBe('Wake-up ')
    expect(unmarked()).toEqual([])

    await f.stop()
    const reopened = await fixture(f.root)
    await reopened.host.connect()
    reopened.host.observeThreads(['local'])
    for (let load = 0; load < 3; load++) await reopened.host.loadEarlierMessages('local')
    await expect.poll(() => reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages.length).toBe(WAKE_UP_MESSAGE_IDS_MAX + 1)
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages.filter(message => !message.wakeUp)).toEqual([])
  })

  it('keeps every wake-up marked across a restart while Keep local history is off, and once it is turned on again', async () => {
    const f = await fixture(undefined, false)
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: model.id })
    for (let index = 0; index <= WAKE_UP_MESSAGE_IDS_MAX; index++) {
      await f.host.execute({ type: 'send', commandId: `wake-${index}`, threadId: 'local', messageId: `wake-${index}`, text: 'Wake-up', wakeUp: true })
      f.adapters.codex.state.threads.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!.status = 'idle'
    }
    const sessions = f.adapters.codex.state.threads
    await f.stop()
    for (const history of [false, true]) {
      // Nothing was kept of what the thread said: its history is read from the provider again.
      const reopened = await fixture(f.root, history)
      reopened.adapters.codex.state.threads = structuredClone(sessions)
      await reopened.host.connect()
      reopened.host.observeThreads(['local'])
      for (let load = 0; load < 3; load++) await reopened.host.loadEarlierMessages('local')
      const messages = () => reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages
      await expect.poll(() => messages().length).toBe(WAKE_UP_MESSAGE_IDS_MAX + 1)
      expect(messages().filter(message => !message.wakeUp).map(message => message.id)).toEqual([])
      await reopened.stop()
    }
  })

  it('keeps a wake-up recorded while history was off marked once history is on, however many come after', async () => {
    const f = await fixture(undefined, false)
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'local', projectId: project.id, title: 'Task', modelId: model.id })
    await f.host.execute({ type: 'send', commandId: 'wake-0', threadId: 'local', messageId: 'wake-0', text: 'Wake-up', wakeUp: true })
    const sessions = f.adapters.codex.state.threads
    sessions.find(thread => thread.id === f.registry.byThread('local')!.sessionId)!.status = 'idle'
    await f.stop()
    // The record is full: the thousand it keeps begin with this wake-up, as if that many had gone since.
    const file = join(f.root, 'workspace.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { snapshot: { threads: Array<{ id: string; wakeUps?: string[] }> } }
    saved.snapshot.threads.find(thread => thread.id === 'local')!.wakeUps = ['wake-0', ...Array.from({ length: WAKE_UP_IDS_KEPT - 1 }, (_, index) => `gone-${index}`)]
    await writeFile(file, JSON.stringify(saved))

    const reopened = await fixture(f.root, false)
    reopened.adapters.codex.state.threads = structuredClone(sessions)
    await reopened.host.connect()
    reopened.setHistory(true); await reopened.host.privacyChanged()
    // One more pushes the first out of the record; the thread store, kept from now on, still names it.
    await reopened.host.execute({ type: 'send', commandId: 'wake-1', threadId: 'local', messageId: 'wake-1', text: 'Wake-up', wakeUp: true })
    const kept = structuredClone(reopened.adapters.codex.state.threads)
    await reopened.stop()
    // The record no longer names the first, so after a restart only the thread store, seeded when history went on, can.
    const restarted = await fixture(f.root)
    restarted.adapters.codex.state.threads = kept
    await restarted.host.connect()
    restarted.host.observeThreads(['local'])
    const messages = () => restarted.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!.messages
    for (let load = 0; load < 3; load++) await restarted.host.loadEarlierMessages('local')
    const session = restarted.adapters.codex.state.threads.find(thread => thread.id === restarted.registry.byThread('local')!.sessionId)!
    session.historyEpoch = 'rebuilt'
    session.messages = session.messages.map(message => ({ ...message, text: `${message.text} ` }))
    restarted.adapters.codex.emit()
    await expect.poll(() => messages().map(message => message.id)).toEqual(['wake-0', 'wake-1'])
    await expect.poll(() => messages()[0]?.text).toBe('Wake-up ')
    expect(messages().map(message => [message.id, message.wakeUp ?? false])).toEqual([['wake-0', true], ['wake-1', true]])
  })
})
