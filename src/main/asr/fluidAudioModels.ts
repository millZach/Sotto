import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PARAKEET_ULTRA, PARAKEET_V2, PARAKEET_V3, type SottoSpeechModel } from '../../shared/speechModel'
import type { CoreMlModelVersion } from './coreMlEngine'

/**
 * Core ML speech models that FluidAudio (used by apps such as Willow Voice) keeps on a Mac.
 * Sotto only reads and runs these folders; it never changes them.
 * Two other kinds of folder are left out on purpose. A folder without the v3 joint model
 * (such as parakeet-tdt-0.6b-v3-coreml) cannot be loaded. The avalon-lite vocabulary does not
 * fit the loader.
 */
export interface FluidAudioModel {
  readonly id: string
  readonly folder: string
  readonly directory: string
  readonly version: CoreMlModelVersion
  readonly name: string
  readonly maker: string
  readonly languages: string
  readonly bytes: number
  /** The id of Sotto's download of the same model, which the picker then leaves off. */
  readonly sameModelAs: string
}

interface KnownFolder {
  readonly folder: string
  readonly version: CoreMlModelVersion
  readonly name: string
  readonly maker: string
  readonly languages: string
  readonly sameModelAs: string
  readonly joint: string
  readonly vocab: string
}

const V3_FILES = { joint: 'JointDecisionv3.mlmodelc', vocab: 'parakeet_v3_vocab.json' }

/** FluidAudio's copy of one of Sotto's models: its maker and languages, and its name marked Core ML. */
const coreMlCopyOf = (model: SottoSpeechModel): Pick<KnownFolder, 'name' | 'maker' | 'languages' | 'sameModelAs'> => ({
  name: `${model.name} (Core ML)`, maker: model.maker, languages: model.languages, sameModelAs: model.id,
})

const KNOWN: readonly KnownFolder[] = [
  { folder: 'parakeet-ultra', version: 'ultra', ...coreMlCopyOf(PARAKEET_ULTRA), ...V3_FILES },
  { folder: 'parakeet-tdt-0.6b-v3', version: 'v3', ...coreMlCopyOf(PARAKEET_V3), ...V3_FILES },
  { folder: 'parakeet-tdt-0.6b-v2', version: 'v2', ...coreMlCopyOf(PARAKEET_V2), joint: 'JointDecision.mlmodelc', vocab: 'parakeet_vocab.json' },
]

const SHARED_PARTS = ['Preprocessor.mlmodelc', 'Encoder.mlmodelc', 'Decoder.mlmodelc']

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await lstat(path)
    if (info.isFile()) return info.size
    if (!info.isDirectory()) return 0
    const names = await readdir(path)
    const sizes = await Promise.all(names.map((name) => sizeOf(join(path, name))))
    return sizes.reduce((sum, size) => sum + size, 0)
  } catch {
    return 0
  }
}

/** Known, loadable FluidAudio folders under `modelsRoot`, in table order. Missing root → []. */
export async function findFluidAudioModels(modelsRoot: string): Promise<FluidAudioModel[]> {
  const found = await Promise.all(
    KNOWN.map(async (known): Promise<FluidAudioModel | null> => {
      const directory = join(modelsRoot, known.folder)
      const parts = [...SHARED_PARTS, known.joint, known.vocab]
      const present = await Promise.all(parts.map((part) => exists(join(directory, part))))
      if (!present.every(Boolean)) return null
      const { folder, version, name, maker, languages, sameModelAs } = known
      return { id: `fluidaudio:${folder}`, folder, directory, version, name, maker, languages, sameModelAs, bytes: await sizeOf(directory) }
    }),
  )
  return found.filter((model): model is FluidAudioModel => model !== null)
}

export function fluidAudioModelsRoot(appDataPath: string): string {
  return join(appDataPath, 'FluidAudio', 'Models')
}
