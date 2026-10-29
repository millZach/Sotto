// A stand-in for parakeetHelper.ts, run under Node with an IPC channel in place of Electron's parent port. The mode is
// FAKE_PARAKEET_MODE: ready | module-fail | model-fail | crash-after-ready | hang (ready, then never answers) | never-ready
// | ignores-stop (ready, but stays when asked to stop). Asked to stop, it exits with code 0, as the real helper does.
// It holds a buffer the size of a small model, so a test can see the memory go with the process.
import { Buffer } from 'node:buffer'
import process from 'node:process'

const mode = process.env.FAKE_PARAKEET_MODE ?? 'ready'
const model = Buffer.alloc(8 * 1024 * 1024, 1)

if (mode === 'module-fail') process.send({ error: 'module' })
else if (mode === 'model-fail') process.send({ error: 'model' })
else if (mode !== 'never-ready') process.send({ ready: true })

process.on('message', (request) => {
  if (request?.stop === true) {
    if (mode !== 'ignores-stop') process.exit(0)
    return
  }
  if (mode === 'crash-after-ready') process.exit(3)
  if (mode === 'hang') return
  const { id, samples } = request
  if (!(samples instanceof Float32Array)) {
    process.send({ id, error: 'failed' })
    return
  }
  const first = samples.length > 0 ? samples[0] : 0
  const last = samples.length > 0 ? samples[samples.length - 1] : 0
  process.send({ id, text: `heard ${samples.length} samples from ${first} to ${last} in ${process.argv.at(-1)} with ${model.length} bytes` })
})
process.on('disconnect', () => process.exit(0))
