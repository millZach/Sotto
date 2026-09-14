// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'

it.runIf(process.env.SOTTO_NATIVE_CODEX_REWIND === '1')('rewinds a completed owned native Codex turn and resumes the same conversation after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-codex-rewind-native-'))
  let host = new CodexAppServerHost({ userDataPath: directory, requestTimeoutMs: 15000 })
  const evidence: Record<string, unknown> = { directory, checkedAt: new Date().toISOString(), syntheticTurns: 2 }
  try {
    const connected = await host.connect()
    expect(connected.connected, connected.error).toBe(true)
    evidence.version = connected.version
    await host.execute({ type: 'create-project', commandId: 'project', projectId: 'owned', title: 'Synthetic rewind', path: directory })
    await host.execute({ type: 'create-thread', commandId: 'create', threadId: 'owned-thread', projectId: 'owned', title: 'Synthetic rewind check', modelId: 'gpt-6-astra', reasoningEffort: 'low', runtimeMode: 'approval-required' })
    for (const id of ['first', 'second']) {
      await host.execute({ type: 'send', commandId: id, threadId: 'owned-thread', messageId: id, text: `Synthetic native rewind check ${id}. Reply exactly SOTTO_REWIND_${id.toUpperCase()}. Do not call tools, read files, browse, delegate, or change anything.` })
      await expect.poll(async () => (await host.snapshot()).threads[0]!.status, { timeout: 60000, interval: 250 }).toBe('idle')
      await host.refreshThread('owned-thread')
    }
    const before = (await host.snapshot()).threads[0]!
    evidence.before = before.messages
    const nativeId = JSON.parse(await readFile(join(directory, 'codex-threads.json'), 'utf8'))['owned-thread'].codexThreadId
    const result = await host.rollbackThread('owned-thread', 1, before.messages.filter(message => message.role === 'user').map(message => message.id))
    evidence.rollback = result
    expect(result).toEqual({ accepted: true })
    const after = (await host.refreshThread('owned-thread')).threads[0]!
    expect(after.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(after.messages.some(message => message.role === 'assistant' && message.text.includes('SOTTO_REWIND_FIRST'))).toBe(true)
    expect(after.messages.some(message => message.text.includes('SOTTO_REWIND_SECOND'))).toBe(false)
    host.disconnect(); await host.closed()
    host = new CodexAppServerHost({ userDataPath: directory })
    await host.connect(); const restored = (await host.refreshThread('owned-thread')).threads[0]!
    expect(restored.messages.map(message => [message.id, message.role, message.text])).toEqual(after.messages.map(message => [message.id, message.role, message.text]))
    expect(JSON.parse(await readFile(join(directory, 'codex-threads.json'), 'utf8'))['owned-thread'].codexThreadId).toBe(nativeId)
    evidence.after = after.messages; evidence.restored = restored.messages; evidence.sameNativeId = true
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error }
  finally {
    host.disconnect(); await host.closed()
    await mkdir('artifacts/phase-four-checkpoints', { recursive: true })
    await writeFile('artifacts/phase-four-checkpoints/codex-native.json', JSON.stringify(evidence, null, 2))
  }
}, 180000)
