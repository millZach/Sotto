import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { AGENT_MAX_ATTACHMENT_BYTES } from '../../shared/agents'

export type ClaudeFrame = Record<string, unknown>
class ClaudeUncertain extends Error {}
/**
 * The CLI answered a control request with an error: it heard the request and did not do it. Unlike a lost or
 * unreadable answer, nothing about the request is unknown, so a caller may try another way.
 */
export class ClaudeRejected extends Error {}
// Native user replay and transcript entries include base64 image data. Honor the
// shared aggregate attachment limit plus room for prompt/protocol metadata.
export const CLAUDE_MAX_FRAME_BYTES = Math.ceil(AGENT_MAX_ATTACHMENT_BYTES / 3) * 4 + 1024 * 1024

/** Native newline-framed control channel. Deadlines never resend a mutation. */
export class ClaudeProtocol {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly waiters = new Map<string, { resolve: (value: ClaudeFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private ended = false
  private stopping = false
  readonly closed: Promise<void>
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeout: number,
    onFrame: (frame: ClaudeFrame) => void, onExit: () => void) {
    this.child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: 'pipe' })
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(); resolve(); if (!this.stopping) onExit() }))
    // The unfinished line is kept as fragments with a running byte count, so a large frame arriving in
    // many chunks costs one pass over each chunk and one join, not a rescan of everything so far.
    let fragments: string[] = []; let pendingBytes = 0; let stderrBytes = 0
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      pendingBytes += Buffer.byteLength(chunk)
      if (pendingBytes > CLAUDE_MAX_FRAME_BYTES) { fragments = []; this.abort(); return }
      let start = 0
      try {
        let newline: number
        while ((newline = chunk.indexOf('\n', start)) >= 0) {
          let line = chunk.slice(start, newline); start = newline + 1
          if (fragments.length) { fragments.push(line); line = fragments.join(''); fragments = [] }
          if (!line.trim()) continue
          let frame: ClaudeFrame
          try { frame = JSON.parse(line) as ClaudeFrame; if (!frame || typeof frame !== 'object') throw new Error() } catch { this.abort(); return }
          if (frame.type === 'control_response') {
            const response = object(frame.response); const id = response?.request_id
            const waiter = typeof id === 'string' ? this.waiters.get(id) : undefined
            if (waiter) {
              clearTimeout(waiter.timer); this.waiters.delete(id as string)
              // A success may carry no body, and the SDK reads a missing one as empty.
              if (response?.subtype === 'success' && (response.response === undefined || object(response.response))) waiter.resolve((response.response ?? {}) as ClaudeFrame)
              else if (response?.subtype === 'error') waiter.reject(new ClaudeRejected('Claude rejected a control request. Check the native client.'))
              else waiter.reject(new ClaudeUncertain('Claude answered a control request in a form Sotto could not read.'))
            }
          }
          onFrame(frame)
        }
      } finally {
        // Whatever this chunk did not consume stays pending, as the rest of the old buffer did, even
        // when a malformed line or a throwing listener ends the loop early.
        if (start === 0) fragments.push(chunk)
        else { const rest = chunk.slice(start); fragments = rest ? [rest] : []; pendingBytes = Buffer.byteLength(rest) }
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) this.abort() })
    this.child.on('error', () => this.abort()); this.child.stdin.on('error', () => this.abort())
  }
  control(request: ClaudeFrame): Promise<ClaudeFrame> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new ClaudeUncertain('Claude did not acknowledge the request.')) }, this.timeout)
      this.waiters.set(id, { resolve, reject, timer })
      void this.write({ type: 'control_request', request_id: id, request }).catch(error => {
        clearTimeout(timer); this.waiters.delete(id); reject(error)
      })
    })
  }
  write(frame: ClaudeFrame): Promise<void> {
    if (this.ended || this.stopping) return Promise.reject(new ClaudeUncertain('Claude is disconnected.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ClaudeUncertain('Claude delivery is uncertain.')), this.timeout)
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, error => {
        clearTimeout(timer); if (error) reject(new ClaudeUncertain('Claude delivery is uncertain.')); else resolve()
      })
    })
  }
  stop(): void {
    if (this.stopping) return
    this.stopping = true; this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill(), 500)
    timer.unref(); void this.closed.then(() => clearTimeout(timer))
  }
  private abort(): void { this.fail(); this.child.kill() }
  private fail(): void {
    this.ended = true
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new ClaudeUncertain('Claude disconnected before acknowledging the request.')) }
    this.waiters.clear()
  }
}

export function object(value: unknown): ClaudeFrame | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeFrame : undefined
}
