// @vitest-environment node
// Zero-model native rollback of an explicitly supplied, previously owned
// synthetic Sotto verification session. Original native history remains intact.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'

it.runIf(process.env.SOTTO_PHASE4_CLAUDE_ROLLBACK_NATIVE === '1')('installed Claude native rollback retains exact earlier conversation after restart without a model call', async () => {
  const source = process.env.SOTTO_PHASE4_CLAUDE_SOURCE!
  if (!source || !basename(source).startsWith('sotto-phase3-claude-')) throw new Error('Supply only the previously owned synthetic phase-3 Claude probe root.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase4-claude-rollback-'))
  await writeFile(join(root, 'claude-threads.json'), await readFile(join(source, 'sotto', 'claude-threads.json')))
  let host = new ClaudeStreamJsonHost({ userDataPath: root })
  const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), root, modelCalls: 0 }
  try {
    expect((await host.connect()).connected).toBe(true)
    const original = (await host.snapshot()).threads[0]!, users = original.messages.filter(message => message.role === 'user')
    expect(users).toHaveLength(2)
    expect(await host.rollbackThread(original.id, 1, users.map(message => message.id))).toEqual({ accepted: true })
    const before = (await host.snapshot()).threads[0]!
    expect(before.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual([users[0]!.id])
    expect(before.messages.some(message => message.id === users[1]!.id)).toBe(false)
    expect(before.historyEpoch).toBeTruthy()
    host.disconnect(); await host.closed(); host = new ClaudeStreamJsonHost({ userDataPath: root })
    expect((await host.connect()).connected).toBe(true)
    const after = (await host.snapshot()).threads[0]!
    expect(after.messages).toEqual(before.messages); expect(after.historyEpoch).toBe(before.historyEpoch)
    evidence.preservedSottoId = after.id === original.id; evidence.retainedUsers = after.messages.filter(message => message.role === 'user').map(message => message.id)
    evidence.messages = after.messages; evidence.historyEpoch = after.historyEpoch; evidence.sameAfterRestart = true
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error }
  finally {
    host.disconnect(); await host.closed(); await mkdir('artifacts/phase-four-native-chats', { recursive: true })
    await writeFile('artifacts/phase-four-native-chats/claude-rollback.json', JSON.stringify(evidence, null, 2))
  }
}, 45000)
