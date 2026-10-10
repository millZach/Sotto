// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { watcherRecordSchema, watcherRefusalSchema, watcherToolSchemas, WATCHER_REFUSAL_CODES,
  WATCHER_PROMPT_BYTES_MAX, WATCHER_READ_BYTES_MAX } from '../../../src/shared/watcher'
import { agentThreadKindSchema } from '../../../src/shared/agents'
import { watcherToolFixtures, watcherRecordFixture, centerTarget } from '../../fixtures/watcher'

const escapes = ['answer', 'approved', 'permissionChoice', 'runtimeMode', 'providerMode', 'requestBinding', 'command', 'workingDirectory', 'providerSessionId', 'token', 'tools']

/** Mutate every object boundary, including descriptors nested in an output array. */
function withUnknownFields(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => withUnknownFields(child).map(mutated => value.map((item, i) => i === index ? mutated : item)))
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  return [...escapes.filter(field => !(field in object)).map(field => ({ ...object, [field]: 'escape' })),
    ...Object.entries(object).flatMap(([key, child]) => withUnknownFields(child).map(mutated => ({ ...object, [key]: mutated })))]
}

describe('closed watcher contracts', () => {
  it('offers exactly the twelve bounded tools', () => {
    expect(Object.keys(watcherToolSchemas)).toEqual(['list_threads', 'read_thread', 'start_thread', 'send_to_thread', 'stop_thread', 'settle_thread',
      'list_projects', 'list_working_copies', 'read_operation'])
  })
  for (const [name, schemas] of Object.entries(watcherToolSchemas)) {
    const fixture = watcherToolFixtures[name as keyof typeof watcherToolFixtures]
    it(`${name} accepts its input/output and rejects escape fields at every object boundary`, () => {
      expect(schemas.input.safeParse(fixture.input).success).toBe(true)
      expect(schemas.output.safeParse(fixture.output).success).toBe(true)
      for (const mutated of withUnknownFields(fixture.input)) expect(schemas.input.safeParse(mutated).success).toBe(false)
      for (const mutated of withUnknownFields(fixture.output)) expect(schemas.output.safeParse(mutated).success).toBe(false)
    })
    it(`${name} accepts every typed refusal and rejects malformed refusals`, () => {
      for (const code of WATCHER_REFUSAL_CODES) expect(schemas.output.safeParse({ status: 'refused', code, message: 'Nothing was sent. Open the thread.', retryable: false }).success).toBe(true)
      for (const bad of [{ status: 'ok' }, { status: 'refused', code: 'UNKNOWN', message: 'No', retryable: false },
        { status: 'refused', code: 'INVALID_INPUT', message: 'No' }, { status: 'refused', code: 'INVALID_INPUT', message: '', retryable: false }]) {
        expect(schemas.output.safeParse(bad).success).toBe(false)
      }
    })
  }
  it('requires explicit host-qualified targets and UUID retry identities for each mutation', () => {
    for (const name of ['start_thread', 'send_to_thread', 'stop_thread', 'settle_thread'] as const) {
      const fixture = watcherToolFixtures[name].input as Record<string, unknown>
      for (const field of ['requestId', 'retryKey']) {
        const missing = { ...fixture }; delete missing[field]
        expect(watcherToolSchemas[name].input.safeParse(missing).success).toBe(false)
        expect(watcherToolSchemas[name].input.safeParse({ ...fixture, [field]: 'invented' }).success).toBe(false)
      }
    }
    expect(watcherToolSchemas.read_thread.input.safeParse({ target: { threadId: centerTarget.threadId } }).success).toBe(false)
    expect(watcherToolSchemas.read_operation.input.safeParse({ operationId: 'not-a-uuid' }).success).toBe(false)
  })
  it('represents workers whose native model offers no reasoning level without inventing one', () => {
    const input = { ...(watcherToolFixtures.start_thread.input as Record<string, unknown>) }
    delete input.reasoningEffort
    expect(watcherToolSchemas.start_thread.input.safeParse(input).success).toBe(true)
    expect(watcherToolSchemas.start_thread.input.safeParse({ ...input, reasoningEffort: null }).success).toBe(false)
    const output = watcherToolFixtures.start_thread.output as { effectiveChoices: object }
    expect(watcherToolSchemas.start_thread.output.safeParse({ ...output, effectiveChoices: { ...output.effectiveChoices, reasoningEffort: null } }).success).toBe(true)
    expect(watcherToolSchemas.start_thread.output.safeParse({ ...output, effectiveChoices: { ...output.effectiveChoices, reasoningEffort: '' } }).success).toBe(false)
  })
  it('bounds prompts by UTF-8 bytes, titles, pages and cursors', () => {
    const base = watcherToolFixtures.send_to_thread.input as object
    expect(watcherToolSchemas.send_to_thread.input.safeParse({ ...base, text: 'a'.repeat(WATCHER_PROMPT_BYTES_MAX) }).success).toBe(true)
    for (const text of ['a'.repeat(WATCHER_PROMPT_BYTES_MAX + 1), 'é'.repeat(WATCHER_PROMPT_BYTES_MAX / 2 + 1), '   ']) {
      expect(watcherToolSchemas.send_to_thread.input.safeParse({ ...base, text }).success).toBe(false)
    }
    expect(watcherToolSchemas.start_thread.input.safeParse({ ...(watcherToolFixtures.start_thread.input as object), title: 'a'.repeat(513) }).success).toBe(false)
    for (const [name, schemas] of Object.entries(watcherToolSchemas)) {
      if (!['list_threads', 'list_projects', 'list_working_copies', 'read_thread'].includes(name)) continue
      const input = watcherToolFixtures[name as keyof typeof watcherToolFixtures].input as object
      const max = name === 'read_thread' ? 50 : 100
      for (const limit of [0, max + 1, 1.5]) expect(schemas.input.safeParse({ ...input, limit }).success).toBe(false)
    }
    expect(watcherToolSchemas.list_threads.input.safeParse({ cursor: 'a'.repeat(2_049) }).success).toBe(false)
    expect(watcherToolSchemas.read_thread.input.safeParse({ target: centerTarget, position: { historyEpoch: -1, afterPosition: 0 } }).success).toBe(false)
  })
  it('bounds whole read responses, including metadata, rather than each message alone', () => {
    const base = watcherToolFixtures.read_thread.output as { messages: object[] }
    expect(watcherToolSchemas.read_thread.output.safeParse({ ...base,
      messages: [{ ...base.messages[0], text: 'a'.repeat(WATCHER_READ_BYTES_MAX) }] }).success).toBe(false)
    expect(watcherToolSchemas.read_thread.output.safeParse({ ...base,
      messages: Array.from({ length: 50 }, (_, i) => ({ ...base.messages[0], id: `m-${i}`, text: 'a'.repeat(1_400) })) }).success).toBe(false)
  })
  it('represents cursor recovery and delivery uncertainty without an answer capability', () => {
    expect(watcherRefusalSchema.parse({ status: 'refused', code: 'CURSOR_EXPIRED', message: 'Read the list again.', retryable: true, restartCursor: 'restart' }).restartCursor).toBe('restart')
    expect(watcherRefusalSchema.safeParse({ status: 'refused', code: 'HISTORY_RESET', message: 'Read the new history.', retryable: true,
      historyCursor: { historyEpoch: 'epoch-2', afterPosition: 0 } }).success).toBe(true)
    const output = watcherToolFixtures.send_to_thread.output as { receipt: object }
    for (const deliveryState of ['queued', 'accepted', 'failed', 'uncertain']) {
      expect(watcherToolSchemas.send_to_thread.output.safeParse({ ...output, receipt: { ...output.receipt, deliveryState } }).success).toBe(true)
    }
  })
  it('keeps the durable record strict and text-free, including nested operation and ownership metadata', () => {
    const record = watcherRecordFixture()
    expect(watcherRecordSchema.parse(record)).toEqual(record)
    for (const mutated of withUnknownFields(record)) expect(watcherRecordSchema.safeParse(mutated).success).toBe(false)
    for (const field of ['prompt', 'brief', 'text', 'fileContents', 'error', 'arguments']) {
      expect(watcherRecordSchema.safeParse({ ...record, [field]: 'private words' }).success).toBe(false)
      expect(watcherRecordSchema.safeParse({ ...record, operations: [{ ...record.operations[0], [field]: 'private words' }] }).success).toBe(false)
    }
    expect(watcherRecordSchema.safeParse({ ...record, operations: [...record.operations, ...record.operations] }).success).toBe(false)
    expect(watcherRecordSchema.safeParse({ ...record, requests: [] }).success).toBe(false)
    expect(watcherRecordSchema.safeParse({ ...record, history: [record.current] }).success).toBe(false)
    expect(watcherRecordSchema.safeParse({ ...record, current: { ...record.current, provider: 'devin' } }).success).toBe(false)
    expect(watcherRecordSchema.safeParse({ ...record, requests: [{ ...record.requests[0], participants: [{ ...record.requests[0]!.participants[0], promptCount: 5 }] }] }).success).toBe(false)
    expect(agentThreadKindSchema.options).toEqual(['project', 'watcher', 'watcher-history'])
  })
})
