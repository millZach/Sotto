// @vitest-environment node
import { expect, it } from 'vitest'
import { hermesCatalog } from '../../src/main/agents/hermesModels'
import { checkOwnServer } from '../../src/main/ownModelServers/check'
import type { OwnServerModel } from '../../src/shared/ownModelServers'

/** Opt in with a SGLang DeepSeek V4.1 endpoint. Reads metadata only; no inference or saved configuration writes. */
const address = process.env.SOTTO_SGLANG_EFFORT_URL
it.skipIf(!address)('discovers the live V4.1 encoder levels and offers them to Hermes', async () => {
  const result = await checkOwnServer(address!, undefined)
  if (result.status !== 'ok') throw new Error(result.message)
  expect(result.kind).toBe('sglang')
  const models: OwnServerModel[] = result.models.filter(model => model.reasoningEfforts !== undefined).map(model => {
    expect(model.context).toBeDefined()
    expect(model.reasoningEfforts).toEqual(['none', 'low', 'high', 'max'])
    return { ...model, context: model.context!, thinking: model.thinking === true, images: model.images === true }
  })
  expect(models.length).toBeGreaterThan(0)
  const catalog = hermesCatalog([{ id: 'own-live', name: 'Live SGLang', address: result.address, keyed: false, models }], true, true)
  expect(catalog.every(model => model.reasoningEfforts?.join(',') === 'off,low,high,max' && model.defaultReasoningEffort === 'high')).toBe(true)
}, 60_000)
