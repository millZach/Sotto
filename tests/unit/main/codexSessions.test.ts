// @vitest-environment node
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionLogWatcher } from '../../../src/main/agents/codexSessions'
import type { AgentMessage } from '../../../src/shared/agents'

const roots: string[] = []
const watchers: CodexSessionLogWatcher[] = []
afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-log-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
export function rollout(ordinal: number, payload: unknown, type = 'event_msg'): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type, payload }) + '\n'
}
describe('Codex session log', () => {
  it('tails bytes across partial Unicode lines, ignores injected instructions, and consumes own text once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    const path = join(directory, 'rollout-2026-09-10-thread.jsonl')
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, pollIntervalMs: 10, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread'); watcher.sent('thread', 'own', 'Hello 🌲')
    await writeFile(path, rollout(1, { id: 'thread', cwd: root }, 'session_meta') + 'broken\n' +
      rollout(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS instructions' }] }, 'response_item') +
      rollout(3, { type: 'item_completed', item: { type: 'UserMessage', id: 'own-item', content: [{ type: 'text', text: 'Hello 🌲' }] } }) +
      rollout(4, { type: 'message', role: 'assistant', content: [] }, 'response_item'))
    await watcher.poll()
    expect(messages).toEqual([])
    const line = Buffer.from(rollout(5, { type: 'user_message', message: 'Hello 🌲' }))
    const cut = line.indexOf(Buffer.from('🌲')) + 1
    await appendFile(path, line.subarray(0, cut)); await watcher.poll(); expect(messages).toEqual([])
    await appendFile(path, line.subarray(cut)); await watcher.poll()
    expect(messages).toMatchObject([{ role: 'user', text: 'Hello 🌲' }]); expect(messages[0]!.commandId).toBeUndefined()
    await watcher.poll(); expect(messages).toHaveLength(1)
    await appendFile(path, rollout(6, { type: 'item_completed', item: { type: 'user_message', id: 'foreign', content: [{ type: 'text', text: 'CLI prompt' }] } }))
    await watcher.poll(); expect(messages.at(-1)!.id).toBe('foreign')
  })
})
