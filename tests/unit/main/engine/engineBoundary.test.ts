// @vitest-environment node
/**
 * The Phase 1 desktop engine boundary (ADR-0210): nothing under `src/main/engine/` may import Electron,
 * the cached `FilesBindingsMirror` / `FilesBindingsTracker` emits only real folder/title changes,
 * `EngineIpcRegistry` routes authenticated role calls without Electron, and the pure-Node picture helpers
 * handle thumbnails and metadata-free photo redraws.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { write as writePng } from 'pngjs/lib/png-sync'
import { FilesBindingsMirror, FilesBindingsTracker } from '../../../../src/main/engine/filesBindingsMirror'
import { EngineIpcRegistry } from '../../../../src/main/engine/ipcRegistry'
import { isAuthorizedIpcSender } from '../../../../src/main/ipc/registerIpc'
import { pictureRedraw, pictureThumbnail } from '../../../../src/host/pictureCopy'
import type { AgentHostSnapshot, AgentProject, AgentThread } from '../../../../src/shared/agents'

function walkTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walkTsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) results.push(full)
  }
  return results
}

function makePngDataUrl(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 40
    data[i + 1] = 120
    data[i + 2] = 200
    data[i + 3] = 255
  }
  const encoded = writePng({ width, height, data }, { colorType: 6, inputColorType: 6, inputHasAlpha: true })
  return `data:image/png;base64,${encoded.toString('base64')}`
}

function makeThread(overrides: Partial<AgentThread> & { id: string; projectId: string; title: string }): AgentThread {
  return {
    providerId: 'codex',
    status: 'idle',
    updatedAt: '2026-11-20T00:00:00.000Z',
    createdAt: '2026-11-20T00:00:00.000Z',
    messages: [],
    activities: [],
    pendingRequests: [],
    ...overrides,
  } as unknown as AgentThread
}

describe('desktop engine zero-Electron boundary (ADR-0210)', () => {
  it('forbids any import or require of electron under src/main/engine/', () => {
    const engineRoot = join(process.cwd(), 'src/main/engine')
    const offenders: string[] = []
    const pattern = /\bfrom\s+['"]electron['"]|\brequire\s*\(\s*['"]electron['"]\s*\)|\bimport\s*\(\s*['"]electron['"]\s*\)/u
    for (const file of walkTsFiles(engineRoot)) {
      const source = readFileSync(file, 'utf8')
      if (pattern.test(source)) offenders.push(relative(process.cwd(), file))
    }
    expect(offenders).toEqual([])
  })
})

describe('FilesBindingsTracker and FilesBindingsMirror', () => {
  it('tracks incremental local binding, project folder, title and deletion deltas', () => {
    const tracker = new FilesBindingsTracker()
    const mirror = new FilesBindingsMirror()
    const projectA: AgentProject = { id: 'p1', title: 'Repo', path: '/repo' }
    const thread1 = makeThread({ id: 't1', projectId: 'p1', title: 'First title', workingDirectory: '/repo/wt1' })
    const host1 = { projects: [projectA], threads: [thread1] } as unknown as AgentHostSnapshot

    const initial = tracker.syncLocal(host1)
    expect(initial).not.toBeNull()
    mirror.apply(initial!)
    expect(mirror.projectFolder('p1')).toBe('/repo')
    expect(mirror.threadTitle('t1')).toBe('First title')
    expect(mirror.resolveBinding('t1')).toMatchObject({ threadId: 't1', projectId: 'p1', workingDirectory: '/repo/wt1' })

    // Unchanged array references emit zero delta.
    expect(tracker.syncLocal(host1)).toBeNull()

    // Same thread object reference in a new array emits zero delta.
    const hostSameRef = { projects: host1.projects, threads: [thread1] } as unknown as AgentHostSnapshot
    expect(tracker.syncLocal(hostSameRef)).toBeNull()

    // Title-only change emits only threadTitles, not bindings or projectFolders.
    const thread1Renamed = { ...thread1, title: 'Renamed' }
    const renameDelta = tracker.syncLocal({ projects: host1.projects, threads: [thread1Renamed] } as unknown as AgentHostSnapshot)
    expect(renameDelta).toEqual({ threadTitles: { t1: 'Renamed' } })
    mirror.apply(renameDelta!)
    expect(mirror.threadTitle('t1')).toBe('Renamed')

    // Removing the thread clears its cached binding and title.
    const removeDelta = tracker.syncLocal({ projects: host1.projects, threads: [] } as unknown as AgentHostSnapshot)
    expect(removeDelta).toEqual({ bindings: { t1: null }, threadTitles: { t1: null } })
    mirror.apply(removeDelta!)
    expect(mirror.resolveBinding('t1')).toBeNull()
    expect(mirror.threadTitle('t1')).toBe('t1')
  })

  it('tracks hosted terminal folders and SSH hosts and supports full reset snapshots', () => {
    const tracker = new FilesBindingsTracker()
    const mirror = new FilesBindingsMirror()
    const delta = tracker.syncHosted(
      ['host:h1:t1'],
      id => id === 'host:h1:t1' ? { hostId: 'h1', projectId: 'p1', workingDirectory: '/srv/wt', projectFolder: '/srv/repo' } : undefined,
      [['h1', { target: 'dev@forge', sshPort: 2222 }]],
    )
    expect(delta).not.toBeNull()
    mirror.apply(delta!)
    expect(mirror.hostedThreadFolders('host:h1:t1')).toEqual({ hostId: 'h1', projectId: 'p1', workingDirectory: '/srv/wt', projectFolder: '/srv/repo' })
    expect(mirror.terminalHost('h1')).toEqual({ target: 'dev@forge', sshPort: 2222 })

    // Identical hosted state emits null.
    expect(tracker.syncHosted(
      ['host:h1:t1'],
      () => ({ hostId: 'h1', projectId: 'p1', workingDirectory: '/srv/wt', projectFolder: '/srv/repo' }),
      [['h1', { target: 'dev@forge', sshPort: 2222 }]],
    )).toBeNull()

    const mirror2 = new FilesBindingsMirror()
    mirror2.apply(tracker.snapshot())
    expect(mirror2.terminalHost('h1')).toEqual({ target: 'dev@forge', sshPort: 2222 })
  })
})

describe('EngineIpcRegistry', () => {
  it('authorizes main vs popup roles through registerIpc helpers without Electron', async () => {
    const registry = new EngineIpcRegistry()
    registry.handle('test:main-only', (event, value) => {
      if (!isAuthorizedIpcSender(event, registry.senders(), ['main'])) throw new Error('MAIN_ONLY')
      return `ok:${String(value)}`
    })
    expect(registry.channels()).toEqual(['test:main-only'])
    await expect(registry.invoke('test:main-only', 'main', [42])).resolves.toBe('ok:42')
    await expect(registry.invoke('test:main-only', 'popup', [42])).rejects.toThrow('MAIN_ONLY')
    registry.removeHandler('test:main-only')
    await expect(registry.invoke('test:main-only', 'main', [42])).rejects.toThrow('ENGINE_IPC_CHANNEL_UNAVAILABLE')
  })
})

describe('pure-Node desktop picture helpers (ADR-0210)', () => {
  it('scales large PNGs into JPEG tile thumbnails and leaves small ones untouched', () => {
    const small = makePngDataUrl(64, 48)
    expect(pictureThumbnail(small, 208, 140)).toBe(small)

    const large = makePngDataUrl(800, 600)
    const thumb = pictureThumbnail(large, 208, 140)
    expect(thumb).toMatch(/^data:image\/jpeg;base64,/u)
  })

  it('redraws PNG pixels cleanly without retaining source metadata', () => {
    const png = makePngDataUrl(32, 24)
    const redrawn = pictureRedraw(png, 'image/png')
    expect(redrawn).not.toBeNull()
    expect(redrawn?.kind).toBe('image/png')
    expect(redrawn?.dataUrl).toMatch(/^data:image\/png;base64,/u)
  })
})
