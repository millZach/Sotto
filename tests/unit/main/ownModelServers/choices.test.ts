// @vitest-environment node
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnServers } from '../../../../src/main/ownModelServers/service'
import { keptModels, type CheckResult } from '../../../../src/shared/ownModelServers'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const model = { id: 'one', name: 'One', context: 131072, thinking: true, images: false }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-api-')); paths.push(directory)
  const key = randomUUID(), key2 = randomUUID(), keys = new Map<string, string>()
  const keepKey = vi.fn(async (id: string, value: string) => { keys.set(id, value) })
  const check = vi.fn<(_address: string, _key: string | undefined) => Promise<CheckResult>>(async () => ({ status: 'ok', address: 'https://example.test/v1', kind: 'openai-compatible', answeredMs: 1, models: [model] }))
  const service = new OwnServers({ directory, openCode: () => undefined, hermes: () => ({ keepKey, forgetKey: async id => { keys.delete(id) } }), readKey: async id => keys.get(id), check })
  const added = await service.add({ name: 'Example', address: 'https://example.test/v1', key, models: [model], inventory: [model], keptModelIds: ['one'] })
  if (added.status !== 'ok') throw new Error('Fixture add failed')
  return { service, directory, server: added.server, key, key2, keys, keepKey, check }
}
describe('kept models and key replacement', () => {
  it('unticks only menu choices, keeping the old model runnable', async () => {
    const { service, server } = await fixture()
    const two = { ...model, id: 'two', name: 'Two' }
    await service.chooseModels({ id: server.id, models: [two], keptModelIds: ['two'] })
    const saved = (await service.list())[0]!
    expect(saved.models.map(model => model.id)).toEqual(['one', 'two'])
    expect(keptModels(saved).map(model => model.id)).toEqual(['two'])
  })
  it('rechecks using the keeper key, preserves choices, and leaves new models unticked', async () => {
    const { service, server, check, key } = await fixture()
    check.mockResolvedValueOnce({ status: 'ok', address: server.address, kind: 'openai-compatible', answeredMs: 1, models: [{ ...model, context: 262144 }, { ...model, id: 'two' }] })
    await service.checkSaved({ id: server.id })
    expect(check).toHaveBeenLastCalledWith(server.address, key)
    const saved = (await service.list())[0]!
    expect(saved.keptModelIds).toEqual(['one'])
    expect(saved.newModelIds).toEqual(['two'])
    expect(saved.models[0]!.context).toBe(262144)
  })
  it('leaves the old key and choices on refusal, then replaces only the key on success', async () => {
    const { service, server, check, key, key2, keys, keepKey, directory } = await fixture()
    check.mockResolvedValueOnce({ status: 'refused', reason: 'key-refused', message: 'Refused' })
    expect((await service.replaceKey({ id: server.id, key: key2 })).status).toBe('refused')
    expect(keys.get(server.id)).toBe(key)
    expect(keepKey).toHaveBeenCalledTimes(1)
    expect((await service.replaceKey({ id: server.id, key: key2 })).status).toBe('ok')
    expect(keys.get(server.id)).toBe(key2)
    expect((await service.list())[0]).toEqual(server)
    const disk = await readFile(join(directory, 'own-model-servers.json'), 'utf8')
    expect(disk.includes(key) || disk.includes(key2)).toBe(false)
  })
})
