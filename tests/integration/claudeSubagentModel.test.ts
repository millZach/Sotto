// @vitest-environment node
import { expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { claudeFixture } from '../fixtures/claudeFixture'

// Claude Code runs a workflow's agents, and a background agent that never streams a sidechain reply,
// as their own sessions. The roster learns their model from the transcript each one writes.
it.each([
  { kind: 'workflow', action: { toolId: 'flow', taskId: 'wmiwtbf0l', runId: 'wf_79f40664-5f1', agentId: 'a2df61422ce4434b7', description: 'Write the spec', model: 'claude-opus-5-5' } },
  { kind: 'background agent', action: { toolId: 'launch', taskId: 'a3a0e66ba6fe555ae', description: 'Review tests', model: 'claude-opus-5-5' } },
])('shows the model a Claude $kind ran on from its own transcript, on the row it already has', async ({ action }) => {
  const fixture = await claudeFixture(undefined, 15_000)
  const workspace = new WorkspaceHost(fixture.host, fixture.root, () => true)
  try {
    await workspace.connect()
    await workspace.execute({ type: 'create-project', commandId: 'project', projectId: 'project', title: 'Models', path: fixture.root })
    await workspace.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: 'project', title: 'Models', modelId: fixture.modelId })
    await workspace.execute({ type: 'send', commandId: 'send', threadId: 'thread', messageId: 'user', text: 'Run the agents' })
    await fixture.action('thread', { type: 'subagent', ...action })
    const row = async () => { await workspace.snapshot(); return (await workspace.subagentPage({ threadId: 'thread' })).rows }
    await expect.poll(async () => (await row()).map(entry => entry.model)).toEqual(['claude-opus-5-5'])
    const [agent] = await row()
    expect(agent).toMatchObject({ title: action.description, status: 'running', assignmentCount: 1 })
    const saved = JSON.stringify(workspace.workspaceSnapshot())
    expect(saved).not.toContain('Fixture subagent task')
    expect(saved).not.toContain('Fixture subagent reply')
  } finally {
    workspace.disconnect(); workspace.dispose()
    await fixture.cleanup()
  }
})
