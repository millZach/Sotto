// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findFluidAudioModels, fluidAudioModelsRoot } from '../../../src/main/asr/fluidAudioModels'
import { PARAKEET_ULTRA, PARAKEET_V2, PARAKEET_V3 } from '../../../src/shared/speechModel'

let root: string

async function makeModel(folder: string, parts: string[]): Promise<void> {
  for (const part of parts) {
    const path = join(root, folder, part)
    if (part.endsWith('.mlmodelc')) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'weights.bin'), 'x'.repeat(10))
    } else {
      await mkdir(join(root, folder), { recursive: true })
      await writeFile(path, '{}')
    }
  }
}

const COMMON = ['Preprocessor.mlmodelc', 'Encoder.mlmodelc', 'Decoder.mlmodelc']
const V3 = [...COMMON, 'JointDecisionv3.mlmodelc', 'parakeet_v3_vocab.json']
const V2 = [...COMMON, 'JointDecision.mlmodelc', 'parakeet_vocab.json']

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-fluidaudio-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('findFluidAudioModels', () => {
  it('lists all three known models in table order', async () => {
    await makeModel('parakeet-tdt-0.6b-v2', V2)
    await makeModel('parakeet-tdt-0.6b-v3', V3)
    await makeModel('parakeet-ultra', V3)
    const models = await findFluidAudioModels(root)
    expect(models.map((m) => [m.id, m.version, m.name, m.maker, m.languages, m.sameModelAs])).toEqual([
      ['fluidaudio:parakeet-ultra', 'ultra', 'Parakeet Ultra (Core ML)', 'Moondream', '25 European languages', PARAKEET_ULTRA.id],
      ['fluidaudio:parakeet-tdt-0.6b-v3', 'v3', 'Parakeet v3 (Core ML)', 'NVIDIA', '25 European languages', PARAKEET_V3.id],
      ['fluidaudio:parakeet-tdt-0.6b-v2', 'v2', 'Parakeet v2 (Core ML)', 'NVIDIA', 'English only', PARAKEET_V2.id],
    ])
    expect(models[0]?.directory).toBe(join(root, 'parakeet-ultra'))
    expect(models[0]?.folder).toBe('parakeet-ultra')
  })

  it('skips a folder missing its joint model', async () => {
    await makeModel('parakeet-tdt-0.6b-v3', [...COMMON, 'parakeet_v3_vocab.json'])
    expect(await findFluidAudioModels(root)).toEqual([])
  })

  it('needs the v2 joint and vocabulary for v2', async () => {
    await makeModel('parakeet-tdt-0.6b-v2', V3)
    expect(await findFluidAudioModels(root)).toEqual([])
    await makeModel('parakeet-tdt-0.6b-v2', V2)
    expect((await findFluidAudioModels(root)).map((m) => m.id)).toEqual(['fluidaudio:parakeet-tdt-0.6b-v2'])
  })

  it('ignores unknown folders', async () => {
    await makeModel('avalon-lite', V3)
    await makeModel('parakeet-tdt-0.6b-v3-coreml', V3)
    expect(await findFluidAudioModels(root)).toEqual([])
  })

  it('returns nothing when the root is missing', async () => {
    expect(await findFluidAudioModels(join(root, 'nope'))).toEqual([])
  })

  it('sums the sizes of nested files', async () => {
    await makeModel('parakeet-ultra', V3)
    await mkdir(join(root, 'parakeet-ultra', 'Encoder.mlmodelc', 'deep'), { recursive: true })
    await writeFile(join(root, 'parakeet-ultra', 'Encoder.mlmodelc', 'deep', 'more.bin'), 'y'.repeat(100))
    const [model] = await findFluidAudioModels(root)
    // 4 model dirs x 10 bytes + vocab '{}' (2) + nested 100
    expect(model?.bytes).toBe(142)
  })
})

describe('fluidAudioModelsRoot', () => {
  it('joins FluidAudio/Models onto app data', () => {
    expect(fluidAudioModelsRoot('/a')).toBe(join('/a', 'FluidAudio', 'Models'))
  })
})
