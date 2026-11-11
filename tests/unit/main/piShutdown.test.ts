// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PiHost } from '../../../src/main/agents/pi'
import { PiAccounts } from '../../../src/main/agents/piAccounts'
import { PiSignIn } from '../../../src/main/agents/piSignIn'
import { PiTools } from '../../../src/main/agents/piTools'
import { deferred } from '../../fixtures/deferred'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-pi-shutdown-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('drains a later tool gateway even when an earlier disconnect failed', async () => {
  const host = new PiHost(await directory()), release = deferred()
  const failure = new Error('First gateway failed')
  vi.spyOn(PiTools.prototype, 'close').mockRejectedValueOnce(failure).mockReturnValueOnce(release.promise).mockResolvedValue(undefined)
  host.disconnect(); host.disconnect()
  let finished = false
  const closing = host.closed().finally(() => { finished = true })
  const assertion = expect(closing).rejects.toBe(failure)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(finished).toBe(false)
  } finally { release.resolve(); await assertion }
})

it('waits for every sign-in cancellation before reporting one cancellation failure', async () => {
  const firstEnded = deferred<boolean>(), secondEnded = deferred<boolean>(), kill = vi.fn()
  const ended = [firstEnded, secondEnded]
  const accounts = new PiAccounts(await directory(), async () => ({ executable: 'unused', args: [], env: {} }))
  const service = new PiSignIn(accounts, { changed: async () => undefined, openExternal: async () => undefined,
    spawn: async (_program, _args, _cwd, output) => {
      const completion = ended.shift()!
      output('Open this URL to sign in: https://auth.openai.com/login\n')
      return { write: () => undefined, kill, ended: completion.promise }
    } })
  const first = await service.startBrowserSignIn({ sourceId: 'openai', methodId: 'browser' })
  expect(first.status).toBe('waiting')
  if (first.status !== 'waiting') throw new Error('Expected the first sign-in page')
  firstEnded.resolve(false)
  await new Promise<void>(resolve => setImmediate(resolve))
  const second = await service.startBrowserSignIn({ sourceId: 'openai', methodId: 'browser' })
  expect(second.status).toBe('waiting')
  const cancel = service.cancel.bind(service), failure = new Error('First cancellation failed')
  const cancelMock = vi.spyOn(service, 'cancel').mockImplementation(async input => {
    if ((input as { attemptId: string }).attemptId === first.attempt.id) throw failure
    return cancel(input)
  })
  let finished = false
  const closing = service.close().finally(() => { finished = true })
  const assertion = expect(closing).rejects.toBe(failure)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(kill).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
  } finally {
    secondEnded.resolve(false); await assertion
    cancelMock.mockRestore(); await service.close()
  }
})
