// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../src/shared/threadActivity'
import { agentCommandSchema, type AgentHostSnapshot } from '../../../src/shared/agents'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'

import { cleanup, fixture, local, send, deferred } from '../../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('opens a new thread in a settled project while its older threads stay settled across restart', async () => {
    const f = await fixture(); const { project } = await local(f)
    await local(f, 'already-settled')
    await f.host.setWorkspaceSettled('thread', 'already-settled', true)
    await f.host.setWorkspaceSettled('project', project.id, true)
    const oldIds = f.host.workspaceSnapshot().threads.filter(thread => thread.projectId === project.id).map(thread => thread.id)
    const before = f.host.workspaceSnapshot()
    await local(f, 'new-work')
    const check = (snapshot: AgentHostSnapshot) => {
      const folder = snapshot.projects.find(item => item.id === project.id)!
      expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === 'new-work')!, folder)).toBe(false)
      for (const id of oldIds) expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === id)!, folder)).toBe(true)
    }
    check(f.host.workspaceSnapshot())
    const after = f.host.workspaceSnapshot()
    expect(after.projects.filter(item => item.id !== project.id)).toEqual(before.projects.filter(item => item.id !== project.id))
    expect(after.threads.filter(item => item.projectId !== project.id)).toEqual(before.threads.filter(item => item.projectId !== project.id))
    expect(after.threads.find(item => item.id === 'already-settled')?.workspaceSettledAt)
      .toBe(before.threads.find(item => item.id === 'already-settled')?.workspaceSettledAt)
    await f.host.snapshot()
    check(f.host.workspaceSnapshot())
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    check(reopened.host.workspaceSnapshot())
  })

  it('leaves a settled folder unchanged when saving its new thread fails', async () => {
    const f = await fixture(); const { project, model } = await local(f)
    await f.host.setWorkspaceSettled('project', project.id, true)
    const before = f.host.workspaceSnapshot()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValue(new Error('Disk unavailable'))
    await expect(f.host.execute({ type: 'create-thread', commandId: 'new-failed', threadId: 'failed', projectId: project.id, modelId: model.id, title: 'New work' })).rejects.toThrow('Disk unavailable')
    expect(f.host.workspaceSnapshot().projects).toEqual(before.projects)
    expect(f.host.workspaceSnapshot().threads).toEqual(before.threads)
    write.mockRestore()
  })

  it.each([false, true])('preserves individual settlement (%s) when restoration overlaps a failed creation', async individuallySettled => {
    const f = await fixture(); const { project, model } = await local(f)
    if (individuallySettled) await f.host.setWorkspaceSettled('thread', 'local', true)
    const original = f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!.workspaceSettledAt
    await f.host.setWorkspaceSettled('project', project.id, true)
    const writing = deferred(); const rejectWrite = deferred()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async () => {
      writing.release(); await rejectWrite.promise; throw new Error('Disk unavailable')
    })
    const creation = f.host.execute({ type: 'create-thread', commandId: 'overlapping-create', threadId: 'new-work', projectId: project.id, modelId: model.id, title: 'New work' })
    await writing.promise
    const restoration = f.host.setWorkspaceSettled('thread', 'local', false)
    const results = Promise.allSettled([creation, restoration])
    // Let restoration reach the shared write or queue behind creation; no elapsed-time assertion.
    await new Promise<void>(resolve => setImmediate(resolve))
    rejectWrite.release()
    const outcomes = await results
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')?.workspaceSettledAt).toBe(original)
    // Restoring an already-unsettled thread is a no-op after creation rolls back.
    expect(outcomes.map(result => result.status)).toEqual(['rejected', individuallySettled ? 'rejected' : 'fulfilled'])
    write.mockRestore()
    const snapshot = await f.host.setWorkspaceSettled('project', project.id, false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(item => item.id === 'local')!, snapshot.projects.find(item => item.id === project.id))).toBe(individuallySettled)
  })

  it('keeps individual settlement across whole-project settlement, events, and restart without stopping work', async () => {
    const f = await fixture(); const { project } = await local(f)
    await local(f, 'other')
    await f.host.execute(send())
    await f.host.setWorkspaceSettled('thread', 'other', true)
    const calls = f.adapters.codex.commands.length
    let snapshot = await f.host.setWorkspaceSettled('project', project.id, true)
    const running = snapshot.threads.find(thread => thread.id === 'local')!
    expect(running.status).toBe('running')
    expect(running.workspaceSettledAt).toBeNull()
    expect(isWorkspaceThreadSettled(running, snapshot.projects.find(item => item.id === project.id))).toBe(true)
    expect(isThreadClosed(running)).toBe(false)
    expect(f.adapters.codex.commands).toHaveLength(calls)
    f.adapters.codex.emit()
    await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    snapshot = reopened.host.workspaceSnapshot()
    expect(snapshot.connected).toBe(false)
    // Messages live in the thread store now; the restored snapshot carries the summary, and the window
    // arrives when a pane says it is looking at the thread.
    expect(snapshot.threads.find(thread => thread.id === 'local')).toMatchObject({ id: 'local', projectId: project.id, status: 'running', nativeSessionStarted: true, messages: [],
      summary: expect.objectContaining({ messageCount: 1, lastUser: expect.objectContaining({ text: 'Implement the task' }) }) })
    reopened.host.observeThreads(['local'])
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.messages).toEqual([expect.objectContaining({ text: 'Implement the task' })])
    snapshot = await reopened.host.setWorkspaceSettled('project', project.id, false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(thread => thread.id === 'local')!, snapshot.projects.find(item => item.id === project.id))).toBe(false)
    expect(isWorkspaceThreadSettled(snapshot.threads.find(thread => thread.id === 'other')!)).toBe(true)
    snapshot = await reopened.host.setWorkspaceSettled('thread', 'other', false)
    expect(snapshot.threads.find(thread => thread.id === 'other')?.workspaceSettledAt).toBeNull()
    expect(reopened.adapters.codex.commands).toHaveLength(0)
    expect(reopened.registry.byThread('local')).toBeUndefined() // provider registry has not even been opened
  })

  it('retains all disconnected provider histories and distinct project IDs across refresh and restart', async () => {
    const f = await fixture(); const snapshot = await f.host.connect()
    const ids = snapshot.projects.map(project => project.id)
    expect(new Set(ids).size).toBe(3)
    f.adapters.grok.state.threads[0]!.messages.push({ id: 'history', role: 'assistant', text: 'Searchable retained result', createdAt: new Date().toISOString() })
    f.adapters.grok.emit(); await f.stop()
    const reopened = await workspaceFixture(f.root); cleanup.push(reopened.stop)
    const retained = await reopened.host.snapshot()
    expect(retained.projects.map(project => project.id)).toEqual(ids)
    expect(retained.threads.map(thread => thread.id)).toEqual(snapshot.threads.map(thread => thread.id))
    const carrying = retained.threads.find(thread => thread.summary?.lastAssistant?.id === 'history')!
    expect(carrying.summary?.lastAssistant?.text).toBe('Searchable retained result')
    reopened.host.observeThreads([carrying.id])
    expect(reopened.host.workspaceSnapshot().threads.find(thread => thread.id === carrying.id)?.messages.map(message => message.text)).toContain('Searchable retained result')
    expect(retained.models).toHaveLength(3)
    expect(retained.models.every(model => !model.ready)).toBe(true)
    expect(retained.threads.every(thread => thread.nativeSessionStarted)).toBe(true)
  })

  it('redacts stored transcripts and requests when local history is disabled, retaining identity and settlement', async () => {
    const f = await fixture(); await local(f); await f.host.execute(send())
    await f.host.setWorkspaceSettled('thread', 'local', true)
    const binding = f.registry.byThread('local')!
    f.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!.requests.push({ id: 'sensitive', kind: 'question', text: 'Private request', options: [] })
    f.adapters.codex.emit(); f.setHistory(false); await f.host.privacyChanged()
    const contents = await readFile(join(f.root, 'workspace.json'), 'utf8')
    expect(contents).not.toContain('Implement the task')
    expect(contents).not.toContain('Private request')
    const saved = JSON.parse(contents).snapshot.threads.find((thread: { id: string }) => thread.id === 'local')
    expect(saved).toMatchObject({ id: 'local', messages: [], requests: [], nativeSessionStarted: true, workspaceSettledAt: expect.any(String) })
  })

  it('strictly validates settlement commands and rejects missing entities', async () => {
    const f = await fixture()
    for (const type of ['settle-thread', 'restore-thread', 'settle-project', 'restore-project']) {
      const field = type.endsWith('project') ? 'projectId' : 'threadId'
      expect(agentCommandSchema.parse({ type, [field]: 'identity' })).toEqual({ type, [field]: 'identity' })
      expect(agentCommandSchema.safeParse({ type, [field]: 'identity', delete: true }).success).toBe(false)
    }
    await expect(f.host.setWorkspaceSettled('thread', 'missing', true)).rejects.toThrow('unavailable')
    await expect(f.host.setWorkspaceSettled('project', 'missing', true)).rejects.toThrow('unavailable')
  })
})
