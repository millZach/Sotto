import { createConnection } from 'node:net'
import { normalizeTerminalHook } from './hooksNormalizer'
import { TERMINAL_HOOK_FRAME_BYTES, terminalHookAnswerSchema } from './hooksProtocol'

/** Packaged Electron runs this bundle as Node. No provider content or failures are logged. */
async function main(): Promise<void> {
  const port = Number(process.env.SOTTO_TERMINAL_HOOK_PORT)
  const secret = process.env.SOTTO_TERMINAL_HOOK_SECRET
  const terminalId = process.env.SOTTO_TERMINAL_HOOK_TERMINAL_ID
  const runId = process.env.SOTTO_TERMINAL_HOOK_RUN_ID
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !secret || !terminalId || !runId) return
  const provider = process.argv[2]
  let input = ''
  if (provider === 'codex') {
    const argument = process.argv[3] ?? ''
    input = argument.startsWith('base64:') ? Buffer.from(argument.slice(7), 'base64').toString('utf8') : argument
  }
  else {
    // Unsupported oversized payloads stay with the native CLI; transcripts are never opened.
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      input += String(chunk)
      if (Buffer.byteLength(input) > 1024 * 1024) { process.stdin.destroy(); return }
    }
  }
  let raw: unknown
  try { raw = JSON.parse(input) } catch { return }
  const normalized = normalizeTerminalHook(provider ?? '', process.argv[3], raw, { terminalId, runId })
  if (!normalized) return
  const frame = `${JSON.stringify({ ...normalized.event, secret })}\n`
  if (Buffer.byteLength(frame) > TERMINAL_HOOK_FRAME_BYTES) return
  await new Promise<void>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    let answered = false
    const timeout = normalized.blocking ? Math.min(Number(process.env.SOTTO_TERMINAL_HOOK_TIMEOUT_MS) || 110_000, 110_000) : 2_000
    const deadline = setTimeout(() => socket.destroy(), timeout)
    socket.on('error', () => { /* A failed helper never invents a user decision. */ })
    socket.on('connect', () => socket.write(frame))
    socket.on('close', () => { clearTimeout(deadline); resolve() })
    socket.on('data', data => {
      if (!normalized.blocking || answered) { socket.destroy(); return }
      buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data])
      if (buffer.length > TERMINAL_HOOK_FRAME_BYTES) { socket.destroy(); return }
      const end = buffer.indexOf(10)
      if (end < 0) return
      let rawAnswer: unknown
      try { rawAnswer = JSON.parse(buffer.subarray(0, end).toString('utf8')) } catch { socket.destroy(); return }
      const answer = terminalHookAnswerSchema.safeParse(rawAnswer)
      if (!answer.success || answer.data.terminalId !== terminalId || answer.data.runId !== runId ||
        answer.data.requestId !== normalized.event.requestId || answer.data.approvalId !== normalized.event.approvalId) { socket.destroy(); return }
      answered = true
      // stdout is the provider hook response, not a Sotto log. Do not change input or permissions.
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: answer.data.decision } } })}\n`, () => {
        socket.end(`${JSON.stringify({ type: 'answer-delivered', secret, terminalId, runId, requestId: answer.data.requestId, approvalId: answer.data.approvalId, answerId: answer.data.answerId })}\n`)
      })
    })
  })
}
void main().catch(() => { /* Native prompts remain usable; raw input never reaches a log. */ })
