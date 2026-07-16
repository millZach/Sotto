export const MODEL_FILE_ALLOWLIST = Object.freeze([
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'merges.txt',
  'normalizer.json',
  'onnx/decoder_model_merged_quantized.onnx',
  'onnx/encoder_model_quantized.onnx',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
])

// Transformers 4.2.0's ONNX backend selects two runtime variants: normal WASM
// and asyncify for the WebGPU execution provider. Each needs its JS glue module
// and matching WASM binary, all served only through the verified local protocol.
export const RUNTIME_FILE_ALLOWLIST = Object.freeze([
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
])

const entry = (value) => Object.freeze(value)

export const MODEL_CATALOG = Object.freeze({
  fast: entry({ label: 'Fast', repository: 'Xenova/whisper-tiny', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', dtype: 'q8', multilingual: true, license: 'Apache-2.0', bundled: false, encoderBytes: 10_124_910, decoderBytes: 30_727_765 }),
  balanced: entry({ label: 'Balanced', repository: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8', dtype: 'q8', multilingual: true, license: 'Apache-2.0', bundled: true, encoderBytes: 23_200_850, decoderBytes: 53_707_539 }),
  accurate: entry({ label: 'Accurate', repository: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13', dtype: 'q8', multilingual: true, license: 'Apache-2.0', bundled: false, encoderBytes: 92_324_809, decoderBytes: 156_780_950 }),
})

export function modelFileUrl(model, path) {
  if (!MODEL_FILE_ALLOWLIST.includes(path)) throw new Error('Model file is not allowed')
  return `https://huggingface.co/${model.repository}/resolve/${model.revision}/${path}`
}

const SHA256 = /^[a-f0-9]{64}$/
const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && Object.keys(value).sort().join() === [...keys].sort().join()

export function validateCatalogLock(value) {
  if (!exactKeys(value, ['version', 'presets']) || value.version !== 1 || !exactKeys(value.presets, Object.keys(MODEL_CATALOG))) throw new Error('Invalid model catalog')
  for (const [preset, expected] of Object.entries(MODEL_CATALOG)) {
    const model = value.presets[preset]
    if (!exactKeys(model, ['repository', 'revision', 'license', 'bundled', 'files'])
      || model.repository !== expected.repository
      || model.revision !== expected.revision
      || model.license !== expected.license
      || model.bundled !== expected.bundled
      || !Array.isArray(model.files)
      || model.files.length !== MODEL_FILE_ALLOWLIST.length
      || model.files.map((file) => file?.path).join() !== MODEL_FILE_ALLOWLIST.join()) throw new Error('Invalid model catalog')
    for (const file of model.files) {
      if (!exactKeys(file, ['path', 'url', 'bytes', 'sha256'])
        || file.url !== modelFileUrl(expected, file.path)
        || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0
        || !SHA256.test(file.sha256)) throw new Error('Invalid model catalog')
    }
    const encoder = model.files.find((file) => file.path === 'onnx/encoder_model_quantized.onnx')
    const decoder = model.files.find((file) => file.path === 'onnx/decoder_model_merged_quantized.onnx')
    if (encoder?.bytes !== expected.encoderBytes || decoder?.bytes !== expected.decoderBytes) throw new Error('Invalid model catalog')
  }
  return value
}

export function validateBundledManifest(value, catalog) {
  const balanced = validateCatalogLock(catalog).presets.balanced
  if (!exactKeys(value, ['version', 'preset', 'repository', 'revision', 'files'])
    || value.version !== 1
    || value.preset !== 'balanced'
    || value.repository !== balanced.repository
    || value.revision !== balanced.revision
    || JSON.stringify(value.files) !== JSON.stringify(balanced.files)) throw new Error('Invalid model manifest')
  return value
}

export function validateRuntimeManifest(value) {
  if (!exactKeys(value, ['version', 'files'])
    || value.version !== 1
    || !Array.isArray(value.files)
    || value.files.length !== RUNTIME_FILE_ALLOWLIST.length
    || value.files.map((file) => file?.path).join() !== RUNTIME_FILE_ALLOWLIST.join()) throw new Error('Invalid runtime manifest')
  for (const file of value.files) {
    if (!exactKeys(file, ['path', 'bytes', 'sha256'])
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !SHA256.test(file.sha256)) throw new Error('Invalid runtime manifest')
  }
  return value
}
