// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostFactsSource } from '../../../src/main/agents/hostFacts'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FilesService } from '../../../src/main/files/service'
import { GitChangesService } from '../../../src/main/tools/gitChanges'
import type { GitRefsPage, GitRefsRequest } from '../../../src/shared/gitRefs'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('Local engine accelerator hooks (ADR-0215 Stage 4a)', () => {
  it('tracks gitRefs refresh epochs per folder so invalidating repo A still forces refresh after reading repo B', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-git-refs-accel-'))
    const repoA = join(dir, 'repo-a')
    const repoB = join(dir, 'repo-b')
    await mkdir(repoA, { recursive: true })
    await mkdir(repoB, { recursive: true })
    cleanup.push(async () => { await rm(dir, { recursive: true, force: true }) })

    const adapter = new FakeProviderHost()
    adapter.state.projects = [
      { id: 'proj-a', providerId: 'codex', title: 'Repo A', path: repoA },
      { id: 'proj-b', providerId: 'codex', title: 'Repo B', path: repoB },
    ]
    adapter.state.threads = [
      { ...adapter.state.threads[0]!, id: 'thread-a', projectId: 'proj-a', workingDirectory: repoA },
      { ...adapter.state.threads[0]!, id: 'thread-b', projectId: 'proj-b', workingDirectory: repoB },
    ]
    const host = new WorkspaceHost(adapter, dir)
    cleanup.push(async () => { host.disconnect(); host.dispose() })

    const fallbackListRefs = vi.fn(async (): Promise<GitRefsPage> => ({
      refs: [{ name: 'fallback', current: true, isDefault: true, worktreePath: null }],
      isRepository: true,
      hasRemote: false,
      nextCursor: null,
      total: 1,
    }))
    host.setGitStatus({
      listRefs: fallbackListRefs,
      invalidate: vi.fn(),
      read: vi.fn(),
      dispose: vi.fn(),
    } as unknown as Parameters<WorkspaceHost['setGitStatus']>[0], { pollIntervalMs: () => 0 })

    await host.initialize()
    await host.connect()

    const calls: Array<{ folder: string; options: Omit<GitRefsRequest, 'threadId'> }> = []
    host.useGitRefsAccelerator(async (folder, options) => {
      calls.push({ folder, options })
      return {
        refs: [{ name: folder === repoA ? 'branch-a' : 'branch-b', current: true, isDefault: true, worktreePath: null }],
        isRepository: true,
        hasRemote: false,
        nextCursor: null,
        total: 1,
      }
    })

    // First read of each repo forces refresh: true.
    await host.listThreadRefs({ threadId: 'thread-a' })
    await host.listThreadRefs({ threadId: 'thread-b' })
    expect(calls[0]).toEqual({ folder: repoA, options: { refresh: true } })
    expect(calls[1]).toEqual({ folder: repoB, options: { refresh: true } })

    // Second read of repo A without any invalidation does NOT force refresh.
    await host.listThreadRefs({ threadId: 'thread-a' })
    expect(calls[2]).toEqual({ folder: repoA, options: {} })

    // Invalidate git status (simulating a branch change in repo A), then read repo B FIRST, then repo A.
    // Repo A MUST still force refresh: true even though repo B already read at the bumped epoch!
    await host.projectCheckoutMoved(repoA)
    await host.listThreadRefs({ threadId: 'thread-b' })
    await host.listThreadRefs({ threadId: 'thread-a' })
    expect(calls[3]).toEqual({ folder: repoB, options: { refresh: true } })
    expect(calls[4]).toEqual({ folder: repoA, options: { refresh: true } })
    expect(fallbackListRefs).not.toHaveBeenCalled()

    // When accelerator returns undefined, listThreadRefs falls back transparently to TypeScript.
    host.useGitRefsAccelerator(async () => undefined)
    const fallback = await host.listThreadRefs({ threadId: 'thread-a' })
    expect(fallback.refs[0]?.name).toBe('fallback')
    expect(fallbackListRefs).toHaveBeenCalledTimes(1)
  })

  it('enforces workspace-changed guards and falls back cleanly on FilesService, GitChangesService, and HostFactsSource', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-accel-fallback-'))
    cleanup.push(async () => { await rm(dir, { recursive: true, force: true }) })
    await writeFile(join(dir, 'hello.txt'), 'Hello fallback\n', 'utf8')
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir })

    let currentRoot = dir
    const files = new FilesService({
      resolveBinding: threadId => threadId === 't1' ? { threadId, projectId: 'p1', workingDirectory: currentRoot } : null,
      copyPath: () => undefined,
      reveal: () => undefined,
      accelerator: {
        list: async () => undefined,
        preview: async () => { throw new Error('simulated accelerator failure') },
      },
    })

    // Undefined / throwing accelerators fall back cleanly to TS.
    const listed = await files.list({ threadId: 't1', path: '' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('expected ok listing')
    const wsId = listed.value.workspace.workspaceId
    const preview = await files.preview({ threadId: 't1', workspaceId: wsId, path: 'hello.txt' })
    expect(preview.ok).toBe(true)
    if (preview.ok && preview.value.content.kind === 'text') {
      expect(preview.value.content.text).toBe('Hello fallback\n')
    }

    // If binding changes mid-accelerator call, FilesService rejects with workspace-changed.
    const otherDir = await mkdtemp(join(tmpdir(), 'sotto-accel-moved-'))
    cleanup.push(async () => { await rm(otherDir, { recursive: true, force: true }) })
    files.useAccelerator({
      list: async ws => {
        currentRoot = otherDir
        return { ok: true, value: { workspace: ws, path: '', entries: [], truncated: false } }
      },
      preview: async () => undefined,
    })
    const moved = await files.list({ threadId: 't1', workspaceId: wsId, path: '' })
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.error.code).toBe('workspace-changed')
    currentRoot = dir
    files.useAccelerator(undefined)

    // GitChangesService falls back cleanly when accelerator returns undefined.
    const gitChanges = new GitChangesService({
      files,
      copyPath: () => undefined,
      reveal: () => undefined,
      emit: () => undefined,
      accelerator: {
        list: async () => undefined,
        review: async () => undefined,
      },
    })
    cleanup.push(async () => { gitChanges.dispose() })
    const changes = await gitChanges.list({ threadId: 't1', workspaceId: wsId })
    expect(changes.ok).toBe(true)
    if (changes.ok) expect(changes.value.files.some(f => f.path === 'hello.txt')).toBe(true)

    // HostFactsSource falls back cleanly when accelerator rejects or returns undefined.
    const facts = new HostFactsSource()
    facts.useAccelerator(async () => undefined)
    const read = await facts.read()
    expect(read.logicalCpuCount).toBeGreaterThanOrEqual(1)
    expect(read.totalMemoryBytes).toBeGreaterThan(0)
  })
})
