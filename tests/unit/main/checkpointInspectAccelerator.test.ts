// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FilesService } from '../../../src/main/files/service'
import { CheckpointService } from '../../../src/main/tools/checkpoints'
import type { CheckpointInspectAccelerator, CheckpointThread } from '../../../src/main/tools/checkpointTypes'

function initRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env })
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env })
}

describe('CheckpointService inspectAccelerator offload and fallback', () => {
  it('offloads blob verification to inspectAccelerator, preserves integrity refusal, and falls back transparently on transport loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-cp-accel-'))
    const repo = join(root, 'repo')
    const data = join(root, 'checkpoints')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'app.txt'), 'before\n', 'utf8')
    initRepo(repo)

    const files = new FilesService({
      resolveBinding: () => ({ threadId: 't-1', projectId: 'p-1', workingDirectory: repo }),
      copyPath: () => undefined,
      reveal: () => undefined,
      open: async () => undefined,
    })
    const resolvedWs = await files.resolveWorkspace('t-1')
    expect(resolvedWs.ok).toBe(true)
    if (!resolvedWs.ok) throw new Error('expected ok workspace')
    const workspaceId = resolvedWs.value.workspaceId

    let userMessages = ['u1']
    const resolveThread = async (): Promise<CheckpointThread> => ({
      threadId: 't-1',
      providerId: 'codex',
      bindingId: 'codex:b1',
      userMessageIds: [...userMessages],
      busy: false,
      running: false,
      rollbackSupported: true,
    })

    let acceleratorImpl: CheckpointInspectAccelerator = async () => undefined
    const acceleratorSpy = vi.fn<CheckpointInspectAccelerator>((blobsDir, pairs) => acceleratorImpl(blobsDir, pairs))

    const service = new CheckpointService({
      files,
      directory: data,
      resolveThread,
      rollback: async () => ({ accepted: true }),
      refresh: async () => undefined,
      inspectAccelerator: acceleratorSpy,
    })

    try {
      await service.initialize()
      await service.beforeTurn('t-1')
      await writeFile(join(repo, 'app.txt'), 'after\n', 'utf8')
      userMessages = ['u1', 'u2']
      await service.afterTurn('t-1')

      const listed = await service.checkpoints({ threadId: 't-1', workspaceId })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error('expected ok listing')
      const checkpointId = listed.value.checkpoints[0]!.id

      // 1. Accelerated path succeeds without reading blobs in TS.
      acceleratorImpl = async (blobsDir, pairs) => {
        expect(blobsDir).toBe(join(data, 'blobs'))
        expect(pairs).toHaveLength(1)
        expect(pairs[0]!.path).toBe('app.txt')
        expect(pairs[0]!.beforeHash).toMatch(/^[a-f0-9]{64}$/)
        expect(pairs[0]!.afterHash).toMatch(/^[a-f0-9]{64}$/)
        return {
          ok: true,
          value: [{ path: 'app.txt', before: 'before\n', after: 'after\n', binary: false }],
        }
      }
      const accelerated = await service.inspectCheckpoint({ threadId: 't-1', workspaceId, checkpointId })
      expect(accelerated.ok).toBe(true)
      if (accelerated.ok) {
        expect(accelerated.value.patches).toEqual([
          { path: 'app.txt', before: 'before\n', after: 'after\n', binary: false },
        ])
      }
      expect(acceleratorSpy).toHaveBeenCalledTimes(1)

      // 2. Integrity refusal (`blocked`) from accelerator is propagated, never swallowed by fallback.
      acceleratorImpl = async () => ({
        ok: false,
        error: { code: 'blocked', message: 'A checkpoint file backup failed its integrity check.' },
      })
      const tampered = await service.inspectCheckpoint({ threadId: 't-1', workspaceId, checkpointId })
      expect(tampered.ok).toBe(false)
      if (!tampered.ok) {
        expect(tampered.error.code).toBe('blocked')
      }

      // 3. Transport failure (`undefined` or thrown error) transparently falls back to TS blob reading.
      acceleratorImpl = async () => { throw new Error('transport closed') }
      const fallback = await service.inspectCheckpoint({ threadId: 't-1', workspaceId, checkpointId })
      expect(fallback.ok).toBe(true)
      if (fallback.ok) {
        expect(fallback.value.patches).toEqual([
          { path: 'app.txt', before: 'before\n', after: 'after\n', binary: false },
        ])
      }
    } finally {
      service.dispose()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
