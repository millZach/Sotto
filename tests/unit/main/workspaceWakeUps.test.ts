// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { WAKE_UP_MESSAGE_IDS_MAX } from '../../../src/shared/agents'

/**
 * A wake-up is Sotto's message (ADR-0061 decision 8): the workspace records its ID on the thread before the provider
 * hears it, and marks the message from that record, never from its text, so the mark survives the history being read
 * again from the provider and a restart.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(root?: string) {
  const f = await workspaceFixture(root)
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

  it('names only the newest wake-ups', async () => {
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
  })
})
