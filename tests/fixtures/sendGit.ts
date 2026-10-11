import { initializeGitRepository, initializeBareGitRepository } from './gitRepository'
/**
 * A send and Git (issue #766), shared by the test that gates it and the benchmark that measures it so both count a
 * send the same way: the fake provider's project as a real repository with an origin, a thread on it, and a send
 * timed and counted up to the moment the provider hears the prompt. A test that counts installs
 * `gitSpawnCounter.ts` in its own `vi.mock`.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { runWorktreeGit as git } from '../../src/main/agents/threadWorktrees'
import { gitSpawns } from './gitSpawnCounter'
import { workspaceFixture } from './workspaceFixture'

export type SendGitFixture = Awaited<ReturnType<typeof workspaceFixture>> & { readonly project: string }

/**
 * The host refreshes a folder this long after a turn's work finishes. Here it never fires inside a test: it would
 * only add its own Git processes to whichever send happened to be under way.
 */
const NO_REFRESH_AFTER_TURN_MS = 600_000

/** The fake provider's project as a real repository with one commit and an origin it was pushed to. */
export async function repositoryWithOrigin(): Promise<SendGitFixture> {
  const f = await workspaceFixture(undefined, { worktreeRefreshDelayMs: NO_REFRESH_AFTER_TURN_MS })
  const project = f.adapters.codex.state.projects[0]!.path
  const origin = join(f.root, 'origin.git'); await mkdir(origin)
  await initializeBareGitRepository(origin)
  await initializeGitRepository(project)
  await git(project, ['remote', 'add', 'origin', origin])
  await git(project, ['push', '-u', 'origin', 'main'])
  return { ...f, project }
}

/**
 * A thread on the project whose first send set up its working copy, idle again, with the inspection that send
 * owes finished: a refresh waits in the thread's lane behind it.
 */
export async function startedThread(f: SendGitFixture, threadId: string, workingCopy: 'shared' | 'independent'): Promise<void> {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: `create-${threadId}`, threadId, projectId: project.id, title: threadId, modelId: model.id, workingCopy })
  await sendAndCount(f, threadId, 0)
  await idle(f, threadId)
  await f.host.updateThreadWorktree(threadId, false)
}

/** Every provider session idle, as after a turn, and the host's record of the thread saying so. */
export async function idle(f: SendGitFixture, threadId: string): Promise<void> {
  for (const session of f.adapters.codex.state.threads) session.status = 'idle'
  f.adapters.codex.emit()
  await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(item => item.id === threadId)?.status).toBe('idle'))
}

/** One send: milliseconds until the provider heard it, and the Git processes started in between. */
export async function sendAndCount(f: SendGitFixture, threadId: string, index: number): Promise<{ ms: number; git: number; heard: boolean }> {
  let heardAt: number | undefined, gitAtHearing = 0
  const execute = f.adapters.codex.execute.bind(f.adapters.codex)
  const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send') { heardAt = performance.now(); gitAtHearing = gitSpawns.count }
    return execute(command)
  })
  const before = gitSpawns.count
  const startedAt = performance.now()
  try {
    await f.host.execute({ type: 'send', commandId: `send-${index}`, threadId, messageId: `message-${index}`, text: 'Synthetic prompt' })
  } finally { spy.mockRestore() }
  return heardAt === undefined ? { ms: Number.NaN, git: Number.NaN, heard: false } : { ms: heardAt - startedAt, git: gitAtHearing - before, heard: true }
}
