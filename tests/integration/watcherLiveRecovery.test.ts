// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { CodexAppServerHost } from '../../src/main/agents/codex'
import { recoverWatcherLiveCodex } from '../fixtures/watcherLiveRecovery'

const prefix = 'sotto-watcher-recovery-'
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), prefix)), data = await mkdtemp(join(tmpdir(), `${prefix}data-`))
  const date = new Date().toISOString(), id = randomUUID()
  const row = { id: 'same-synthetic-native-session', cwd: join(root, 'project'), createdAt: Math.floor(Date.parse(date) / 1000) }
  const methods: string[] = []
  const host = (rows: typeof row[]) => ({ rpc: async (method: string, _params: unknown, apply: (value: unknown) => void) => { methods.push(method); apply({ data: rows, nextCursor: null }) } }) as unknown as CodexAppServerHost
  const options = { date, data, id, projectId: randomUUID(), modelId: 'synthetic-model', prefix, sentinel: 'UNCHANGED', marker: 'synthetic-read-marker' }
  const cleanup = async () => {
    for (const owned of [root, data]) {
      if (dirname(resolve(owned)) !== resolve(tmpdir()) || !owned.split(/[\\/]/u).at(-1)?.startsWith(prefix)) throw new Error('recovery-test-cleanup-refused')
      await rm(owned, { recursive: true, force: true })
    }
  }
  return { root, data, row, methods, host, options, cleanup }
}

it('reconstructs only fixture aliases for the unique same native session without starting a thread', async () => {
  const f = await fixture()
  try {
    await rmdir(f.root)
    expect(await recoverWatcherLiveCodex(f.host([f.row]), f.options)).toBe(f.row.cwd)
    const aliases = JSON.parse(await readFile(join(f.data, 'codex-threads.json'), 'utf8'))
    expect(aliases[f.options.id].codexThreadId).toBe(f.row.id)
    expect(await readFile(join(f.row.cwd, 'sentinel.txt'), 'utf8')).toBe('UNCHANGED')
    expect(f.methods).toEqual(['thread/list'])
  } finally { await f.cleanup() }
})

it('refuses an occupied original project root', async () => {
  const f = await fixture()
  try { await expect(recoverWatcherLiveCodex(f.host([f.row]), f.options)).rejects.toThrow('live-recovery-project-occupied') }
  finally { await f.cleanup() }
})

it('refuses ambiguous sessions and sessions outside the original creation window', async () => {
  const f = await fixture()
  try {
    await expect(recoverWatcherLiveCodex(f.host([f.row, { ...f.row, id: 'another-native-session' }]), f.options)).rejects.toThrow('live-recovery-native-session-not-unique')
    await expect(recoverWatcherLiveCodex(f.host([{ ...f.row, createdAt: f.row.createdAt - 600 }]), f.options)).rejects.toThrow('live-recovery-native-session-not-unique')
    expect(f.methods).toEqual(['thread/list', 'thread/list'])
  } finally { await f.cleanup() }
})
