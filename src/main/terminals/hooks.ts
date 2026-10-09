import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TERMINAL_HOOK_FRAME_BYTES, TERMINAL_HOOK_MAX_CONNECTIONS,
  terminalHookAcknowledgementSchema, terminalHookAnswerSchema, terminalHookFrameSchema,
  type TerminalAgentHookEvent, type TerminalHookAnswer,
} from './hooksProtocol'

export type { TerminalAgentHookEvent, TerminalHookAnswer } from './hooksProtocol'
export interface PreparedTerminalAgentHooks {
  readonly runId: string
  readonly providerSessionId?: string
  readonly args: string[]
  readonly env: Record<string, string>
  /** Only an explicit user answer can call this; a race accepts at most one delivery. */
  answer(answer: TerminalHookAnswer): boolean
  dispose(): void
}
export interface PrepareTerminalAgentHooksOptions {
  terminalId: string
  provider: 'claude' | 'codex' | 'grok'
  onEvent(event: TerminalAgentHookEvent): void
  onRequestClosed(requestId: string): void
  onUnavailable?(): void
  onAnswerDelivered?(answer: TerminalHookAnswer): void
  runner?: string
  helperPath?: string
  tempRoot?: string
  platform?: NodeJS.Platform
  /** Test seams; production always stays below the provider's 120-second hook timeout. */
  requestTimeoutMs?: number
  connectionTimeoutMs?: number
}
const shellQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`
const psQuote = (value: string): string => `'${value.replace(/'/gu, "''")}'`
const commandQuote = (value: string): string => `"${value.replace(/"/gu, '\\"')}"`
/** Literal TOML strings survive Windows PowerShell 5's native-argument quote handling. */
const tomlLiteral = (value: string): string => {
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.includes("'''")) throw new Error('The terminal hook path cannot be passed to this CLI.')
  return value.includes("'") ? `'''${value}'''` : `'${value}'`
}

/** One loopback listener and private launch overrides per PTY lifecycle. Never logs provider input. */
export async function prepareTerminalAgentHooks(options: PrepareTerminalAgentHooksOptions): Promise<PreparedTerminalAgentHooks> {
  const runId = randomUUID()
  if (options.provider === 'grok') return { runId, args: [], env: {}, answer: () => false, dispose() {} }
  const secret = randomBytes(32).toString('hex')
  const providerSessionId = options.provider === 'claude' ? randomUUID() : undefined
  const connections = new Set<Socket>()
  const requests = new Map<string, { socket: Socket; event: TerminalAgentHookEvent; answer?: TerminalHookAnswer }>()
  const eventIds = new Set<string>()
  let disposed = false
  const authenticate = (candidate: string): boolean => timingSafeEqual(Buffer.from(candidate), Buffer.from(secret))
  const server = createServer(socket => {
    if (disposed || connections.size >= TERMINAL_HOOK_MAX_CONNECTIONS) { socket.destroy(); return }
    connections.add(socket)
    socket.setTimeout(options.connectionTimeoutMs ?? 2_000, () => socket.destroy())
    let buffer = Buffer.alloc(0)
    let requestId: string | undefined
    let eventReceived = false
    socket.on('error', () => { /* The native prompt remains the fallback. */ })
    socket.on('close', () => {
      connections.delete(socket)
      if (requestId && requests.get(requestId)?.socket === socket) {
        requests.delete(requestId)
        if (!disposed) options.onRequestClosed(requestId)
      }
    })
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data])
      if (buffer.length > TERMINAL_HOOK_FRAME_BYTES) { socket.destroy(); return }
      const end = buffer.indexOf(10)
      if (end < 0) return
      if (end !== buffer.length - 1) { socket.destroy(); return }
      let payload: unknown
      try { payload = JSON.parse(buffer.subarray(0, end).toString('utf8')) } catch { socket.destroy(); return }
      buffer = Buffer.alloc(0)
      if (eventReceived) {
        const ack = terminalHookAcknowledgementSchema.safeParse(payload)
        const pending = requestId ? requests.get(requestId) : undefined
        if (!ack.success || !authenticate(ack.data.secret) || !pending?.answer ||
          ack.data.terminalId !== options.terminalId || ack.data.runId !== runId ||
          ack.data.requestId !== pending.event.requestId || ack.data.approvalId !== pending.event.approvalId ||
          ack.data.answerId !== pending.answer.answerId) { socket.destroy(); return }
        options.onAnswerDelivered?.(pending.answer)
        socket.end()
        return
      }
      const frame = terminalHookFrameSchema.safeParse(payload)
      if (!frame.success || !authenticate(frame.data.secret) || frame.data.terminalId !== options.terminalId || frame.data.runId !== runId ||
        (providerSessionId && frame.data.providerSessionId !== providerSessionId)) { socket.destroy(); return }
      const { secret: _secret, ...event } = frame.data
      // The schema is an allow-list; the secret is discarded before the callback.
      void _secret
      if (eventIds.has(event.eventId)) { socket.end(); return }
      eventIds.add(event.eventId)
      if (eventIds.size > 4096) eventIds.delete(eventIds.values().next().value!)
      eventReceived = true
      if (event.kind === 'permission') {
        if (!event.requestId || !event.approvalId || options.provider !== 'claude' || requests.has(event.requestId)) { socket.destroy(); return }
        requestId = event.requestId
        requests.set(requestId, { socket, event })
        socket.setTimeout(Math.min(options.requestTimeoutMs ?? 110_000, 110_000), () => socket.destroy())
        options.onEvent(event)
      } else {
        if (event.kind === 'cancelled' || event.kind === 'ended') {
          for (const pending of requests.values()) pending.socket.destroy()
        }
        options.onEvent(event)
        socket.end()
      }
    })
  })
  server.on('error', () => { if (!disposed) options.onUnavailable?.() })
  let folder: string | undefined
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const socket of connections) socket.destroy()
    requests.clear()
    server.close()
    if (folder) void rm(folder, { recursive: true, force: true }).catch(() => { /* Private temporary cleanup only. */ })
  }
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The terminal hook listener could not start.')
    folder = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'sotto-terminal-hook-'))
    await chmod(folder, 0o700)
    const platform = options.platform ?? process.platform
    const runner = options.runner ?? process.execPath
    const helperPath = options.helperPath ?? join(__dirname, 'terminalAgentHook.js')
    const wrapperPath = join(folder, platform === 'win32' ? 'runner.ps1' : 'runner.sh')
    // Scope Electron's Node mode to our helper, rather than the CLI or the user's tools.
    await writeFile(wrapperPath, platform === 'win32'
      ? `$hookArguments=@($args)\nif ($hookArguments.Count -eq 3 -and $hookArguments[1] -eq 'codex') {\n  $hookArguments[2]='base64:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$hookArguments[2]))\n}\n$env:ELECTRON_RUN_AS_NODE='1'\n& ${psQuote(runner)} @hookArguments\nexit $LASTEXITCODE\n`
      : `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(runner)} "$@"\n`, { mode: 0o700 })
    const runnerArgs = platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath]
      : [wrapperPath]
    const invoke = [...runnerArgs, helperPath]
    let args: string[]
    if (options.provider === 'claude') {
      const hooks: Record<string, unknown> = {}
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd', 'Notification']) {
        const command = [...invoke, 'claude', event].map(platform === 'win32' ? commandQuote : shellQuote).join(' ')
        hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command, timeout: 120 }] }]
      }
      const settings = join(folder, 'claude-settings.json')
      await writeFile(settings, JSON.stringify({ hooks }), { mode: 0o600 })
      args = ['--session-id', providerSessionId!, '--settings', settings]
    } else {
      // Basic-string double quotes are lost before Codex receives them on legacy PowerShell.
      args = ['-c', `notify=[${[...invoke, 'codex'].map(tomlLiteral).join(',')}]`]
    }
    return {
      runId, ...(providerSessionId ? { providerSessionId } : {}), args,
      env: {
        SOTTO_TERMINAL_HOOK_PORT: String(address.port), SOTTO_TERMINAL_HOOK_SECRET: secret,
        SOTTO_TERMINAL_HOOK_TERMINAL_ID: options.terminalId, SOTTO_TERMINAL_HOOK_RUN_ID: runId,
        SOTTO_TERMINAL_HOOK_TIMEOUT_MS: String(Math.min(options.requestTimeoutMs ?? 110_000, 110_000)),
      },
      answer(answer): boolean {
        const parsed = terminalHookAnswerSchema.safeParse(answer)
        if (!parsed.success || disposed) return false
        const checked = parsed.data
        if (checked.terminalId !== options.terminalId || checked.runId !== runId) return false
        const pending = requests.get(checked.requestId)
        if (!pending || pending.answer || pending.socket.destroyed || pending.event.approvalId !== checked.approvalId) return false
        pending.answer = checked
        pending.socket.write(`${JSON.stringify(checked)}\n`)
        return true
      },
      dispose,
    }
  } catch (error) { dispose(); throw error }
}
