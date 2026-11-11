// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENCODE_CONFIG_CONTENT, opencodeConfigContent, prepareOpenCodeEnvironment, opencodeEnvironment, opencodeFolders } from '../../../../src/main/agents/opencodeServer'
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


  it('gives a process a private config file and only small routing overrides in its environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-models-'))
    expect(opencodeEnvironment({}, opencodeFolders(root), 'test-password').OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_CONFIG_CONTENT)
    const prepared = await prepareOpenCodeEnvironment({}, opencodeFolders(root), 'test-password', [spark])
    try {
      expect(prepared.env.OPENCODE_CONFIG_CONTENT!.length).toBeLessThan(32767)
      const content = JSON.parse(await readFile(prepared.env.OPENCODE_CONFIG!, 'utf8'))
      expect(content.providers['own-spark1'].models).toHaveProperty('deepseek-v4.1-flash')
      expect(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).providers['own-spark1'].settings.baseURL).toBe(spark.address)
    } finally { await prepared.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps a large inventory out of the environment, retains unticked models, and cleans up its snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-large-'))
    const large: OwnServer = { ...spark, models: Array.from({ length: 1000 }, (_, n) => ({ ...spark.models[0]!, id: `model-${n}` })), keptModelIds: ['model-1'] }
    const prepared = await prepareOpenCodeEnvironment({}, opencodeFolders(root), 'test-password', [large])
    try {
      expect(prepared.env.OPENCODE_CONFIG_CONTENT!.length).toBeLessThan(32767)
      const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.env.OPENCODE_CONFIG_CONTENT.length))'], { env: prepared.env, windowsHide: true })
      expect(Number(child.stdout)).toBeLessThan(32767)
      const content = await readFile(prepared.env.OPENCODE_CONFIG!, 'utf8')
      expect(content.length).toBeGreaterThan(131071)
      expect(Object.keys(JSON.parse(content).providers[large.id].models)).toHaveLength(1000)
      await prepared.dispose()
      await expect(readFile(prepared.env.OPENCODE_CONFIG!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await prepared.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('leaves Hermes-only keys out of the generated config, while keeping old keyed records and keyless servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-opencode-keepers-'))
    const hermes: OwnServer = { ...spark, id: 'own-hermes', keyKeeper: 'hermes' }
    const openCode: OwnServer = { ...spark, id: 'own-opencode', keyKeeper: 'opencode' }
    const keyless: OwnServer = { ...spark, id: 'own-keyless', keyed: false }
    const prepared = await prepareOpenCodeEnvironment({}, opencodeFolders(root), 'test-password', [spark, hermes, openCode, keyless])
    try {
      expect(Object.keys(JSON.parse(await readFile(prepared.env.OPENCODE_CONFIG!, 'utf8')).providers)).toEqual(['own-spark1', 'own-opencode', 'own-keyless'])
      expect(prepared.env.OPENCODE_CONFIG_CONTENT).not.toContain(hermes.id)
    } finally { await prepared.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
