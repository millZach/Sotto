// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { antigravityFixture } from '../fixtures/fakeAntigravityFixture'

describe('live child steps end-to-end across Antigravity, Claude Code, and Codex', () => {
  it('streams Antigravity child transcript steps live into SubagentStore and preserves them through completion', async () => {
    const f = await antigravityFixture()
    const workspace = new WorkspaceHost(f.host, f.root, { historyEnabled: () => true })
    try {
      await workspace.connect()
      await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Agy', path: f.root })
      const threadId = randomUUID()
      await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Agy live steps' })
      f.host.observeThreads?.([threadId])
      await workspace.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'm1', text: 'Run child' })
      await f.action(threadId, { type: 'subagent', role: 'Transcript Auditor', prompt: 'Check brain transcript.' })

      const parent = await f.realId(threadId)
      const appData = join(f.root, 'antigravity', 'gemini', 'antigravity-acp')
      await expect.poll(async () => (await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents')).catch(() => [])).length).toBe(1)
      const childId = (await readdir(join(appData, 'brain', parent, '.system_generated', 'subagents')))[0]!.replace(/\.json$/u, '')
      const logsDir = join(appData, 'brain', childId, '.system_generated', 'logs')
      await mkdir(logsDir, { recursive: true })
      const transcript = join(logsDir, 'transcript.jsonl')
      await writeFile(transcript, JSON.stringify({
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T12:00:01.000Z',
        model: 'gemini-4-neon-high',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      }) + '\n')

      const page = async () => { await workspace.snapshot(); return workspace.subagentPage({ threadId }) }
      await expect.poll(async () => (await page()).rows[0]?.currentStep?.detail, { timeout: 10_000 }).toBe('npm test')
      const runningRow = (await page()).rows[0]!
      expect(runningRow).toMatchObject({ status: 'running', model: 'gemini-4-neon-high', stepCount: 1 })
      expect(runningRow.currentStep).toMatchObject({ kind: 'command', title: 'Run', detail: 'npm test', status: 'running', mono: true })

      await appendFile(transcript, JSON.stringify({
        step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T12:00:03.000Z', content: 'ok',
      }) + '\n')
      await f.action(threadId, { type: 'subagent-answer', text: 'ALL_GOOD' })

      await expect.poll(async () => (await page()).rows[0]?.status, { timeout: 10_000 }).toBe('completed')
      const finishedRow = (await page()).rows[0]!
      expect(finishedRow.currentStep).toBeUndefined()
      expect(finishedRow.stepCount).toBe(1)
      const detail = await workspace.subagentAssignments({ threadId, agentId: finishedRow.id })
      expect(detail.assignments[0]).toMatchObject({
        status: 'completed',
        result: 'ALL_GOOD',
        stepCount: 1,
        steps: [expect.objectContaining({ kind: 'command', title: 'Run', detail: 'npm test', status: 'completed', durationMs: 2000 })],
      })
    } finally {
      workspace.disconnect(); workspace.dispose()
      await f.cleanup()
    }
  })

  it('tails Claude Code background subagent transcript steps live into SubagentStore', async () => {
    const f = await claudeFixture(undefined, 15_000)
    const workspace = new WorkspaceHost(f.host, f.root, { historyEnabled: () => true })
    try {
      await workspace.connect()
      await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'project', title: 'Claude', path: f.root })
      await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId: 'thread', projectId: 'project', title: 'Claude steps', modelId: f.modelId })
      await workspace.execute({ type: 'send', commandId: randomUUID(), threadId: 'thread', messageId: 'user', text: 'Run background agent' })
      await f.action('thread', {
        type: 'subagent',
        toolId: 'launch-bg',
        taskId: 'a9911bb22',
        description: 'Inspect subagent files',
        model: 'claude-sonnet-5',
        transcriptLines: [
          { type: 'assistant', message: { id: 'm-bg-1', model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-read-1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-read-1', content: 'ok' }] } },
          { type: 'assistant', message: { id: 'm-bg-2', model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-bash-2', name: 'Bash', input: { command: 'npx vitest run' } }] } },
        ],
      })

      const page = async () => { await workspace.snapshot(); return workspace.subagentPage({ threadId: 'thread' }) }
      await expect.poll(async () => (await page()).rows[0]?.stepCount, { timeout: 10_000 }).toBe(2)
      const row = (await page()).rows[0]!
      expect(row).toMatchObject({ status: 'running', model: 'claude-sonnet-5', stepCount: 2 })
      expect(row.currentStep).toMatchObject({ kind: 'command', title: 'Run', detail: 'npx vitest run', status: 'running', mono: true })

      const detail = await workspace.subagentAssignments({ threadId: 'thread', agentId: row.id })
      expect(detail.assignments[0]?.steps).toEqual([
        expect.objectContaining({ id: 'claude-step-tu-read-1', kind: 'read', title: 'Read', status: 'completed' }),
        expect.objectContaining({ id: 'claude-step-tu-bash-2', kind: 'command', title: 'Run', detail: 'npx vitest run', status: 'running' }),
      ])
    } finally {
      workspace.disconnect(); workspace.dispose()
      await f.cleanup()
    }
  })

  it('streams Codex child notifications as live child steps and settles them on child turn completion', async () => {
    const f = await codexFixture(undefined, false, 15_000)
    const workspace = new WorkspaceHost(f.host, f.root, { historyEnabled: () => true })
    try {
      await workspace.connect()
      await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Codex', path: f.root })
      const threadId = randomUUID()
      await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, modelId: f.modelId, title: 'Codex steps' })
      await workspace.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'u1', text: 'Delegate work' })
      const childNative = `child-${randomUUID()}`
      await f.carriedOut(await f.action(threadId, { type: 'background-agent', childId: childNative, description: 'audit_worker', text: 'Started child.' }))

      await f.carriedOut(await f.action(threadId, {
        type: 'notify',
        method: 'item/started',
        params: {
          threadId: childNative,
          turnId: 'ct-1',
          startedAtMs: 20_000,
          item: { id: 'cmd-1', type: 'commandExecution', command: "bash -lc 'npm run lint'", status: 'inProgress' },
        },
      }))

      const page = async () => { await workspace.snapshot(); return workspace.subagentPage({ threadId }) }
      await expect.poll(async () => (await page()).rows[0]?.currentStep?.detail, { timeout: 10_000 }).toBe('npm run lint')
      const runningRow = (await page()).rows[0]!
      expect(runningRow).toMatchObject({ title: 'audit_worker', status: 'running', stepCount: 1 })
      expect(runningRow.currentStep).toMatchObject({ kind: 'command', title: 'Run', detail: 'npm run lint', status: 'running', mono: true })

      await f.carriedOut(await f.action(threadId, {
        type: 'notify',
        method: 'item/completed',
        params: {
          threadId: childNative,
          turnId: 'ct-1',
          completedAtMs: 21_500,
          item: { id: 'cmd-1', type: 'commandExecution', command: "bash -lc 'npm run lint'", status: 'completed', exitCode: 0, durationMs: 1500 },
        },
      }))
      await f.carriedOut(await f.action(threadId, { type: 'background-agent-end', status: 'completed' }))

      await expect.poll(async () => (await page()).rows[0]?.status, { timeout: 10_000 }).toBe('completed')
      const doneRow = (await page()).rows[0]!
      expect(doneRow.currentStep).toBeUndefined()
      const detail = await workspace.subagentAssignments({ threadId, agentId: doneRow.id })
      expect(detail.assignments[0]?.steps).toEqual([
        expect.objectContaining({ kind: 'command', title: 'Run', detail: 'npm run lint', status: 'completed', durationMs: 1500 }),
      ])
    } finally {
      workspace.disconnect(); workspace.dispose()
      await f.cleanup()
    }
  })
})
