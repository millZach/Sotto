// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { hermesCatalog, hermesSettingsOf, hermesEffortValue, hermesHasEffort } from '../../../src/main/agents/hermesModels'
import type { OwnServer } from '../../../src/shared/ownModelServers'
const server: OwnServer = { id: 'own-test', name: 'Example', address: 'https://example.test/v1', keyed: false, keptModelIds: ['one'], models: [
  { id: 'one', name: 'One', context: 128000, images: false, thinking: true, reasoningEfforts: ['none', 'low', 'high', 'max'] },
  { id: 'two', name: 'Two', context: 128000, images: false, thinking: true, reasoningEfforts: ['default'] },
] }
describe('Hermes model thinking', () => {
  it('uses only confirmed model levels when the harness supports the option', () => {
    expect(hermesCatalog([server], false, true)[0]!.reasoningEfforts).toEqual(['off', 'low', 'high', 'max'])
    expect(hermesCatalog([server], false, true)[1]).toMatchObject({ reasoningEfforts: ['default'], hiddenFromMenu: true })
    expect(hermesCatalog([server])[0]!.reasoningEfforts).toBeUndefined()
    const legacy = { ...server, models: [{ ...server.models[0]!, reasoningEfforts: undefined }] }
    expect(hermesCatalog([legacy], false, true)[0]!.reasoningEfforts).toEqual(['default'])
  })
  it('maps Off and Default and reads the session answer', () => {
    expect(hermesEffortValue('off')).toBe('none')
    expect(hermesEffortValue(undefined)).toBe('default')
    expect(hermesEffortValue('max')).toBe('max')
    const value = { configOptions: [{ id: 'reasoning_effort', currentValue: 'high' }] }
    expect(hermesHasEffort(value)).toBe(true)
    expect(hermesSettingsOf(value).effort).toBe('high')
    expect(hermesHasEffort({ models: {} })).toBe(false)
  })
})
