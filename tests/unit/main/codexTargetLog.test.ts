// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexSessionLogWatcher } from '../../../src/main/agents/codexSessionLog'
import { rolloutLine } from '../../fixtures/codexFixture'

it('reads through the target history before declaring its latest user message current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-target-log-'))
  const messages: string[] = []
  const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message.text) })
  try {
    const directory = join(root, 'sessions'); await mkdir(directory)
    const own = rolloutLine(1, { type: 'user_message', message: 'Own text' })
    // Background reads have a byte budget; an authoritative target read must reach its tail.
    await writeFile(join(directory, 'rollout-target.jsonl'), own.repeat(Math.ceil(2 * 1024 * 1024 / own.length)) + rolloutLine(2, { type: 'user_message', message: 'External takeover at the tail' }))
    watcher.sent('target', 'own', 'Own text')
    await watcher.pollThread('target')
    expect(messages).toEqual(['External takeover at the tail'])
    await watcher.pollThread('target')
    expect(messages).toHaveLength(1)
  } finally { await watcher.stop(); await rm(root, { recursive: true, force: true }) }
})
