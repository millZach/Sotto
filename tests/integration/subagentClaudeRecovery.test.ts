// @vitest-environment node
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { MAX_AGENT_ACTIVITIES } from '../../src/shared/agentActivity'
import { claudeFixture } from '../fixtures/claudeFixture'

it.each([{ evicted: false, privacy: false }, { evicted: true, privacy: false }, { evicted: true, privacy: true }])('finishes and reuses a Claude subagent after restart with eviction=$evicted privacy=$privacy', async ({ evicted, privacy }) => {
  let historyEnabled = true
  let fixture = await claudeFixture(undefined, 15_000)
  let workspace = new WorkspaceHost(fixture.host, fixture.root, () => historyEnabled)
  const root = fixture.root
  try {
    await workspace.connect()
    await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Recovery', path: root })
    await workspace.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', title: 'Recovery', modelId: fixture.modelId })
    await workspace.execute({ type: 'send', commandId: 'send', threadId: 'thread', messageId: 'user', text: 'Original cursor anchor' })
    const session = await fixture.realId('thread')
    const path = join(root, 'home', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'), `${session}.jsonl`)
    const append = async (frames: Record<string, unknown>[]) => {
      await appendFile(path, frames.map(frame => JSON.stringify({ ...frame, sessionId: session, timestamp: new Date().toISOString() })).join('\n') + '\n')
      await fixture.adapter.pollSessionLogs()
      await workspace.snapshot()
    }
    await append([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { description: 'Private task title', prompt: 'PRIVATE_TASK_PROMPT' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'retained', tool_use_id: 'launch', task_type: 'local_agent', description: 'Private task title' },
      { type: 'user', tool_use_result: { agentId: 'native-agent', isAsync: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Agent launched' }] } },
      { type: 'system', subtype: 'task_started', task_id: 'reassigned', task_type: 'local_agent', description: 'Earlier task' },
      { type: 'system', subtype: 'task_notification', task_id: 'reassigned', status: 'completed', summary: 'PRIVATE_EARLIER_RESULT' },
      { type: 'system', subtype: 'task_started', task_id: 'reassigned', task_type: 'monitor', description: 'Monitor after agent' },
    ])
    const initial = (await workspace.subagentPage({ threadId: 'thread' })).rows
    expect(initial).toHaveLength(2)
    const active = initial.find(row => row.id === 'claude-agent-launch')!
    const completed = initial.find(row => row.id !== active.id)!
    expect(completed.status).toBe('completed')
    const retainedCount = privacy ? 1 : 2
    if (evicted) {
      await append([{ type: 'assistant', message: { content: Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => ({ type: 'tool_use', id: `ordinary-${index}`, name: 'Read', input: {} })) } }])
      expect(workspace.workspaceSnapshot().threads[0]!.activities!.every(row => !row.agents?.length)).toBe(true)
    }
    if (privacy) {
      historyEnabled = false; await workspace.privacyChanged()
      historyEnabled = true; await workspace.privacyChanged()
      expect((await workspace.subagentPage({ threadId: 'thread' })).rows).toHaveLength(1)
    }
    workspace.disconnect()
    await fixture.adapter.closed()
    await workspace.privacyChanged()
    workspace.dispose()
    const saved = await readFile(join(root, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('PRIVATE_TASK_PROMPT')
    expect(saved).not.toContain('PRIVATE_EARLIER_RESULT')
    expect(saved).not.toContain('Private task title')
    const cursor = JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8')).thread.transcriptCursor
    expect(cursor.offset).toBe((await readFile(path)).byteLength)
    if (!privacy) await writeFile(path, (await readFile(path, 'utf8')).replace('Original cursor anchor', 'Tampered cursor anchor'))
    expect((await readFile(path)).byteLength).toBe(cursor.offset)

    fixture = await claudeFixture(root, 15_000)
    workspace = new WorkspaceHost(fixture.host, root, () => historyEnabled)
    await workspace.connect()
    await fixture.adapter.refreshThread('thread')
    const restored = (await workspace.subagentPage({ threadId: 'thread' })).rows
    expect(restored.find(row => row.id === active.id)?.status).toBe('unknown')
    expect(workspace.threadMessages('thread').some(message => message.text.includes('Tampered'))).toBe(false)
    expect(workspace.workspaceSnapshot().threads[0]!.monitoring ?? []).toEqual([])
    expect(workspace.workspaceSnapshot().threads[0]!.backgroundWork ?? []).toEqual([])
    const live = async (frame: Record<string, unknown>, expected: () => Promise<boolean>) => {
      await fixture.action('thread', { type: 'raw', frame })
      await expect.poll(expected).toBe(true)
    }
    await live({ type: 'system', subtype: 'task_notification', task_id: 'retained', status: 'completed', summary: 'Fresh completion after restart' }, async () => (await workspace.subagentPage({ threadId: 'thread' })).rows.find(row => row.id === active.id)?.status === 'completed')
    const assignments = await workspace.subagentAssignments({ threadId: 'thread', agentId: active.id })
    expect(assignments.assignments).toHaveLength(1)
    expect(assignments.assignments[0]).toMatchObject({ id: active.assignmentId, status: 'completed' })
    expect(assignments.assignments[0]?.prompt).toBe(privacy ? undefined : 'PRIVATE_TASK_PROMPT')
    expect(assignments.assignments[0]?.result).toBe(privacy ? undefined : 'Fresh completion after restart')
    // A delayed monitor result must not overwrite the earlier real agent outcome.
    await fixture.action('thread', { type: 'raw-burst', frames: [
      { type: 'system', subtype: 'task_notification', task_id: 'reassigned', status: 'failed', summary: 'Monitor outcome must stay hidden' },
      { type: 'assistant', message: { id: 'barrier', content: [{ type: 'text', text: 'Recovery barrier' }] } },
    ] })
    await expect.poll(() => workspace.workspaceSnapshot().threads[0]!.messages.some(message => message.text === 'Recovery barrier')).toBe(true)
    const after = await workspace.subagentPage({ threadId: 'thread' })
    expect(after.rows).toHaveLength(retainedCount)
    expect(after.rows.find(row => row.id === completed.id)?.status).toBe(privacy ? undefined : 'completed')
    expect(JSON.stringify(await workspace.subagentAssignments({ threadId: 'thread', agentId: completed.id }))).not.toContain('Monitor outcome')
    // Real streamed resume arrives as an empty tool start, then its parsed input. Neither restart nor
    // the early empty block may mint a second roster identity for the same native agent.
    await fixture.action('thread', { type: 'raw-burst', frames: [
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'resumed', name: 'Agent', input: {} } } },
      { type: 'assistant', message: { id: 'empty-barrier', content: [{ type: 'text', text: 'Empty input observed' }] } },
    ] })
    await expect.poll(() => workspace.workspaceSnapshot().threads[0]!.messages.some(message => message.text === 'Empty input observed')).toBe(true)
    expect((await workspace.subagentPage({ threadId: 'thread' })).rows).toHaveLength(retainedCount)
    await fixture.action('thread', { type: 'raw-burst', frames: [
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ resume: 'native-agent', prompt: 'Check the revision' }) } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    ] })
    await expect.poll(async () => (await workspace.subagentPage({ threadId: 'thread' })).rows.find(row => row.id === active.id)?.assignmentCount).toBe(2)
    expect((await workspace.subagentPage({ threadId: 'thread' })).rows).toHaveLength(retainedCount)
    const history = await workspace.subagentAssignments({ threadId: 'thread', agentId: active.id })
    expect(history.assignments[0]).toMatchObject({ id: 'claude-tool-resumed', prompt: 'Check the revision', status: 'running' })
    expect(history.assignments[1]).toMatchObject({ id: active.assignmentId, status: 'completed' })
    expect(history.assignments[1]?.result).toBe(privacy ? undefined : 'Fresh completion after restart')
  } finally {
    workspace.disconnect()
    await fixture.adapter.closed()
    await workspace.privacyChanged()
    workspace.dispose()
    await fixture.cleanup()
  }
})
