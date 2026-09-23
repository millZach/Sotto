// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadHostIdentity, migrateWorkspaceHost } from '../../../src/main/agents/hostIdentity'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { EMPTY_AGENT_HOST } from '../../../src/shared/agents'

const directories: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'sotto-host-id-')); directories.push(path); return path }
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const workspace = () => ({ snapshot: { ...EMPTY_AGENT_HOST,
  projects: [{ id: 'p', title: 'Project', path: '/work' }],
  threads: [{ id: 't', projectId: 'p', title: 'Task', modelId: 'm', status: 'idle', messages: [], requests: [] }] },
  creations: [], projectAliases: [], preserved: 'unknown field' })

it('mints once, survives restart and converges across concurrent first starts', async () => {
  const path = await directory()
  const ids = await Promise.all(Array.from({ length: 8 }, () => loadHostIdentity(path)))
  expect(new Set(ids).size).toBe(1)
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u)
  expect(await loadHostIdentity(path)).toBe(ids[0])
  expect(JSON.parse(await readFile(join(path, 'host.json'), 'utf8'))).toEqual({ hostId: ids[0] })
})
it('refuses a corrupt identity without replacing it', async () => {
  const path = await directory(); await writeFile(join(path, 'host.json'), '{broken')
  await expect(loadHostIdentity(path)).rejects.toThrow()
  expect(await readFile(join(path, 'host.json'), 'utf8')).toBe('{broken')
})
it('stamps legacy entities atomically and performs no write on the next migration', async () => {
  const path = await directory(); const hostId = await loadHostIdentity(path)
  await writeFile(join(path, 'workspace.json'), JSON.stringify(workspace()))
  await migrateWorkspaceHost(path, hostId)
  const saved = JSON.parse(await readFile(join(path, 'workspace.json'), 'utf8')) as ReturnType<typeof workspace> & { snapshot: { hostId: string } }
  expect(saved.snapshot).toMatchObject({ hostId, projects: [{ hostId }], threads: [{ hostId }] })
  expect(saved.preserved).toBe('unknown field')
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
  await migrateWorkspaceHost(path, hostId)
  expect(write).not.toHaveBeenCalled()
})
it('leaves workspace bytes untouched after a refused write, corrupt snapshot or foreign host', async () => {
  const path = await directory(); const hostId = await loadHostIdentity(path)
  const original = JSON.stringify(workspace(), null, 4)
  await writeFile(join(path, 'workspace.json'), original)
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk unavailable'))
  await expect(migrateWorkspaceHost(path, hostId)).rejects.toThrow('Disk unavailable')
  expect(await readFile(join(path, 'workspace.json'), 'utf8')).toBe(original)
  for (const raw of ['{broken', JSON.stringify({ ...workspace(), snapshot: { ...workspace().snapshot, hostId: '22222222-2222-4222-8222-222222222222' } })]) {
    await writeFile(join(path, 'workspace.json'), raw)
    await expect(migrateWorkspaceHost(path, hostId)).rejects.toThrow()
    expect(await readFile(join(path, 'workspace.json'), 'utf8')).toBe(raw)
  }
})

it.each(['retained-corrupt', 'write-refused', 'foreign-host', 'corrupt-identity'])('preserves workspace bytes through failed startup and disposal: %s', async failure => {
  const path = await directory(); await loadHostIdentity(path)
  const original = failure === 'retained-corrupt' ? '{broken' : JSON.stringify({ ...workspace(),
    snapshot: { ...workspace().snapshot, ...(failure === 'foreign-host' ? { hostId: '22222222-2222-4222-8222-222222222222' } : {}) } })
  await writeFile(join(path, 'workspace.json'), original)
  if (failure === 'corrupt-identity') await writeFile(join(path, 'host.json'), '{broken')
  if (failure === 'write-refused') vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk unavailable'))
  const host = new WorkspaceHost(new FakeProviderHost(), path, () => failure === 'retained-corrupt')
  await expect(host.initialize()).rejects.toThrow()
  host.disconnect(); host.dispose()
  expect(await readFile(join(path, 'workspace.json'), 'utf8')).toBe(original)
})
