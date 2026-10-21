// A stand-in for sotto-coreml-asr (protocol 1). The mode is the model directory argument:
// ready | load-fail | crash-after-ready | never-ready | hang (ready, then never answers).
import { Buffer } from 'node:buffer'
import process from 'node:process'

const mode = process.argv[2]

process.stdout.write('FluidAudio log line that is not JSON\n42\n')
if (mode === 'load-fail') {
  process.stdout.write('{"error":"load"}\n')
  process.exit(1)
}
if (mode !== 'never-ready') process.stdout.write('{"ready":true}\n')

let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  if (mode === 'crash-after-ready') process.exit(3)
  if (mode === 'hang') return
  buffered = Buffer.concat([buffered, chunk])
  while (buffered.length >= 8) {
    const id = buffered.readUInt32LE(0)
    const count = buffered.readUInt32LE(4)
    const size = 8 + count * 4
    if (buffered.length < size) break
    const first = count > 0 ? buffered.readFloatLE(8) : 0
    buffered = buffered.subarray(size)
    process.stdout.write(`${JSON.stringify({ id, text: `heard ${count} samples from ${first}` })}\n`)
  }
})
process.stdin.on('end', () => process.exit(0))
