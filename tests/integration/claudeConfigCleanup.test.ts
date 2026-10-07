// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) }
})

describe('Claude configuration cleanup', () => {
  let f: Awaited<ReturnType<typeof claudeFixture>> | undefined
  afterEach(async () => { vi.mocked(rm).mockReset(); vi.mocked(writeFile).mockReset(); if (f) await f.cleanup() })
  const setup = async () => {
    f = await claudeFixture(undefined, 2000, undefined, { logEvent: vi.fn() })
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    f.adapter.useBrowserTools({ definitions: [], call: async () => ({ content: [] }), mcpServer: async () => ({ name: 'sotto_browser', type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: [] }) })
    return f
  }
  const create = async () => f!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f!.projectId, title: 'Cleanup', modelId: f!.modelId })
  it('removes leftover configuration files before reconnect launches and keeps other files', async () => {
    await setup(); await create()
    const leftover = join(f!.root, 'claude-mcp-leftover.json')
    const unrelated = join(f!.root, 'claude-other.json')
    await writeFile(leftover, '{}'); await writeFile(unrelated, '{}')
    f!.host.observeThreads?.((await f!.host.snapshot()).threads.map(thread => thread.id))
    await f!.host.connect()
    await expect(readFile(leftover)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(unrelated, 'utf8')).toBe('{}')
    expect((await readdir(f!.root)).filter(name => /^claude-mcp-.*\.json$/.test(name))).toHaveLength(1)
  })
  it.each(['EBUSY', 'EPERM'])('keeps reconnect usable when configuration removal fails with %s', async code => {
    await setup(); await create()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes('claude-mcp-')) throw Object.assign(new Error('Private path must not be logged'), { code })
      return actual.rm(path, options)
    })
    await expect(f!.host.connect()).resolves.toMatchObject({ connected: true })
    const removals = vi.mocked(rm).mock.calls.filter(([path]) => String(path).includes('claude-mcp-'))
    expect(removals.length).toBeGreaterThan(0)
    for (const [, options] of removals) expect(options).toMatchObject({ force: true, maxRetries: 3 })
    const log = (f!.adapter as unknown as { options: { logEvent: ReturnType<typeof vi.fn> } }).options.logEvent
    expect(log.mock.calls).toContainEqual(['claude-mcp-config-cleanup-failed'])
    expect(log.mock.calls.every(call => call.length === 1 && !String(call[0]).includes(f!.root))).toBe(true)
  })
  it('preserves the configuration write error when cleanup also fails', async () => {
    await setup()
    const id = randomUUID()
    await f!.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f!.projectId, title: 'Write failure', modelId: f!.modelId })
    f!.host.disconnect(); await f!.adapter.closed()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const launchError = new Error('Configuration write failed')
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      if (String(path).includes('claude-mcp-')) throw launchError
      return actual.writeFile(path, data, options)
    })
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes('claude-mcp-')) throw new Error('Cleanup failed')
      return actual.rm(path, options)
    })
    await expect((f!.adapter as unknown as { start(id: string): Promise<unknown> }).start(id)).rejects.toBe(launchError)
  })
})
