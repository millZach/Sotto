// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

for (const [provider, factory, nativeKey] of [
  ['codex', codexFixture, 'codexThreadId'],
  ['claude', claudeFixture, 'sessionId'],
  ['grok', grokFixture, 'grokSessionId'],
] as const) {
  it(`${provider} leaves legacy personal aliases on disk without opening or exposing them`, async () => {
    const f = await factory()
    try {
      const id = randomUUID(), nativeId = randomUUID()
      const file = join(f.root, `${provider}-threads.json`)
      const legacy = { [nativeKey]: nativeId, kind: 'personal', cwd: f.root, title: 'Saved chat', modelId: f.modelId,
        createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [],
        ...(provider !== 'grok' ? { compaction: { commandId: randomUUID(), status: 'running' } } : {}),
        ...(provider === 'codex' ? { messageIdentities: [] } : {}), ...(provider === 'grok' ? { settingsConfirmed: true } : {}) }
      const stored = JSON.stringify({ [id]: legacy })
      await writeFile(file, stored)
      f.host.observeThreads?.([id])
      expect((await f.host.connect()).threads).toEqual([])
      f.host.observeThreads?.([id])
      expect((await f.host.snapshot()).threads).toEqual([])
      await expect(f.host.refreshThread?.(id)).rejects.toThrow('unavailable')
      await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id,
        projectId: f.projectId, modelId: f.modelId, title: 'Reused ID' })).rejects.toThrow('unavailable')
      expect(await readFile(file, 'utf8')).toBe(stored)
      expect((await f.driver.requests()).some(request => ['thread/resume', 'resume', 'session/load'].includes(request.method ?? ''))).toBe(false)
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(),
        projectId: f.projectId, modelId: f.modelId, title: 'Project thread' })
      expect(JSON.parse(await readFile(file, 'utf8'))[id]).toEqual(legacy)
    } finally { await f.cleanup() }
  })
}
