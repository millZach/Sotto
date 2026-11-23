// @vitest-environment node
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SUBAGENT_STEPS, type AgentActivity, type ObservedAgent, type SubagentStep } from '../../../src/shared/agentActivity'
import { CutBodies, detailWithoutAgentSteps } from '../../../src/shared/activityBodies'
import { detailWithActivitySummaries } from '../../../src/shared/hostProtocol'
import { subagentAssignmentsPageSchema, subagentChangeSchema, subagentPageSchema } from '../../../src/shared/subagents'
import { antigravityActivities } from '../../../src/main/agents/antigravityActivity'
import { antigravityChildReading, readAntigravityChild } from '../../../src/main/agents/antigravityChildren'
import { ClaudeActivity } from '../../../src/main/agents/providers/claude/claudeActivity'
import { ClaudeSubagentTranscripts, MAX_SUBAGENT_TRANSCRIPTS } from '../../../src/main/agents/providers/claude/claudeSubagentModels'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/providers/codex/codexActivity'
import { validIso } from '../../../src/main/agents/subagentSteps'
import { SubagentStore } from '../../../src/main/agents/subagentStore'
import { WindowActivityBodies } from '../../../src/main/agents/windowActivityBodies'

const dirs: string[] = []
const stores: SubagentStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('live child steps — Antigravity', () => {
  const PARENT = 'b6a16745-4f3f-4712-8084-bba4df9c5ae0'
  const CHILD = 'ce42f6a1-2bb2-4038-8815-5bc19a14894a'
  const CALL = 'call_live_steps_1'

  it('recognises all Antigravity subagent spawn titles and bare tool names without matching MCP calls', () => {
    for (const [title, name] of [
      ['Run start_subagent', undefined],
      ['Running start_subagent', undefined],
      ['Run start_subagent?', undefined],
      ['start_subagent', undefined],
      ['Run invoke_subagent', undefined],
      ['invoke_subagent', undefined],
      ['Custom title', 'invoke_subagent'],
      ['Custom title', 'start_subagent'],
    ] as const) {
      const [row] = antigravityActivities(
        {
          sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind: 'other', title, ...(name ? { name } : {}),
          status: 'completed', rawInput: { role: 'Spec Auditor', prompt: 'Inspect files', model: 'inherit' },
        },
        { turnId: 't1', cwd: '/repo', key: 'k1' },
      )
      expect(row?.kind, `${title}/${name}`).toBe('subagent')
      expect(row?.agents?.[0], `${title}/${name}`).toMatchObject({ title: 'Spec Auditor', prompt: 'Inspect files', status: 'running' })
      expect(row?.agents?.[0]?.model).toBeUndefined()
    }

    const [mcpRow] = antigravityActivities(
      {
        sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'other', title: 'Run invoke_subagent', name: 'invoke_subagent',
        status: 'in_progress', _meta: { is_mcp_tool_call: true },
      },
      { turnId: 't1', cwd: '/repo', key: 'k2' },
    )
    expect(mcpRow?.kind).toBe('tool')
    expect(mcpRow?.agents).toBeUndefined()
  })

  it('incrementally tails child transcript steps and resolved model across passes and handles partial lines', async () => {
    const appData = await tempDir('sotto-agy-steps-')
    const generated = (conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)
    const putJson = async (path: string, value: unknown) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

    await putJson(generated(PARENT, 'subagents', `${CHILD}.json`), { conversationId: CHILD, state: 'SUBAGENT_STATE_ALIVE' })
    await putJson(generated(CHILD, 'messages', 'launch.json'), {
      id: 'launch', recipient: CHILD, sender: PARENT, content: 'Audit steps', timestamp: '2026-11-22T10:00:00.000Z',
      sourceMetadata: { tool: { conversationId: PARENT, stepIndex: 1, toolCall: { id: CALL, name: 'invoke_subagent' } } },
    })

    const logsDir = generated(CHILD, 'logs')
    await mkdir(logsDir, { recursive: true })
    const transcript = join(logsDir, 'transcript.jsonl')
    const line1 = JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:01.000Z',
      model: 'gemini-4-neon-high',
      tool_calls: [
        { name: 'read_file', args: { Path: '/workspace/project/src/main/agents/antigravityChildren.ts' } },
        { name: 'run_command', args: { CommandLine: 'npx vitest run tests/unit/main/antigravityChildren.test.ts' } },
      ],
    }) + '\n'
    const line2 = JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T10:00:01.500Z', content: 'ok' }) + '\n'
    const line3 = JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'ERROR', created_at: '2026-11-22T10:00:04.000Z', error: 'Assertion failed in antigravityChildren.test.ts' }) + '\n'

    // Write first line + half of second line.
    await writeFile(transcript, line1 + line2.slice(0, 25))
    const reading = antigravityChildReading()
    const first = await readAntigravityChild(appData, PARENT, CALL, reading)
    expect(first?.status).toBe('running')
    expect(first?.model).toBe('gemini-4-neon-high')
    expect(first?.steps).toHaveLength(2)
    expect(first?.steps?.[0]).toMatchObject({ kind: 'read', title: 'Read', status: 'running', mono: true })
    expect(first?.steps?.[0]?.detail).toContain('antigravityChildren.ts')
    expect(first?.steps?.[1]).toMatchObject({ kind: 'command', title: 'Run', status: 'running', mono: true, detail: 'npx vitest run tests/unit/main/antigravityChildren.test.ts' })

    // Append remainder of line2 and full line3.
    await appendFile(transcript, line2.slice(25) + line3)
    const second = await readAntigravityChild(appData, PARENT, CALL, reading)
    expect(second?.steps?.[0]).toMatchObject({ status: 'completed', durationMs: 500 })
    expect(second?.steps?.[1]).toMatchObject({ status: 'failed', durationMs: 3000, error: 'Assertion failed in antigravityChildren.test.ts' })
    expect(second?.stepsTotal).toBe(2)

    // Final answer arrives in parent inbox; transcript steps stay attached.
    await putJson(generated(PARENT, 'messages', 'done.json'), {
      id: 'done', recipient: PARENT, sender: CHILD, content: 'Audit complete.', timestamp: '2026-11-22T10:00:05.000Z',
    })
    const final = await readAntigravityChild(appData, PARENT, CALL, reading)
    expect(final).toMatchObject({ status: 'completed', message: 'Audit complete.', model: 'gemini-4-neon-high', stepsTotal: 2 })
    expect(final?.steps).toHaveLength(2)
  })

  it('refuses symlinked logs directory and symlinked transcript.jsonl pointing outside brain', async () => {
    const appData = await tempDir('sotto-agy-sec-')
    const outside = await tempDir('sotto-agy-outside-')
    const generated = (conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)
    const putJson = async (path: string, value: unknown) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

    await putJson(generated(PARENT, 'subagents', `${CHILD}.json`), { conversationId: CHILD, state: 'SUBAGENT_STATE_ALIVE' })
    await putJson(generated(CHILD, 'messages', 'launch.json'), {
      id: 'launch', recipient: CHILD, sender: PARENT, content: 'Secret', timestamp: '2026-11-22T10:00:00.000Z',
      sourceMetadata: { tool: { toolCall: { id: CALL } } },
    })

    const secretTranscript = join(outside, 'transcript.jsonl')
    await writeFile(secretTranscript, JSON.stringify({
      step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', model: 'secret-model',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'SECRET_OUTSIDE_COMMAND' } }],
    }) + '\n')

    // Case 1: symlinked logs directory.
    await symlink(outside, generated(CHILD, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')
    const res1 = await readAntigravityChild(appData, PARENT, CALL, antigravityChildReading())
    expect(res1).toEqual({ conversationId: CHILD, status: 'running' })

    // Case 2: real logs directory containing symlinked transcript.jsonl.
    await rm(generated(CHILD, 'logs'), { recursive: true, force: true })
    await mkdir(generated(CHILD, 'logs'), { recursive: true })
    await symlink(secretTranscript, generated(CHILD, 'logs', 'transcript.jsonl'))
    const res2 = await readAntigravityChild(appData, PARENT, CALL, antigravityChildReading())
    expect(res2).toEqual({ conversationId: CHILD, status: 'running' })
  })

  it('holds back partial head chunks on >256 KiB transcripts until EOF so reconnect replays never inflate or reorder steps', async () => {
    const appData = await tempDir('sotto-agy-large-')
    const generated = (conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)
    const putJson = async (path: string, value: unknown) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

    await putJson(generated(PARENT, 'subagents', `${CHILD}.json`), { conversationId: CHILD, state: 'SUBAGENT_STATE_ALIVE' })
    await putJson(generated(CHILD, 'messages', 'launch.json'), {
      id: 'launch', recipient: CHILD, sender: PARENT, content: 'Big audit', timestamp: '2026-11-22T10:00:00.000Z',
      sourceMetadata: { tool: { toolCall: { id: CALL } } },
    })

    const logsDir = generated(CHILD, 'logs')
    await mkdir(logsDir, { recursive: true })
    const transcript = join(logsDir, 'transcript.jsonl')
    // Write 240 steps totalling > 300 KiB (more than one 256 KiB poll chunk).
    const padding = 'x'.repeat(1200)
    const lines: string[] = []
    for (let i = 0; i < 240; i++) {
      lines.push(JSON.stringify({
        step_index: i + 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:01.000Z',
        model: 'gemini-4-neon-high',
        tool_calls: [{ name: 'read_file', args: { Path: `/repo/src/file-${i}.ts`, pad: padding } }],
      }))
    }
    await writeFile(transcript, lines.join('\n') + '\n')

    const reading = antigravityChildReading()
    const pass1 = await readAntigravityChild(appData, PARENT, CALL, reading)
    // First pass has not reached EOF yet -> steps held back rather than publishing old head steps.
    expect(pass1?.status).toBe('running')
    expect(pass1?.steps).toBeUndefined()

    const pass2 = await readAntigravityChild(appData, PARENT, CALL, reading)
    expect(pass2?.status).toBe('running')
    expect(pass2?.stepsTotal).toBe(240)
    expect(pass2?.steps).toHaveLength(MAX_SUBAGENT_STEPS)
    expect(pass2?.steps?.[0]?.detail).toContain('file-40.ts')
    expect(pass2?.steps?.at(-1)?.detail).toContain('file-239.ts')
  })
})

describe('live child steps — Claude Code', () => {
  it('captures live steps for foreground sidechain subagents via parent_tool_use_id', () => {
    const activity = new ClaudeActivity()
    let rows: AgentActivity[] = []
    rows = activity.apply(rows, {
      type: 'assistant', timestamp: '2026-11-22T10:00:00.000Z',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { description: 'Audit parser', prompt: 'Inspect parser.ts' } }] },
    }, 'turn-1', 'u1', '/repo', true)
    rows = activity.apply(rows, {
      type: 'assistant', parent_tool_use_id: 'spawn-1', timestamp: '2026-11-22T10:00:01.000Z',
      message: { id: 'm2', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'child-t1', name: 'Bash', input: { command: 'npm test' } }] },
    }, 'turn-1', 'u1', '/repo', true)

    const parentRow = rows.find(row => row.id === 'claude-tool-spawn-1')
    expect(parentRow?.agents?.[0]?.steps).toEqual([
      expect.objectContaining({ id: 'claude-step-child-t1', kind: 'command', title: 'Run', detail: 'npm test', status: 'running', mono: true }),
    ])

    rows = activity.apply(rows, {
      type: 'user', parent_tool_use_id: 'spawn-1', timestamp: '2026-11-22T10:00:03.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child-t1', is_error: true, content: 'Exit 1: test failed' }] },
    }, 'turn-1', 'u1', '/repo', true)

    const updatedParent = rows.find(row => row.id === 'claude-tool-spawn-1')
    expect(updatedParent?.agents?.[0]?.steps).toEqual([
      expect.objectContaining({ id: 'claude-step-child-t1', status: 'failed', error: 'Exit 1: test failed', durationMs: 2000 }),
    ])
  })

  it('tails background and workflow subagent transcripts incrementally and refuses symlinks outside subagents', async () => {
    const root = await tempDir('sotto-claude-steps-')
    const outside = await tempDir('sotto-claude-outside-')
    const sessionFolder = join(root, 'session-1')
    const subagentsDir = join(sessionFolder, 'subagents')
    await mkdir(subagentsDir, { recursive: true })

    const file = join(subagentsDir, 'agent-bg123.jsonl')
    const line1 = JSON.stringify({
      type: 'assistant', timestamp: '2026-11-22T10:00:01.000Z',
      message: { id: 'a1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] },
    }) + '\n'
    const line2 = JSON.stringify({
      type: 'user', timestamp: '2026-11-22T10:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'contents' }] },
    }) + '\n'
    await writeFile(file, line1)

    // Symlink escape attempt
    const secretFile = join(outside, 'secret.jsonl')
    await writeFile(secretFile, line1)
    await symlink(secretFile, join(subagentsDir, 'agent-evil.jsonl'))

    const reader = new ClaudeSubagentTranscripts()
    const first = await reader.read(sessionFolder, [
      { id: 'claude-agent-bg', transcript: { agentId: 'bg123' }, settled: false, needsModel: true },
      { id: 'claude-agent-evil', transcript: { agentId: 'evil' }, settled: false, needsModel: true },
    ])
    expect(first.has('claude-agent-evil')).toBe(false)
    expect(first.get('claude-agent-bg')).toMatchObject({
      model: 'claude-opus-5-5',
      stepsTotal: 1,
      steps: [expect.objectContaining({ id: 'claude-step-tu1', kind: 'read', title: 'Read', status: 'running', mono: true })],
    })

    // Next poll appends tool_result
    await appendFile(file, line2)
    const second = await reader.read(sessionFolder, [
      { id: 'claude-agent-bg', transcript: { agentId: 'bg123' }, settled: false, needsModel: false },
    ])
    expect(second.get('claude-agent-bg')).toMatchObject({
      stepsTotal: 1,
      steps: [expect.objectContaining({ id: 'claude-step-tu1', status: 'completed', durationMs: 1000 })],
    })
  })

  it('publishes out-of-order parallel tool_result updates, resets steps on resumed assignments, and rotates >16 concurrent transcripts', async () => {
    const root = await tempDir('sotto-claude-edge-')
    const sessionFolder = join(root, 'session-1')
    const subagentsDir = join(sessionFolder, 'subagents')
    await mkdir(subagentsDir, { recursive: true })

    // 1. Out-of-order parallel tool results (earlier tool finishes/fails while later tool stays running)
    const parallelFile = join(subagentsDir, 'agent-par1.jsonl')
    await writeFile(parallelFile, JSON.stringify({
      type: 'assistant', timestamp: '2026-11-22T10:00:01.000Z',
      message: {
        id: 'a1', model: 'claude-sonnet-5',
        content: [
          { type: 'tool_use', id: 'tuA', name: 'Read', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 'tuB', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }) + '\n')

    const reader = new ClaudeSubagentTranscripts()
    const target1 = { id: 'claude-agent-1', assignmentId: 'claude-tool-run1', transcript: { agentId: 'par1' }, settled: false, needsModel: true }
    const p1 = await reader.read(sessionFolder, [target1])
    expect(p1.get('claude-agent-1')?.steps?.map(s => `${s.id}:${s.status}`)).toEqual(['claude-step-tuA:running', 'claude-step-tuB:running'])

    await appendFile(parallelFile, JSON.stringify({
      type: 'user', timestamp: '2026-11-22T10:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tuA', is_error: true, content: 'ENOENT' }] },
    }) + '\n')
    const p2 = await reader.read(sessionFolder, [{ ...target1, needsModel: false }])
    expect(p2.get('claude-agent-1')?.steps?.map(s => `${s.id}:${s.status}`)).toEqual(['claude-step-tuA:failed', 'claude-step-tuB:running'])
    expect(p2.get('claude-agent-1')?.steps?.[0]?.error).toBe('ENOENT')

    // 2. Abandon after settling, then resume under a new assignmentId on the same transcript file
    for (let i = 0; i < 4; i++) {
      await reader.read(sessionFolder, [{ ...target1, settled: true, needsModel: false }])
    }
    await appendFile(parallelFile, JSON.stringify({
      type: 'assistant', timestamp: '2026-11-22T10:01:00.000Z',
      message: { id: 'a2', content: [{ type: 'tool_use', id: 'tuC', name: 'Grep', input: { pattern: 'TODO' } }] },
    }) + '\n')
    const resumed = await reader.read(sessionFolder, [
      { id: 'claude-agent-1', assignmentId: 'claude-tool-run2', transcript: { agentId: 'par1' }, settled: false, needsModel: false },
    ])
    expect(resumed.get('claude-agent-1')).toMatchObject({
      stepsTotal: 1,
      steps: [expect.objectContaining({ id: 'claude-step-tuC', kind: 'search', status: 'running' })],
    })

    // 3. Rotation across > MAX_SUBAGENT_TRANSCRIPTS running agents so older targets are never starved
    const total = MAX_SUBAGENT_TRANSCRIPTS + 4
    const manyTargets = []
    for (let i = 0; i < total; i++) {
      const aid = `rot${i}`
      await writeFile(join(subagentsDir, `agent-${aid}.jsonl`), JSON.stringify({
        type: 'assistant', timestamp: '2026-11-22T10:02:00.000Z',
        message: { id: `m-${i}`, content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Read', input: { file_path: `/repo/f${i}.ts` } }] },
      }) + '\n')
      manyTargets.push({ id: `agent-${i}`, assignmentId: `run-${i}`, transcript: { agentId: aid }, settled: false, needsModel: false })
    }
    const rotReader = new ClaudeSubagentTranscripts()
    const seen = new Set<string>()
    for (const id of (await rotReader.read(sessionFolder, manyTargets)).keys()) seen.add(id)
    expect(seen.size).toBe(MAX_SUBAGENT_TRANSCRIPTS)
    for (const id of (await rotReader.read(sessionFolder, manyTargets)).keys()) seen.add(id)
    expect(seen.size).toBe(total)
  })
})

describe('live child steps — Codex', () => {
  it('captures live child command, file change, reasoning delta, plan, and settles steps on turn completion', () => {
    let now = 10_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'thread-1', messages: [], activities: [] as AgentActivity[] }

    projection.item(thread, codexItemSchema.parse({
      id: 'spawn-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/check_tests', model: 'gpt-5.4-codex',
    }), { turnId: 'turn-1', phase: 'completed' })

    now = 11_000
    expect(projection.childNotification('child-1', 'turn/started', { turn: { id: 'ct-1', status: 'inProgress' } })).toBe(thread)

    // Command started -> completed
    now = 12_000
    expect(projection.childNotification('child-1', 'item/started', {
      turnId: 'ct-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: "bash -lc 'npm test'", status: 'inProgress' },
      startedAtMs: 12_000,
    })).toBe(thread)
    let agent = thread.activities.find(row => row.kind === 'subagent')?.agents?.[0]
    expect(agent?.steps).toEqual([
      expect.objectContaining({ kind: 'command', title: 'Run', detail: 'npm test', status: 'running', mono: true }),
    ])

    now = 14_500
    expect(projection.childNotification('child-1', 'item/completed', {
      turnId: 'ct-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: "bash -lc 'npm test'", status: 'completed', exitCode: 0, durationMs: 2500 },
      completedAtMs: 14_500,
    })).toBe(thread)

    // File change
    now = 15_000
    expect(projection.childNotification('child-1', 'item/completed', {
      turnId: 'ct-1',
      item: { id: 'fc-1', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/src/a.ts' }, { path: '/repo/src/b.ts' }] },
    })).toBe(thread)

    // Reasoning summary delta
    now = 16_000
    expect(projection.childNotification('child-1', 'item/reasoning/summaryTextDelta', {
      turnId: 'ct-1', itemId: 'r-1', summaryIndex: 0, delta: 'Checking edge cases',
    })).toBe(thread)

    // Plan update
    now = 16_500
    expect(projection.childNotification('child-1', 'turn/plan/updated', {
      turnId: 'ct-1', plan: [{ step: 'Run tests', status: 'completed' }, { step: 'Fix edge case', status: 'in_progress' }],
    })).toBe(thread)

    // Turn completes -> settles remaining running steps
    now = 18_000
    expect(projection.childNotification('child-1', 'turn/completed', {
      turn: { id: 'ct-1', status: 'completed', startedAt: 11, completedAt: 18, durationMs: 7000 },
    })).toBe(thread)

    agent = thread.activities.find(row => row.kind === 'subagent')?.agents?.[0]
    expect(agent?.status).toBe('completed')
    expect(agent?.stepsTotal).toBe(4)
    expect(agent?.steps).toHaveLength(4)
    expect(agent?.steps?.[0]).toMatchObject({ kind: 'command', status: 'completed', durationMs: 2500 })
    expect(agent?.steps?.[1]).toMatchObject({ kind: 'file-change', detail: '/repo/src/a.ts (+1 more)', status: 'completed' })
    expect(agent?.steps?.[2]).toMatchObject({ kind: 'reasoning', detail: 'Checking edge cases', status: 'completed' })
    expect(agent?.steps?.[3]).toMatchObject({ kind: 'plan', detail: 'Fix edge case (1/2)', status: 'completed' })
  })

  it('throttles rapid Codex reasoning deltas to avoid write storms while preserving the accumulated text', () => {
    let now = 20_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'thread-1', messages: [], activities: [] as AgentActivity[] }
    projection.item(thread, codexItemSchema.parse({
      id: 'spawn-1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/worker',
    }), { turnId: 'turn-1', phase: 'completed' })
    projection.childNotification('child-1', 'turn/started', { turn: { id: 'ct-1', status: 'inProgress' } })

    // First chunk publishes immediately.
    now = 21_000
    expect(projection.childNotification('child-1', 'item/reasoning/summaryTextDelta', {
      turnId: 'ct-1', itemId: 'r-1', summaryIndex: 0, delta: 'Checking ',
    })).toBe(thread)

    // Subsequent rapid chunks within 500 ms are buffered without publishing.
    now = 21_050
    expect(projection.childNotification('child-1', 'item/reasoning/summaryTextDelta', {
      turnId: 'ct-1', itemId: 'r-1', summaryIndex: 0, delta: 'many ',
    })).toBeUndefined()
    now = 21_100
    expect(projection.childNotification('child-1', 'item/reasoning/summaryTextDelta', {
      turnId: 'ct-1', itemId: 'r-1', summaryIndex: 0, delta: 'files',
    })).toBeUndefined()

    // Once >= 500 ms elapses, the next delta publishes the full accumulated text.
    now = 21_600
    expect(projection.childNotification('child-1', 'item/reasoning/summaryTextDelta', {
      turnId: 'ct-1', itemId: 'r-1', summaryIndex: 0, delta: ' now',
    })).toBe(thread)
    const agent = thread.activities.find(row => row.kind === 'subagent')?.agents?.[0]
    expect(agent?.steps?.[0]?.detail).toBe('Checking many files now')
  })
})

describe('live child steps — SubagentStore retention, bounds, and privacy', () => {
  const step = (n: number, patch: Partial<SubagentStep> = {}): SubagentStep => ({
    id: `s-${n}`, kind: 'command', status: 'completed', title: 'Run', detail: `cmd-${n}`, mono: true, ...patch,
  })

  it('tracks currentStep and stepCount on rows, bounds steps to MAX_SUBAGENT_STEPS, settles on unknown, and erases on privacy off', async () => {
    const root = await tempDir('sotto-steps-store-')
    const store = new SubagentStore(join(root, 'subagents.sqlite'))
    stores.push(store)
    store.open()

    const base: ObservedAgent = {
      id: 'a1', assignmentId: 'run-1', title: 'Worker', prompt: 'Do work', status: 'running',
      observedAt: '2026-11-22T10:00:00.000Z', startedAt: '2026-11-22T10:00:00.000Z',
      steps: [step(1), step(2, { status: 'running', detail: 'SECRET_STEP_DETAIL' })],
      stepsTotal: 2,
    }
    const change = store.ingest('t1', [base])!
    expect(subagentChangeSchema.safeParse(change).success).toBe(true)
    expect(change.rows[0]).toMatchObject({ stepCount: 2, currentStep: expect.objectContaining({ id: 's-2', status: 'running', detail: 'SECRET_STEP_DETAIL' }) })

    const page = store.page({ threadId: 't1' })
    expect(subagentPageSchema.safeParse(page).success).toBe(true)
    const detail = store.assignments({ threadId: 't1', agentId: 'a1' })
    expect(subagentAssignmentsPageSchema.safeParse(detail).success).toBe(true)
    expect(detail.assignments[0]?.steps).toHaveLength(2)

    // markUnknown clears currentStep on row and marks running step unknown
    const unknown = store.markUnknown('t1')!
    expect(unknown.rows[0]?.currentStep).toBeUndefined()
    expect(store.assignments({ threadId: 't1', agentId: 'a1' }).assignments[0]?.steps?.[1]?.status).toBe('unknown')

    // Privacy off scrubs all step text from disk and redactions prevent replay from restoring it
    store.privacyChanged(false)
    const diskFiles = (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'latin1')))).join(' ')
    expect(diskFiles).not.toContain('SECRET_STEP_DETAIL')
    store.privacyChanged(true)
    store.ingest('t1', [{ ...base, status: 'completed', observedAt: '2026-11-22T10:00:05.000Z' }])
    expect(store.assignments({ threadId: 't1', agentId: 'a1' }).assignments[0]?.steps).toBeUndefined()

    // Bound check on a fresh assignment past MAX_SUBAGENT_STEPS
    const many = Array.from({ length: MAX_SUBAGENT_STEPS + 25 }, (_, i) => step(i))
    store.ingest('t1', [{ ...base, assignmentId: 'run-2', observedAt: '2026-11-22T10:01:00.000Z', steps: many.slice(0, MAX_SUBAGENT_STEPS), stepsTotal: MAX_SUBAGENT_STEPS + 25 }])
    const bounded = store.assignments({ threadId: 't1', agentId: 'a1' }).assignments[0]!
    expect(bounded.steps?.length).toBeLessThanOrEqual(MAX_SUBAGENT_STEPS)
    expect(bounded.stepCount).toBe(MAX_SUBAGENT_STEPS + 25)
  })

  it('rejects extended-year timestamps in validIso and strips agents[].steps from outbound thread details', () => {
    expect(validIso('100000')).toBeUndefined()
    expect(validIso('-000001-01-01T00:00:00.000Z')).toBeUndefined()
    expect(validIso('2026-11-22T10:00:00.000Z')).toBe('2026-11-22T10:00:00.000Z')

    const steps: SubagentStep[] = Array.from({ length: MAX_SUBAGENT_STEPS }, (_, i) => step(i, { detail: 'x'.repeat(200) }))
    const activities: AgentActivity[] = Array.from({ length: 40 }, (_, i) => ({
      id: `act-${i}`, turnId: 't1', sequence: i, kind: 'subagent', status: i === 0 ? 'running' : 'completed', title: `Agent ${i}`,
      agents: [{ id: `ag-${i}`, status: i === 0 ? 'running' : 'completed', title: `Agent ${i}`, steps, stepsTotal: MAX_SUBAGENT_STEPS }],
    }))
    const detail = { threadId: 't1', revision: 1, messages: [], activities }

    const windowStripped = new WindowActivityBodies(() => null).detail(detail)!
    const cutStripped = new CutBodies().detail(detail)
    const legacyStripped = detailWithoutAgentSteps(detail)
    const summaryStripped = detailWithActivitySummaries(detail)

    for (const view of [windowStripped, cutStripped, legacyStripped, summaryStripped]) {
      expect(view.activities?.some(a => a.agents?.some(ag => ag.steps !== undefined))).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(32 * 1024)
    }
  })
})
