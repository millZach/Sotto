import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { ActivityGroupView } from '../../../src/renderer/src/agents/ThreadActivity'
import {
  activityChanges, activityInput, activityLabel, displayDiff, inputDetail, nestActivities,
} from '../../../src/renderer/src/agents/threadActivityView'

afterEach(cleanup)

let sequence = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 't1', sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', ...patch })

// Shapes as the Phase 3 Claude and Grok projectors write them (src/main/agents/claudeActivity.ts, grokActivity.ts).
const claudeRead = record({ id: 'claude-tool-read', title: 'Read', text: JSON.stringify({ file_path: 'D:\\repo\\src\\app.ts', limit: 40 }), output: 'export const ready = true' })
const claudeTask = record({ id: 'claude-tool-task', kind: 'subagent', title: 'Task', status: 'completed', text: JSON.stringify({ description: 'Audit the tests', prompt: 'Look for flaky tests', subagent_type: 'general-purpose' }) })
const claudeGrep = record({ id: 'claude-tool-grep', parentId: 'claude-tool-task', title: 'Grep', text: JSON.stringify({ pattern: 'it\\.skip', path: 'tests' }) })
const claudeBash = record({ id: 'claude-tool-bash', parentId: 'claude-tool-task', kind: 'command', title: 'Bash', command: 'npm test', text: JSON.stringify({ command: 'npm test', description: 'Run the unit tests' }), output: 'PASS', exitCode: 0 })
const claudeEdit = record({ id: 'claude-tool-edit', kind: 'file-change', title: 'Edit', text: JSON.stringify({ file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'c' }),
  changes: [{ path: 'src/a.ts', kind: 'Edit', diff: '--- before\na\nb\n+++ after\nc' }] })
const claudeWrite = record({ id: 'claude-tool-write', kind: 'file-change', title: 'Write', text: JSON.stringify({ file_path: 'notes.md', content: '# Notes\nhello\n' }), changes: [{ path: 'notes.md', kind: 'Write' }] })
const grokSearch = record({ id: 'grok-tool-1', title: 'Search files', text: JSON.stringify({ query: 'TODO', glob: '*.ts' }), changes: [{ path: 'src/b.ts', kind: 'search' }] })

describe('native activity wording', () => {
  it('reads JSON input as a preview instead of raw JSON', () => {
    expect(activityInput(claudeRead)).toMatchObject({ limit: 40 })
    expect(activityLabel(claudeRead)).toMatchObject({ subject: 'Read', preview: 'D:\\repo\\src\\app.ts' })
    expect(activityLabel(grokSearch).preview).toBe('TODO')
    expect(activityLabel(claudeTask)).toMatchObject({ subject: 'Audit the tests', preview: '' })
    expect(activityLabel(record({ id: 'prose', text: 'Looked at {braces} in prose' })).preview).toBe('Looked at {braces} in prose')
    expect(activityInput(record({ id: 'cut', text: '{"file_path": "src/a' }))).toBeNull()
  })

  it('names Claude and Grok change kinds and turns before/after text into removed and added lines', () => {
    expect(activityLabel(claudeEdit)).toMatchObject({ lead: 'Edited', subject: 'src/a.ts' })
    expect(activityLabel(claudeWrite).lead).toBe('Wrote')
    expect(activityLabel(record({ id: 'mv', kind: 'file-change', changes: [{ path: 'a', kind: 'move' }] })).lead).toBe('Moved')
    expect(displayDiff('--- before\na\nb\n+++ after\nc')).toBe('-a\n-b\n+c')
    expect(displayDiff('--- before\n\n+++ after\nnew file')).toBe('+new file')
    expect(displayDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')
    expect(activityChanges(claudeWrite)[0]!.diff).toBe('+# Notes\n+hello')
    expect(inputDetail(claudeEdit)).toBe('')
    expect(inputDetail(claudeBash)).toBe('Run the unit tests')
    expect(inputDetail(grokSearch)).toContain('"glob": "*.ts"')
  })

  it('nests work under its parent and keeps orphans and cycles visible', () => {
    const orphan = record({ id: 'orphan', parentId: 'missing' })
    const loopA = record({ id: 'loop-a', parentId: 'loop-b' })
    const loopB = record({ id: 'loop-b', parentId: 'loop-a' })
    const nodes = nestActivities([claudeTask, claudeGrep, claudeBash, orphan, loopA, loopB])
    expect(nodes.map(node => node.record.id)).toEqual(['claude-tool-task', 'orphan', 'loop-a'])
    expect(nodes[0]!.children.map(node => node.record.id)).toEqual(['claude-tool-grep', 'claude-tool-bash'])
    expect(nodes[2]!.children.map(node => node.record.id)).toEqual(['loop-b'])
  })
})

describe('native activity rows', () => {
  const view = (records: AgentActivity[]) => render(<ActivityGroupView group={{ key: 'g', turnId: 't1', anchorMessageId: 'm1', records }} live threadRunning connected provider="Claude" />)

  it('opens a subagent to its own steps and says when its result was not reported', async () => {
    const user = userEvent.setup()
    view([claudeTask, claudeGrep, claudeBash, claudeEdit])
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Audit the tests, 2 steps, completed', 'Edited src/a.ts, completed',
    ])
    await user.click(screen.getByRole('button', { name: 'Audit the tests, 2 steps, completed' }))
    const steps = screen.getByRole('list', { name: 'Steps in Audit the tests' })
    expect(within(steps).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Grep, it\\.skip, completed', 'npm test, completed'])
    expect(screen.getByText('Claude did not report this agent’s result.')).toBeTruthy()
    expect(screen.getByLabelText('json code block')).toHaveTextContent('"subagent_type": "general-purpose"')
    await user.click(within(steps).getByRole('button', { name: /npm test/u }))
    expect(screen.getByText('Run the unit tests')).toBeTruthy()
    expect(screen.queryByText(/"description": "Run the unit tests"/u)).toBeNull()
  })

  it('shows an edit as a diff without its raw input', async () => {
    const user = userEvent.setup()
    view([claudeEdit])
    await user.click(screen.getByRole('button', { name: 'Edited src/a.ts, completed' }))
    expect(screen.getByLabelText('diff code block')).toHaveTextContent('-a -b +c')
    expect(screen.queryByText(/old_string/u)).toBeNull()
  })
})
