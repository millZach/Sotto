// @vitest-environment node
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { agentHostSnapshotSchema, EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import { cloneHostSnapshot, copyOver } from '../../../src/main/agents/cloneHostSnapshot'

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

describe('a copy over the last one (#1326)', () => {
  const kept = new WeakSet<object>()
  const seal = (item: object): void => { Object.freeze(item); kept.add(item) }
  const over = <T>(value: T, previous?: T): T => copyOver([value], [previous], item => kept.has(item), seal)[0]!

  it('equals a fresh copy, keys in order, and gives back the last copy itself when nothing changed', () => {
    const source = fixture()
    const first = over(source)
    expect(first).toStrictEqual(structuredClone(source))
    expect(JSON.stringify(first)).toBe(JSON.stringify(source))
    expect(Object.isFrozen(first.threads[0]!.messages[0]!.attachments![0])).toBe(true)
    expect(over(source, first)).toBe(first)
    expect(over(structuredClone(source), first)).toBe(first)
  })

  it('copies only the path to what changed, even when it was changed in place', () => {
    const source = fixture()
    const first = over(source)
    source.threads[0]!.requests[0]!.questions![0]!.question = 'Choose again'
    const second = over(source, first)
    expect(second).toStrictEqual(structuredClone(source))
    expect(second).not.toBe(first)
    expect(second.threads[0]!.requests[0]!.questions![0]!.question).toBe('Choose again')
    expect(first.threads[0]!.requests[0]!.questions![0]!.question).toBe('Choose')
    expect(second.threads[0]!.messages).toBe(first.threads[0]!.messages)
    expect(second.threads[0]!.activities).toBe(first.threads[0]!.activities)
    expect(second.models).toBe(first.models)
    expect(second.threads[0]!.requests[0]!.options).toBe(first.threads[0]!.requests[0]!.options)
  })

  it('keeps what a list had when it grew at its end, and follows a key that moved, appeared or went', () => {
    const source = fixture()
    const first = over(source)
    source.threads[0]!.messages.push({ id: 'next', role: 'assistant', text: 'Reply', createdAt: '2026-09-20T00:00:01Z' })
    const grown = over(source, first)
    expect(grown.threads[0]!.messages).toHaveLength(2)
    expect(grown.threads[0]!.messages[0]).toBe(first.threads[0]!.messages[0])
    const thread = source.threads[0]! as unknown as Record<string, unknown>
    const { title, ...rest } = thread
    source.threads[0] = { ...rest, title } as unknown as typeof source.threads[0]
    const moved = over(source, grown)
    expect(Object.keys(moved.threads[0]!)).toEqual(Object.keys(source.threads[0]!))
    expect(JSON.stringify(moved)).toBe(JSON.stringify(source))
    delete source.threads[0]!.reasoningEffort
    source.threads[0]!.historySaveNotice = 'Notice'
    const changed = over(source, moved)
    expect(JSON.stringify(changed)).toBe(JSON.stringify(source))
    expect(changed).toStrictEqual(structuredClone(source))
  })

  it('tells -0 from 0, and never keeps a part of the last copy that it does not own', () => {
    const first = over({ value: 0, nested: { text: 'a' } })
    expect(Object.is(over({ value: -0, nested: { text: 'a' } }, first).value, -0)).toBe(true)
    const loose = { value: 1, nested: { text: 'a' } }
    const copy = over({ value: 1, nested: { text: 'a' } }, loose)
    expect(copy).not.toBe(loose)
    expect(copy.nested).not.toBe(loose.nested)
    expect(copy).toEqual(loose)
  })

  it('copies each record over the previous at its place, in a list the caller owns', () => {
    const first = copyOver([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], [undefined, undefined], item => kept.has(item), seal)
    const second = copyOver([{ id: 'c', n: 3 }, { id: 'a', n: 1 }, { id: 'b', n: 5 }], [undefined, first[0], first[1]], item => kept.has(item), seal)
    expect(second).toEqual([{ id: 'c', n: 3 }, { id: 'a', n: 1 }, { id: 'b', n: 5 }])
    expect(second[1]).toBe(first[0])
    expect(second[2]).not.toBe(first[1])
    expect(Object.isFrozen(second)).toBe(false)
    expect(Object.isFrozen(second[2])).toBe(true)
  })
})
