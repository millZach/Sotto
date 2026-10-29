// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// The speech model's helper loads sherpa-onnx-node with a native import(), not Vitest's, so this asks a plain Node child
// the question the helper's loader depends on. The package is CommonJS and import() lists only the exports
// Node can find by reading it: OfflineRecognizer is not one of them, and reading it by name left the
// speech model failed with "engine" in the running app. The default export is all of module.exports.
it('finds the offline recognizer on the default export of a native import, where the speech engine reads it', async () => {
  const probe = `const sherpa = await import('sherpa-onnx-node')
process.stdout.write(JSON.stringify({ createAsync: typeof sherpa.default?.OfflineRecognizer?.createAsync }))`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: process.cwd(),
    windowsHide: true,
  })
  expect(JSON.parse(stdout)).toEqual({ createAsync: 'function' })
})
