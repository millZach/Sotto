// A fake Claude Code for the limits probe: speaks just enough stream-json to answer `initialize` and `get_usage`.
// argv after the script: <mode> <spawn log> [delay ms]. Modes: usage, unsupported, silent, exit, no-init.
// Every start appends its flags to the spawn log, so a test can count probes and check what they were asked to do.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { URL } from 'node:url'

const [mode = 'usage', log, delay = '50'] = process.argv.slice(2)
const flags = process.argv.slice(5)
if (log) appendFileSync(log, `${JSON.stringify({ flags, cwd: process.cwd() })}\n`)

// Recorded shape, invented numbers, with undocumented keys standing in for the codename keys a real answer carries.
const usageBody = JSON.parse(readFileSync(new URL('./claudeUsageAnswer.json', import.meta.url), 'utf8'))

const write = frame => process.stdout.write(`${JSON.stringify(frame)}\n`)
const lines = createInterface({ input: process.stdin })
lines.on('line', text => {
  let frame
  try { frame = JSON.parse(text) } catch { return }
  if (frame?.type !== 'control_request') return
  const id = frame.request_id
  if (frame.request?.subtype === 'initialize') {
    if (mode === 'no-init') { write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'no' } }); return }
    write({ type: 'system', subtype: 'init', note: 'private text the reader must ignore' })
    write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: [] } } })
    if (mode === 'exit') setTimeout(() => process.exit(0), 10)
    return
  }
  if (frame.request?.subtype === 'get_usage') {
    if (frame.request.skip_behaviors !== true) process.exit(3)
    if (mode === 'silent' || mode === 'exit') return
    setTimeout(() => {
      if (mode === 'unsupported') write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported control request subtype: get_usage' } })
      else write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: usageBody } })
    }, Number(delay))
  }
})
lines.on('close', () => process.exit(0))
