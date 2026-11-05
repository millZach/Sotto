import { describe, expect, it } from 'vitest'

import { PARAKEET_ULTRA, PARAKEET_V2, PARAKEET_V3, SOTTO_SPEECH_MODELS, sottoSpeechModel, speechModelBytes, speechModelFileUrl } from '../../../src/shared/speechModel'

describe("Sotto's speech models", () => {
  it('keeps Parakeet v3 where an existing install already has it', () => {
    expect(PARAKEET_V3.id).toBe('parakeet-tdt-0.6b-v3-int8')
    expect(PARAKEET_V3.releaseTag).toBe('speech-model-parakeet-tdt-0.6b-v3-int8-1')
    expect(speechModelBytes(PARAKEET_V3)).toBe(670_478_772)
  })

  it('pins the four files the speech engine loads, for every model, each under its own pre-release tag', () => {
    for (const model of SOTTO_SPEECH_MODELS) {
      expect(model.files.map((file) => file.name)).toEqual(['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'])
      for (const file of model.files) {
        expect(file.bytes).toBeGreaterThan(0)
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(speechModelFileUrl(model, file)).toBe(`https://github.com/millZach/Sotto-releases/releases/download/${model.releaseTag}/${file.name}`)
      }
      expect(model.releaseTag).toBe(`speech-model-${model.id}-1`)
    }
    expect(PARAKEET_ULTRA.releaseTag).toBe('speech-model-parakeet-ultra-int8-1')
    expect(PARAKEET_V2.releaseTag).toBe('speech-model-parakeet-tdt-0.6b-v2-int8-1')
  })

  it('shares v3\'s tokens with Ultra, which is v3 post-trained', () => {
    expect(PARAKEET_ULTRA.files[3]).toEqual(PARAKEET_V3.files[3])
    expect(PARAKEET_V2.files[3]).not.toEqual(PARAKEET_V3.files[3])
  })

  it('finds a model by id, and nothing for a model already on this computer', () => {
    expect(sottoSpeechModel(PARAKEET_ULTRA.id)).toBe(PARAKEET_ULTRA)
    expect(sottoSpeechModel('fluidaudio:parakeet-ultra')).toBeUndefined()
    expect(sottoSpeechModel(null)).toBeUndefined()
  })
})
