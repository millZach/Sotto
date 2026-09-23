// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalChatService } from '../../../src/main/agents/personalChats'
import { E2EPersonalChatHost } from '../../../src/main/e2e/personalChatHost'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'

const roots: string[] = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-personal-shutdown-')); roots.push(root)
  const hosts = {
    codex: new E2EPersonalChatHost(root), claude: new E2EPersonalChatHost(root, 'claude'), grok: new E2EPersonalChatHost(root, 'grok'),
  }
  const service = new PersonalChatService({ userDataPath: root, hosts,
    configuration: () => ({ reasoning: 'codex', reasoningModel: 'codex:test', reasoningEffort: '' }),
  })
  await service.start()
  const chat = (await service.create()).chats[0]!
  await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Keep this draft', skills: [] })
  return { root, hosts, service }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-personal-shutdown-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

it('removes provider callbacks before the final write drain so restart cannot race a late atomic save', async () => {
  const { root, hosts, service } = await fixture()
  const release = deferred()
  let holdNewWrites = false, activeWrites = 0
  const originalWrite = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value: unknown) {
    activeWrites++
    try { if (holdNewWrites) await release.promise; await originalWrite.call(this, value) }
    finally { activeWrites-- }
  })
  const settled = service.settled.bind(service)
  vi.spyOn(service, 'settled').mockImplementationOnce(async () => {
    const pending = settled()
    // settled has captured its current writing promise. A native notification arriving now
    // must no longer be able to enqueue another save behind that captured promise.
    await Promise.resolve()
    holdNewWrites = true
    hosts.grok.disconnect()
    await pending
  })
  try {
    await service.close()
    expect(activeWrites).toBe(0)
    expect(JSON.parse(await readFile(join(root, 'personal-chat', 'chats.json'), 'utf8')).chats[0].draft.text).toBe('Keep this draft')
  } finally { release.resolve(); await settled() }
})

it('waits for every native closure and drains persistence before propagating a closure failure', async () => {
  const { service, hosts } = await fixture()
  const entered = deferred(), release = deferred()
  vi.spyOn(hosts.codex, 'closed').mockRejectedValue(new Error('Native close failed'))
  vi.spyOn(hosts.grok, 'closed').mockImplementation(async () => { entered.resolve(); await release.promise })
  let finished = false
  const closing = service.close().finally(() => { finished = true })
  const failed = expect(closing).rejects.toThrow('Native close failed')
  await entered.promise
  try {
    await new Promise<void>(done => setImmediate(done))
    expect(finished).toBe(false)
  } finally { release.resolve(); await failed }
})
