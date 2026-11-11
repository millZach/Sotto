import type { IPty } from 'node-pty'
import type { PiSource } from '../../shared/piSignIn'
import type { PiProgram } from './piAccounts'

export interface PiLoginProcess { write(text: string): void; kill(): void; readonly ended: Promise<boolean> }
export type PiLoginSpawner = (program: PiProgram, args: readonly string[], cwd: string, output: (text: string) => void) => Promise<PiLoginProcess>

/** A hidden terminal: Pi refuses login over pipes. Nothing from this terminal is a log or a user-visible transcript. */
export const spawnPiLogin: PiLoginSpawner = async (program, args, cwd, output) => {
  const { spawn } = await import('node-pty')
  const pty: IPty = spawn(program.executable, [...program.args, 'auth', ...args], { cwd, env: program.env, cols: 160, rows: 24, name: 'xterm-256color' })
  const data = pty.onData(output)
  const ended = new Promise<boolean>(resolve => { pty.onExit(event => { data.dispose(); resolve(event.exitCode === 0) }) })
  return { write: text => pty.write(text), kill: () => { try { pty.kill() } catch { /* Already closed. */ } }, ended }
}

const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'gu')

/** Whitelist only the progress fields the existing sign-in dialog needs; never surface raw terminal text. */
export class PiLoginReader {
  private buffer = ''
  private domainAnswered = false
  constructor(private readonly source: PiSource, private readonly events: { keyPrompt(): void; domain(): void; page(url: string, code?: string): void }) {}
  push(chunk: string): void {
    this.buffer = (this.buffer + chunk).replace(ansi, '').slice(-16_384)
    if (this.source.keyLabel && this.buffer.includes(`Enter ${this.source.keyLabel}:`)) { this.buffer = ''; this.events.keyPrompt(); return }
    if (!this.domainAnswered && this.source.id === 'github-copilot' && this.buffer.includes('GitHub Enterprise URL/domain')) {
      this.domainAnswered = true; this.buffer = ''; this.events.domain(); return
    }
    const pages = /Open (https:\/\/\S+) and enter code: ([A-Za-z0-9-]{2,64})[\r\n]|Open this URL to sign in:\s*(https:\/\/[^\s]+)[\r\n]/gu
    for (const match of this.buffer.matchAll(pages)) {
      try {
        const page = new URL((match[1] ?? match[3])!)
        if (page.protocol !== 'https:' || page.username || page.password || !this.source.hosts?.includes(page.hostname)) continue
        this.buffer = ''; this.events.page(page.href, match[2]); return
      } catch { /* Not a complete, approved address. */ }
    }
  }
}
