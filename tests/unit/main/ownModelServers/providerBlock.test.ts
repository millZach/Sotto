// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OPENCODE_CONFIG_CONTENT, opencodeConfigContent, opencodeEnvironment, opencodeFolders } from '../../../../src/main/agents/opencodeServer'
import { OPENCODE_OPENAI_COMPATIBLE, OWN_SERVER_PLACEHOLDER_KEY, openCodeProviderBlock, openCodeProviders, ownModelOutput } from '../../../../src/main/ownModelServers/providerBlock'
import type { OwnServer } from '../../../../src/shared/ownModelServers'

const spark: OwnServer = {
  id: 'own-spark1', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: true,
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 163_840, thinking: true, images: false },
    { id: 'gemma3', name: 'Gemma 3', context: 8_192, output: 2_000, thinking: false, images: true },
  ],
}

describe('a server as OpenCode is told about it', () => {
  it('is an OpenAI-compatible provider with every model declared, and a placeholder key that is no secret', () => {
    expect(openCodeProviderBlock(spark)).toEqual({
      name: 'Spark', package: OPENCODE_OPENAI_COMPATIBLE, settings: { baseURL: 'http://spark-head:8888/v1', apiKey: OWN_SERVER_PLACEHOLDER_KEY },
      models: {
        'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash',
          capabilities: { tools: true, input: ['text'], output: ['text'], reasoning: { supported: true, effort: ['low', 'medium', 'high'] } },
          limit: { context: 163_840, output: 32_000 } },
        gemma3: { name: 'Gemma 3',
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'], reasoning: { supported: false } },
          limit: { context: 8_192, output: 2_000 } },
      },
    })
    expect(OPENCODE_OPENAI_COMPATIBLE).toBe('@opencode/ai/providers/openai-compatible')
  })

  it('gives a model a quarter of its context to answer in, up to 32K, unless it was saved with its own', () => {
    expect(ownModelOutput({ context: 8_192 })).toBe(2_048)
    expect(ownModelOutput({ context: 1_000_000 })).toBe(32_000)
    expect(ownModelOutput({ context: 1_000_000, output: 64_000 })).toBe(64_000)
  })

  it('is keyed by server ID beside the share and update settings, and changes nothing when there are no servers', () => {
    expect(opencodeConfigContent()).toBe(OPENCODE_CONFIG_CONTENT)
    expect(opencodeConfigContent([])).toBe(OPENCODE_CONFIG_CONTENT)
    expect(JSON.parse(opencodeConfigContent([spark]))).toEqual({ share: 'disabled', update: 'disable', providers: openCodeProviders([spark]) })
    expect(Object.keys(openCodeProviders([spark, { ...spark, id: 'own-other' }]))).toEqual(['own-spark1', 'own-other'])
  })

  it('reaches an OpenCode process only through OPENCODE_CONFIG_CONTENT', () => {
    const folders = opencodeFolders('/tmp/sotto/opencode')
    expect(opencodeEnvironment({ PATH: '/bin' }, folders, 'pw').OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_CONFIG_CONTENT)
    const env = opencodeEnvironment({ PATH: '/bin' }, folders, 'pw', [spark])
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).providers['own-spark1'].settings.baseURL).toBe('http://spark-head:8888/v1')
  })
})
