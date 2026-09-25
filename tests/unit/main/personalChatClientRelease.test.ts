// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalChatService } from '../../../src/main/agents/personalChats'
import { E2EPersonalChatHost } from '../../../src/main/e2e/personalChatHost'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-personal-release-')); roots.push(root)
  const hosts = {
    codex: new E2EPersonalChatHost(root), claude: new E2EPersonalChatHost(root, 'claude'), grok: new E2EPersonalChatHost(root, 'grok'),
  }
  const service = new PersonalChatService({ userDataPath: root, hosts,
    configuration: () => ({ reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: '' }),
  })
  await service.start()
  await service.create()
  await service.connect()
  return { hosts, service }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-personal-release-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

it('lets go of a client while it is replaced and takes it back after, so chats never keep the old one running', async () => {
  const { hosts, service } = await fixture()
  try {
    expect(service.get().connected).toBe(true)
    const disconnect = vi.spyOn(hosts.codex, 'disconnect')
    const connect = vi.spyOn(hosts.codex, 'connect')
    const restore = await service.releaseClient('codex')
    expect(disconnect).toHaveBeenCalledOnce()
    expect(service.get().connected).toBe(false)
    // A Connect press while npm runs would start the old binary again.
    await service.connect()
    expect(connect).not.toHaveBeenCalled()
    await restore()
    expect(connect).toHaveBeenCalledOnce()
    expect(service.get().connected).toBe(true)
  } finally { await service.close() }
})

it('keeps a Connect pressed while the client is away and honours it after', async () => {
  const { hosts, service } = await fixture()
  try {
    await service.disconnect()
    const connect = vi.spyOn(hosts.codex, 'connect')
    const restore = await service.releaseClient('codex')
    await service.connect()
    expect(connect).not.toHaveBeenCalled()
    await restore()
    expect(connect).toHaveBeenCalledOnce()
    expect(service.get().connected).toBe(true)
  } finally { await service.close() }
})

it('hands the provider back when letting go of it fails', async () => {
  const { hosts, service } = await fixture()
  try {
    vi.spyOn(hosts.codex, 'disconnect').mockImplementationOnce(() => { throw new Error('stuck') })
    await expect(service.releaseClient('codex')).rejects.toThrow('stuck')
    await service.connect()
    expect(service.get().connected).toBe(true)
  } finally { await service.close() }
})

it('does not start a client the chats were not using', async () => {
  const { hosts, service } = await fixture()
  try {
    const connect = vi.spyOn(hosts.grok, 'connect')
    const restore = await service.releaseClient('grok')
    await restore()
    expect(connect).not.toHaveBeenCalled()
    // Devin has no personal chats, so there is nothing to release.
    await (await service.releaseClient('devin'))()
    expect(service.get().connected).toBe(true)
  } finally { await service.close() }
})
