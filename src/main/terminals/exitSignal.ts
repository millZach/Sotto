import { randomUUID } from 'node:crypto'

/** The owning launcher reports CLI exit independently of native hooks. Never forward its run marker to output. */
export class TerminalAgentExitSignal {
  readonly body = `]777;sotto-agent-exited;${randomUUID()}`
  private readonly marker = `\x1b${this.body}\x07`
  private pending = ''
  private ended = false

  write(data: string): { output: string; exited: boolean } {
    let buffered = this.pending + data
    this.pending = ''
    const index = buffered.indexOf(this.marker)
    let exited = false
    if (index >= 0) {
      exited = !this.ended
      this.ended = true
      buffered = buffered.split(this.marker).join('')
    }
    // Keep only a possible marker prefix; split PTY frames cannot leak part of the marker into retained output.
    let length = Math.min(buffered.length, this.marker.length - 1)
    while (length && !this.marker.startsWith(buffered.slice(-length))) length--
    if (length) this.pending = buffered.slice(-length)
    return { output: length ? buffered.slice(0, -length) : buffered, exited }
  }

  flush(): string { const output = this.pending; this.pending = ''; return output }
}
