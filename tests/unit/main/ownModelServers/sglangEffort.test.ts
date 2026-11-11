// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hermesCatalog } from '../../../../src/main/agents/hermesModels'
import { mergeModelFacts } from '../../../../src/main/ownModelServers/catalogue'
import { checkOwnServer } from '../../../../src/main/ownModelServers/check'
import { openCodeProviderBlock } from '../../../../src/main/ownModelServers/providerBlock'
import { OwnServers } from '../../../../src/main/ownModelServers/service'
import type { OwnServerModel } from '../../../../src/shared/ownModelServers'

const names = ['DeepSeek-V4.1-Flash-1017-UNCENSORED', 'DeepSeek-V4.1-Flash-1017', 'DeepSeek-V4.1-Flash', 'DeepSeek', 'deepseek', 'deepseek-v4.1-flash']
const levels = ['none', 'low', 'high', 'max']
const info = { served_model_name: names[0], model_type: 'deepseek_v41', reasoning_parser: 'deepseek-v41', has_image_understanding: true }
const listed = names.map(id => ({ id, owned_by: 'sglang', root: names[0], max_model_len: 1048576 }))
const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function endpoint(modelInfo: unknown = info, models: unknown[] = listed) {
  return vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname
    return new Response(JSON.stringify(path === '/v1/models' ? { data: models } : modelInfo), { status: 200 })
  })
}

describe('SGLang DeepSeek V4.1 effort', () => {
  it('rechecks a saved Spark and carries its four encoder levels into both thread providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-spark-effort-')); paths.push(directory)
    const fetch = endpoint(), changed = vi.fn()
    const service = new OwnServers({ directory, openCode: () => undefined, deepSeek: () => ({ changed }), checkOptions: { fetch } })
    const models: OwnServerModel[] = names.map(id => ({ id, name: id, context: 1048576, thinking: true, images: true }))
    const added = await service.add({ name: 'Spark Cluster', address: 'https://spark.example/v1', models, keptModelIds: [names[0]!] })
    if (added.status !== 'ok') throw new Error(added.message)
    changed.mockClear()
    expect((await service.checkSaved({ id: added.server.id })).status).toBe('ok')
    const saved = (await service.list())[0]!
    expect(saved.keptModelIds).toEqual([names[0]])
    expect(saved.models.map(model => model.reasoningEfforts)).toEqual(names.map(() => levels))
    expect(changed).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(directory, 'own-model-servers.json'), 'utf8'))[0].models[0].reasoningEfforts).toEqual(levels)
    const catalog = hermesCatalog([saved], true, true)
    expect(catalog[0]).toMatchObject({ reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' })
    expect(catalog.slice(1).every(model => model.hiddenFromMenu)).toBe(true)
    expect(catalog[0]!.reasoningEfforts).not.toContain('xhigh')
    expect(openCodeProviderBlock(saved)).toMatchObject({ models: { [names[0]!]: { capabilities: { reasoning: { supported: true, effort: levels } } } } })
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/models', '/model_info'])
  })

  it.each([
    { ...info, reasoning_parser: 'deepseek-r1' },
    { ...info, model_type: 'deepseek_v4' },
    { ...info, served_model_name: undefined },
    { model_path: names[0], reasoning_parser: 'deepseek-v41' },
  ])('leaves unknown encoders or an unbound model on Default: %j', async modelInfo => {
    const result = await checkOwnServer('https://spark.example/v1', undefined, { fetch: endpoint(modelInfo) })
    if (result.status !== 'ok') throw new Error(result.message)
    expect(result.models.every(model => model.reasoningEfforts === undefined)).toBe(true)
    expect(mergeModelFacts(result.models[0]!).reasoningEfforts).toEqual(['default'])
  })

  it('keeps explicit API levels and does not apply one loaded model’s profile to unrelated models', async () => {
    const result = await checkOwnServer('https://spark.example/v1', undefined, { fetch: endpoint(info, [
      { ...listed[0], reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      { id: 'unrelated', owned_by: 'sglang', root: 'another-model', max_model_len: 32768 },
    ]) })
    if (result.status !== 'ok') throw new Error(result.message)
    expect(result.models[0]!.reasoningEfforts).toEqual(['low', 'high'])
    expect(result.models[1]!.reasoningEfforts).toBeUndefined()
  })
})
