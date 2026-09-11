// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { T3CodeHost } from '../../../src/main/agents/t3'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('can acknowledge creation while a joined shell snapshot still predates the project', async () => {
  vi.useFakeTimers()
  const host = new T3CodeHost()
  const path = 'C:\\synthetic\\Codex'
  const project = { id: 'requested-id', title: 'Codex', workspaceRoot: path }
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  let releaseAcknowledgement!: () => void
  const acknowledgementGate = new Promise<void>(done => { releaseAcknowledgement = done })
  let readStarted!: () => void
  const started = new Promise<void>(done => { readStarted = done })
  let created = false
  const transport = host as unknown as { request(path: string, init?: RequestInit): Promise<unknown>; rpc(tag: string, input: unknown): Promise<unknown> }
  const request = vi.spyOn(transport, 'request').mockImplementation(async (route, init) => {
    if (route === '/api/orchestration/shell') {
      const projects = created ? [project] : []
      if (!created) { readStarted(); await gate }
      else await acknowledgementGate
      return { snapshotSequence: projects.length, projects, threads: [] }
    }
    if (route === '/api/orchestration/dispatch') {
      expect(JSON.parse(String(init?.body))).toMatchObject({ type: 'project.create', projectId: project.id, workspaceRoot: path, createWorkspaceRootIfMissing: false })
      created = true
      // T3's shipped DispatchResult is { sequence }, not a project receipt.
      return { sequence: 1 }
    }
    throw new Error(`Unexpected transport request: ${route}`)
  })
  vi.spyOn(transport, 'rpc').mockResolvedValue({ providers: [] })
  host['connected'] = true
  try {
    const beforeCreation = host.snapshot()
    await started
    expect(await host.execute({ type: 'create-project', commandId: 'command', projectId: project.id, title: project.title, path })).toEqual({ accepted: true })
    const acknowledgementSnapshot = host.snapshot()
    release()
    await beforeCreation
    expect((await acknowledgementSnapshot).projects).toEqual([])
    releaseAcknowledgement()
    expect((await host.snapshot()).projects).toEqual([{ id: project.id, title: project.title, path }])
    expect(request.mock.calls.filter(([route]) => route === '/api/orchestration/dispatch')).toHaveLength(1)
  } finally { release(); releaseAcknowledgement(); host.disconnect() }
})
