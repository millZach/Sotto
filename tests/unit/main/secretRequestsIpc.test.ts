// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSecretRequestsIpc } from '../../../src/main/secrets/secretRequestsIpc'
import { SecretRequests, type SecretOutcome } from '../../../src/main/secrets/secretRequests'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { SECRET_REQUESTS_ANSWER } from '../../../src/shared/secretRequests'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'
const CANARY = 'canary-ipc-91c2'
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function service(): Promise<SecretRequests> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-secrets-ipc-'))
  folders.push(directory)
  return new SecretRequests({ directory, protect: async () => undefined })
}

describe('the secret card\'s own channel (ADR-0219)', () => {
  it('registers nothing while the Owl feature is off', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerSecretRequestsIpc(ipc, undefined, () => [main], () => LOCAL)()
    expect(handlers.size).toBe(0)
  })

  it('saves the values from the main window for a card on this computer, and answers only whether it worked', async () => {
    const secrets = await service()
    const { ipc, handlers, main, mainEvent } = ipcRegistry()
    const close = registerSecretRequestsIpc(ipc, secrets, () => [main], () => LOCAL)
    const outcome = secrets.ask('thread-a', { label: 'Key', reason: 'Why' })
    const requestId = secrets.requests().get('thread-a')![0]!.id
    const result = await handlers.get(SECRET_REQUESTS_ANSWER)!(mainEvent, { answer: 'save', threadId: hostEntityKey(LOCAL, 'thread-a'), requestId, values: { value: CANARY } })
    expect(result).toEqual({ ok: true })
    const saved = await outcome as Extract<SecretOutcome, { delivery: 'secretRef' }>
    expect(secrets.take('thread-a', saved.refs.value!)).toBe(CANARY)
    close()
    expect(handlers.size).toBe(0)
    secrets.close()
  })

  it('declines from the window', async () => {
    const secrets = await service()
    const { ipc, handlers, main, mainEvent } = ipcRegistry()
    registerSecretRequestsIpc(ipc, secrets, () => [main], () => LOCAL)
    const outcome = secrets.ask('thread-a', { label: 'Key', reason: 'Why' })
    const requestId = secrets.requests().get('thread-a')![0]!.id
    expect(await handlers.get(SECRET_REQUESTS_ANSWER)!(mainEvent, { answer: 'decline', threadId: 'thread-a', requestId })).toEqual({ ok: true })
    expect(await outcome).toEqual({ status: 'declined' })
    secrets.close()
  })

  it('refuses other windows, other hosts\' threads and unreadable answers, and never repeats a value', async () => {
    const secrets = await service()
    const save = vi.spyOn(secrets, 'save')
    const { ipc, handlers, main, widgetEvent, mainEvent } = ipcRegistry()
    registerSecretRequestsIpc(ipc, secrets, () => [main], () => LOCAL)
    const handler = handlers.get(SECRET_REQUESTS_ANSWER)!
    const answer = { answer: 'save', threadId: 'thread-a', requestId: 'sotto:secret:x', values: { value: CANARY } }
    const refusals = [
      await handler(widgetEvent, answer),
      await handler(mainEvent, { ...answer, threadId: hostEntityKey(FORGE, 'thread-a') }),
      await handler(mainEvent, { ...answer, values: { 'not a name': CANARY } }),
      await handler(mainEvent, answer),
    ]
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ ok: false })
      expect(JSON.stringify(refusal)).not.toContain(CANARY)
    }
    expect(save).toHaveBeenCalledTimes(1)
    secrets.close()
  })
})
