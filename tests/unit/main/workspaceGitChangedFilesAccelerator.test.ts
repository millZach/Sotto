// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitStatusReader } from '../../../src/main/agents/git/gitStatus'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { GitChangedFiles } from '../../../src/shared/gitChangedFiles'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('WorkspaceHost accelerated gitChangedFiles worktree-removal guard (#766, ADR-0215)', () => {
  it('tracks in-flight accelerated gitChangedFiles so GitStatusReader.idle() waits for it and hold() skips Rust', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-git-changed-idle-'))
    const repo = join(dir, 'repo')
    await import('node:fs/promises').then(fs => fs.mkdir(repo, { recursive: true }))
    cleanup.push(async () => { await rm(dir, { recursive: true, force: true }) })

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    await writeFile(join(repo, 'a.txt'), 'hello\n', 'utf8')

    const adapter = new FakeProviderHost()
    adapter.state.projects = [{ id: 'proj-1', providerId: 'codex', title: 'Repo', path: repo }]
    adapter.state.threads = [{ ...adapter.state.threads[0]!, id: 'thread-1', projectId: 'proj-1', workingDirectory: repo }]

    const host = new WorkspaceHost(adapter, dir)
    cleanup.push(async () => { host.disconnect(); host.dispose() })

    const gitStatus = new GitStatusReader({ fetchIntervalMs: () => 0 })
    cleanup.push(async () => { await gitStatus.stop() })
    host.setGitStatus(gitStatus, { pollIntervalMs: () => 0 })

    await host.initialize()
    await host.connect()

    let releaseAccel!: (value: GitChangedFiles) => void
    let accelStarted = false
    let accelCalls = 0
    host.useGitChangedFilesAccelerator(() => {
      accelCalls++
      accelStarted = true
      return new Promise<GitChangedFiles>(resolve => { releaseAccel = resolve })
    })

    // 1. Start an accelerated changed-files read and hold it open.
    const readPromise = host.listThreadChangedFiles({ threadId: 'thread-1' })
    while (!accelStarted) await new Promise(r => setTimeout(r, 5))

    // 2. GitStatusReader.idle(repo) MUST wait until the accelerated call settles.
    let idleResolved = false
    const idlePromise = gitStatus.idle(repo).then(() => { idleResolved = true })
    await new Promise(r => setTimeout(r, 40))
    expect(idleResolved).toBe(false)

    releaseAccel({
      isRepository: true,
      files: [{ path: 'a.txt', status: 'untracked', insertions: 1, deletions: 0 }],
      truncated: false,
    })
    const result = await readPromise
    await idlePromise
    expect(idleResolved).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(accelCalls).toBe(1)

    // 3. While hold(repo) is active (reclaim in progress), runInFolder skips starting the Rust accelerator
    //    and falls back to GitStatusReader's own tracked listChangedFiles.
    const releaseHold = gitStatus.hold(repo)
    try {
      const heldResult = await host.listThreadChangedFiles({ threadId: 'thread-1' })
      expect(accelCalls).toBe(1)
      expect(heldResult.isRepository).toBe(true)
      expect(heldResult.files.some(f => f.path === 'a.txt')).toBe(true)
    } finally {
      releaseHold()
    }
  })
})
