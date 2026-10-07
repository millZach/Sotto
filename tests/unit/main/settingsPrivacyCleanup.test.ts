// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { cleanSettingsHistory } from '../../../src/main/settings/privacyCleanup'

it('finishes settings notifications when thread privacy cleanup fails', async () => {
  const failure = new Error('Synthetic unavailable storage')
  let finish!: () => void
  const pending = new Promise<void>((_, reject) => { finish = () => reject(failure) })
  const agents = { privacyChanged: vi.fn(() => pending) }
  const notify = vi.fn(async () => undefined)
  const cleanup = cleanSettingsHistory(agents, notify)
  const rejected = cleanup.catch(error => error)
  await vi.waitFor(() => expect(agents.privacyChanged).toHaveBeenCalledOnce())
  expect(notify).not.toHaveBeenCalled()
  finish()
  expect(await rejected).toBe(failure)
  expect(notify).toHaveBeenCalledOnce()
})

it.each([false, true])('preserves privacy failure priority when notification fails (cleanup failed: %s)', async failed => {
  const privacyFailure = new Error('Synthetic failed redaction')
  const notificationFailure = new Error('Synthetic failed notification')
  const agents = { privacyChanged: vi.fn(async () => { if (failed) throw privacyFailure }) }
  const notify = vi.fn(async () => { throw notificationFailure })
  await expect(cleanSettingsHistory(agents, notify)).rejects.toBe(failed ? privacyFailure : notificationFailure)
  expect(agents.privacyChanged).toHaveBeenCalledOnce()
  expect(notify).toHaveBeenCalledOnce()
})

it('attempts thread, retired-chat and retired-answer cleanup independently and still publishes saved Settings', async () => {
  const agentFailure = new Error('thread storage unavailable')
  const agents = { privacyChanged: vi.fn(async () => { throw agentFailure }) }
  const retiredChats = vi.fn(async () => { throw new Error('chat storage unavailable') })
  const requestDrafts = vi.fn(async () => undefined)
  const notify = vi.fn(async () => undefined)
  await expect(cleanSettingsHistory(agents, notify, [retiredChats, requestDrafts])).rejects.toBe(agentFailure)
  expect(retiredChats).toHaveBeenCalledOnce()
  expect(requestDrafts).toHaveBeenCalledOnce()
  expect(notify).toHaveBeenCalledOnce()
})
