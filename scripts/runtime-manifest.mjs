// Transformers 4.2.0's ONNX backend selects two runtime variants: normal WASM
// and asyncify for the WebGPU execution provider. Each needs its JS glue module
// and matching WASM binary, all served only through the verified local protocol.
export const RUNTIME_FILE_ALLOWLIST = Object.freeze([
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
])

const SHA256 = /^[a-f0-9]{64}$/
const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && Object.keys(value).sort().join() === [...keys].sort().join()

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
