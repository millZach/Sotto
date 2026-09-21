// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { AgentActivity } from '../../../src/shared/agentActivity'

it.each(['json', 'sqlite'])('migrates retained child tasks from %s into only the agent roster', async source => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-agent-migration-'))
  const native = new FakeProviderHost()
  const thread = native.state.threads[0]!
  const records: AgentActivity[] = [{ id: 'spawn', turnId: 'turn', sequence: 0, kind: 'subagent', status: 'completed', title: 'Private task title', agents: [{ id: 'child', assignmentId: 'task', status: 'completed', title: 'Private task title', prompt: 'Private migration task', message: 'Private migration result' }] }]
  if (source === 'json') thread.activities = records
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ snapshot: native.state, creations: [], projectAliases: [] }))
  if (source === 'sqlite') { const store = new ThreadStore(join(directory, 'threads.sqlite')); store.open(); store.syncActivities(thread.id, records); store.close() }
  let host = new WorkspaceHost(new FakeProviderHost(), directory)
  try {
    await host.initialize()
    const assignments = await host.subagentAssignments({ threadId: thread.id, agentId: 'child' })
    expect(assignments.assignments[0]).toMatchObject({ prompt: 'Private migration task', result: 'Private migration result' })
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain('Private migration')
    const db = new DatabaseSync(join(directory, 'threads.sqlite'), { readOnly: true })
    try { expect(JSON.stringify(db.prepare('SELECT payload FROM activities').all())).not.toContain('Private') } finally { db.close() }
    host.dispose()
    host = new WorkspaceHost(new FakeProviderHost(), directory)
    await host.initialize()
    expect((await host.subagentAssignments({ threadId: thread.id, agentId: 'child' })).assignments).toEqual(assignments.assignments)
  } finally { host.dispose(); await rm(directory, { recursive: true, force: true }) }
})