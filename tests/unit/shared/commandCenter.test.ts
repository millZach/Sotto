// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { commandCenterRecordSchema, commandCenterRefusalSchema, commandCenterToolSchemas, COMMAND_CENTER_REFUSAL_CODES,
  COMMAND_CENTER_PROMPT_BYTES_MAX, COMMAND_CENTER_READ_BYTES_MAX } from '../../../src/shared/commandCenter'
import { agentThreadKindSchema } from '../../../src/shared/agents'
import { commandCenterToolFixtures, commandCenterRecordFixture, centerTarget } from '../../fixtures/commandCenter'

const escapes = ['answer', 'approved', 'permissionChoice', 'runtimeMode', 'providerMode', 'requestBinding', 'command', 'workingDirectory', 'providerSessionId', 'token', 'tools']

/** Mutate every object boundary, including descriptors nested in an output array. */
function withUnknownFields(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => withUnknownFields(child).map(mutated => value.map((item, i) => i === index ? mutated : item)))
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  return [...escapes.filter(field => !(field in object)).map(field => ({ ...object, [field]: 'escape' })),
    ...Object.entries(object).flatMap(([key, child]) => withUnknownFields(child).map(mutated => ({ ...object, [key]: mutated })))]
}

describe('closed command-center contracts', () => {
  it('offers exactly the twelve bounded tools', () => {
    expect(Object.keys(commandCenterToolSchemas)).toEqual(['list_threads', 'read_thread', 'start_thread', 'send_to_thread', 'stop_thread', 'settle_thread',
      'list_projects', 'list_working_copies', 'list_project_files', 'search_project_files', 'read_project_file', 'read_operation'])
  })
  for (const [name, schemas] of Object.entries(commandCenterToolSchemas)) {
    const fixture = commandCenterToolFixtures[name as keyof typeof commandCenterToolFixtures]
    it(`${name} accepts its input/output and rejects escape fields at every object boundary`, () => {
      expect(schemas.input.safeParse(fixture.input).success).toBe(true)
      expect(schemas.output.safeParse(fixture.output).success).toBe(true)
      for (const mutated of withUnknownFields(fixture.input)) expect(schemas.input.safeParse(mutated).success).toBe(false)
      for (const mutated of withUnknownFields(fixture.output)) expect(schemas.output.safeParse(mutated).success).toBe(false)
    })
    it(`${name} accepts every typed refusal and rejects malformed refusals`, () => {
      for (const code of COMMAND_CENTER_REFUSAL_CODES) expect(schemas.output.safeParse({ status: 'refused', code, message: 'Nothing was sent. Open the thread.', retryable: false }).success).toBe(true)
      for (const bad of [{ status: 'ok' }, { status: 'refused', code: 'UNKNOWN', message: 'No', retryable: false },
        { status: 'refused', code: 'INVALID_INPUT', message: 'No' }, { status: 'refused', code: 'INVALID_INPUT', message: '', retryable: false }]) {
        expect(schemas.output.safeParse(bad).success).toBe(false)
      }
    })
  }
  it('requires explicit host-qualified targets and UUID retry identities for each mutation', () => {
    for (const name of ['start_thread', 'send_to_thread', 'stop_thread', 'settle_thread'] as const) {
      const fixture = commandCenterToolFixtures[name].input as Record<string, unknown>
      for (const field of ['requestId', 'retryKey']) {
        const missing = { ...fixture }; delete missing[field]
        expect(commandCenterToolSchemas[name].input.safeParse(missing).success).toBe(false)
        expect(commandCenterToolSchemas[name].input.safeParse({ ...fixture, [field]: 'invented' }).success).toBe(false)
      }
    }
    expect(commandCenterToolSchemas.read_thread.input.safeParse({ target: { threadId: centerTarget.threadId } }).success).toBe(false)
    expect(commandCenterToolSchemas.read_operation.input.safeParse({ operationId: 'not-a-uuid' }).success).toBe(false)
  })
  it('represents workers whose native model offers no reasoning level without inventing one', () => {
    const input = { ...(commandCenterToolFixtures.start_thread.input as Record<string, unknown>) }
    delete input.reasoningEffort
    expect(commandCenterToolSchemas.start_thread.input.safeParse(input).success).toBe(true)
    expect(commandCenterToolSchemas.start_thread.input.safeParse({ ...input, reasoningEffort: null }).success).toBe(false)
    const output = commandCenterToolFixtures.start_thread.output as { effectiveChoices: object }
    expect(commandCenterToolSchemas.start_thread.output.safeParse({ ...output, effectiveChoices: { ...output.effectiveChoices, reasoningEffort: null } }).success).toBe(true)
    expect(commandCenterToolSchemas.start_thread.output.safeParse({ ...output, effectiveChoices: { ...output.effectiveChoices, reasoningEffort: '' } }).success).toBe(false)
  })
  it('bounds prompts by UTF-8 bytes, titles, pages, cursors and file windows', () => {
    const base = commandCenterToolFixtures.send_to_thread.input as object
    expect(commandCenterToolSchemas.send_to_thread.input.safeParse({ ...base, text: 'a'.repeat(COMMAND_CENTER_PROMPT_BYTES_MAX) }).success).toBe(true)
    for (const text of ['a'.repeat(COMMAND_CENTER_PROMPT_BYTES_MAX + 1), 'é'.repeat(COMMAND_CENTER_PROMPT_BYTES_MAX / 2 + 1), '   ']) {
      expect(commandCenterToolSchemas.send_to_thread.input.safeParse({ ...base, text }).success).toBe(false)
    }
    expect(commandCenterToolSchemas.start_thread.input.safeParse({ ...(commandCenterToolFixtures.start_thread.input as object), title: 'a'.repeat(513) }).success).toBe(false)
    for (const [name, schemas] of Object.entries(commandCenterToolSchemas)) {
      if (!['list_threads', 'list_projects', 'list_working_copies', 'list_project_files', 'search_project_files', 'read_thread'].includes(name)) continue
      const input = commandCenterToolFixtures[name as keyof typeof commandCenterToolFixtures].input as object
      const max = name === 'read_thread' ? 50 : 100
      for (const limit of [0, max + 1, 1.5]) expect(schemas.input.safeParse({ ...input, limit }).success).toBe(false)
    }
    expect(commandCenterToolSchemas.list_threads.input.safeParse({ cursor: 'a'.repeat(2_049) }).success).toBe(false)
    expect(commandCenterToolSchemas.read_thread.input.safeParse({ target: centerTarget, position: { historyEpoch: -1, afterPosition: 0 } }).success).toBe(false)
    expect(commandCenterToolSchemas.read_project_file.input.safeParse({ ...(commandCenterToolFixtures.read_project_file.input as object), lineLimit: 201 }).success).toBe(false)
    expect(commandCenterToolSchemas.read_project_file.output.safeParse({ ...(commandCenterToolFixtures.read_project_file.output as object), sizeBytes: 1_048_577 }).success).toBe(false)
  })
  it('bounds whole read responses, including metadata, rather than each message alone', () => {
    const base = commandCenterToolFixtures.read_thread.output as { messages: object[] }
    expect(commandCenterToolSchemas.read_thread.output.safeParse({ ...base,
      messages: [{ ...base.messages[0], text: 'a'.repeat(COMMAND_CENTER_READ_BYTES_MAX) }] }).success).toBe(false)
    expect(commandCenterToolSchemas.read_thread.output.safeParse({ ...base,
      messages: Array.from({ length: 50 }, (_, i) => ({ ...base.messages[0], id: `m-${i}`, text: 'a'.repeat(1_400) })) }).success).toBe(false)
  })
  it('rejects absolute, device, traversal and alternate-stream paths before any broker dispatch', () => {
    for (const path of ['../secret', 'sub/../../secret', 'C:/secret', '\\\\server\\share', '\\\\?\\C:\\secret', '/secret', 'file:token', 'file\u0000']) {
      expect(commandCenterToolSchemas.read_project_file.input.safeParse({ ...(commandCenterToolFixtures.read_project_file.input as object), path }).success).toBe(false)
    }
  })
  it('represents cursor recovery and delivery uncertainty without an answer capability', () => {
    expect(commandCenterRefusalSchema.parse({ status: 'refused', code: 'CURSOR_EXPIRED', message: 'Read the list again.', retryable: true, restartCursor: 'restart' }).restartCursor).toBe('restart')
    expect(commandCenterRefusalSchema.safeParse({ status: 'refused', code: 'HISTORY_RESET', message: 'Read the new history.', retryable: true,
      historyCursor: { historyEpoch: 'epoch-2', afterPosition: 0 } }).success).toBe(true)
    const output = commandCenterToolFixtures.send_to_thread.output as { receipt: object }
    for (const deliveryState of ['queued', 'accepted', 'failed', 'uncertain']) {
      expect(commandCenterToolSchemas.send_to_thread.output.safeParse({ ...output, receipt: { ...output.receipt, deliveryState } }).success).toBe(true)
    }
  })
  it('keeps the durable record strict and text-free, including nested operation and ownership metadata', () => {
    const record = commandCenterRecordFixture()
    expect(commandCenterRecordSchema.parse(record)).toEqual(record)
    for (const mutated of withUnknownFields(record)) expect(commandCenterRecordSchema.safeParse(mutated).success).toBe(false)
    for (const field of ['prompt', 'brief', 'text', 'fileContents', 'error', 'arguments']) {
      expect(commandCenterRecordSchema.safeParse({ ...record, [field]: 'private words' }).success).toBe(false)
      expect(commandCenterRecordSchema.safeParse({ ...record, operations: [{ ...record.operations[0], [field]: 'private words' }] }).success).toBe(false)
    }
    expect(commandCenterRecordSchema.safeParse({ ...record, operations: [...record.operations, ...record.operations] }).success).toBe(false)
    expect(commandCenterRecordSchema.safeParse({ ...record, requests: [] }).success).toBe(false)
    expect(commandCenterRecordSchema.safeParse({ ...record, history: [record.current] }).success).toBe(false)
    expect(commandCenterRecordSchema.safeParse({ ...record, current: { ...record.current, provider: 'devin' } }).success).toBe(false)
    expect(commandCenterRecordSchema.safeParse({ ...record, requests: [{ ...record.requests[0], participants: [{ ...record.requests[0]!.participants[0], promptCount: 5 }] }] }).success).toBe(false)
    expect(agentThreadKindSchema.options).toEqual(['project', 'command-center', 'command-center-history'])
  })
})
