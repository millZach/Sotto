// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSessionLogWatcher, mayBeRead } from '../../../src/main/agents/codexSessionLog'
import type { AgentMessage } from '../../../src/shared/agents'

const at = '2026-11-01T14:42:41.865Z'
/** A line as Codex writes it today: its time, its ordinal, its kind and its payload, in that order. */
const line = (type: string, payload: unknown, ordinal = 1): string => JSON.stringify({ timestamp: at, ordinal, type, payload })
const big = (bytes: number): string => 'x'.repeat(bytes)

/** Every kind of line the reader takes anything from (`CodexRolloutIdentities.consume` and the user messages it reports). */
const read = {
  'a turn\'s context': line('turn_context', { turn_id: 'turn-1', cwd: '/work' }),
  'a turn starting': line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
  'a turn ending': line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
  'a user\'s message as an event': line('event_msg', { type: 'user_message', message: 'Hello' }),
  'the agent\'s message as an event': line('event_msg', { type: 'agent_message', message: 'Hi' }),
  'a completed user message': line('event_msg', { type: 'item_completed', thread_id: 't', turn_id: 'u', item: { type: 'UserMessage', id: 'i', content: [] } }),
  'a completed user message, older spelling': line('event_msg', { type: 'item_completed', item: { type: 'user_message', id: 'i', content: [] } }),
  'the agent\'s message as a response item': line('response_item', { type: 'message', status: 'completed', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }),
}
/** Lines it takes nothing from: most of a rollout's bytes. */
const skipped = {
  'a tool call\'s output': line('response_item', { type: 'function_call_output', call_id: 'c', output: big(5000) }),
  'a custom tool call\'s output': line('response_item', { type: 'custom_tool_call_output', call_id: 'c', output: big(5000) }),
  'reasoning': line('response_item', { type: 'reasoning', summary: [], encrypted_content: big(5000) }),
  'a user\'s message as a response item': line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'assistant user_message' }] }),
  'the developer\'s message': line('response_item', { type: 'message', status: 'completed', id: 'm', role: 'developer', content: [] }),
  'a token count': line('event_msg', { type: 'token_count', info: null }),
  'a completed tool item': line('event_msg', { type: 'item_completed', thread_id: 't', item: { type: 'CommandExecution', id: 'i', output: '"UserMessage"' } }),
  'the session\'s details': line('session_meta', { id: 't', instructions: 'turn_context task_started assistant' }),
  'the world\'s state': line('world_state', { files: [] }),
}

describe('which rollout lines the Codex reader reads (#992)', () => {
  it.each(Object.entries(read))('reads %s', (_name, text) => { expect(mayBeRead(text)).toBe(true) })
  it.each(Object.entries(skipped))('skips %s', (_name, text) => { expect(mayBeRead(text)).toBe(false) })

  it('reads any line every start of which it cannot prove holds nothing it takes', () => {
    // A line's start answers for the whole line only when it answers no, so no start of a line it reads may answer no.
    for (const text of Object.values(read)) for (let end = 0; end <= text.length; end++) expect(mayBeRead(text.slice(0, end)), text.slice(0, end)).toBe(true)
  })

  it('parses a line that does not start the way Codex writes them today, as it always did', () => {
    expect(mayBeRead(JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'token_count' } }))).toBe(true)
    expect(mayBeRead(JSON.stringify({ timestamp: at, type: 'response_item', payload: { role: 'user', type: 'message' } }))).toBe(true)
    // A role after a nested value cannot be told from a nested object's role, so the line is read.
    expect(mayBeRead(line('response_item', { type: 'message', content: [{ role: 'user' }], role: 'assistant' }))).toBe(true)
    expect(mayBeRead('broken')).toBe(true)
  })

  it('is not fooled by a key\'s words inside another key\'s value', () => {
    expect(mayBeRead(line('response_item', { type: 'message', id: 'a","role":"user', role: 'assistant', content: [] }))).toBe(true)
    expect(mayBeRead(line('event_msg', { type: 'item_completed', note: 'x\\","item":{"type":"Command', item: { type: 'UserMessage', id: 'i', content: [] } }))).toBe(true)
  })
})

const roots: string[] = []
const watchers: CodexSessionLogWatcher[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const watcher of watchers.splice(0)) await watcher.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('a Codex rollout read past the lines it takes nothing from (#992)', () => {
  it('reports the same messages and parses only the lines it reads, across lines longer than a read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-skip-')); roots.push(root)
    const directory = join(root, 'sessions', '2026', '11', '01'); await mkdir(directory, { recursive: true })
    const kept = [
      line('turn_context', { turn_id: 'turn-1' }, 1),
      line('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 2),
      line('event_msg', { type: 'user_message', id: 'first', message: 'Read the logs' }, 3),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'second', content: [{ type: 'text', text: 'And the 🌲 tests' }] } }, 7),
      line('response_item', { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }, 8),
      JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', id: 'reordered', message: 'Keys in another order' } }),
      line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 10),
    ]
    // Three lines longer than the reader's one-megabyte read, two of them with text in several bytes a character.
    const rollout = [kept[0], kept[1], kept[2],
      line('response_item', { type: 'function_call_output', call_id: 'c', output: '🌲'.repeat(700_000) }, 4),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: big(2_500_000) }] }, 5),
      line('response_item', { type: 'reasoning', encrypted_content: 'é'.repeat(600_000) }, 6),
      kept[3], kept[4], kept[5], line('event_msg', { type: 'token_count', info: null }, 9), kept[6]].join('\n') + '\n'
    await writeFile(join(directory, 'rollout-2026-11-01T14-42-41-thread.jsonl'), rollout)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread')
    const parse = vi.spyOn(JSON, 'parse')
    await watcher.pollThread('thread', true)
    expect(messages.map(message => [message.id, message.text])).toEqual([['first', 'Read the logs'], ['second', 'And the 🌲 tests'], ['reordered', 'Keys in another order']])
    expect(parse.mock.calls.map(([text]) => text).filter(text => typeof text === 'string' && text.startsWith('{"t'))).toEqual(kept)
  })
})
