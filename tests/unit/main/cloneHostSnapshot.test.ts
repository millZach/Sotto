// @vitest-environment node
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { agentHostSnapshotSchema, EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import { cloneHostSnapshot } from '../../../src/main/agents/cloneHostSnapshot'

function fixture(): AgentHostSnapshot {
  return agentHostSnapshotSchema.parse({
    ...EMPTY_AGENT_HOST, connected: true, error: undefined,
    models: [{ id: 'model', provider: 'codex', name: 'Model', ready: true, reasoningEfforts: ['low', 'high'] }],
    projects: [{ id: 'project', title: 'Project', path: '/project', workspaceSettledAt: null }],
    threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model', status: 'running',
      nativeSessionStarted: false, reasoningEffort: undefined,
      messages: [{ id: 'message', role: 'user', text: '', createdAt: '2026-09-20T00:00:00Z',
        attachments: [{ id: 'image', name: 'image.png', mimeType: 'image/png', sizeBytes: 0, preview: { available: true } }] }],
      requests: [{ id: 'request', kind: 'question', text: 'Choose', options: [{ id: 'yes', label: 'Yes' }],
        questions: [{ id: 'question', question: 'Choose', options: [{ id: 'yes', label: 'Yes' }], multiSelect: false, allowFreeText: true }] }],
      activities: [{ id: 'activity', turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'Build',
        output: 'Build output', exitCode: 0, truncated: false,
        changes: [{ path: 'file.ts', kind: 'modified', diff: 'diff' }],
        steps: [{ text: 'Build', status: 'completed' }], agents: [{ id: 'agent', status: 'completed', message: 'Done' }],
        context: { before: 0, after: 0 } }],
    }],
  })
}

it('matches structuredClone for a schema-validated host including optional and empty values', () => {
  const source = fixture()
  const copy = cloneHostSnapshot(source)
  expect(copy).toStrictEqual(structuredClone(source))
  expect(Object.hasOwn(copy, 'error')).toBe(true)
  expect(Object.hasOwn(copy.threads[0]!, 'reasoningEffort')).toBe(true)
})

it('keeps returned snapshots writable without changing source or sibling snapshots', () => {
  const source = fixture()
  const original = structuredClone(source)
  const first = cloneHostSnapshot(source)
  const second = cloneHostSnapshot(source)
  first.models[0]!.reasoningEfforts!.push('extra')
  first.projects[0]!.title = 'Renamed'
  first.capabilities.submit = !first.capabilities.submit
  const thread = first.threads[0]!
  Object.assign(thread.messages[0]!.attachments![0]!.preview!, { available: false })
  thread.messages.push({ id: 'new', role: 'assistant', text: 'New', createdAt: '' })
  thread.requests[0]!.options[0]!.label = 'Changed'
  thread.requests[0]!.questions![0]!.options.push({ id: 'no', label: 'No' })
  const activity = thread.activities![0]!
  activity.changes![0]!.path = 'changed.ts'
  activity.steps![0]!.text = 'Changed'
  activity.agents![0]!.message = 'Changed'
  activity.context!.after = 123
  thread.activities!.push({ ...activity, id: 'new' })
  expect(source).toStrictEqual(original)
  expect(second).toStrictEqual(original)
  source.threads[0]!.activities![0]!.output = 'Later provider output'
  expect(second.threads[0]!.activities![0]!.output).toBe('Build output')
})

it('preserves shared references inside the copy while isolating them from the provider', () => {
  const source = fixture()
  source.providers = [{ id: 'codex', connection: 'connected', name: 'Codex', version: '', capabilities: source.capabilities }]
  const copy = cloneHostSnapshot(source)
  expect(copy.providers![0]!.capabilities).toBe(copy.capabilities)
  expect(copy.capabilities).not.toBe(source.capabilities)
  copy.providers![0]!.capabilities.submit = !source.capabilities.submit
  expect(source.providers[0]!.capabilities.submit).not.toBe(copy.capabilities.submit)
})
it('copies an own __proto__ property as data without changing the clone prototype', () => {
  const source = fixture()
  Object.defineProperty(source, '__proto__', { value: { marker: ['original'] }, enumerable: true, writable: true })
  const copy = cloneHostSnapshot(source)
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  expect(copy).toStrictEqual(structuredClone(source))
  const marker = Object.getOwnPropertyDescriptor(copy, '__proto__')!.value as { marker: string[] }
  marker.marker.push('changed')
  expect(Object.getOwnPropertyDescriptor(source, '__proto__')!.value).toEqual({ marker: ['original'] })
})

it('reports the cost of copying 24 MiB of retained activity output', () => {
  const source = fixture()
  source.threads[0]!.activities = Array.from({ length: 384 }, (_, sequence) => ({
    id: `activity-${sequence}`, turnId: 'turn', sequence, kind: 'command', status: 'completed', title: 'Command',
    output: `${sequence}`.padEnd(65_536, 'x'),
  }))
  const measure = (copy: typeof cloneHostSnapshot): number => {
    const samples = Array.from({ length: 5 }, () => {
      const start = performance.now()
      const result = copy(source)
      const elapsed = performance.now() - start
      expect(result.threads[0]!.activities![383]!.output).toBe(source.threads[0]!.activities![383]!.output)
      return elapsed
    })
    return samples.sort((a, b) => a - b)[2]!
  }
  const baselineMs = measure(structuredClone)
  const snapshotMs = measure(cloneHostSnapshot)
  console.info(JSON.stringify({ benchmark: 'host-snapshot-24mib', baselineMs, snapshotMs }))
  if (process.env.SOTTO_PERF_ASSERT === '1') expect(snapshotMs).toBeLessThan(baselineMs / 2)
})
